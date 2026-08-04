/**
 * fiscal/fiscal-correction.js — HAPI 7: kuponë korrigjues (cancel/return/storno).
 * WRITE-ONCE: vetëm INSERT në fiscal_receipts. Thirret kur isFiscalEnabled()=true.
 */
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const {
  generateNUIKF,
  getSefIdentifier,
  getNextDailyNumber,
  getNextTotalNumber,
} = require("./fiscal-numbering");
const { generateFiscalReceipt } = require("./fiscal-print");
const { syncLanguageFromSettings } = require("./fiscal-i18n");
const { calculateVatBreakdown, calculateVatTaxBreakdown } = require("./fiscal-vat");
const { logFiscalAction } = require("./fiscal-audit");
const { insertFiscalReceipt } = require("./fiscal-db");

const CORRECTION_TYPES = Object.freeze(["cancel", "return", "storno"]);

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function assertFiscalOn() {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është i aktivizuar");
  }
}

function todayParts() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return {
    fiscal_date: `${dd}.${mm}.${yyyy}`,
    fiscal_time: `${hh}:${mi}`,
  };
}

function parseItemsJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch {
    return [];
  }
}

function normalizeItem(item) {
  return {
    name: String(item.name || item.emri || "-").trim(),
    quantity: Number(item.quantity ?? item.qty ?? 1) || 0,
    qty: Number(item.quantity ?? item.qty ?? 1) || 0,
    price: Number(item.price ?? item.unit_price ?? item.cmimi ?? 0) || 0,
    unit_price: Number(item.unit_price ?? item.price ?? item.cmimi ?? 0) || 0,
    vat_norm: String(item.vat_norm || item.vat_letter || "E")
      .trim()
      .toUpperCase(),
    menu_item_id: item.menu_item_id ?? item.id ?? null,
  };
}

function lineGross(item) {
  const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
  const price = Number(item.unit_price ?? item.price ?? 0) || 0;
  return qty * price;
}

function sumItems(items) {
  return (items || []).reduce((s, it) => s + lineGross(it), 0);
}

function computeTaxBreakdownFromGross(items, totalAmount) {
  const result = calculateVatTaxBreakdown(items, {
    totalAmount: totalAmount != null ? Number(totalAmount) : undefined,
  });
  if (result && result.tax) return result.tax;
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function rowToReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    sale_id: row.sale_id,
    nuikf: row.nuikf,
    sef_id: row.sef_id,
    receipt_type: row.receipt_type,
    original_nuikf: row.original_nuikf,
    daily_number: row.daily_number,
    fiscal_date: row.fiscal_date,
    fiscal_time: row.fiscal_time,
    operator_name: row.operator_name,
    operator_id: row.operator_id,
    taxpayer_nui: row.taxpayer_nui,
    taxpayer_vat: row.taxpayer_vat,
    taxpayer_name: row.taxpayer_name,
    taxpayer_address: row.taxpayer_address,
    items: parseItemsJson(row.items_json),
    items_json: row.items_json,
    subtotal: row.subtotal,
    discount_amount: row.discount_amount,
    total_amount: row.total_amount,
    total_without_tax: row.total_without_tax,
    vat_breakdown: (() => {
      try {
        return JSON.parse(row.vat_breakdown_json || "{}");
      } catch {
        return {};
      }
    })(),
    payment_method: row.payment_method,
    currency: row.currency || "EUR",
    qr_code_data: row.qr_code_data,
    is_offline: !!row.is_offline,
    sent_to_atk: !!row.sent_to_atk,
    created_at: row.created_at,
    correction_reason: (() => {
      try {
        const q = JSON.parse(row.qr_code_data || "{}");
        return q && q.correction_reason ? String(q.correction_reason) : "";
      } catch {
        return "";
      }
    })(),
  };
}

/**
 * Kupon origjinal sipas NUIKF.
 */
function getOriginalReceipt(nuikf) {
  assertFiscalOn();
  const key = String(nuikf || "")
    .trim()
    .toUpperCase();
  if (!key) return null;

  const sqlite = getSqlite();
  const row = sqlite
    .prepare(
      `SELECT * FROM fiscal_receipts
       WHERE UPPER(nuikf) = ? AND receipt_type = 'regular'
       LIMIT 1`
    )
    .get(key);
  return rowToReceipt(row);
}

