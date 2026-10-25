/**
 * fiscal/fiscal-test-coupon-data.js — Hapi 3: kupon provë me ≥5 artikuj.
 * Testim i brendshëm i modulit fiskal — PA dërgim HTTP te serveri ATK.
 * Çmimet dhe sasitë ruhen me 4 presje (Neni 25); printimi vizual mbetet 2 presje.
 */
const {
  round4,
  lineTotalAmount,
  normalizeQty,
  normalizeUnitPrice,
  calculateVatBreakdown,
  calculateVatTaxBreakdown,
  formatUnitPrice,
  FISCAL_DECIMAL_PLACES,
} = require("./fiscal-vat");

const MIN_ATK_TEST_ITEMS = 5;
/** Alias — e njëjta kufi për testimin e brendshëm */
const MIN_INTERNAL_TEST_ITEMS = MIN_ATK_TEST_ITEMS;

/**
 * Katalog i artikujve provë — burim i vetëm për kuponët testues (print + self-test).
 * Norma D/E, sasi dhe çmime me deri 4 presje.
 */
const ATK_TEST_COUPON_CATALOG = Object.freeze([
  { name: "Kafe Espresso", qty: 1.25, unit_price: 1.2345, vat_norm: "D" },
  { name: "Uje mineral 0.5L", qty: 2.5, unit_price: 0.875, vat_norm: "D" },
  { name: "Croissant", qty: 1, unit_price: 1.875, vat_norm: "E" },
  { name: "Sallam i thate", qty: 0.75, unit_price: 3.4567, vat_norm: "E" },
  { name: "Leng portokalli", qty: 3, unit_price: 1.1111, vat_norm: "E" },
]);

/** Kontrollon që vlera ka max 4 presje dhjetore (para round4). */
function assertMaxFourDecimals(value, label) {
  const s = String(value);
  const dot = s.indexOf(".");
  if (dot === -1) return;
  const frac = s.slice(dot + 1);
  if (frac.length > FISCAL_DECIMAL_PLACES) {
    throw new Error(
      `${label}: max ${FISCAL_DECIMAL_PLACES} presje, morëm "${s}"`
    );
  }
}

function buildTestCouponItem(raw) {
  assertMaxFourDecimals(raw.qty ?? raw.quantity ?? 1, "sasia");
  assertMaxFourDecimals(raw.unit_price ?? raw.price ?? 0, "çmimi");
  const qty = normalizeQty(raw.qty ?? raw.quantity ?? 1);
  const unit_price = normalizeUnitPrice({ unit_price: raw.unit_price ?? raw.price });
  const letter = String(raw.vat_norm || raw.vat_letter || "E")
    .trim()
    .toUpperCase();
  return {
    name: String(raw.name || "-").trim(),
    qty,
    quantity: qty,
    unit_price,
    price: unit_price,
    vat_norm: letter,
    vat_letter: letter,
    __internal_test_coupon__: true,
    __atk_test_coupon__: true,
  };
}

function assertMinAtkTestItems(items) {
  const n = Array.isArray(items) ? items.length : 0;
  if (n < MIN_ATK_TEST_ITEMS) {
    throw new Error(
      `Kupon provë: duhen min ${MIN_ATK_TEST_ITEMS} artikuj, morëm ${n}`
    );
  }
}

/** Validon strukturën e kuponit test (≥5 artikuj unikë, 4 dec, totalet). */
function validateInternalTestCouponStructure(items) {
  const list = Array.isArray(items) ? items : [];
  assertMinAtkTestItems(list);
  const names = new Set();
  for (const it of list) {
    const name = String(it.name || "").trim();
    if (!name) throw new Error("Kupon provë: artikull pa emër");
    names.add(name);
    const qty = normalizeQty(it.qty ?? it.quantity);
    const unit = normalizeUnitPrice(it);
    if (Math.abs(qty - round4(qty)) > 0.00005) {
      throw new Error(`Kupon provë: sasia jo 4-dec për ${name}`);
    }
    if (Math.abs(unit - round4(unit)) > 0.00005) {
      throw new Error(`Kupon provë: çmimi jo 4-dec për ${name}`);
    }
  }
  if (names.size < MIN_INTERNAL_TEST_ITEMS) {
    throw new Error(
      `Kupon provë: duhen ${MIN_INTERNAL_TEST_ITEMS} emra unikë, morëm ${names.size}`
    );
  }
  const totals = computeAtkTestCouponTotals(list);
  return {
    ok: true,
    itemCount: list.length,
    uniqueNames: names.size,
    total: totals.total,
    totalWithoutTax: totals.totalWithoutTax,
    lineTotals: totals.lineTotals,
  };
}

