/**
 * fiscal/fiscal-receipts-list.js — listë kuponësh fiskalë + preview teksti për panelin e pronarit.
 * Vetëm kur isFiscalEnabled()=true. NUK dërgon te ATK, NUK printon.
 */
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { generateFiscalReceipt } = require("./fiscal-print");
const { getFiscalReceiptById } = require("./fiscal-db");
const { isFiscalMemoryOnly, memListReceiptSummaries } = require("./fiscal-test-mode-store");
const { formatSentAtForDisplay } = require("./fiscal-time-sync");
const {
  t,
  tReceiptType,
  tPayment,
  syncLanguageFromSettings,
} = require("./fiscal-i18n");

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function statusLabel(row) {
  if (Number(row.is_offline) === 1) return t("status_offline");
  if (Number(row.sent_to_atk) === 1) return t("status_sent");
  return t("status_pending");
}

function typeLabel(type) {
  try {
    return tReceiptType(type) || String(type || "regular");
  } catch {
    const map = {
      regular: "i rregullt",
      cancel: "anulim",
      return: "kthim malli",
      storno: "storno",
    };
    return map[String(type || "").toLowerCase()] || String(type || "regular");
  }
}

function paymentLabel(method) {
  try {
    return tPayment(method) || String(method || "cash");
  } catch {
    return String(method || "cash");
  }
}

function stripEscMarkers(text) {
  return String(text || "")
    .replace(/\^B/g, "")
    .replace(/\^L/g, "")
    .replace(/\^C/g, "");
}

function mapListRow(row) {
  return {
    id: row.id,
    nuikf: row.nuikf,
    daily_number: row.daily_number,
    total_number: row.total_number,
    fiscal_date: row.fiscal_date,
    fiscal_time: row.fiscal_time,
    receipt_type: row.receipt_type,
    receipt_type_label: typeLabel(row.receipt_type),
    total_amount: Number(row.total_amount) || 0,
    payment_method: row.payment_method,
    payment_label: paymentLabel(row.payment_method),
    operator_name: row.operator_name,
    operator_id: row.operator_id,
    is_offline: Number(row.is_offline) === 1,
    sent_to_atk: Number(row.sent_to_atk) === 1,
    sent_at: formatSentAtForDisplay(row.sent_at, row.fiscal_date, row.fiscal_time),
    status: statusLabel(row),
    created_at: row.created_at,
  };
}

/**
 * Lista e kuponëve (më i riu lart).
 */
