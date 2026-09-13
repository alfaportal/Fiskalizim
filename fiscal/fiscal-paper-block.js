/**
 * fiscal/fiscal-paper-block.js — Neni 45: bllok letër kur SEF ndalon plotësisht.
 * Regjistrim i kuponëve me numër serik → fiskalizim në SEF kur pajisja rikthehet.
 */
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { logFiscalAction } = require("./fiscal-audit");
const { insertFiscalReceipt, getFiscalReceiptById, fiscalReceiptUpdate } = require("./fiscal-db");
const {
  generateNUIKF,
  getSefIdentifier,
  getNextDailyNumber,
  getNextTotalNumber,
} = require("./fiscal-numbering");
const { calculateVatTaxBreakdown, round4, lineTotalAmount, normalizeQty, normalizeUnitPrice } = require("./fiscal-vat");
const { getFiscalTodayParts, getFiscalNowMs } = require("./fiscal-time-sync");
const { signReceipt } = require("./fiscal-crypto");
const { generateFiscalQR } = require("./fiscal-qr");
const { sendReceiptToAtk, markReceiptSent } = require("./fiscal-offline");

const HOURS_48 = 48;
const DAYS_5_AFTER_48H = 5;

const SETTING_ACTIVE = "paper_block_mode_active";
const SETTING_STARTED = "paper_block_started_at";
const SETTING_BATCH = "paper_block_batch_id";
const SETTING_AUTO = "paper_block_auto_enabled";
const SETTING_AUTO_REASON = "paper_block_auto_reason";
const SETTING_FAILURE_COUNT = "paper_block_sef_failure_count";
const SETTING_LAST_FAILURE = "paper_block_sef_last_failure_at";
const SETTING_LAST_FAILURE_MSG = "paper_block_sef_last_failure_msg";

const MONITOR_MS = 60 * 1000;
const FAILURE_THRESHOLD = 2;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const HEALTH_FAIL_THRESHOLD = 3;

/** Gabime që tregojnë SEF të ndalur (jo thjesht offline/print/ATK queue). */
const CRITICAL_FAILURE_PATTERNS = [
  /databaz/i,
  /sqlite/i,
  /write-once/i,
  /insert/i,
  /numërimi fiskal/i,
  /numërim/i,
  /nuikf/i,
  /çelës/i,
  /celes/i,
  /ecdsa/i,
  /certifikat/i,
  /sign/i,
  /nënshkrim/i,
  /validimi para insert/i,
  /fiscal_receipts/i,
  /hash.?chain/i,
  /enkriptim/i,
];

let _monitorTimer = null;
let _healthFailStreak = 0;

function getDb() {
  return require("../database");
}

