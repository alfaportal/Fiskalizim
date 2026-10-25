/**
 * fiscal/fiscal-vat.js — HAPI 3: normat TVSH me shkronja (A/B/C/D/E).
 * Hapi 2: çmimet, sasitë dhe totalet me 4 presje dhjetore (Neni 25 / ATK).
 *
 * Residual rounding (last/largest group): pas rrumbullakimit 4-dec të çdo
 * grupi, kompenson diferencën që shuma e TVSH + Total pa TVSH = Total ekzakt.
 */
const { isFiscalEnabled } = require("./fiscal-config");

function netLineAmountSafe(item) {
  const { netLineAmount } = require("./fiscal-line-discount");
  return netLineAmount(item);
}

/** Valuta fiskale — gjithmonë EUR */
const CURRENCY = "EUR";

/** Presje dhjetore fiskale (Hapi 2) */
const FISCAL_DECIMAL_PLACES = 4;
const FISCAL_DECIMAL_FACTOR = 10000;

/** Norma TVSH: shkronjë → përqindje */
const VAT_RATES = Object.freeze({
  A: 0,
  B: 0,
  C: 0,
  D: 8,
  E: 18,
});

const VAT_LETTERS = Object.freeze(["A", "B", "C", "D", "E"]);

const EMPTY_BREAKDOWN = Object.freeze({ A: 0, B: 0, C: 0, D: 0, E: 0 });

function assertFiscalOn() {
  return isFiscalEnabled();
}

function round4(n) {
  return Math.round((Number(n) || 0) * FISCAL_DECIMAL_FACTOR) / FISCAL_DECIMAL_FACTOR;
}

/** Rrumbullakim në cent (€0.01) — shpërndarje karroce, ATK line totals. */
function round2Money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Alias për kompatibilitet brenda modulit fiskal — tani = round4. */
function round2(n) {
  return round4(n);
}

