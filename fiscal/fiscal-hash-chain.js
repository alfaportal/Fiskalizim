/**
 * fiscal/fiscal-hash-chain.js — Zinxhiri i hash-eve (Hash Chain) për kuponët fiskalë.
 *
 * Çdo kupon: Payload, Current Hash, Previous Hash, Integrity Check.
 * Previous Hash = hash-i i kuponit të menjëhershëm paraprak (zinxhir auditimi ATK).
 */
const crypto = require("crypto");
const { round4, normalizeQty, normalizeUnitPrice } = require("./fiscal-vat");
const { isFiscalMemoryOnly } = require("./fiscal-test-mode-store");

const GENESIS_HASH = crypto
  .createHash("sha256")
  .update("REVOLUTION_FISCAL_HASH_CHAIN_GENESIS_v1")
  .digest("hex")
  .toUpperCase();

const CHAIN_VERSION = 1;

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ensureChainColumns(sqlite) {
  for (const colSql of [
    `ALTER TABLE fiscal_receipts ADD COLUMN chain_payload_json TEXT`,
    `ALTER TABLE fiscal_receipts ADD COLUMN chain_current_hash TEXT`,
    `ALTER TABLE fiscal_receipts ADD COLUMN chain_previous_hash TEXT`,
    `ALTER TABLE fiscal_receipts ADD COLUMN chain_integrity_ok INTEGER DEFAULT 1`,
  ]) {
    try {
      sqlite.prepare(colSql).run();
    } catch {
      /* already exists */
    }
  }
}