function getSqlite() {
  const database = getDb();
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function getSetting(key, fallback = null) {
  try {
    return getDb().getSetting(key, fallback);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  getDb().setSetting(key, value);
}

function clearSetting(key) {
  try {
    getSqlite().prepare(`DELETE FROM settings WHERE key = ?`).run(String(key));
  } catch {
    /* ignore */
  }
}

function assertFiscalOn() {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }
}

function normalizeItems(items) {
  const { resolveItemUnitCategory } = require("./fiscal-item-meta");
  return (Array.isArray(items) ? items : []).map((item) => {
    const letter = String(item.vat_norm || item.vat_letter || "E")
      .trim()
      .toUpperCase();
    const L = /^[A-E]$/.test(letter) ? letter : "E";
    const qty = normalizeQty(item.quantity ?? item.qty ?? 1);
    const unitPrice = normalizeUnitPrice(item);
    const meta = resolveItemUnitCategory(item, { authoritativeDb: true });
    return {
      name: String(item.name || "-").trim(),
      quantity: qty,
      qty,
      price: unitPrice,
      unit_price: unitPrice,
      vat_norm: L,
      vat_letter: L,
      product_id: item.product_id ?? item.menu_item_id ?? meta.product_id ?? null,
      menu_item_id: item.menu_item_id ?? item.product_id ?? meta.product_id ?? null,
      unit_code: meta.unit_code,
      category_code: meta.category_code,
    };
  });
}

function sumItems(items) {
  return round4(
    items.reduce(
      (s, it) => s + lineTotalAmount(it.quantity || it.qty, it.unit_price || it.price),
      0
    )
  );
}

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isPaperBlockModeActive() {
  if (!isFiscalEnabled()) return false;
  const v = getSetting(SETTING_ACTIVE, "0");
  return v === "1" || v === 1 || v === true || v === "true";
}

function isAutoPaperBlockEligible() {
  // SEF test / POS — auto-bllokim letre i çaktivizuar (vetëm manual nga Cilësimet nëse duhet).
  return false;
}

function isCriticalSefFailure(err) {
  const msg = String(err?.message || err || "").trim();
  if (!msg) return false;
  if (/print/i.test(msg) && !/insert/i.test(msg)) return false;
  if (/atk/i.test(msg) && /queue|offline|pritje|transmetim|http/i.test(msg)) return false;
  if (/printer/i.test(msg)) return false;
  if (/internet|offline queue|pa internet/i.test(msg)) return false;
  return CRITICAL_FAILURE_PATTERNS.some((re) => re.test(msg));
}

function clearSefFailureStreak() {
  clearSetting(SETTING_FAILURE_COUNT);
  clearSetting(SETTING_LAST_FAILURE);
  clearSetting(SETTING_LAST_FAILURE_MSG);
  _healthFailStreak = 0;
}

function recordSefCriticalFailure(err, context = {}) {
  if (!isAutoPaperBlockEligible()) {
    return { recorded: false, enabled: false, reason: "not_eligible" };
  }
  if (!isCriticalSefFailure(err)) {
    return { recorded: false, enabled: false, reason: "not_critical" };
  }

  const msg = String(err?.message || err || "Gabim i panjohur SEF").slice(0, 500);
  const now = Date.now();
  const lastRaw = getSetting(SETTING_LAST_FAILURE);
  const lastTs = lastRaw ? new Date(lastRaw).getTime() : 0;
  let count = Number(getSetting(SETTING_FAILURE_COUNT, "0")) || 0;
  if (!lastTs || now - lastTs > FAILURE_WINDOW_MS) {
    count = 0;
  }
  count += 1;

  setSetting(SETTING_FAILURE_COUNT, String(count));
  setSetting(SETTING_LAST_FAILURE, new Date(now).toISOString());
  setSetting(SETTING_LAST_FAILURE_MSG, msg);

  try {
    logFiscalAction(
      "error",
      {
        source: "sef_critical_failure",
        message: msg,
        count,
        threshold: FAILURE_THRESHOLD,
        context: context && typeof context === "object" ? context : {},
      },
      "SYSTEM",
      "PAPER_BLOCK"
    );
  } catch {
    /* ignore */
  }

  if (count >= FAILURE_THRESHOLD) {
    const status = maybeAutoEnablePaperBlock("sef_checkout_failures", {
      failure_count: count,
      last_error: msg,
      ...context,
    });
    return { recorded: true, enabled: !!status?.active, auto: true, status };
  }

  console.warn(
    `[fiscal-paper-block] dështim kritik SEF ${count}/${FAILURE_THRESHOLD}:`,
    msg
  );
  return { recorded: true, enabled: false, failure_count: count };
}

/**
 * Kontroll i lexueshëm i shëndetit — pa increment counter fiskal.
 */
function probeSefHealth() {
  const issues = [];
  if (!isFiscalEnabled()) {
    return { ok: false, issues: ["fiscal_off"] };
  }

  try {
    const sqlite = getSqlite();
    const row = sqlite.prepare(`SELECT id FROM fiscal_settings LIMIT 1`).get();
    if (!row) issues.push("fiscal_settings_empty");
  } catch (e) {
    issues.push("db_read:" + e.message);
  }

  try {
    const nuikf = generateNUIKF();
    if (!/^[A-Z0-9]{16}$/.test(String(nuikf || ""))) {
      issues.push("nuikf_invalid");
    }
  } catch (e) {
    issues.push("nuikf:" + e.message);
  }

  try {
    const sef = getSefIdentifier();
    if (!sef || String(sef).trim().length < 5) {
      issues.push("sef_id_missing");
    }
  } catch (e) {
    issues.push("sef_id:" + e.message);
  }

  try {
    const { isAtkTransmissionBlocked } = require("./fiscal-test-mode-store");
    if (!isAtkTransmissionBlocked()) {
      const { getAtkStatus } = require("./fiscal-atk-api");
      const st = getAtkStatus();
      if (!st?.has_private_key) {
        issues.push("private_key_missing");
      }
    }
  } catch (e) {
    issues.push("crypto:" + e.message);
  }

  return { ok: issues.length === 0, issues };
}

function maybeAutoEnablePaperBlock(reason, details = {}) {
  if (!isAutoPaperBlockEligible()) return getPaperBlockStatus();

  const status = enablePaperBlockMode("SYSTEM", {
    batch_id: details.batch_id,
    reason: reason || "auto",
    auto: true,
    auto_details: details,
  });
  setSetting(SETTING_AUTO, "1");
  setSetting(SETTING_AUTO_REASON, String(reason || "auto"));
  console.warn("[fiscal-paper-block] AUTO-aktivizuar —", reason);
  return status;
}

function runPaperBlockMonitorTick() {
  if (!isFiscalEnabled()) return null;
  if (isPaperBlockModeActive()) return getPaperBlockStatus();
  if (!isAutoPaperBlockEligible()) {
    _healthFailStreak = 0;
    return null;
  }

  const health = probeSefHealth();
  if (health.ok) {
    _healthFailStreak = 0;
    return null;
  }

  _healthFailStreak += 1;
  console.warn(
    `[fiscal-paper-block] health FAIL ${_healthFailStreak}/${HEALTH_FAIL_THRESHOLD}:`,
    health.issues.join("; ")
  );

  if (_healthFailStreak >= HEALTH_FAIL_THRESHOLD) {
    return maybeAutoEnablePaperBlock("sef_health_check", {
      issues: health.issues,
      fail_streak: _healthFailStreak,
    });
  }
  return null;
}

function startPaperBlockMonitor() {
  if (!isFiscalEnabled()) return false;
  if (_monitorTimer) return true;

  console.log("[fiscal-paper-block] monitor nisur (60s) — auto Neni 45");
  runPaperBlockMonitorTick();
  _monitorTimer = setInterval(() => {
    if (!isFiscalEnabled()) return;
    try {
      runPaperBlockMonitorTick();
    } catch (e) {
      console.warn("[fiscal-paper-block] tick:", e.message);
    }
  }, MONITOR_MS);

  if (typeof _monitorTimer.unref === "function") {
    _monitorTimer.unref();
  }
  return true;
}

function stopPaperBlockMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
}

