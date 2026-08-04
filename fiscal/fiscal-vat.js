/**
 * fiscal/fiscal-vat.js — HAPI 3: normat TVSH me shkronja (A/B/C/D/E).
 * Përdoret VETËM kur isFiscalEnabled()=true. Nuk prek kalkulimet ekzistuese.
 *
 * Residual rounding (last/largest group): pas rrumbullakimit 2-dec të çdo
 * grupi, kompenson diferencën që shuma e TVSH + Total pa TVSH = Total ekzakt.
 */
const { isFiscalEnabled } = require("./fiscal-config");

/** Valuta fiskale — gjithmonë EUR */
const CURRENCY = "EUR";

/** Norma TVSH: shkronjë → përqindje */
const VAT_RATES = Object.freeze({
  A: 0, // përjashtuar nga TVSH
  B: 0, // rezervuar (përdorim i ardhshëm)
  C: 0, // normë tjetër (përcaktohet nga ATK më vonë)
  D: 8, // 8% TVSH
  E: 18, // 18% TVSH
});

const VAT_LETTERS = Object.freeze(["A", "B", "C", "D", "E"]);

const EMPTY_BREAKDOWN = Object.freeze({ A: 0, B: 0, C: 0, D: 0, E: 0 });

function assertFiscalOn() {
  return isFiscalEnabled();
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function emptyBreakdown() {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

/**
 * Residual / last-group adjustment: shuma e grupeve të rrumbullakuara
 * barazohet me targetTotal (2 decimale).
 * Preferon grupin me vlerën më të madhe; në barazim — shkronjën e fundit.
 */
function applyResidualRounding(breakdown, targetTotal) {
  const out = emptyBreakdown();
  for (const L of VAT_LETTERS) {
    out[L] = round2(breakdown[L]);
  }
  const target = round2(targetTotal);
  let sum = round2(VAT_LETTERS.reduce((s, L) => s + out[L], 0));
  const delta = round2(target - sum);
  if (delta === 0) return out;

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
  out[adjustKey] = round2(out[adjustKey] + delta);
  if (out[adjustKey] < 0) out[adjustKey] = 0;
  return out;
}

/**
 * Merr përqindjen (0, 8, 18), kthen shkronjën (A, D, E).
 * 0 → A; 8 → D; 18 → E; tjera → C (normë e panjohur / ATK).
 */
function getVatNormLetter(ratePct) {
  if (!assertFiscalOn()) return null;
  const rate = Number(ratePct);
  if (!Number.isFinite(rate)) return null;
  if (rate === 0) return "A";
  if (rate === 8) return "D";
  if (rate === 18) return "E";
  return "C";
}

/**
 * Merr shkronjën (A–E), kthen përqindjen.
 */
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
  // Default fiskal: 18% (E) kur mungon norma
  return "E";
}

function lineAmount(item) {
  const qty = Number(item.qty ?? item.quantity ?? 1) || 0;
  const price = Number(
    item.unit_price ?? item.unitPrice ?? item.price ?? item.cmimi ?? 0
  );
  return qty * (Number.isFinite(price) ? price : 0);
}

/**
 * Merr listën e artikujve, kthen { A, B, C, D, E } — shuma e rreshtave (turnover/gross) për çdo normë.
 * Artikulli: { qty, unit_price|price, vat_norm|vat_letter|vat_rate }
 * Residual: shuma e grupeve = totali i rrumbullakuar i artikujve.
 */
function calculateVatBreakdown(items) {
  if (!assertFiscalOn()) return null;
  const raw = emptyBreakdown();
  if (!Array.isArray(items)) return raw;
  let grossTotal = 0;
  for (const item of items) {
    const letter = resolveItemLetter(item);
    const gross = lineAmount(item);
    grossTotal += gross;
    raw[letter] = (raw[letter] || 0) + gross;
  }
  const rounded = emptyBreakdown();
  for (const L of VAT_LETTERS) {
    rounded[L] = round2(raw[L]);
  }
  return applyResidualRounding(rounded, round2(grossTotal));
}

/**
 * Llogarit tatimin TVSH për grup (jo bazën/turnover).
 * 1) Tatim i saktë për artikull → grumbullo për A–E
 * 2) Rrumbullako çdo grup në 2 decimale
 * 3) Residual te grupi më i madh (ose i fundit) që
 *    sum(TVSH) + Total pa TVSH = Total (ekzakt)
 *
 * @param {Array} items
 * @param {{ totalAmount?: number, totalWithoutTax?: number }} [opts]
 * @returns {{ tax: object, totalTax: number, totalWithoutTax: number, total: number }|null}
 */
function calculateVatTaxBreakdown(items, opts = {}) {
  if (!assertFiscalOn()) return null;
  const list = Array.isArray(items) ? items : [];
  const raw = emptyBreakdown();
  let grossTotal = 0;

  for (const item of list) {
    const letter = resolveItemLetter(item);
    const key = VAT_LETTERS.includes(letter) ? letter : "E";
    const gross = lineAmount(item);
    grossTotal += gross;
    const r = Number(VAT_RATES[key]) || 0;
    const tax = r > 0 ? (gross * r) / (100 + r) : 0;
    raw[key] = (raw[key] || 0) + tax;
  }

  if (opts.totalAmount != null && Number.isFinite(Number(opts.totalAmount))) {
    grossTotal = Number(opts.totalAmount);
  }
  grossTotal = round2(grossTotal);

  const rounded = emptyBreakdown();
  for (const L of VAT_LETTERS) {
    rounded[L] = round2(raw[L]);
  }

  const exactTaxSum = round2(VAT_LETTERS.reduce((s, L) => s + Number(raw[L] || 0), 0));
  let targetTax = exactTaxSum;
  if (opts.totalWithoutTax != null && Number.isFinite(Number(opts.totalWithoutTax))) {
    targetTax = round2(grossTotal - round2(opts.totalWithoutTax));
  }

  const tax = applyResidualRounding(rounded, targetTax);
  const totalTax = round2(VAT_LETTERS.reduce((s, L) => s + tax[L], 0));
  const totalWithoutTax = round2(grossTotal - totalTax);

  return {
    tax,
    totalTax,
    totalWithoutTax,
    total: grossTotal,
  };
}

/**
 * Gjithmonë 2 presje dhjetore (1.2→"1.20", 3→"3.00").
 * Nuk kthen null — që kuponët të mos rrjedhin me Number.toString() të gjatë.
 */
function money2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Çmimi për njësi me 4 presje dhjetore (Neni 25) — p.sh. "1.5000".
 * TOTALI mbetet me money2 / formatTotal (2 presje).
 */
function formatUnitPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return "0.0000";
  return (Math.round(n * 10000) / 10000).toFixed(4);
}

/**
 * Totali me 2 presje dhjetore (p.sh. "1.50").
 */
function formatTotal(amount) {
  return money2(amount);
}

module.exports = {
  CURRENCY,
  VAT_RATES,
  VAT_LETTERS,
  EMPTY_BREAKDOWN,
  getVatNormLetter,
  getVatRate,
  resolveItemLetter,
  round2,
  applyResidualRounding,
  calculateVatBreakdown,
  calculateVatTaxBreakdown,
  money2,
  formatUnitPrice,
  formatTotal,
};