function parseJsonField(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function normalizeItemsForPayload(items) {
  const arr = parseJsonField(items, []);
  if (!Array.isArray(arr)) return [];
  return arr.map((it) => ({
    name: String(it?.name || it?.emri || "-").trim(),
    qty: normalizeQty(it?.quantity ?? it?.qty ?? 1),
    unit_price: normalizeUnitPrice(it),
    vat: String(it?.vat_norm || it?.vat_letter || "E")
      .trim()
      .toUpperCase(),
  }));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Payload kanonik për hash — vetëm fusha fiskale të kuponit.
 */
function buildReceiptChainPayload(row) {
  const r = row && typeof row === "object" ? row : {};
  return {
    v: CHAIN_VERSION,
    sale_id: Number(r.sale_id) || 0,
    nuikf: String(r.nuikf || "")
      .trim()
      .toUpperCase(),
    sef_id: String(r.sef_id || ""),
    receipt_type: String(r.receipt_type || "regular"),
    original_nuikf: r.original_nuikf != null ? String(r.original_nuikf) : null,
    daily_number: Number(r.daily_number) || 0,
    total_number: Number(r.total_number) || 0,
    fiscal_date: String(r.fiscal_date || ""),
    fiscal_time: String(r.fiscal_time || ""),
    operator_name: String(r.operator_name || ""),
    operator_id: String(r.operator_id || ""),
    taxpayer_nui: String(r.taxpayer_nui || ""),
    taxpayer_name: String(r.taxpayer_name || ""),
    subtotal: round4(r.subtotal),
    discount_amount: round4(r.discount_amount),
    total_amount: round4(r.total_amount),
    total_without_tax: round4(r.total_without_tax),
    vat_breakdown: parseJsonField(r.vat_breakdown_json, {}),
    payment_method: String(r.payment_method || "cash"),
    currency: String(r.currency || "EUR"),
    is_offline: r.is_offline ? 1 : 0,
    items: normalizeItemsForPayload(r.items_json),
  };
}

function computeChainHash(previousHash, payloadObj) {
  const prev = String(previousHash || GENESIS_HASH).trim().toUpperCase();
  const payloadStr = stableStringify(payloadObj);
  return crypto
    .createHash("sha256")
    .update(prev)
    .update("|")
    .update(payloadStr)
    .digest("hex")
    .toUpperCase();
}

function getPreviousChainHash(sqlite) {
  if (isFiscalMemoryOnly()) {
    const { memGetLastChainHash } = require("./fiscal-test-mode-store");
    return memGetLastChainHash();
  }
  const db = sqlite || getSqlite();
  ensureChainColumns(db);
  const row = db
    .prepare(
      `SELECT chain_current_hash FROM fiscal_receipts
       WHERE chain_current_hash IS NOT NULL AND TRIM(chain_current_hash) != ''
       ORDER BY id DESC LIMIT 1`
    )
    .get();
  const hash = row?.chain_current_hash ? String(row.chain_current_hash).trim().toUpperCase() : "";
  return hash || GENESIS_HASH;
}

function verifyReceiptChainIntegrity(row) {
  if (!row) {
    return { ok: false, error: "mungon rreshti" };
  }
  const payload = parseJsonField(row.chain_payload_json, null);
  if (!payload) {
    return { ok: false, error: "mungon chain_payload_json" };
  }
  const previous = String(row.chain_previous_hash || GENESIS_HASH)
    .trim()
    .toUpperCase();
  const expected = computeChainHash(previous, payload);
  const current = String(row.chain_current_hash || "")
    .trim()
    .toUpperCase();
  const ok = !!current && expected === current;
  return {
    ok,
    integrity_check: ok ? "OK" : "FAIL",
    expected_hash: expected,
    current_hash: current,
    previous_hash: previous,
    payload,
  };
}

/**
 * Llogarit fushat e zinxhirit për një rresht kupon (para INSERT).
 */
function applyHashChainToReceipt(row, sqlite) {
  const payload = buildReceiptChainPayload(row);
  const previousHash = getPreviousChainHash(sqlite);
  const currentHash = computeChainHash(previousHash, payload);
  const check = verifyReceiptChainIntegrity({
    chain_payload_json: JSON.stringify(payload),
    chain_previous_hash: previousHash,
    chain_current_hash: currentHash,
  });

  return {
    ...row,
    chain_payload_json: JSON.stringify(payload),
    chain_previous_hash: previousHash,
    chain_current_hash: currentHash,
    chain_integrity_ok: check.ok ? 1 : 0,
  };
}

function recordChainHashAfterInsert(currentHash) {
  if (!isFiscalMemoryOnly()) return;
  const { memSetLastChainHash } = require("./fiscal-test-mode-store");
  memSetLastChainHash(currentHash);
}

function attachChainToFiscalData(fiscalData, receiptRow) {
  if (!fiscalData || typeof fiscalData !== "object" || !receiptRow) return fiscalData;
  fiscalData.chain_payload = parseJsonField(receiptRow.chain_payload_json, null);
  fiscalData.chain_current_hash = receiptRow.chain_current_hash || null;
  fiscalData.chain_previous_hash = receiptRow.chain_previous_hash || null;
  fiscalData.chain_integrity_ok =
    Number(receiptRow.chain_integrity_ok) === 1 ||
    receiptRow.chain_integrity_ok === true;
  fiscalData.chain_integrity_check = fiscalData.chain_integrity_ok ? "OK" : "FAIL";
  return fiscalData;
}

function verifyFullChain(limit = 5000) {
  if (isFiscalMemoryOnly()) {
    const { memGetAllReceiptsForChainVerify } = require("./fiscal-test-mode-store");
    const rows = memGetAllReceiptsForChainVerify();
    return _verifyRowsChain(rows);
  }
  const sqlite = getSqlite();
  ensureChainColumns(sqlite);
  const rows = sqlite
    .prepare(
      `SELECT id, nuikf, chain_payload_json, chain_current_hash, chain_previous_hash, chain_integrity_ok
       FROM fiscal_receipts
       WHERE chain_current_hash IS NOT NULL AND TRIM(chain_current_hash) != ''
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Math.max(1, Number(limit) || 5000));
  return _verifyRowsChain(rows);
}

function _verifyRowsChain(rows) {
  let expectedPrevious = GENESIS_HASH;
  const breaks = [];
  let okCount = 0;

  for (const row of rows || []) {
    const previous = String(row.chain_previous_hash || GENESIS_HASH)
      .trim()
      .toUpperCase();
    const linkOk = previous === expectedPrevious;
    const selfCheck = verifyReceiptChainIntegrity(row);
    const ok = linkOk && selfCheck.ok;
    if (ok) okCount += 1;
    else {
      breaks.push({
        id: row.id,
        nuikf: row.nuikf,
        link_ok: linkOk,
        self_ok: selfCheck.ok,
        expected_previous: expectedPrevious,
        actual_previous: previous,
      });
    }
    expectedPrevious = String(row.chain_current_hash || expectedPrevious)
      .trim()
      .toUpperCase();
  }

  return {
    ok: breaks.length === 0,
    total: (rows || []).length,
    verified: okCount,
    breaks: breaks.slice(0, 20),
    genesis: GENESIS_HASH,
  };
}

function formatHashShort(hash, len = 16) {
  const s = String(hash || "").trim();
  if (!s) return "-";
  if (s.length <= len) return s;
  return `${s.slice(0, len)}…`;
}

module.exports = {
  GENESIS_HASH,
  CHAIN_VERSION,
  buildReceiptChainPayload,
  computeChainHash,
  applyHashChainToReceipt,
  verifyReceiptChainIntegrity,
  verifyFullChain,
  attachChainToFiscalData,
  recordChainHashAfterInsert,
  getPreviousChainHash,
  formatHashShort,
  stableStringify,
};
