/**
 * ATK_TEST_MODE — mjedisi TEST (fiskalizimi-test.atk-ks.org); HTTP lejohet kur FISCAL_LOCAL_RUN=0.
 * FISCAL_LOCAL_RUN=1 — profil lokal; ATK HTTP i bllokuar plotësisht.
 */
const { isFiscalLocalRun, isAtkHost } = require("./fiscal-local-env");

function isAtkTestMode() {
  const env = process.env.ATK_TEST_MODE ?? process.env.FISCAL_TEST_MODE;
  if (env !== undefined && env !== null && String(env).trim() !== "") {
    const v = String(env).trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  try {
    const database = require("../database");
    const v = database.getSetting("atk_test_mode", "0");
    return v === "1" || v === 1 || v === true || v === "true";
  } catch {
    return false;
  }
}

/** true vetëm kur pronari e lejon me BIZNES_ATK_SEND_ALLOWED=1 ose settings atk_send_allowed=1. */
function isAtkSendAllowedByOwner() {
  if (/^1|true|yes|on$/i.test(String(process.env.BIZNES_ATK_SEND_ALLOWED || "").trim())) {
    return true;
  }
  try {
    const database = require("../database");
    return database.getSetting("atk_send_allowed", "0") === "1";
  } catch {
    return false;
  }
}

/** true → asnjë HTTP te serveri ATK (default deri urdhër pronari). */
function isAtkTransmissionBlocked() {
  if (!isAtkSendAllowedByOwner()) return true;
  return isFiscalLocalRun();
}

/**
 * Vetëm self-test / CI: kuponët mbeten në memorie (pa SQLite).
 * LOKAL (FISCAL_LOCAL_RUN) + ATK_TEST_MODE bllokojnë HTTP, por ruajnë në DB.
 */
function isFiscalMemoryOnly() {
  const v = process.env.FISCAL_MEMORY_ONLY;
  if (v !== undefined && v !== null && String(v).trim() !== "") {
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

const mem = {
  receipts: new Map(),
  receiptsByNuikf: new Map(),
  receiptsBySaleId: new Map(),
  audit: [],
  pending: new Map(),
  nextReceiptId: 900000001,
  nextPendingId: 1,
  nextAuditId: 1,
  dailyCounter: 0,
  totalCounter: 0,
  lastZDate: "",
  lastDailyNumberDate: "",
  lastChainHash: null,
};

function todayLocalYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowLocal() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function memInsertReceipt(row) {
  const nuikf = String(row.nuikf || "")
    .trim()
    .toUpperCase();
  if (mem.receiptsByNuikf.has(nuikf)) {
    throw new Error("fiscal INSERT (mem): NUIKF nuk është unik: " + nuikf);
  }
  const id = mem.nextReceiptId++;
  const full = {
    ...row,
    id,
    nuikf,
    sent_to_atk: row.sent_to_atk ? 1 : 0,
    is_offline: row.is_offline ? 1 : 0,
    created_at: nowLocal(),
    __mem_only: true,
  };
  mem.receipts.set(id, full);
  mem.receiptsByNuikf.set(nuikf, full);
  const saleId = Number(row.sale_id) || 0;
  if (saleId) mem.receiptsBySaleId.set(saleId, full);
  if (full.chain_current_hash) {
    mem.lastChainHash = String(full.chain_current_hash).trim().toUpperCase();
  }
  console.log("[fiscal-test-mode] receipt in-memory id=", id, "nuikf=", nuikf);
  return id;
}

function memGetLastChainHash() {
  const { GENESIS_HASH } = require("./fiscal-hash-chain");
  return mem.lastChainHash || GENESIS_HASH;
}

function memSetLastChainHash(hash) {
  mem.lastChainHash = String(hash || "").trim().toUpperCase() || null;
}

function memGetAllReceiptsForChainVerify() {
  return [...mem.receipts.values()]
    .filter((r) => r.chain_current_hash)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function memUpdateReceipt(id, data) {
  const rid = Number(id);
  const row = mem.receipts.get(rid);
  if (!row) return { id: rid, changes: 0 };

  const allowed = ["sent_to_atk", "sent_at", "atk_response_json"];
  const forbidden = Object.keys(data || {}).filter(
    (k) => data[k] !== undefined && !allowed.includes(k)
  );
  if (forbidden.length) {
    throw new Error(
      "fiscalReceiptUpdate: WRITE-ONCE — fusha të ndaluara: " +
        forbidden.join(", ") +
        ". Lejohen vetëm: sent_to_atk, sent_at, atk_response_json"
    );
  }

  if (data.sent_to_atk !== undefined) {
    row.sent_to_atk = data.sent_to_atk === true || data.sent_to_atk === 1 || data.sent_to_atk === "1" ? 1 : 0;
  }
  if (data.sent_at !== undefined) row.sent_at = data.sent_at;
  if (data.atk_response_json !== undefined) {
    row.atk_response_json =
      data.atk_response_json != null && typeof data.atk_response_json === "object"
        ? JSON.stringify(data.atk_response_json)
        : data.atk_response_json;
  }
  mem.receipts.set(rid, row);
  return { id: rid, changes: 1 };
}

function memGetReceipt(id) {
  return mem.receipts.get(Number(id)) || null;
}

function memGetReceiptBySaleId(saleId) {
  return mem.receiptsBySaleId.get(Number(saleId)) || null;
}

function memLogAudit(action, details, operatorName, operatorId) {
  const entry = {
    id: mem.nextAuditId++,
    action: String(action || "").trim().toLowerCase(),
    details_json: JSON.stringify(details && typeof details === "object" ? details : { value: details }),
    details,
    operator_name: operatorName != null ? String(operatorName) : null,
    operator_id: operatorId != null ? String(operatorId) : null,
    created_at: nowLocal(),
    __mem_only: true,
  };
  mem.audit.push(entry);
  console.log("[fiscal-test-mode] audit (in-memory):", entry.action, details);
  return entry;
}

function memBeginPending({ orderId, operatorName, operatorId }) {
  const oid = Number(orderId) || null;
  for (const [pid, row] of mem.pending.entries()) {
    if (row.order_id === oid && row.status === "open") {
      row.status = "abandoned";
      row.stage = "abandoned";
      row.updated_at = nowLocal();
      mem.pending.set(pid, row);
    }
  }
  const id = mem.nextPendingId++;
  const row = {
    id,
    order_id: oid,
    fiscal_receipt_id: null,
    nuikf: null,
    stage: "started",
    status: "open",
    print_text: null,
    last_printed_line: null,
    operator_name: operatorName != null ? String(operatorName) : null,
    operator_id: operatorId != null ? String(operatorId) : null,
    details_json: JSON.stringify({ checkpoint: "before_coupon" }),
    created_at: nowLocal(),
    updated_at: nowLocal(),
    __mem_only: true,
  };
  mem.pending.set(id, row);
  return id;
}

function memUpdatePending(pendingId, patch) {
  const id = Number(pendingId);
  const row = mem.pending.get(id);
  if (!row || row.status !== "open") return;
  if (patch.stage != null) row.stage = String(patch.stage);
  if (patch.status != null) row.status = String(patch.status);
  if (patch.fiscal_receipt_id != null) row.fiscal_receipt_id = Number(patch.fiscal_receipt_id);
  if (patch.nuikf != null) row.nuikf = String(patch.nuikf);
  if (patch.print_text != null) row.print_text = String(patch.print_text);
  if (patch.last_printed_line != null) row.last_printed_line = String(patch.last_printed_line);
  if (patch.details && typeof patch.details === "object") {
    let details = {};
    try {
      details = JSON.parse(row.details_json || "{}");
    } catch {
      details = {};
    }
    row.details_json = JSON.stringify({ ...details, ...patch.details });
  }
  row.updated_at = nowLocal();
  mem.pending.set(id, row);
}

function memGetPendingForOrder(orderId) {
  let best = null;
  for (const row of mem.pending.values()) {
    if (
      row.order_id === Number(orderId) &&
      row.status === "open" &&
      ["started", "coupon_ready", "printing"].includes(row.stage)
    ) {
      if (!best || row.id > best.id) best = row;
    }
  }
  return best;
}

function memListOpenPending() {
  return [...mem.pending.values()].filter(
    (row) =>
      row.status === "open" && (row.stage === "coupon_ready" || row.stage === "printing")
  );
}

function memGetNextDailyNumber() {
  const today = todayLocalYmd();
  const lastZ = mem.lastZDate ? String(mem.lastZDate).slice(0, 10) : "";
  const lastDaily = mem.lastDailyNumberDate
    ? String(mem.lastDailyNumberDate).slice(0, 10)
    : "";
  const counter = Number(mem.dailyCounter) || 0;
  let next;

  if (lastZ === today) {
    next = counter + 1;
    if (next < 1) next = 1;
  } else if (lastDaily !== today) {
    next = 1;
  } else {
    next = counter + 1;
    if (next < 1) next = 1;
  }

  mem.dailyCounter = next;
  mem.lastDailyNumberDate = today;
  return next;
}

function memResetDailyCounter() {
  const today = todayLocalYmd();
  mem.dailyCounter = 0;
  mem.lastZDate = today;
  mem.lastDailyNumberDate = today;
  return true;
}

function memGetNextTotalNumber() {
  mem.totalCounter = (Number(mem.totalCounter) || 0) + 1;
  if (mem.totalCounter < 1) mem.totalCounter = 1;
  return mem.totalCounter;
}

function memGetAuditLog(fromDate, toDate) {
  const from = fromDate ? String(fromDate).slice(0, 10) : "";
  const to = toDate ? String(toDate).slice(0, 10) : "";
  return mem.audit
    .filter((row) => {
      const day = String(row.created_at || "").slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    })
    .map((row) => ({
      id: row.id,
      action: row.action,
      details_json: row.details_json,
      details: row.details,
      operator_name: row.operator_name,
      operator_id: row.operator_id,
      created_at: row.created_at,
    }));
}

function memPurgeNonFiscalAudit(keepActions) {
  const keep = new Set((keepActions || []).map((a) => String(a || "").toLowerCase()));
  const before = mem.audit.length;
  mem.audit = mem.audit.filter((row) => keep.has(String(row.action || "").toLowerCase()));
  return { deleted: Math.max(0, before - mem.audit.length) };
}

/** Për listën e kuponëve kur ATK_TEST_MODE — kuponët janë vetëm në memorie. */
function memListReceiptSummaries(limit = 500) {
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
  return [...mem.receipts.values()]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, lim)
    .map((row) => ({
      id: row.id,
      nuikf: row.nuikf,
      daily_number: row.daily_number,
      fiscal_date: row.fiscal_date,
      fiscal_time: row.fiscal_time,
      receipt_type: row.receipt_type,
      total_amount: row.total_amount,
      payment_method: row.payment_method,
      operator_name: row.operator_name,
      operator_id: row.operator_id,
      is_offline: row.is_offline,
      sent_to_atk: row.sent_to_atk,
      created_at: row.created_at,
    }));
}

module.exports = {
  isFiscalLocalRun,
  isAtkHost,
  isAtkTestMode,
  isAtkSendAllowedByOwner,
  isAtkTransmissionBlocked,
  isFiscalMemoryOnly,
  memInsertReceipt,
  memUpdateReceipt,
  memGetReceipt,
  memGetReceiptBySaleId,
  memLogAudit,
  memBeginPending,
  memUpdatePending,
  memGetPendingForOrder,
  memListOpenPending,
  memGetNextDailyNumber,
  memGetNextTotalNumber,
  memResetDailyCounter,
  memGetLastChainHash,
  memSetLastChainHash,
  memGetAllReceiptsForChainVerify,
  memGetAuditLog,
  memPurgeNonFiscalAudit,
  memListReceiptSummaries,
};