function hoursSince(iso) {
  if (!iso) return 0;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function addDays(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * Gjendja e bllokut letër + afatet 48h / 5 ditë (Neni 45.5 / 45.6).
 */
function getPaperBlockStatus() {
  if (!isFiscalEnabled()) return null;

  const active = isPaperBlockModeActive();
  const startedAt = getSetting(SETTING_STARTED);
  const batchId = getSetting(SETTING_BATCH);
  const sqlite = getSqlite();

  const pending = sqlite
    .prepare(
      `SELECT id, serial_no, fiscal_date, fiscal_time, total_amount, created_at
       FROM paper_block_receipts
       WHERE registered_fiscal_receipt_id IS NULL
       ORDER BY id ASC`
    )
    .all();

  const registered = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM paper_block_receipts
       WHERE registered_fiscal_receipt_id IS NOT NULL`
    )
    .get();
  const registered_count = Number(registered?.c) || 0;

  const hSince = hoursSince(startedAt);
  const restore_deadline_hours = Math.max(0, HOURS_48 - hSince);
  const past_restore_48h = active && hSince > HOURS_48;
  const register_deadline_at = startedAt ? addDays(startedAt, HOURS_48 / 24 + DAYS_5_AFTER_48H) : null;
  const past_register_5d =
    register_deadline_at && Date.now() > new Date(register_deadline_at).getTime();

  let level = "ok";
  let message = null;
  if (active && pending.length && past_register_5d) {
    level = "critical";
    message = "Regjistroni urgjent kuponët e bllokut letër në SEF";
  } else if (active && past_restore_48h) {
    level = "urgent";
    message = "Riktheni SEF-in ose siguroni pajisje të re (48h)";
  } else if (active) {
    level = "warning";
    const autoFlag = getSetting(SETTING_AUTO, "0") === "1";
    message = autoFlag
      ? `Bllok letër AUTO (SEF ndaloi) — ${pending.length} kupon(ë) pa regjistruar`
      : `Modalitet bllok letër AKTIV — ${pending.length} kupon(ë) pa regjistruar në SEF`;
  }

  const autoEnabled =
    getSetting(SETTING_AUTO, "0") === "1" || getSetting(SETTING_AUTO, "0") === 1;
  const failureCount = Number(getSetting(SETTING_FAILURE_COUNT, "0")) || 0;

  return {
    active,
    auto_enabled: autoEnabled,
    auto_reason: getSetting(SETTING_AUTO_REASON),
    sef_failure_count: failureCount,
    sef_last_failure_at: getSetting(SETTING_LAST_FAILURE),
    sef_last_failure_msg: getSetting(SETTING_LAST_FAILURE_MSG),
    started_at: startedAt,
    batch_id: batchId,
    pending_count: pending.length,
    registered_count,
    pending,
    hours_since_failure: Math.round(hSince * 10) / 10,
    restore_deadline_hours: Math.round(restore_deadline_hours * 10) / 10,
    past_restore_48h,
    register_deadline_at,
    past_register_5d,
    level,
    message,
    legal_basis: "Udhëzim Administrativ MF 01/2026",
  };
}

function enablePaperBlockMode(operatorName, opts = {}) {
  assertFiscalOn();
  if (isPaperBlockModeActive()) {
    return getPaperBlockStatus();
  }
  const now = new Date(getFiscalNowMs()).toISOString();
  const batch =
    String(opts.batch_id || "").trim() ||
    `BLK-${now.slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  setSetting(SETTING_ACTIVE, "1");
  setSetting(SETTING_STARTED, now);
  setSetting(SETTING_BATCH, batch);

  logFiscalAction(
    "paper_block_mode_on",
    {
      batch_id: batch,
      started_at: now,
      reason: opts.reason || null,
      auto: !!opts.auto,
      auto_details: opts.auto_details || null,
    },
    operatorName || "Operator",
    "ADMIN"
  );

  console.warn("[fiscal-paper-block] modalitet AKTIV — batch", batch);
  return getPaperBlockStatus();
}

function disablePaperBlockMode(operatorName, opts = {}) {
  assertFiscalOn();
  if (!isPaperBlockModeActive()) {
    return getPaperBlockStatus();
  }

  const status = getPaperBlockStatus();
  if (status.pending_count > 0 && !opts.force) {
    throw new Error(
      `Ka ${status.pending_count} kupon(ë) bllok letër pa regjistruar në SEF. Regjistroji së pari ose përdor force=true.`
    );
  }

  clearSetting(SETTING_ACTIVE);
  clearSetting(SETTING_STARTED);
  clearSetting(SETTING_BATCH);
  clearSetting(SETTING_AUTO);
  clearSetting(SETTING_AUTO_REASON);
  clearSefFailureStreak();

  logFiscalAction(
    "paper_block_mode_off",
    { forced: !!opts.force, pending_remaining: status.pending_count },
    operatorName || "Operator",
    "ADMIN"
  );

  return getPaperBlockStatus();
}

/** Nisje — çaktivizo bllokimin auto (mos ndërprej pagesën normale). */
function resetAutoPaperBlockOnStartup() {
  if (!isPaperBlockModeActive()) return;
  if (getSetting(SETTING_AUTO, "0") !== "1") return;
  disablePaperBlockMode("SYSTEM", { force: true });
  console.log("[fiscal-paper-block] auto-bllokim u çaktivizua në nisje");
}

/**
function issuePaperBlockCoupon(payload) {
  assertFiscalOn();
  if (!isPaperBlockModeActive()) {
    throw new Error("Modaliteti bllok letër nuk është aktiv — aktivizoje në Cilësimet SEF");
  }

  const serialNo = String(payload?.serial_no || "").trim();
  if (!serialNo) {
    throw new Error("Numri serik i bllokut letër mungon");
  }

  const items = normalizeItems(payload?.items);
  if (!items.length) {
    throw new Error("Kuponi kërkon të paktën një artikull");
  }

  const sqlite = getSqlite();
  const dup = sqlite
    .prepare(`SELECT id FROM paper_block_receipts WHERE serial_no = ? LIMIT 1`)
    .get(serialNo);
  if (dup) {
    throw new Error(`Numri serik ${serialNo} ekziston tashmë`);
  }

  const { fiscal_date, fiscal_time } = payload.fiscal_date
    ? { fiscal_date: payload.fiscal_date, fiscal_time: payload.fiscal_time || "12:00" }
    : getFiscalTodayParts();

  const subtotal = round4(payload.subtotal != null ? Number(payload.subtotal) : sumItems(items));
  const discount = round4(Number(payload.discount_amount || 0) || 0);
  const totalAmount = round4(
    payload.total_amount != null ? Number(payload.total_amount) : subtotal - discount
  );
  const vatResult = calculateVatTaxBreakdown(items, { totalAmount });
  const totalWithoutTax = round4(vatResult?.totalWithoutTax ?? totalAmount);
  const vatBreak = vatResult?.tax || { A: 0, B: 0, C: 0, D: 0, E: 0 };

  const operatorName = String(payload.operator_name || "Operator").trim() || "Operator";
  const operatorId = String(payload.operator_id || "POS").trim() || "POS";
  const paymentMethod = String(payload.payment_method || "cash").trim() || "cash";
  const batchId = getSetting(SETTING_BATCH) || "";

  const info = sqlite
    .prepare(
      `INSERT INTO paper_block_receipts (
        serial_no, block_batch, fiscal_date, fiscal_time,
        operator_name, operator_id,
        items_json, subtotal, discount_amount, total_amount, total_without_tax,
        vat_breakdown_json, payment_method, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      serialNo,
      batchId,
      fiscal_date,
      fiscal_time,
      operatorName,
      operatorId,
      JSON.stringify(items),
      subtotal,
      discount,
      totalAmount,
      totalWithoutTax,
      JSON.stringify(vatBreak),
      paymentMethod,
      String(payload.notes || "").slice(0, 500) || null
    );

  const rowId = Number(info.lastInsertRowid);

  logFiscalAction(
    "paper_block_issued",
    { paper_id: rowId, serial_no: serialNo, total: totalAmount, batch_id: batchId },
    operatorName,
    operatorId
  );

  const slipText = generatePaperBlockSlipText(
    sqlite.prepare(`SELECT * FROM paper_block_receipts WHERE id = ?`).get(rowId),
    "merchant"
  );

  return {
    id: rowId,
    serial_no: serialNo,
    total_amount: totalAmount,
    fiscal_date,
    fiscal_time,
    slip_text: slipText,
    copy: "merchant",
  };
}

function generatePaperBlockSlipText(row, copy = "merchant") {
  if (!row) return "";
  const settings = getFiscalSettings();
  const items = parseJson(row.items_json, []);
  const w = 42;
  const lines = [];
  const hr = "-".repeat(w);
  lines.push("^C^BBLLOK LETRE");
  lines.push(`^B${settings.taxpayer_legal_name || "Biznesi"}`);
  lines.push(settings.taxpayer_address || "");
  lines.push(`NUI: ${settings.taxpayer_nui || "—"}`);
  lines.push(hr);
  lines.push(`NR. SERIK: ${row.serial_no}`);
  lines.push(`DATA: ${row.fiscal_date}  ${row.fiscal_time}`);
  lines.push(`OPERATOR: ${row.operator_name}`);
  lines.push(
    copy === "merchant" ? "*** KOPJE FURNIZUESI ***" : "*** ORIGJINAL KONSUMATORI ***"
  );
  lines.push(hr);
  for (const it of items) {
    const q = Number(it.qty ?? it.quantity ?? 1);
    const p = Number(it.unit_price ?? it.price ?? 0);
    lines.push(`${it.name}`.slice(0, w));
    lines.push(`  ${q} x ${p.toFixed(2)} = ${(q * p).toFixed(2)} EUR  TVSH ${it.vat_norm || "E"}`);
  }
  lines.push(hr);
  lines.push(`TOTALI: ${Number(row.total_amount).toFixed(2)} EUR`);
  lines.push(`Pagesa: ${row.payment_method}`);
  lines.push(hr);
  lines.push("Fiskalizo ne SEF kur pajisja rikthehet.");
  lines.push("(Dy kopje: konsumator + furnizues)");
  return lines.join("\n");
}

function listPaperBlockReceipts({ pendingOnly = false } = {}) {
  assertFiscalOn();
  const sqlite = getSqlite();
  if (pendingOnly) {
    return sqlite
      .prepare(
        `SELECT * FROM paper_block_receipts
         WHERE registered_fiscal_receipt_id IS NULL
         ORDER BY id ASC`
      )
      .all();
  }
  return sqlite
    .prepare(`SELECT * FROM paper_block_receipts ORDER BY id DESC LIMIT 200`)
    .all();
}

/**
 * Konverton një kupon bllok letër → fiscal_receipts + dërgon te ATK.
 */
async function registerPaperBlockInSef(paperId, opts = {}) {
  assertFiscalOn();
  const id = Number(paperId);
  if (!id) throw new Error("ID e pavlefshme");

  const sqlite = getSqlite();
  const paper = sqlite.prepare(`SELECT * FROM paper_block_receipts WHERE id = ?`).get(id);
  if (!paper) throw new Error("Kuponi bllok letër nuk u gjet");
  if (paper.registered_fiscal_receipt_id) {
    return {
      paper_id: id,
      fiscal_receipt_id: paper.registered_fiscal_receipt_id,
      already_registered: true,
    };
  }

  const settings = getFiscalSettings();
  const items = parseJson(paper.items_json, []);
  const vatBreak = parseJson(paper.vat_breakdown_json, { A: 0, B: 0, C: 0, D: 0, E: 0 });

  const nuikf = generateNUIKF();
  const sefId = getSefIdentifier() || "";
  const dailyNumber = getNextDailyNumber();
  const totalNumber = getNextTotalNumber();

  let signature = null;
  try {
    signature = signReceipt({
      nuikf,
      total_amount: paper.total_amount,
      fiscal_date: paper.fiscal_date,
      fiscal_time: paper.fiscal_time,
      taxpayer_nui: settings.taxpayer_nui,
      sef_id: sefId,
      daily_number: dailyNumber,
      total_number: totalNumber,
      receipt_type: "paper_block",
    });
  } catch (e) {
    console.warn("[fiscal-paper-block] sign:", e.message);
  }

  let qrPayload = JSON.stringify({ paper_block: true, serial: paper.serial_no });
  try {
    const qr = await generateFiscalQR({
      nuikf,
      total_amount: paper.total_amount,
      fiscal_date: paper.fiscal_date,
      taxpayer_nui: settings.taxpayer_nui,
    });
    if (qr?.payload) qrPayload = qr.payload;
  } catch (e) {
    console.warn("[fiscal-paper-block] QR:", e.message);
  }

  const itemsWithMeta = items.map((it) => ({
    ...it,
    paper_serial: paper.serial_no,
  }));

  const fiscalId = insertFiscalReceipt({
    sale_id: 0,
    nuikf,
    sef_id: sefId,
    receipt_type: "paper_block",
    original_nuikf: null,
    daily_number: dailyNumber,
    total_number: totalNumber,
    fiscal_date: paper.fiscal_date,
    fiscal_time: paper.fiscal_time,
    operator_name: paper.operator_name,
    operator_id: paper.operator_id,
    taxpayer_nui: settings.taxpayer_nui || "",
    taxpayer_vat: settings.taxpayer_vat_number || null,
    taxpayer_name: settings.taxpayer_legal_name || "Biznesi",
    taxpayer_address: settings.taxpayer_address || "",
    items_json: JSON.stringify(itemsWithMeta),
    subtotal: paper.subtotal,
    discount_amount: paper.discount_amount,
    total_amount: paper.total_amount,
    total_without_tax: paper.total_without_tax,
    vat_breakdown_json: paper.vat_breakdown_json,
    payment_method: paper.payment_method,
    currency: "EUR",
    qr_code_data: qrPayload,
    digital_signature: signature,
    is_offline: 0,
    sent_to_atk: 0,
  });

  sqlite
    .prepare(
      `UPDATE paper_block_receipts SET
        registered_fiscal_receipt_id = ?,
        registered_at = datetime('now','localtime')
       WHERE id = ?`
    )
    .run(fiscalId, id);

  let atkSent = false;
  let atkError = null;
  if (opts.send_to_atk !== false) {
    const row = getFiscalReceiptById(fiscalId);
    const result = await sendReceiptToAtk(row);
    if (result?.sent) {
      markReceiptSent(fiscalId, result);
      atkSent = true;
    } else {
      atkError = result?.error || "dështoi dërgimi";
    }
  }

  logFiscalAction(
    "paper_block_registered",
    {
      paper_id: id,
      serial_no: paper.serial_no,
      fiscal_receipt_id: fiscalId,
      nuikf,
      atk_sent: atkSent,
      atk_error: atkError,
    },
    opts.operator_name || paper.operator_name,
    paper.operator_id
  );

  return {
    paper_id: id,
    serial_no: paper.serial_no,
    fiscal_receipt_id: fiscalId,
    nuikf,
    atk_sent: atkSent,
    atk_error: atkError,
  };
}

async function registerAllPaperBlockInSef(opts = {}) {
  const rows = listPaperBlockReceipts({ pendingOnly: true });
  const results = [];
  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      const r = await registerPaperBlockInSef(row.id, {
        send_to_atk: opts.send_to_atk !== false,
        operator_name: opts.operator_name,
      });
      results.push({ ok: true, ...r });
      if (r.atk_sent || r.already_registered) ok += 1;
      else fail += 1;
    } catch (e) {
      fail += 1;
      results.push({ ok: false, paper_id: row.id, serial_no: row.serial_no, error: e.message });
    }
  }
  return { processed: rows.length, success: ok, failed: fail, results };
}

module.exports = {
  isPaperBlockModeActive,
  getPaperBlockStatus,
  enablePaperBlockMode,
  disablePaperBlockMode,
  issuePaperBlockCoupon,
  generatePaperBlockSlipText,
  listPaperBlockReceipts,
  registerPaperBlockInSef,
  registerAllPaperBlockInSef,
  recordSefCriticalFailure,
  clearSefFailureStreak,
  probeSefHealth,
  maybeAutoEnablePaperBlock,
  runPaperBlockMonitorTick,
  startPaperBlockMonitor,
  stopPaperBlockMonitor,
  resetAutoPaperBlockOnStartup,
  isCriticalSefFailure,
  HOURS_48,
  DAYS_5_AFTER_48H,
  FAILURE_THRESHOLD,
  HEALTH_FAIL_THRESHOLD,
};