/** Artikujt normalizuar (4 dec) — printTestFiscalCoupon + self-test. */
function getAtkTestCouponItems() {
  return ATK_TEST_COUPON_CATALOG.map(buildTestCouponItem);
}

/** Alias — testim i brendshëm, pa ATK HTTP */
function getInternalTestCouponItems() {
  return getAtkTestCouponItems();
}

function computeAtkTestCouponTotals(items) {
  const list = Array.isArray(items) ? items : [];
  assertMinAtkTestItems(list);

  const lineTotals = list.map((it) => ({
    item: it,
    lineTotal: lineTotalAmount(it.qty ?? it.quantity, it.unit_price),
  }));
  const total = round4(lineTotals.reduce((s, x) => s + x.lineTotal, 0));
  const vatBreak = calculateVatBreakdown(list) || {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };
  const taxResult = calculateVatTaxBreakdown(list, { totalAmount: total });

  return {
    items: list,
    lineTotals,
    total,
    vatBreak,
    tax: taxResult?.tax || { A: 0, B: 0, C: 0, D: 0, E: 0 },
    totalTax: taxResult?.totalTax ?? 0,
    totalWithoutTax:
      taxResult?.totalWithoutTax ?? round4(total - (taxResult?.totalTax ?? 0)),
  };
}

/** 2 presje — për të verifikuar tekstin e printuar (fiscal-print.js). */
function formatUnitPricePrintCheck(price) {
  const n = Math.round(round4(price) * 100) / 100;
  return n.toFixed(2);
}

function buildAtkTestOrderData(opts = {}) {
  const items = opts.items || getAtkTestCouponItems();
  validateInternalTestCouponStructure(items);
  const totals = computeAtkTestCouponTotals(items);
  return {
    items: totals.items,
    operator_name: opts.operator_name || "Prove",
    operator_id: opts.operator_id || "0",
    payment_method: opts.payment_method || "cash",
    subtotal: totals.total,
    total_amount: totals.total,
    total_without_tax: totals.totalWithoutTax,
    amount_paid:
      opts.amount_paid != null ? round4(opts.amount_paid) : totals.total,
  };
}

/**
 * Paketë e plotë për testim lokal — orderData + fiscalMeta + totalet.
 * Nuk thërret fiscal-atk-api dhe nuk bën HTTP te ATK.
 */
function buildInternalTestCouponBundle(settings = {}, opts = {}) {
  const items = opts.items || getInternalTestCouponItems();
  validateInternalTestCouponStructure(items);
  const totals = computeAtkTestCouponTotals(items);
  const orderData = buildAtkTestOrderData({
    items,
    operator_name: opts.operator_name || "Prove",
    operator_id: opts.operator_id || "0",
    payment_method: opts.payment_method || "cash",
    amount_paid: opts.amount_paid,
  });
  const fiscalMeta = {
    taxpayer_nui: settings.taxpayer_nui || opts.taxpayer_nui || "123456789",
    taxpayer_name:
      settings.taxpayer_legal_name || opts.taxpayer_legal_name || "Test Biznes",
    taxpayer_legal_name:
      settings.taxpayer_legal_name || opts.taxpayer_legal_name || "Test Biznes",
    taxpayer_address: settings.taxpayer_address || opts.taxpayer_address || "Prishtine",
    taxpayer_vat: settings.taxpayer_vat_number || opts.taxpayer_vat || "",
    unit_name: settings.unit_name || opts.unit_name || "Njësia Test",
    unit_phone: settings.unit_phone || opts.unit_phone || "044 111 222",
    daily_number: opts.daily_number != null ? opts.daily_number : 1,
    total_number: opts.total_number != null ? opts.total_number : 42,
    nuikf: opts.nuikf || "TESTNUIKF0000001",
    receipt_type: opts.receipt_type || "regular",
    is_offline: !!opts.is_offline,
    fiscal_date: opts.fiscal_date || "18.07.2026",
    fiscal_time: opts.fiscal_time || "12:00",
    vat_breakdown: totals.tax,
  };
  return { items, totals, orderData, fiscalMeta };
}

module.exports = {
  MIN_ATK_TEST_ITEMS,
  MIN_INTERNAL_TEST_ITEMS,
  ATK_TEST_COUPON_CATALOG,
  getAtkTestCouponItems,
  getInternalTestCouponItems,
  buildTestCouponItem,
  assertMinAtkTestItems,
  validateInternalTestCouponStructure,
  computeAtkTestCouponTotals,
  buildAtkTestOrderData,
  buildInternalTestCouponBundle,
  formatUnitPricePrintCheck,
  formatUnitPrice,
};