function listFiscalReceipts(limit = 500) {
  if (!isFiscalEnabled()) return null;

  try {
    const s = getFiscalSettings();
    syncLanguageFromSettings(s && s.language === "sr" ? "sr" : "sq");
  } catch {
    syncLanguageFromSettings();
  }

  const sqlite = getSqlite();
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
  const rows = sqlite
    .prepare(
      `SELECT id, nuikf, daily_number, total_number, fiscal_date, fiscal_time, receipt_type,
              total_amount, payment_method, operator_name, operator_id,
              is_offline, sent_to_atk, sent_at, created_at
       FROM fiscal_receipts
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(lim);

  let merged = rows;
  if (isFiscalMemoryOnly()) {
    const memRows = memListReceiptSummaries(lim);
    const seen = new Set(rows.map((r) => Number(r.id)));
    for (const row of memRows) {
      if (!seen.has(Number(row.id))) merged.push(row);
    }
    merged.sort((a, b) => Number(b.id) - Number(a.id));
    merged = merged.slice(0, lim);
  }

  return merged.map(mapListRow);
}

/**
 * Rigjeneron tekstin e kuponit nga rreshti WRITE-ONCE (pa INSERT të ri).
 * Ruhet NUIKF/SEF/numrat origjinale — nuk thërret generateNUIKF nëse NUIKF është valid.
 */
function buildFiscalReceiptTextFromRow(row) {
  const items = parseJson(row.items_json, []);
  const vatBreak = parseJson(row.vat_breakdown_json, {});

  const paymentSplits = parseJson(row.payment_splits_json, []);

  const orderData = {
    items: Array.isArray(items) ? items : [],
    operator_name: row.operator_name,
    operator_id: row.operator_id,
    payment_method: row.payment_method,
    payment_splits: Array.isArray(paymentSplits) ? paymentSplits : [],
    payment_splits_json: row.payment_splits_json,
    subtotal: row.subtotal,
    discount_amount: row.discount_amount,
    total_amount: row.total_amount,
    total_without_tax: row.total_without_tax,
    amount_paid: row.total_amount,
    is_offline: Number(row.is_offline) === 1,
  };

  let language = "sq";
  try {
    const s = getFiscalSettings();
    language = syncLanguageFromSettings(s && s.language === "sr" ? "sr" : "sq");
  } catch {
    language = syncLanguageFromSettings("sq");
  }

  const fiscalData = {
    taxpayer_legal_name: row.taxpayer_name,
    taxpayer_name: row.taxpayer_name,
    taxpayer_address: row.taxpayer_address,
    taxpayer_nui: row.taxpayer_nui,
    taxpayer_vat: row.taxpayer_vat,
    daily_number: row.daily_number,
    total_number: row.total_number,
    nuikf: row.nuikf,
    sef_id: row.sef_id,
    receipt_type: row.receipt_type,
    original_nuikf: row.original_nuikf,
    is_offline: Number(row.is_offline) === 1,
    fiscal_date: row.fiscal_date,
    fiscal_time: row.fiscal_time,
    vat_breakdown: vatBreak,
    payment_method: row.payment_method,
    payment_splits_json: row.payment_splits_json,
    language,
  };

  let text = generateFiscalReceipt(orderData, fiscalData);
  if (!text) {
    text =
      "NUIKF: " +
      (row.nuikf || "-") +
      "\nTotali: " +
      Number(row.total_amount || 0).toFixed(4) +
      " EUR\n";
  }
  return text;
}

/**
 * Shton shënimin e qartë "KOPJE E KUPONIT" (header pas emrit + footer).
 * Nuk ndryshon NUIKF / përmbajtjen fiskale — vetëm shënimi i kopjes.
 */
function markReceiptTextAsCopy(printText) {
  const banner = "^B^CKOPJE E KUPONIT";
  const rule = "^C==============================";
  const lines = String(printText || "").split(/\r?\n/);
  let first = 0;
  while (first < lines.length && !String(lines[first] || "").trim()) first += 1;
  if (first < lines.length) {
    lines.splice(first + 1, 0, banner, rule);
  } else {
    lines.unshift(banner, rule);
  }
  while (lines.length && !String(lines[lines.length - 1] || "").trim()) {
    lines.pop();
  }
  lines.push(rule, banner, "");
  return lines.join("\n");
}

/**
 * Teksti i plotë i kuponit (si do printohej), pa printim.
 */
function getFiscalReceiptPreview(id) {
  if (!isFiscalEnabled()) return null;

  const rid = Number(id);
  if (!Number.isFinite(rid) || rid < 1) {
    throw new Error("id i pavlefshëm");
  }

  const row = getFiscalReceiptById(rid);
  if (!row) {
    throw new Error("Kuponi nuk u gjet");
  }

  const text = buildFiscalReceiptTextFromRow(row);

  return {
    ...mapListRow(row),
    print_text: stripEscMarkers(text),
    sef_id: row.sef_id,
    taxpayer_name: row.taxpayer_name,
  };
}

function loadReceiptRow(id) {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }
  const rid = Number(id);
  if (!Number.isFinite(rid) || rid < 1) {
    throw new Error("id i pavlefshëm");
  }
  const row = getFiscalReceiptById(rid);
  if (!row) {
    throw new Error("Kuponi nuk u gjet");
  }
  return row;
}

/**
 * Reprint i kuponit origjinal (pa shënimin KOPJE) — PA INSERT të ri.
 */
function prepareFiscalReceiptReprint(id) {
  const row = loadReceiptRow(id);
  return {
    id: row.id,
    nuikf: row.nuikf,
    total_amount: Number(row.total_amount) || 0,
    fiscal_date: row.fiscal_date,
    fiscal_time: row.fiscal_time,
    taxpayer_nui: row.taxpayer_nui,
    print_text: buildFiscalReceiptTextFromRow(row),
    is_copy: false,
  };
}

/**
 * Përgatit kopjen e kuponit për printim — PA INSERT / PA kupon të ri fiskal.
 */
function prepareFiscalReceiptCopy(id) {
  const row = loadReceiptRow(id);
  const originalText = buildFiscalReceiptTextFromRow(row);
  const print_text = markReceiptTextAsCopy(originalText);
  return {
    id: row.id,
    nuikf: row.nuikf,
    total_amount: Number(row.total_amount) || 0,
    fiscal_date: row.fiscal_date,
    fiscal_time: row.fiscal_time,
    taxpayer_nui: row.taxpayer_nui,
    print_text,
    is_copy: true,
  };
}

module.exports = {
  listFiscalReceipts,
  getFiscalReceiptPreview,
  prepareFiscalReceiptCopy,
  prepareFiscalReceiptReprint,
  markReceiptTextAsCopy,
  statusLabel,
};
