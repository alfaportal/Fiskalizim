/**
 * fiscal/atk-model-builder.js — konverton fiscal_receipts → PosCoupon / CitizenCoupon (Protobuf ATK).
 * Vetëm strukturë / encode lokal. NUK dërgon te API ATK.
 */
const path = require("path");
const protobuf = require("protobufjs");
const { VAT_RATES } = require("./fiscal-vat");

const PROTO_PATH = path.join(__dirname, "atk-models.proto");

function vatRatePct(letter) {
  const key = String(letter || "").trim().toUpperCase();
  if (key in VAT_RATES) return Number(VAT_RATES[key]) || 0;
  return 0;
}

let _root = null;
let _PosCoupon = null;
let _CitizenCoupon = null;

function loadTypes() {
  if (_root) return;
  _root = protobuf.loadSync(PROTO_PATH);
  _PosCoupon = _root.lookupType("atk.PosCoupon");
  _CitizenCoupon = _root.lookupType("atk.CitizenCoupon");
}

function getPosCouponType() {
  loadTypes();
  return _PosCoupon;
}

function getCitizenCouponType() {
  loadTypes();
  return _CitizenCoupon;
}

function toCents(eur) {
  const n = Number(eur);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function parseUint64(raw, fallback = 0) {
  if (raw == null || raw === "") return fallback;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return fallback;
  const n = Number(digits);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function itemLetter(item) {
  if (!item || typeof item !== "object") return "E";
  const raw =
    item.vat_norm ?? item.vat_letter ?? item.vatNorm ?? item.vatLetter ?? null;
  if (raw != null && String(raw).trim() !== "") {
    const letter = String(raw).trim().toUpperCase();
    if (["A", "B", "C", "D", "E"].includes(letter)) return letter;
  }
  const rate = item.vat_rate ?? item.vat_percent ?? item.vatPercent ?? null;
  if (rate != null && rate !== "") {
    const r = Number(rate);
    if (r === 0) return "A";
    if (r === 8) return "D";
    if (r === 18) return "E";
    return "C";
  }
  return "E";
}

function mapCouponType(receiptType) {
  const t = String(receiptType || "regular")
    .trim()
    .toLowerCase();
  if (t === "cancel" || t === "cancelled" || t === "anulim") return "CANCEL";
  if (t === "return" || t === "storno" || t === "refund") return "RETURN";
  return "SALE";
}

function mapPaymentType(paymentMethod) {
  const v = String(paymentMethod || "cash")
    .trim()
    .toLowerCase();
  if (v === "cash" || v === "gotovina") return "CASH";
  if (
    v === "credit_card" ||
    v === "debit_card" ||
    v === "karte" ||
    v === "kartë" ||
    v === "card"
  ) {
    return "CREDIT_CARD";
  }
  if (v === "voucher" || v === "vaucer") return "VOUCHER";
  if (v === "check" || v === "cheque" || v === "cek" || v === "çek") {
    return "CHEQUE";
  }
  if (v === "crypto" || v === "cryptocurrency") return "CRYPTOCURRENCY";
  return "OTHER";
}

function parsePosIdFromSef(sefId) {
  const parts = String(sefId || "").split("-");
  if (parts.length >= 3) {
    return parseUint64(parts[parts.length - 1], 0);
  }
  return 0;
}

function fiscalUnixTime(row) {
  const date = String(row.fiscal_date || "").trim();
  const time = String(row.fiscal_time || "00:00").trim();
  if (!date) return Math.floor(Date.now() / 1000);
  const iso = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

function resolveSettings(opts) {
  if (opts && opts.settings && typeof opts.settings === "object") {
    return opts.settings;
  }
  try {
    return require("./fiscal-config").getFiscalSettings();
  } catch {
    return {};
  }
}

function buildCouponItems(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => {
    const qty = Number(item.quantity ?? item.qty ?? 1) || 0;
    const unitPrice = Number(
      item.unit_price ?? item.unitPrice ?? item.price ?? item.cmimi ?? 0
    );
    const lineTotal =
      item.total != null || item.line_total != null
        ? Number(item.total ?? item.line_total)
        : qty * (Number.isFinite(unitPrice) ? unitPrice : 0);
    const letter = itemLetter(item);
    return {
      name: String(item.name || item.emri || item.title || "").slice(0, 128),
      price: toCents(unitPrice),
      unit: String(item.unit || item.njesi || item.uom || "cope").slice(0, 32),
      quantity: qty,
      total: toCents(lineTotal),
      taxRate: letter,
      type: String(item.item_type || item.type || "TT").slice(0, 16),
    };
  });
}

function buildTaxGroups(items, vatBreakdown) {
  const breakdown =
    vatBreakdown && typeof vatBreakdown === "object" ? vatBreakdown : {};
  const netByLetter = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const taxByLetter = { A: 0, B: 0, C: 0, D: 0, E: 0 };

  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const letter = itemLetter(item);
    const qty = Number(item.quantity ?? item.qty ?? 1) || 0;
    const unitPrice = Number(
      item.unit_price ?? item.unitPrice ?? item.price ?? item.cmimi ?? 0
    );
    const gross =
      item.total != null || item.line_total != null
        ? Number(item.total ?? item.line_total)
        : qty * (Number.isFinite(unitPrice) ? unitPrice : 0);
    const r = vatRatePct(letter);
    const tax = r > 0 ? (gross * r) / (100 + r) : 0;
    const net = gross - tax;
    netByLetter[letter] = (netByLetter[letter] || 0) + net;
    taxByLetter[letter] = (taxByLetter[letter] || 0) + tax;
  }

  for (const letter of ["A", "B", "C", "D", "E"]) {
    if (breakdown[letter] != null && Number(breakdown[letter]) !== 0) {
      taxByLetter[letter] = Number(breakdown[letter]) || 0;
    }
  }

  const groups = [];
  for (const letter of ["A", "C", "D", "E"]) {
    const totalTax = toCents(taxByLetter[letter] || 0);
    const totalForTax = toCents(netByLetter[letter] || 0);
    if (totalTax === 0 && totalForTax === 0) continue;
    groups.push({ taxRate: letter, totalForTax, totalTax });
  }
  return groups;
}

function buildPayments(row) {
  const amount = toCents(row.total_amount ?? row.total ?? 0);
  return [
    {
      type: mapPaymentType(row.payment_method),
      amount,
    },
  ];
}

function resolveIds(row, settings, opts) {
  const businessId = parseUint64(
    opts.businessId ?? row.taxpayer_nui ?? settings.taxpayer_nui,
    0
  );
  const posId = parseUint64(
    opts.posId ?? settings.pos_id ?? parsePosIdFromSef(row.sef_id),
    0
  );
  const couponId = parseUint64(
    opts.couponId ?? row.daily_number ?? row.id ?? row.sale_id,
    0
  );
  const branchId = parseUint64(
    opts.branchId ?? settings.business_unit_number ?? 1,
    1
  );
  const applicationId = parseUint64(
    opts.applicationId ?? settings.application_id ?? 0,
    0
  );
  const verificationNo = String(
    opts.verificationNo ?? row.nuikf ?? ""
  )
    .trim()
    .toUpperCase()
    .slice(0, 16);
  return {
    businessId,
    posId,
    couponId,
    branchId,
    applicationId,
    verificationNo,
  };
}

/**
 * Ndërton objekt plain PosCoupon nga rreshti fiscal_receipts (+ opts opsionale).
 */
function buildPosCoupon(receiptRow, opts = {}) {
  if (!receiptRow || typeof receiptRow !== "object") {
    throw new Error("buildPosCoupon: mungon receiptRow");
  }
  const settings = resolveSettings(opts);
  const items = parseJson(receiptRow.items_json, []);
  const vatBreakdown = parseJson(receiptRow.vat_breakdown_json, {});
  const ids = resolveIds(receiptRow, settings, opts);
  const taxGroups = buildTaxGroups(items, vatBreakdown);
  const total = toCents(receiptRow.total_amount ?? receiptRow.total ?? 0);
  const totalTaxFromGroups = taxGroups.reduce((s, g) => s + (g.totalTax || 0), 0);
  const totalTax =
    receiptRow.total_amount != null && receiptRow.total_without_tax != null
      ? toCents(
          Number(receiptRow.total_amount) - Number(receiptRow.total_without_tax)
        )
      : totalTaxFromGroups;
  const totalNoTax =
    receiptRow.total_without_tax != null
      ? toCents(receiptRow.total_without_tax)
      : Math.max(0, total - totalTax);

  return {
    businessId: ids.businessId,
    couponId: ids.couponId,
    branchId: ids.branchId,
    location: String(
      opts.location ?? receiptRow.taxpayer_address ?? settings.taxpayer_address ?? ""
    ).slice(0, 256),
    operatorId: String(
      opts.operatorId ?? receiptRow.operator_id ?? ""
    ).slice(0, 64),
    posId: ids.posId,
    applicationId: ids.applicationId,
    verificationNo: ids.verificationNo,
    type: mapCouponType(receiptRow.receipt_type),
    time: opts.time != null ? Number(opts.time) : fiscalUnixTime(receiptRow),
    items: buildCouponItems(items),
    payments: buildPayments(receiptRow),
    total,
    taxGroups,
    totalTax,
    totalNoTax,
    referenceNo: parseUint64(opts.referenceNo ?? 0, 0),
    transactionNo: parseUint64(opts.transactionNo ?? receiptRow.sale_id ?? 0, 0),
    totalDiscount: toCents(
      opts.totalDiscount ?? receiptRow.discount_amount ?? 0
    ),
  };
}

/**
 * Ndërton objekt plain CitizenCoupon (nënshkrim QR / verifikim qytetar).
 */
function buildCitizenCoupon(receiptRow, opts = {}) {
  const pos = buildPosCoupon(receiptRow, opts);
  return {
    businessId: pos.businessId,
    couponId: pos.couponId,
    branchId: pos.branchId,
    posId: pos.posId,
    verificationNo: pos.verificationNo,
    type: pos.type,
    time: pos.time,
    total: pos.total,
    taxGroups: pos.taxGroups,
    totalTax: pos.totalTax,
    totalNoTax: pos.totalNoTax,
  };
}

/** Encode PosCoupon → Buffer (Protobuf binary). */
function encodePosCoupon(receiptRow, opts = {}) {
  const Type = getPosCouponType();
  const payload = buildPosCoupon(receiptRow, opts);
  const message = Type.fromObject(payload);
  const err = Type.verify(message);
  if (err) throw new Error("PosCoupon invalid: " + err);
  return Type.encode(message).finish();
}

/** Encode CitizenCoupon → Buffer (Protobuf binary). */
function encodeCitizenCoupon(receiptRow, opts = {}) {
  const Type = getCitizenCouponType();
  const payload = buildCitizenCoupon(receiptRow, opts);
  const message = Type.fromObject(payload);
  const err = Type.verify(message);
  if (err) throw new Error("CitizenCoupon invalid: " + err);
  return Type.encode(message).finish();
}

module.exports = {
  PROTO_PATH,
  loadTypes,
  getPosCouponType,
  getCitizenCouponType,
  buildPosCoupon,
  buildCitizenCoupon,
  encodePosCoupon,
  encodeCitizenCoupon,
  mapCouponType,
  mapPaymentType,
  toCents,
};