/**
 * A ka tashmë kupon korrigjues për këtë NUIKF origjinal?
 */
function hasCorrection(nuikf) {
  assertFiscalOn();
  const key = String(nuikf || "")
    .trim()
    .toUpperCase();
  if (!key) return false;

  const sqlite = getSqlite();
  const row = sqlite
    .prepare(
      `SELECT 1 AS ok FROM fiscal_receipts
       WHERE UPPER(original_nuikf) = ?
         AND receipt_type IN ('cancel','return','storno')
       LIMIT 1`
    )
    .get(key);
  return !!row;
}

/**
 * Lista e kuponëve korrigjues për një NUIKF origjinal.
 */
function getCorrectionHistory(nuikf) {
  assertFiscalOn();
  const key = String(nuikf || "")
    .trim()
    .toUpperCase();
  if (!key) return [];

  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      `SELECT * FROM fiscal_receipts
       WHERE UPPER(original_nuikf) = ?
         AND receipt_type IN ('cancel','return','storno')
       ORDER BY id ASC`
    )
    .all(key);
  return rows.map(rowToReceipt);
}

/**
 * Krijon kupon korrigjues (INSERT write-once) dhe kthen objektin + print_text.
 */
function createCorrectionReceipt(originalNuikf, correctionType, items, reason, opts = {}) {
  assertFiscalOn();

  const type = String(correctionType || "")
    .trim()
    .toLowerCase();
  if (!CORRECTION_TYPES.includes(type)) {
    throw new Error("Tipi i korrigjimit duhet të jetë cancel, return ose storno");
  }

  const original = getOriginalReceipt(originalNuikf);
  if (!original) {
    throw new Error("Kuponi origjinal nuk u gjet (vetëm kuponë regular)");
  }

  if ((type === "cancel" || type === "storno") && hasCorrection(original.nuikf)) {
    throw new Error("Ky kupon ka tashmë korrigjim — anulimi/storno nuk lejohet përsëri");
  }

  const originalItems = (original.items || []).map(normalizeItem);
  let correctionItems;

  if (type === "return") {
    const selected = Array.isArray(items) ? items.map(normalizeItem) : [];
    if (!selected.length) {
      throw new Error("Për kthim malli zgjidhni të paktën një artikull");
    }
    // Validim: sasia ≤ origjinale (sipas emrit+çmimit)
    for (const sel of selected) {
      if (sel.quantity <= 0) {
        throw new Error(`Sasia e pavlefshme për: ${sel.name}`);
      }
      const match = originalItems.find(
        (o) =>
          o.name === sel.name &&
          Math.abs(o.price - sel.price) < 0.0001
      );
      if (!match) {
        throw new Error(`Artikulli nuk është në kuponin origjinal: ${sel.name}`);
      }
      if (sel.quantity > match.quantity + 1e-9) {
        throw new Error(`Sasia e kthimit tejkalon origjinalin për: ${sel.name}`);
      }
    }
    correctionItems = selected;
  } else {
    // cancel / storno — krejt artikujt e origjinalit
    correctionItems = originalItems.map((it) => ({ ...it }));
  }

  const settings = getFiscalSettings();
  const subtotal = Math.round(sumItems(correctionItems) * 100) / 100;
  const discount = 0;
  const totalAmount = subtotal;
  const taxResult = calculateVatTaxBreakdown(correctionItems, {
    totalAmount,
  }) || {
    tax: computeTaxBreakdownFromGross(correctionItems, totalAmount),
    totalTax: 0,
    totalWithoutTax: totalAmount,
  };
  const vatBreak = taxResult.tax;
  const totalTax = Number(taxResult.totalTax) || 0;
  const totalWithoutTax =
    taxResult.totalWithoutTax != null
      ? Number(taxResult.totalWithoutTax)
      : Math.round((totalAmount - totalTax) * 100) / 100;

  // turnover breakdown (për referencë); printi përdor vat_breakdown tatim
  try {
    calculateVatBreakdown(correctionItems);
  } catch {
    /* ignore */
  }

  const nuikf = generateNUIKF();
  if (!nuikf) throw new Error("Nuk u gjenerua NUIKF");
  const sefId = getSefIdentifier() || original.sef_id || "";
  const dailyNumber = getNextDailyNumber();
  const totalNumber = getNextTotalNumber();
  if (dailyNumber == null || totalNumber == null) {
    throw new Error("Nuk u gjenerua numri ditor/total");
  }

  const { fiscal_date, fiscal_time } = todayParts();
  const operatorName =
    String(opts.operator_name || opts.waiter_name || "Pronari").trim() || "Pronari";
  const operatorId = String(opts.operator_id || "OWNER").trim() || "OWNER";
  const reasonText = String(reason || "").trim();

  const taxpayerNui =
    original.taxpayer_nui || settings.taxpayer_nui || settings.developer_nui || "";
  const taxpayerVat =
    original.taxpayer_vat || settings.taxpayer_vat_number || "";
  const taxpayerName =
    original.taxpayer_name || settings.taxpayer_legal_name || "Biznesi";
  const taxpayerAddress =
    original.taxpayer_address || settings.taxpayer_address || "";
  const unitName = settings.unit_name || "";
  const unitPhone = settings.unit_phone || "";

  const qrPayload = JSON.stringify({
    placeholder: true,
    hapi: 8,
    correction_reason: reasonText,
  });

  const itemsJson = JSON.stringify(correctionItems);
  const vatJson = JSON.stringify(vatBreak);

  const insertedId = insertFiscalReceipt({
    sale_id: original.sale_id || 0,
    nuikf,
    sef_id: sefId,
    receipt_type: type,
    original_nuikf: original.nuikf,
    daily_number: dailyNumber,
    total_number: totalNumber,
    fiscal_date,
    fiscal_time,
    operator_name: operatorName,
    operator_id: operatorId,
    taxpayer_nui: taxpayerNui,
    taxpayer_vat: taxpayerVat || null,
    taxpayer_name: taxpayerName,
    taxpayer_address: taxpayerAddress,
    items_json: itemsJson,
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    vat_breakdown_json: vatJson,
    payment_method: original.payment_method || "cash",
    currency: "EUR",
    qr_code_data: qrPayload,
    digital_signature: null,
    is_offline: 0,
    sent_to_atk: 0,
  });

  const orderData = {
    items: correctionItems,
    operator_name: operatorName,
    operator_id: operatorId,
    payment_method: original.payment_method || "cash",
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    amount_paid: totalAmount,
  };

  let language = "sq";
  try {
    const s = getFiscalSettings();
    language = syncLanguageFromSettings(s && s.language === "sr" ? "sr" : "sq");
  } catch {
    language = syncLanguageFromSettings("sq");
  }

  const fiscalData = {
    taxpayer_legal_name: taxpayerName,
    taxpayer_address: taxpayerAddress,
    taxpayer_nui: taxpayerNui,
    taxpayer_vat: taxpayerVat,
    unit_name: unitName,
    unit_phone: unitPhone,
    daily_number: dailyNumber,
    total_number: totalNumber,
    nuikf,
    sef_id: sefId,
    receipt_type: type,
    original_nuikf: original.nuikf,
    correction_reason: reasonText,
    is_offline: false,
    fiscal_date,
    fiscal_time,
    vat_breakdown: vatBreak,
    language,
  };

  const printText = generateFiscalReceipt(orderData, fiscalData);

  try {
    logFiscalAction(
      "correction_created",
      {
        nuikf,
        original_nuikf: original.nuikf,
        receipt_type: type,
        reason: reasonText,
        total: totalAmount,
      },
      operatorName,
      operatorId
    );
  } catch (e) {
    console.warn("[fiscal-correction] audit:", e.message);
  }

  return {
    id: insertedId,
    nuikf,
    sef_id: sefId,
    receipt_type: type,
    original_nuikf: original.nuikf,
    daily_number: dailyNumber,
    fiscal_date,
    fiscal_time,
    operator_name: operatorName,
    operator_id: operatorId,
    items: correctionItems,
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    vat_breakdown: vatBreak,
    payment_method: original.payment_method || "cash",
    currency: "EUR",
    correction_reason: reasonText,
    sent_to_atk: false,
    print_text: printText,
  };
}

module.exports = {
  CORRECTION_TYPES,
  getOriginalReceipt,
  hasCorrection,
  getCorrectionHistory,
  createCorrectionReceipt,
};