function emptyBreakdown() {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function isZeroDelta(delta) {
  return Math.abs(Number(delta) || 0) < 0.00005;
}

/**
 * Residual / last-group adjustment: shuma e grupeve të rrumbullakuara
 * barazohet me targetTotal (4 decimale).
 */
function applyResidualRounding(breakdown, targetTotal) {
  const out = emptyBreakdown();
  for (const L of VAT_LETTERS) {
    out[L] = round4(breakdown[L]);
  }
  const target = round4(targetTotal);
  let sum = round4(VAT_LETTERS.reduce((s, L) => s + out[L], 0));
  const delta = round4(target - sum);
  if (isZeroDelta(delta)) return out;

  let adjustKey = "E";
  let best = -1;
  for (const L of VAT_LETTERS) {
    const v = out[L];
    if (v > best) {
      best = v;
      adjustKey = L;
    }
  }
  if (best <= 0) {
    for (let i = VAT_LETTERS.length - 1; i >= 0; i--) {
      const L = VAT_LETTERS[i];
      if (Number(breakdown[L]) !== 0 || out[L] !== 0) {
        adjustKey = L;
        break;
      }
    }
  }
  out[adjustKey] = round4(out[adjustKey] + delta);
  if (out[adjustKey] < 0) out[adjustKey] = 0;
  return out;
}

function getVatNormLetter(ratePct) {
  if (!assertFiscalOn()) return null;
  const rate = Number(ratePct);
  if (!Number.isFinite(rate)) return null;
  if (rate === 0) return "A";
  if (rate === 8) return "D";
  if (rate === 18) return "E";
  return "C";
}

function getVatRate(letter) {
  if (!assertFiscalOn()) return null;
  const key = String(letter || "")
    .trim()
    .toUpperCase();
  if (!(key in VAT_RATES)) return null;
  return VAT_RATES[key];
}

function resolveItemLetter(item) {
  if (!item || typeof item !== "object") return "E";
  const raw =
    item.vat_norm ??
    item.vat_letter ??
    item.vatNorm ??
    item.vatLetter ??
    null;
  if (raw != null && String(raw).trim() !== "") {
    const letter = String(raw).trim().toUpperCase();
    if (letter in VAT_RATES) return letter;
  }
  const rate =
    item.vat_rate ??
    item.vat_percent ??
    item.vatPercent ??
    item.tvsh_percent ??
    null;
  if (rate != null && rate !== "") {
    const letter = getVatNormLetter(rate);
    if (letter) return letter;
  }
  return "E";
}

function normalizeQty(qty) {
  return round4(Number(qty ?? 1) || 0);
}

function normalizeUnitPrice(item) {
  const price = Number(
    item?.unit_price ?? item?.unitPrice ?? item?.price ?? item?.cmimi ?? 0
  );
  return round4(Number.isFinite(price) ? price : 0);
}

function lineTotalAmount(qty, unitPrice) {
  return round4(normalizeQty(qty) * round4(unitPrice));
}

function lineAmount(item) {
  const qty = normalizeQty(item?.qty ?? item?.quantity ?? 1);
  const price = normalizeUnitPrice(item);
  return lineTotalAmount(qty, price);
}

/**
 * Vlera e rreshtit me TVSH pas zbritjes/shtesës së rreshtit dhe pjesës së karrocës.
 * Ruaj price/unit_price bruto për print — përdor fiscal_line_total ose cart_*_share.
 */
function lineAmountAfterCart(item) {
  if (!item || typeof item !== "object") return 0;
  if (item.fiscal_line_total != null && Number.isFinite(Number(item.fiscal_line_total))) {
    return round4(Number(item.fiscal_line_total));
  }
  const gross = netLineAmountSafe(item);
  const cartDisc = round4(Number(item.cart_discount_share ?? item.cartDiscountShare ?? 0) || 0);
  const cartSur = round4(Number(item.cart_surcharge_share ?? item.cartSurchargeShare ?? 0) || 0);
  if (cartDisc > 0 || cartSur > 0) {
    return round4(Math.max(0, gross - cartDisc + cartSur));
  }
  return gross;
}

/**
 * Shpërndan zbritjen/shtesën e karrocës proporcionalisht te artikujt.
 * Secili rresht rrumbullakohet në cent (2 dec); artikulli i fundit merr mbetjen
 * (penny rounding) që shuma e fiscal_line_total = totali real pas zbritjes.
 * Nuk ndryshon price/unit_price — shton cart_discount_share, fiscal_line_total.
 */
function distributeCartAdjustment(items, cartDiscount = 0, cartSurcharge = 0) {
  const list = Array.isArray(items) ? items : [];
  const disc = round4(Math.max(0, Number(cartDiscount) || 0));
  const sur = round4(Math.max(0, Number(cartSurcharge) || 0));
  if (disc <= 0 && sur <= 0) {
    return list.map((it) => ({
      ...it,
      cart_discount_share: 0,
      cart_surcharge_share: 0,
      fiscal_line_total: round2Money(netLineAmountSafe(it)),
    }));
  }

  const bases = list.map((it) => netLineAmountSafe(it));
  const baseSum = round4(bases.reduce((s, v) => s + v, 0));
  if (baseSum <= 0) {
    return list.map((it) => ({
      ...it,
      cart_discount_share: 0,
      cart_surcharge_share: 0,
      fiscal_line_total: 0,
    }));
  }

  const targetTotal = round2Money(baseSum - disc + sur);
  const n = list.length;

  if (n === 1) {
    const surShare = round2Money(sur);
    const discShare = round2Money(Math.max(0, bases[0] - targetTotal + surShare));
    return [
      {
        ...list[0],
        cart_discount_share: discShare,
        cart_surcharge_share: surShare,
        fiscal_line_total: targetTotal,
      },
    ];
  }

  let discAssigned = 0;
  let surAssigned = 0;
  let lineSum = 0;
  const result = [];

  for (let i = 0; i < n - 1; i++) {
    const weight = bases[i] / baseSum;
    const discShare = round2Money(disc * weight);
    const surShare = round2Money(sur * weight);
    discAssigned = round2Money(discAssigned + discShare);
    surAssigned = round2Money(surAssigned + surShare);
    const fiscalLineTotal = round2Money(Math.max(0, bases[i] - discShare + surShare));
    lineSum = round2Money(lineSum + fiscalLineTotal);
    result.push({
      ...list[i],
      cart_discount_share: discShare,
      cart_surcharge_share: surShare,
      fiscal_line_total: fiscalLineTotal,
    });
  }

  const lastIdx = n - 1;
  const lastSurShare = round2Money(sur - surAssigned);
  const lastFiscalTotal = round2Money(Math.max(0, targetTotal - lineSum));
  const lastDiscShare = round2Money(
    Math.max(0, bases[lastIdx] - lastFiscalTotal + lastSurShare)
  );

  result.push({
    ...list[lastIdx],
    cart_discount_share: lastDiscShare,
    cart_surcharge_share: lastSurShare,
    fiscal_line_total: lastFiscalTotal,
  });

  return result;
}

function calculateVatBreakdown(items) {
  if (!assertFiscalOn()) return null;
  const raw = emptyBreakdown();
  if (!Array.isArray(items)) return raw;
  let grossTotal = 0;
  for (const item of items) {
    const letter = resolveItemLetter(item);
    const gross = lineAmountAfterCart(item);
    grossTotal += gross;
    raw[letter] = (raw[letter] || 0) + gross;
  }
  const rounded = emptyBreakdown();
  for (const L of VAT_LETTERS) {
    rounded[L] = round4(raw[L]);
  }
  return applyResidualRounding(rounded, round4(grossTotal));
}

function calculateVatTaxBreakdown(items, opts = {}) {
  if (!assertFiscalOn()) return null;
  let list = Array.isArray(items) ? items : [];
  const cartDisc = round4(
    Number(opts.cartDiscount ?? opts.cart_discount ?? 0) || 0
  );
  const cartSur = round4(
    Number(opts.cartSurcharge ?? opts.cart_surcharge ?? 0) || 0
  );
  const hasCartShares = list.some(
    (it) =>
      Number(it?.cart_discount_share ?? it?.cartDiscountShare ?? 0) > 0 ||
      Number(it?.cart_surcharge_share ?? it?.cartSurchargeShare ?? 0) > 0
  );
  if ((cartDisc > 0 || cartSur > 0) && !hasCartShares) {
    list = distributeCartAdjustment(list, cartDisc, cartSur);
  }

  const raw = emptyBreakdown();
  let grossTotal = 0;

  for (const item of list) {
    const letter = resolveItemLetter(item);
    const key = VAT_LETTERS.includes(letter) ? letter : "E";
    const gross = lineAmountAfterCart(item);
    grossTotal += gross;
    const r = Number(VAT_RATES[key]) || 0;
    const tax = r > 0 ? (gross * r) / (100 + r) : 0;
    raw[key] = (raw[key] || 0) + tax;
  }

  grossTotal = round4(grossTotal);
  if (opts.totalAmount != null && Number.isFinite(Number(opts.totalAmount))) {
    const target = round4(Number(opts.totalAmount));
    if (Math.abs(target - grossTotal) > 0.0001) {
      grossTotal = target;
    }
  }

  const rounded = emptyBreakdown();
  for (const L of VAT_LETTERS) {
    rounded[L] = round4(raw[L]);
  }

  const exactTaxSum = round4(VAT_LETTERS.reduce((s, L) => s + Number(raw[L] || 0), 0));
  let targetTax = exactTaxSum;
  if (opts.totalWithoutTax != null && Number.isFinite(Number(opts.totalWithoutTax))) {
    targetTax = round4(grossTotal - round4(opts.totalWithoutTax));
  }

  const tax = applyResidualRounding(rounded, targetTax);
  const totalTax = round4(VAT_LETTERS.reduce((s, L) => s + tax[L], 0));
  const totalWithoutTax = round4(grossTotal - totalTax);

  return {
    tax,
    totalTax,
    totalWithoutTax,
    total: grossTotal,
  };
}

/** Format 4 presje — shuma fiskale. */
function money4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.0000";
  return round4(n).toFixed(FISCAL_DECIMAL_PLACES);
}

