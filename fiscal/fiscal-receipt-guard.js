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

/** Regex të përbashkëta — formati i vjetër + Shtojca F (alternativa të reja). */
const RE_TOTAL =
  /TOTALI NE EURO|UKUPNO U EUR|UKUPNO ZA PLA[CĆ]ANJE|TOTALI PER PAGESE/i;
const RE_TOT_PA =
  /TOT\.\s*PA\s*TVSH|UKUP\.\s*BEZ\s*PDV|UKUPNO\s+BEZ\s+PDV|TOTALI PA TVSH/i;
const RE_OPERATOR =
  /Operator:|Operater:|EMRI I PUNETORIT:|IME RADNIKA:/i;
const RE_DATA_ORA = /DATA DHE ORA:?|DATUM I VREME:?/i;
const RE_DATA = /Data:|Datum:/i;
const RE_ORA = /Ora:|Vreme:/i;
const RE_NR_FISKAL =
  /NR\.\s*FISKAL:|FISKALNI BR:|NR-NUI:|NF-NUI:|NF-PIB:/i;
const RE_NR_TVSH =
  /NR\.\s*TVSH:|PDV BR:|PDV BROJ:|NUMRI TVSH-SE:|NUMRI I TVSH-SE:/i;
const RE_TVSH_BREAKDOWN =
  /TVSH\s+[A-E]=|PDV\s+[A-E]=|TVSH\s+[A-E]\s+\d[\d.,]*%|PDV\s+[A-E]\s+\d[\d.,]*%/i;
const RE_SEF =
  /Nr\.\s*SEF:|SEF\s*br:|SEF\s*IDENT\.\s*BR\.?:|NR\.\s*IDENTIFIKUES I SEF:|NR\.\s*IDENTIFIKUES SEF:?/i;
const RE_PAY_METHOD =
  /MËNYRA E PAGESËS:?|NAČIN PLAĆANJA:?|MENYRA E PAGESES:?/i;
const RE_CURRENCY =
  /TOTALI NE EURO|UKUPNO U EUR|UKUPNO ZA PLA[CĆ]ANJE|TOTALI PER PAGESE|\bEUR\b|\bEURO\b|€/i;
const RE_SHTOJCA_F =
  /TOTALI PER PAGESE|MENYRA E PAGESES|UKUPNO ZA PLA[CĆ]ANJE|NAČIN PLAĆANJA|DATA DHE ORA|DATUM I VREME/i;
const RE_SHTOJCA_F_COUPON =
  /TOTALI PER PAGESE|MENYRA E PAGESES|UKUPNO ZA PLA[CĆ]ANJE|NAČIN PLAĆANJA/i;
const RE_COUPON_NR_LABEL = /KUPON FISKAL NR\.|FISKALNI KUPON BR\./i;

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
    .replace(/^\^[CRLBH]+/g, "")
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
  const m = clean.match(
    /(?:Nr\.\s*SEF|SEF\s*br|SEF\s*IDENT\.\s*BR\.?|NR\.\s*IDENTIFIKUES I SEF|NR\.\s*IDENTIFIKUES SEF):?\s*(.+)/i
  );
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
 * Shtojca F: numër rendor pa etiketë (rresht vetëm shifra, p.sh. 0000000321)
 * midis TOTALI PA TVSH dhe DATA DHE ORA.
 */
