/**
 * fiscal/fiscal-receipt-guard.js — mbrojtje absolute e formatit të kuponit fiskal.
 * E MBROJTUR: mos ndrysho STRUCTURE_SPEC / RECEIPT_FORMAT_HASH pa aprovim + FISCAL-REQUIREMENTS.md.
 */
const crypto = require("crypto");
const { isFiscalEnabled } = require("./fiscal-config");

/**
 * Spec i strukturës ATK (radhitja + fusha të mbyllura).
 * Nëse e ndryshon → DUHET të ripërditësosh RECEIPT_FORMAT_HASH (pas aprovimit).
 * v3: unit_name, phone, mënyra pagesës, nr. total + nr. ditor, e-kuponi (Neni 25 / Shtojca F).
 */
const STRUCTURE_SPEC = Object.freeze({
  version: 3,
  order: Object.freeze([
    "BUSINESS_NAME_BOLD",
    "UNIT_NAME_OPT",
    "LEGAL_NAME_OPT",
    "ADDRESS_OPT",
    "PHONE_OPT",
    "CITY_OPT",
    "BLANK",
    "NR_FISKAL",
    "NR_TVSH",
    "BLANK",
    "OPERATOR",
    "DATE_TIME",
    "CORRECTIVE_OPT",
    "DIV_DASH",
    "ITEMS_HEADER",
    "ITEMS",
    "DIV_DASH",
    "TOTALI_NE_EURO",
    "PAYMENT_AMOUNT_LINE",
    "PAYMENT_METHOD_LINE",
    "BLANK",
    "TVSH_BREAKDOWN",
    "TOT_PA_TVSH",
    "DIV_DASH",
    "NUIKF",
    "SEF",
    "KUPON_FISKAL_NR",
    "KUPON_FISKAL_DITOR_NR",
    "E_KUPONI",
    "QR",
    "LOGO_RKS_MF",
  ]),
  locked: Object.freeze([
    "element_order",
    "nuikf_16_alnum",
    "sef_unit_nui_pos",
    "vat_norms_ABCDE",
    "currency_EUR",
    "logo_rks_mf_after_qr",
    "business_name_bold_normal",
  ]),
  currency: "EUR",
  nuikfPattern: "^[A-Z0-9]{16}$",
  // ATK Neni 25: [NumriNjësisëARBK]-[NUI9]-[PosID]  p.sh. 5130484-812345678-11
  sefPattern: "^[0-9]+-[0-9]{9}-.+$",
  vatLabelStyle: "LETTER=RATE%",
});

/** SHA256 i JSON.stringify(STRUCTURE_SPEC) — E MBROJTUR */
const RECEIPT_FORMAT_HASH =
  "20beb427946f844c61bef073c463e3258ce2e684d06e421a9c7ae76cec94a846";

const LOCKED_FIELDS = STRUCTURE_SPEC.locked;

function hashStructureSpec(spec) {
  return crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

function assertFormatSpecIntegrity() {
  const computed = hashStructureSpec(STRUCTURE_SPEC);
  if (computed !== RECEIPT_FORMAT_HASH) {
    throw new Error(
      "RECEIPT_FORMAT_HASH nuk përputhet me STRUCTURE_SPEC — " +
        "formati i kuponit u ndryshua pa aprovim. Lexo FISCAL-REQUIREMENTS.md / Rregulli #15."
    );
  }
  return true;
}

function stripMarkers(line) {
  return String(line || "")
    .replace(/^\^[CRLB]+/g, "")
    .replace(/\^b/g, "")
    .trim();
}

/** Hiq ^C/^R/^L/^B nga çdo rresht — për validim (p.sh. ^BNUIKF: nuk duhet me prishur match). */
function stripEscPosMarkersFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => stripMarkers(line))
    .join("\n");
}

function extractNuikf(text) {
  const clean = stripEscPosMarkersFromText(text);
  const m = clean.match(/\bNUIKF:\s*([A-Za-z0-9]+)/i);
  return m ? String(m[1]).trim().toUpperCase() : "";
}

function extractSef(text) {
  const clean = stripEscPosMarkersFromText(text);
  const m = clean.match(/(?:Nr\.\s*SEF|SEF\s*br):\s*(.+)/i);
  return m ? String(m[1]).trim() : "";
}

function failValidate(gabim, missing, violations) {
  return {
    ok: false,
    gabim: String(gabim || "Validimi i kuponit dështoi"),
    missing: Array.isArray(missing) ? missing : [],
    violations: Array.isArray(violations) ? violations : [],
  };
}

function indexOfRe(text, re) {
  const m = String(text || "").match(re);
  return m ? String(text).indexOf(m[0]) : -1;
}

/**
 * Validon tekstin e kuponit PARA printimit.
 * @param {string} receiptText
 * @param {{ qrAttached?: boolean, logoAttached?: boolean, operatorName?: string }} [opts]
 * @returns {{ ok: boolean, gabim?: string, missing?: string[], violations?: string[] }}
 */