/** Alias brenda modulit fiskal — tani 4 presje. */
function money2(value) {
  return money4(value);
}

/** Çmimi për njësi — 4 presje (Neni 25). */
function formatUnitPrice(price) {
  return money4(price);
}

/** Sasia — 4 presje kur nuk është e plotë; e plotë mbetet pa .0000 nëse integer. */
function formatQty(qty) {
  const n = normalizeQty(qty);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(FISCAL_DECIMAL_PLACES);
}

/** Totali i rreshtit / kuponit — 4 presje. */
function formatTotal(amount) {
  return money4(amount);
}

module.exports = {
  CURRENCY,
  FISCAL_DECIMAL_PLACES,
  FISCAL_DECIMAL_FACTOR,
  VAT_RATES,
  VAT_LETTERS,
  EMPTY_BREAKDOWN,
  getVatNormLetter,
  getVatRate,
  resolveItemLetter,
  round4,
  round2,
  round2Money,
  normalizeQty,
  normalizeUnitPrice,
  lineTotalAmount,
  lineAmountAfterCart,
  distributeCartAdjustment,
  applyResidualRounding,
  calculateVatBreakdown,
  calculateVatTaxBreakdown,
  money4,
  money2,
  formatUnitPrice,
  formatQty,
  formatTotal,
};
