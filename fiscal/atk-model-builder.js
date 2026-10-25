/**
 * fiscal/atk-model-builder.js — konverton fiscal_receipts → PosCoupon / CitizenCoupon (Protobuf ATK).
 * Vetëm strukturë / encode lokal. NUK dërgon te API ATK.
 */
const path = require("path");
const protobuf = require("protobufjs");
const { VAT_RATES, round4, lineTotalAmount, normalizeQty, normalizeUnitPrice } = require("./fiscal-vat");
const {
  resolveLineDiscountAmount,
  netLineAmount,
  computeCouponTotalDiscount,
} = require("./fiscal-line-discount");
const { lineAmountAfterCart } = require("./fiscal-vat");

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

/** Totalet / Payment / CouponItem.total — cent (€0.01) sipas ATK pos-golang. */
function toCents(eur) {
  const n = Number(eur);
  if (!Number.isFinite(n)) return 0;
  return Math.round(round4(n) * 100);
}

/** CouponItem.price — €0.0001 (4 presje) sipas ATK Important Notes. */
function toPriceUnits(eur) {
  const n = Number(eur);
  if (!Number.isFinite(n)) return 0;
  return Math.round(round4(n) * 10000);
}

function resolvePaymentSplits(row, opts = {}) {
  const sources = [
    opts && opts.payment_splits,
    row && row.payment_splits,
  ];
  for (const src of sources) {
    if (Array.isArray(src) && src.length) return src;
  }
  const jsonRaw =
    (opts && opts.payment_splits_json) ??
    (row && row.payment_splits_json) ??
    null;
  const parsed = parseJson(jsonRaw, null);
  if (Array.isArray(parsed) && parsed.length) return parsed;
  return null;
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
  const hhmmss = time.length === 5 ? `${time}:00` : time.length === 8 ? time : "00:00:00";
  // ATK / lokal: dd.mm.yyyy
  const dmy = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  let ms = NaN;
  if (dmy) {
    ms = Date.parse(`${dmy[3]}-${dmy[2]}-${dmy[1]}T${hhmmss}`);
  } else {
    ms = Date.parse(`${date}T${hhmmss}`);
  }
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

function couponLineNet(item) {
  return lineAmountAfterCart(item);
}

function buildCouponItems(items) {
  const { enrichItemsUnitCategory } = require("./fiscal-item-meta");
  const list = enrichItemsUnitCategory(Array.isArray(items) ? items : []);
  return list.map((item) => {
    const qty = normalizeQty(item.quantity ?? item.qty ?? 1);
    const lineDiscount = resolveLineDiscountAmount(item);
    const net = couponLineNet(item);
    const netUnit = qty > 0 ? round4(net / qty) : 0;
    const letter = itemLetter(item);
    return {
      name: String(item.name || item.emri || item.title || "").slice(0, 128),
      // ATK: price/total = neto pas zbritjes së rreshtit DHE pjesës së karrocës
      price: toPriceUnits(netUnit),
      unit: String(item.unit_code || item.unit || item.njesi || item.uom || "EA").slice(0, 32),
      quantity: qty,
      total: toCents(net),
      taxRate: letter,
      type: String(item.category_code || item.item_type || item.category || "TT").slice(0, 16),
      discount: toCents(lineDiscount),
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
    const gross = couponLineNet(item);
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

function buildPayments(row, opts = {}) {
  const totalCents = toCents(row.total_amount ?? row.total ?? 0);
  const splits = resolvePaymentSplits(row, opts);
  if (Array.isArray(splits) && splits.length) {
    const payments = [];
    for (const sp of splits) {
      if (!sp || typeof sp !== "object") continue;
      const amt = toCents(sp.amount ?? sp.value ?? 0);
      if (amt <= 0) continue;
      payments.push({
        type: mapPaymentType(sp.method ?? sp.payment_method ?? row.payment_method),
        amount: amt,
      });
    }
    if (payments.length) return payments;
  }
  return [
    {
      type: mapPaymentType(row.payment_method),
      amount: totalCents,
    },
  ];
}

function resolveIds(row, settings, opts) {
  // Prefero NUI aktual nga settings (regjistruar te ATK) — receipt mund të ketë NUI të vjetër/demo.
  const businessId = parseUint64(
    opts.businessId ?? settings.taxpayer_nui ?? row.taxpayer_nui,
    0
  );
  const posId = parseUint64(
    opts.posId ?? settings.pos_id ?? parsePosIdFromSef(row.sef_id),
    0
  );
  // ATK spec: CouponId unik biznesi = total_number (i njëjtë QR Citizen + POST Pos).
  const couponId = parseUint64(
    opts.couponId ?? row.total_number ?? row.id ?? row.sale_id,
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
 * Për CANCEL/RETURN: referenceNo = couponId (total_number) i kuponit origjinal.
 */
function resolveReferenceNo(receiptRow, opts = {}) {
  if (opts.referenceNo != null && opts.referenceNo !== "") {
    return parseUint64(opts.referenceNo, 0);
  }
  const couponType = mapCouponType(receiptRow.receipt_type);
  if (couponType !== "CANCEL" && couponType !== "RETURN") return 0;

  const origNuikf = String(receiptRow.original_nuikf || "").trim().toUpperCase();
  if (!origNuikf) return 0;

  try {
    const database = require("../database");
    const sqlite = database.db;
    if (!sqlite) return 0;
    const orig = sqlite
      .prepare(
        `SELECT total_number, daily_number, id FROM fiscal_receipts
         WHERE UPPER(nuikf) = ? ORDER BY id ASC LIMIT 1`,
      )
      .get(origNuikf);
    if (!orig) return 0;
    return parseUint64(orig.total_number, 0);
  } catch {
    return 0;
  }
}

/** Ops encode ATK — couponId = total_number (sinkron QR + POST). */
function resolveAtkCouponBuildOpts(receiptRow, opts = {}) {
  if (opts.couponId != null && opts.couponId !== "") {
    return opts;
  }
  const row = receiptRow && typeof receiptRow === "object" ? receiptRow : {};
  const couponId = parseUint64(row.total_number ?? row.id ?? 0, 0);
  return couponId > 0 ? { ...opts, couponId } : { ...opts };
}

/** Hiq discount (field 8) para serializimit — spec zyrtar ATK nuk e ka. */
function stripDiscountFromCouponItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const { discount, ...rest } = item;
    return rest;
  });
}

const ATK_CORRECTION_REF_ERROR =
  "Nuk mund të anulohet/kthehet kuponi — mungon referenca e kuponit origjinal.";

/** Bllokon dërgim CANCEL/RETURN te ATK pa ReferenceNo (total_number origjinal). */
function validateAtkReferenceForSend(receiptRow, opts = {}) {
  const couponType = mapCouponType(receiptRow?.receipt_type);
  if (couponType !== "CANCEL" && couponType !== "RETURN") {
    return { ok: true };
  }
  const refNo = resolveReferenceNo(receiptRow, opts);
  if (refNo > 0) {
    return { ok: true, referenceNo: refNo };
  }
  return { ok: false, error: ATK_CORRECTION_REF_ERROR };
}

/**
 * Ndërton objekt plain PosCoupon nga rreshti fiscal_receipts (+ opts opsionale).
 */
function buildPosCoupon(receiptRow, opts = {}) {
  if (!receiptRow || typeof receiptRow !== "object") {
    throw new Error("buildPosCoupon: mungon receiptRow");
  }
  const settings = resolveSettings(opts);
  const { enrichItemsUnitCategory } = require("./fiscal-item-meta");
  const items = enrichItemsUnitCategory(parseJson(receiptRow.items_json, []));
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
    payments: buildPayments(receiptRow, opts),
    total,
    taxGroups,
    totalTax,
    totalNoTax,
    referenceNo: resolveReferenceNo(receiptRow, opts),
    transactionNo: parseUint64(opts.transactionNo ?? receiptRow.sale_id ?? 0, 0),
    totalDiscount: toCents(
      opts.totalDiscount ??
        computeCouponTotalDiscount(receiptRow, items)
    ),
  };
}

/**
 * Ndërton objekt plain CitizenCoupon (nënshkrim QR / verifikim qytetar).
 */
function buildCitizenCoupon(receiptRow, opts = {}) {
  const pos = buildPosCoupon(receiptRow, resolveAtkCouponBuildOpts(receiptRow, opts));
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
  const payload = buildPosCoupon(receiptRow, resolveAtkCouponBuildOpts(receiptRow, opts));
  payload.items = stripDiscountFromCouponItems(payload.items);
  const message = Type.fromObject(payload);
  const err = Type.verify(message);
  if (err) throw new Error("PosCoupon invalid: " + err);
  return Type.encode(message).finish();
}

/** Encode CitizenCoupon → Buffer (Protobuf binary). */
function encodeCitizenCoupon(receiptRow, opts = {}) {
  const Type = getCitizenCouponType();
  const payload = buildCitizenCoupon(
    receiptRow,
    resolveAtkCouponBuildOpts(receiptRow, opts)
  );
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
  buildCouponItems,
  buildPosCoupon,
  buildCitizenCoupon,
  encodePosCoupon,
  encodeCitizenCoupon,
  mapCouponType,
  mapPaymentType,
  buildPayments,
  resolvePaymentSplits,
  resolveAtkCouponBuildOpts,
  stripDiscountFromCouponItems,
  validateAtkReferenceForSend,
  resolveReferenceNo,
  ATK_CORRECTION_REF_ERROR,
  toCents,
  toPriceUnits,
  computeCouponTotalDiscount,
};