function validateReceiptBeforePrint(receiptText, opts = {}) {
  try {
    assertFormatSpecIntegrity();
  } catch (e) {
    return failValidate(e.message, ["RECEIPT_FORMAT_HASH"]);
  }

  if (!isFiscalEnabled()) {
    return { ok: false, gabim: "Fiskalizimi është OFF", missing: ["fiscal_enabled"] };
  }

  const rawText = String(receiptText || "");
  // Validimi mbi tekst pa markera ESC — ^BNUIKF: → NUIKF:
  const text = stripEscPosMarkersFromText(rawText);
  const missing = [];
  const violations = [];

  if (!text.trim()) {
    return failValidate("Teksti i kuponit fiskal është bosh", ["receipt_text"]);
  }

  if (!/NUIKF:\s*[A-Z0-9]{16}\b/i.test(text) && !/NUIKF:\s*[A-Za-z0-9]+/i.test(text)) {
    missing.push("NUIKF");
  }
  if (!opts.qrAttached && !/\[QR/i.test(text)) {
    missing.push("QR");
  }
  if (!opts.logoAttached && !/RKS|Logo Fiskale|Fiskalni logo/i.test(text)) {
    missing.push("Logo RKS/MF");
  }
  if (!/TOTALI NE EURO|UKUPNO U EUR|UKUPNO ZA PLA[CĆ]ANJE/i.test(text)) {
    missing.push("TOTALI NE EURO");
  }
  if (!/TOT\.\s*PA\s*TVSH|UKUP\.\s*BEZ\s*PDV/i.test(text)) missing.push("TOT. PA TVSH");
  if (!/TVSH\s+[A-E]=|PDV\s+[A-E]=/i.test(text)) missing.push("TVSH breakdown");
  if (!/Data:|Datum:/i.test(text) || !/Ora:|Vreme:/i.test(text)) {
    missing.push("data/ora");
  }
  if (!/Operator:|Operater:/i.test(text)) missing.push("operator");
  if (!/NR\.\s*FISKAL:|FISKALNI BR:/i.test(text)) missing.push("NR. FISKAL");
  if (!/NR\.\s*TVSH:|PDV BR:/i.test(text)) missing.push("NR. TVSH");
  if (!/KUPON FISKAL NR\.|FISKALNI KUPON BR\./i.test(text)) {
    missing.push("KUPON FISKAL NR.");
  }
  if (!/KUPON FISKAL DITOR NR\.|FISKALNI KUPON DNEVNI BR\./i.test(text)) {
    missing.push("KUPON FISKAL DITOR NR.");
  }
  if (!/MËNYRA E PAGESËS:|NAČIN PLAĆANJA:/i.test(text)) {
    missing.push("MËNYRA E PAGESËS");
  }
  if (!/\be-kuponi\b|\be-kupon\b/i.test(text)) {
    missing.push("e-kuponi");
  }
  // Valuta: TOTALI NE EURO / UKUPNO U EUR / UKUPNO ZA PLAĆANJE
  if (!/TOTALI NE EURO|UKUPNO U EUR|UKUPNO ZA PLA[CĆ]ANJE|\bEUR\b|\bEURO\b/i.test(text)) {
    missing.push("valuta EUR");
  }
  // Emri biznesit: bold (^B) madhësi normale — PA ^L / GS ! 0x11
  if (/\^L/.test(rawText)) {
    violations.push("emri biznesit nuk duhet ^L (GS ! 0x11) — vetëm bold madhësi normale");
  }
  const firstContent = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstContent && !/\^B/.test(firstContent)) {
    violations.push("emri biznesit duhet ^B (bold, madhësi normale)");
  }

  const nuikf = extractNuikf(rawText);
  if (nuikf) {
    if (!new RegExp(STRUCTURE_SPEC.nuikfPattern).test(nuikf)) {
      violations.push(`NUIKF format i gabuar: ${nuikf}`);
    }
    if (/^\d{8}-\d{6}$/.test(nuikf)) {
      violations.push("NUIKF nuk mund të jetë numri lokal i faturës");
    }
  } else {
    missing.push("NUIKF");
  }

  const sef = extractSef(text);
  if (sef && sef !== "-") {
    if (!new RegExp(STRUCTURE_SPEC.sefPattern).test(sef)) {
      if (!/^-?$/.test(sef)) {
        violations.push(`Nr. SEF format i gabuar: ${sef}`);
      }
    }
  } else if (!/Nr\.\s*SEF:|SEF\s*br:/i.test(text)) {
    missing.push("Nr. SEF");
  }

  // Radhitja ATK: TOTALI → pagesa → mënyra → TVSH → TOT.PA → NUIKF → SEF → NR → DITOR → e-kuponi
  const idxTotal = indexOfRe(text, /TOTALI NE EURO|UKUPNO U EUR|UKUPNO ZA PLA[CĆ]ANJE/i);
  const idxPay = indexOfRe(text, /PARA TE GATSHME|GOTOVINA|Gotovina|Debit|Kredit|Pagesa:|Plaćanje:/i);
  const idxPayMethod = indexOfRe(text, /MËNYRA E PAGESËS:|NAČIN PLAĆANJA:/i);
  const idxTvsh = indexOfRe(text, /TVSH\s+[A-E]=|PDV\s+[A-E]=/i);
  const idxTotPa = indexOfRe(text, /TOT\.\s*PA\s*TVSH|UKUP\.\s*BEZ\s*PDV/i);
  const idxNuikf = indexOfRe(text, /NUIKF:/i);
  const idxSef = indexOfRe(text, /Nr\.\s*SEF:|SEF\s*br:/i);
  const idxCouponNr = indexOfRe(text, /KUPON FISKAL NR\.|FISKALNI KUPON BR\./i);
  const idxDailyNr = indexOfRe(
    text,
    /KUPON FISKAL DITOR NR\.|FISKALNI KUPON DNEVNI BR\./i
  );
  const idxEKuponi = indexOfRe(text, /\be-kuponi\b|\be-kupon\b/i);
  const idxNrFiskal = indexOfRe(text, /NR\.\s*FISKAL:|FISKALNI BR:/i);

  if (idxNrFiskal >= 0 && idxTotal >= 0 && idxNrFiskal > idxTotal) {
    violations.push("radhitja: NR. FISKAL duhet para TOTALI NE EURO");
  }
  if (idxTotal >= 0 && idxPay >= 0 && idxTotal > idxPay) {
    violations.push("radhitja: TOTALI NE EURO duhet para pagesës (PARA TE GATSHME)");
  }
  if (idxPay >= 0 && idxPayMethod >= 0 && idxPay > idxPayMethod) {
    violations.push("radhitja: shuma e pagesës duhet para MËNYRA E PAGESËS");
  }
  if (idxPayMethod >= 0 && idxTvsh >= 0 && idxPayMethod > idxTvsh) {
    violations.push("radhitja: MËNYRA E PAGESËS duhet para TVSH breakdown");
  }
  if (idxTvsh >= 0 && idxTotPa >= 0 && idxTvsh > idxTotPa) {
    violations.push("radhitja: TVSH duhet para TOT. PA TVSH");
  }
  if (idxTotPa >= 0 && idxNuikf >= 0 && idxTotPa > idxNuikf) {
    violations.push("radhitja: TOT. PA TVSH duhet para NUIKF");
  }
  if (idxNuikf >= 0 && idxSef >= 0 && idxNuikf > idxSef) {
    violations.push("radhitja: NUIKF duhet para Nr. SEF");
  }
  if (idxSef >= 0 && idxCouponNr >= 0 && idxSef > idxCouponNr) {
    violations.push("radhitja: Nr. SEF duhet para KUPON FISKAL NR.");
  }
  if (idxCouponNr >= 0 && idxDailyNr >= 0 && idxCouponNr > idxDailyNr) {
    violations.push("radhitja: KUPON FISKAL NR. duhet para KUPON FISKAL DITOR NR.");
  }
  if (idxDailyNr >= 0 && idxEKuponi >= 0 && idxDailyNr > idxEKuponi) {
    violations.push("radhitja: KUPON FISKAL DITOR NR. duhet para e-kuponi");
  }
  if (opts.qrAttached && opts.logoAttached === false) {
    violations.push("logo RKS/MF mungon pas QR");
  }

  if (missing.length || violations.length) {
    const parts = [];
    if (missing.length) parts.push("mungojnë: " + missing.join(", "));
    if (violations.length) parts.push(violations.join("; "));
    return failValidate(parts.join(" | "), missing, violations);
  }

  return { ok: true, missing: [], violations: [] };
}

/**
 * Validim i brendshëm pas generateFiscalReceipt — hedh Error nëse dështon.
 */
function assertGeneratedReceiptText(receiptText, opts = {}) {
  const v = validateReceiptBeforePrint(receiptText, {
    qrAttached: true,
    logoAttached: true,
    ...opts,
  });
  if (!v.ok) {
    try {
      const { logFiscalAction } = require("./fiscal-audit");
      logFiscalAction(
        "receipt_format_violation",
        {
          gabim: v.gabim,
          missing: v.missing,
          violations: v.violations,
        },
        "SYSTEM",
        "RECEIPT_GUARD"
      );
    } catch {
      /* */
    }
    throw new Error(v.gabim || "Formati i kuponit fiskal është i pavlefshëm");
  }
  return true;
}

module.exports = {
  STRUCTURE_SPEC,
  RECEIPT_FORMAT_HASH,
  LOCKED_FIELDS,
  hashStructureSpec,
  assertFormatSpecIntegrity,
  validateReceiptBeforePrint,
  assertGeneratedReceiptText,
  extractNuikf,
  extractSef,
  stripEscPosMarkersFromText,
};