function findShtojcaFBareSerial(text) {
  const clean = stripEscPosMarkersFromText(text);
  const idxTotPa = indexOfRe(clean, RE_TOT_PA);
  const idxDataOra = indexOfRe(clean, RE_DATA_ORA);
  if (idxTotPa < 0 || idxDataOra < 0 || idxTotPa >= idxDataOra) {
    return { found: false, index: -1, value: "" };
  }
  const slice = clean.slice(idxTotPa, idxDataOra);
  const reSerial = /(?:^|\n)\s*(\d{4,12})\s*(?=\n|$)/g;
  let match = null;
  let m;
  while ((m = reSerial.exec(slice)) !== null) {
    match = m;
  }
  if (!match) {
    return { found: false, index: -1, value: "" };
  }
  const value = match[1];
  const lineOffset = match.index + match[0].indexOf(value);
  return { found: true, index: idxTotPa + lineOffset, value };
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
  if (!RE_TOTAL.test(text)) {
    missing.push("TOTALI NE EURO");
  }
  if (!RE_TOT_PA.test(text)) missing.push("TOT. PA TVSH / UKUPNO BEZ PDV");
  if (!RE_TVSH_BREAKDOWN.test(text)) missing.push("TVSH/PDV breakdown");
  if (!RE_DATA_ORA.test(text) && (!RE_DATA.test(text) || !RE_ORA.test(text))) {
    missing.push("data/ora");
  }
  if (!RE_OPERATOR.test(text)) missing.push("operator");
  if (!RE_NR_FISKAL.test(text)) missing.push("NR. FISKAL");
  if (!RE_NR_TVSH.test(text)) missing.push("NR. TVSH");
  const isShtojcaFCoupon = RE_SHTOJCA_F_COUPON.test(text);
  const hasCouponNrLabel = RE_COUPON_NR_LABEL.test(text);
  const shtojcaBareSerial = isShtojcaFCoupon ? findShtojcaFBareSerial(text) : { found: false };
  if (!hasCouponNrLabel && !(isShtojcaFCoupon && shtojcaBareSerial.found)) {
    missing.push("KUPON FISKAL NR.");
  }
  if (!/KUPON FISKAL DITOR NR\.|FISKALNI KUPON DNEVNI BR\./i.test(text)) {
    missing.push("KUPON FISKAL DITOR NR.");
  }
  if (!RE_PAY_METHOD.test(text)) {
    missing.push("MËNYRA E PAGESËS");
  }
  if (!/\be-kuponi\b|\be-kupon\b/i.test(text)) {
    missing.push("e-kuponi");
  }
  if (!RE_CURRENCY.test(text)) {
    missing.push("valuta EUR");
  }
  if (opts.printOfflineBanner && !/\bOFFLINE\b/i.test(text)) {
    missing.push("OFFLINE");
  }
  // Emri biznesit / titulli: ^C^L^B (logo + KUPON FISKAL) — si Shtojca F origjinal.
  const firstContent = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (
    firstContent &&
    !/\^B/.test(firstContent) &&
    !/\^L/.test(firstContent) &&
    !/\^H/.test(firstContent)
  ) {
    violations.push("emri biznesit duhet ^B / ^H / ^L (bold / i madh) si origjinali ATK");
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
  } else if (!RE_SEF.test(text)) {
    missing.push("Nr. SEF");
  }

  const isShtojcaF = RE_SHTOJCA_F.test(text);

  // Radhitja: formati i vjetër ose Shtojca F (pozicionet e reja)
  const idxTotal = indexOfRe(text, RE_TOTAL);
  const idxPay = indexOfRe(
    text,
    /PARA TE GATSHME|GOTOVINA|Gotovina|Debit|Kredit|Pagesa:|Plaćanje:/i
  );
  const idxPayMethod = indexOfRe(text, RE_PAY_METHOD);
  const idxTvsh = indexOfRe(text, RE_TVSH_BREAKDOWN);
  const idxTotPa = indexOfRe(text, RE_TOT_PA);
  const idxDataOra = indexOfRe(text, RE_DATA_ORA);
  const idxNuikf = indexOfRe(text, /NUIKF:/i);
  const idxSef = indexOfRe(text, RE_SEF);
  const idxCouponNr = indexOfRe(text, RE_COUPON_NR_LABEL);
  const idxDailyNr = indexOfRe(
    text,
    /KUPON FISKAL DITOR NR\.|FISKALNI KUPON DNEVNI BR\./i
  );
  const idxEKuponi = indexOfRe(text, /\be-kuponi\b|\be-kupon\b/i);
  const idxNrFiskal = indexOfRe(text, RE_NR_FISKAL);

  if (idxNrFiskal >= 0 && idxTotal >= 0 && idxNrFiskal > idxTotal) {
    violations.push(
      "radhitja: NR. FISKAL / NR-NUI duhet para TOTALI NE EURO / TOTALI PER PAGESE"
    );
  }
  // Format i vjetër (PARA TE GATSHME / Gotovina para etiketës) — jo Shtojca F.
  if (!isShtojcaF) {
    if (idxTotal >= 0 && idxPay >= 0 && idxTotal > idxPay) {
      violations.push(
        "radhitja: TOTALI NE EURO / TOTALI PER PAGESE duhet para pagesës (PARA TE GATSHME)"
      );
    }
    if (idxPay >= 0 && idxPayMethod >= 0 && idxPay > idxPayMethod) {
      violations.push(
        "radhitja: shuma e pagesës duhet para MËNYRA E PAGESËS / MENYRA E PAGESES"
      );
    }
  }
  if (idxPayMethod >= 0 && idxTvsh >= 0 && idxPayMethod > idxTvsh) {
    violations.push(
      "radhitja: MËNYRA E PAGESËS / MENYRA E PAGESES duhet para TVSH breakdown"
    );
  }
  if (idxTvsh >= 0 && idxTotPa >= 0 && idxTvsh > idxTotPa) {
    violations.push("radhitja: TVSH duhet para TOT. PA TVSH / TOTALI PA TVSH");
  }

  if (isShtojcaF) {
    // Shtojca F: TOTALI PER PAGESE → MENYRA E PAGESES → TVSH → TOTALI PA TVSH → … → DATA DHE ORA → SEF → NUIKF → DITOR → e-kuponi
    if (idxTotal >= 0 && idxPayMethod >= 0 && idxTotal > idxPayMethod) {
      violations.push(
        "radhitja: TOTALI PER PAGESE duhet para MENYRA E PAGESES"
      );
    }
    if (idxTotPa >= 0 && idxDataOra >= 0 && idxTotPa > idxDataOra) {
      violations.push(
        "radhitja: TOTALI PA TVSH duhet para DATA DHE ORA"
      );
    }
    if (idxTotPa >= 0 && idxNuikf >= 0 && idxTotPa > idxNuikf && idxDataOra < 0) {
      violations.push("radhitja: TOTALI PA TVSH duhet para NUIKF");
    }
    if (idxDataOra >= 0 && idxSef >= 0 && idxDataOra > idxSef) {
      violations.push(
        "radhitja: DATA DHE ORA duhet para NR. IDENTIFIKUES SEF"
      );
    }
    if (idxSef >= 0 && idxNuikf >= 0 && idxSef > idxNuikf) {
      violations.push(
        "radhitja: NR. IDENTIFIKUES SEF duhet para NUIKF"
      );
    }
    if (idxNuikf >= 0 && idxDailyNr >= 0 && idxNuikf > idxDailyNr) {
      violations.push(
        "radhitja: NUIKF duhet para KUPON FISKAL DITOR NR."
      );
    }
    if (
      isShtojcaFCoupon &&
      !hasCouponNrLabel &&
      shtojcaBareSerial.found
    ) {
      const idxBareSerial = shtojcaBareSerial.index;
      if (idxTotPa >= 0 && idxBareSerial >= 0 && idxTotPa > idxBareSerial) {
        violations.push(
          "radhitja: numri rendor duhet pas TOTALI PA TVSH"
        );
      }
      if (idxDataOra >= 0 && idxBareSerial >= 0 && idxBareSerial > idxDataOra) {
        violations.push(
          "radhitja: numri rendor duhet para DATA DHE ORA"
        );
      }
    }
  } else {
    // Formati i vjetër: TOT.PA → NUIKF → SEF → KUPON FISKAL NR. → DITOR → e-kuponi
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
