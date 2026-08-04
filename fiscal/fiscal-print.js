/**
 * fiscal/fiscal-print.js — HAPI 6: gjenerimi i tekstit të kuponit fiskal (layout ATK).
 * NUK printon — vetëm kthen stringun. Thirret kur isFiscalEnabled()=true.
 * ESC/POS: ESC E/G (bold) për krejt; emri biznesit bold + madhësi NORMALE (pa GS ! 0x11).
 */
const { isFiscalEnabled } = require("./fiscal-config");
const {
  formatUnitPrice,
  formatTotal,
  money2,
  getVatNormLetter,
  calculateVatTaxBreakdown,
} = require("./fiscal-vat");
const { getSefIdentifier, generateNUIKF } = require("./fiscal-numbering");
const { t, tPayment, tReceiptType, syncLanguageFromSettings } = require("./fiscal-i18n");
const { paperChars, pad: receiptPad, divider: receiptDivider } = require("../receipt-text");

/** Default 80mm = 42 char — njësoj si receipt-text. */
const WIDTH = 42;

function resolvePrintWidth() {
  try {
    const database = require("../database");
    const printer = require("../printer");
    let paper = "80mm";
    try {
      paper = String(printer.getPrinterConfig(database).paper || "80mm").trim() || "80mm";
    } catch {
      /* */
    }
    if (paper === "auto") paper = "80mm";
    return paperChars(paper);
  } catch {
    return WIDTH;
  }
}

function pad(str, width, align = "left") {
  return receiptPad(str, width, align);
}

/** Si receipt-text labelValueLine — left … right. */
function padLine(left, right, width = WIDTH) {
  const l = String(left ?? "");
  const r = String(right ?? "");
  const gap = Math.max(1, width - l.length - r.length);
  return `${l}${" ".repeat(gap)}${r}`;
}

function divider(char = "-", width = WIDTH) {
  return receiptDivider(width, char);
}

function paymentLabelSq(method) {
  return tPayment(method);
}

/** Etiketë e shkurtër ATK për rreshtin "MËNYRA E PAGESËS: KESH|POS|…" */
function atkPaymentModeShort(method) {
  const v = String(method || "cash")
    .trim()
    .toLowerCase();
  if (v === "cash" || v === "gotovina") return t("payment_mode_cash");
  if (
    v === "credit_card" ||
    v === "debit_card" ||
    v === "karte" ||
    v === "kartë" ||
    v === "card" ||
    v === "pos"
  ) {
    return t("payment_mode_pos");
  }
  if (v === "voucher" || v === "vaucer") return t("payment_mode_voucher");
  if (v === "check" || v === "cheque" || v === "cek" || v === "çek") {
    return t("payment_mode_cheque");
  }
  return t("payment_mode_other");
}

function receiptTypeLabel(type) {
  return tReceiptType(type);
}

function formatFiscalDateTime(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const dd = String(safe.getDate()).padStart(2, "0");
  const mm = String(safe.getMonth() + 1).padStart(2, "0");
  const yyyy = String(safe.getFullYear());
  const hh = String(safe.getHours()).padStart(2, "0");
  const mi = String(safe.getMinutes()).padStart(2, "0");
  return { date: `${dd}.${mm}.${yyyy}`, time: `${hh}:${mi}` };
}

function itemQty(item) {
  return Number(item.qty ?? item.quantity ?? 1) || 0;
}

function itemUnit(item) {
  return Number(item.unit_price ?? item.unitPrice ?? item.price ?? item.cmimi ?? 0) || 0;
}

function itemVatLetter(item) {
  const raw =
    item?.vat_norm ??
    item?.vat_letter ??
    item?.vatNorm ??
    item?.vatLetter ??
    null;
  if (raw != null && String(raw).trim() !== "") {
    const letter = String(raw).trim().toUpperCase();
    if (["A", "B", "C", "D", "E"].includes(letter)) return letter;
    const fromPct = getVatNormLetter(raw);
    if (fromPct) return fromPct;
  }
  const pct =
    item?.vat_category ??
    item?.vat_rate ??
    item?.vat_percent ??
    item?.tvsh_percent ??
    null;
  if (pct != null && String(pct).trim() !== "") {
    const fromPct = getVatNormLetter(pct);
    if (fromPct) return fromPct;
  }
  return "E";
}

/**
 * Rresht artikulli: emri … sasia  çmimi  vlera  TVSH
 * p.sh. Kafe        1  1.2000  1.20  E
 * Njësia: 4 presje (Neni 25); vlera/totali: 2 presje.
 */
function formatItemRow(item, width = WIDTH) {
  const qty = itemQty(item);
  const unit = itemUnit(item);
  const lineTotal = Math.round(qty * unit * 100) / 100;
  const unitStr = formatUnitPrice(unit); // toFixed(4)
  const valStr = formatTotal(lineTotal); // toFixed(2)
  const letter = itemVatLetter(item);
  const qtyStr = Number.isInteger(qty) ? String(qty) : money2(qty);
  const tail = `${qtyStr}  ${unitStr}  ${valStr}  ${letter}`;
  const nameMax = Math.max(4, width - tail.length - 1);
  let name = String(item.name || item.emri || "").trim() || "-";
  if (name.length > nameMax) {
    name = `${name.slice(0, Math.max(3, nameMax - 1))}…`;
  }
  const gap = Math.max(1, width - name.length - tail.length);
  return `${name}${" ".repeat(gap)}${tail}`;
}

/** Shuma me 2 presje — pa sufiks EUR (si kuponi ATK). */
function moneyAmt(v) {
  return money2(v);
}

function isCashPayment(method) {
  const m = String(method || "")
    .trim()
    .toLowerCase();
  return m === "cash" || m === "para" || m === "para_e_gatshme" || m === "para te gatshme";
}

/** Etiketa: "TVSH E=18.00%" (sq) / "PDV E=18.00%" (sr). */
function vatRateLineLabel(letter) {
  const L = String(letter || "").toUpperCase();
  const pct = L === "D" ? "8.00" : L === "E" ? "18.00" : "0.00";
  const prefix = String(t("vat") || "TVSH").trim() || "TVSH";
  return `${prefix} ${L}=${pct}%`;
}

/**
 * Rreshta TVSH për çdo normë që ekziston në kupon (edhe A/C me tatim 0.00),
 * që ATK / guard të shohin "TVSH A=0.00%" … "TVSH E=18.00%".
 */
function appendPositiveVatRateLines(lines, vatBreak, width, items) {
  const tax = {
    A: Math.round(Number(vatBreak?.A ?? vatBreak?.a ?? 0) * 100) / 100,
    B: Math.round(Number(vatBreak?.B ?? vatBreak?.b ?? 0) * 100) / 100,
    C: Math.round(Number(vatBreak?.C ?? vatBreak?.c ?? 0) * 100) / 100,
    D: Math.round(Number(vatBreak?.D ?? vatBreak?.d ?? 0) * 100) / 100,
    E: Math.round(Number(vatBreak?.E ?? vatBreak?.e ?? 0) * 100) / 100,
  };
  const present = new Set();
  for (const it of items || []) {
    const L = String(it.vat_norm || it.vat_letter || "")
      .trim()
      .toUpperCase();
    if (/^[A-E]$/.test(L)) present.add(L);
  }
  for (const L of ["A", "B", "C", "D", "E"]) {
    const show = present.has(L) || Number(tax[L] || 0) > 0;
    if (!show) continue;
    lines.push(padLine(`${vatRateLineLabel(L)}:`, moneyAmt(tax[L] || 0), width));
  }
}

function resolveVatTaxForPrint(items, fiscalOrOrderBreak) {
  // Prefero breakdown e ruajtur (tashmë me residual) — përputhet me TOT. PA TVSH
  let raw = fiscalOrOrderBreak;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (raw && typeof raw === "object") {
    const stored = {
      A: Math.round(Number(raw.A ?? raw.a ?? 0) * 100) / 100,
      B: Math.round(Number(raw.B ?? raw.b ?? 0) * 100) / 100,
      C: Math.round(Number(raw.C ?? raw.c ?? 0) * 100) / 100,
      D: Math.round(Number(raw.D ?? raw.d ?? 0) * 100) / 100,
      E: Math.round(Number(raw.E ?? raw.e ?? 0) * 100) / 100,
    };
    const hasStored = ["A", "B", "C", "D", "E"].some(
      (L) => Number(stored[L] || 0) > 0
    );
    if (hasStored) return stored;
  }

  return computeVatTaxBreakdown(items);
}

function computeVatTaxBreakdown(items) {
  const result = calculateVatTaxBreakdown(items);
  if (result && result.tax) return result.tax;
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

/** Ndaj adresën në rreshta + qytet opsional (rreshti i fundit). */
function splitAddressLines(address) {
  const raw = String(address || "").trim();
  if (!raw) return { lines: [], city: "" };
  const parts = raw
    .split(/\r?\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return { lines: parts.slice(0, -1), city: parts[parts.length - 1] };
  }
  // "Rruga X, Prishtine" → adresa + qyteti
  const comma = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (comma.length >= 2) {
    return { lines: [comma.slice(0, -1).join(", ")], city: comma[comma.length - 1] };
  }
  return { lines: [raw], city: "" };
}

/**
 * Gjeneron kuponin fiskal si string (layout ATK / shembull Super Viva).
 * Markerë: ^C^B = emri biznesit (bold, madhësi normale — PA ^L / GS ! 0x11).
 * @returns {string|null}
 */
function generateFiscalReceipt(orderData, fiscalData) {
  if (!isFiscalEnabled()) return null;

  const order = orderData && typeof orderData === "object" ? orderData : {};
  const fiscal = fiscalData && typeof fiscalData === "object" ? fiscalData : {};

  // Gjuha e kuponit = fiscal_settings.language nga SQLite (gjithmonë rilexohet).
  const lang = syncLanguageFromSettings();
  console.log("[fiscal-print] generateFiscalReceipt language=", lang, "→", t("KUPON_FISKAL"));

  const w = Number(fiscal.print_width) > 0
    ? Number(fiscal.print_width)
    : resolvePrintWidth();

  const items = Array.isArray(order.items) ? order.items : [];
  const isOffline = !!(fiscal.is_offline === 1 || fiscal.is_offline === true || order.is_offline);
  const receiptType = String(fiscal.receipt_type || order.receipt_type || "regular")
    .trim()
    .toLowerCase();
  const isCorrective = receiptType !== "regular";

  const legalName =
    fiscal.taxpayer_legal_name ||
    fiscal.taxpayer_name ||
    order.taxpayer_legal_name ||
    t("business_fallback");
  const brandName =
    fiscal.taxpayer_trade_name ||
    fiscal.business_name ||
    order.taxpayer_trade_name ||
    legalName;
  const unitName = String(
    fiscal.unit_name || order.unit_name || ""
  ).trim();
  const unitPhone = String(
    fiscal.unit_phone || order.unit_phone || ""
  ).trim();
  const address = fiscal.taxpayer_address || order.taxpayer_address || "";
  const { lines: addressLines, city } = splitAddressLines(address);
  const nui = fiscal.taxpayer_nui || order.taxpayer_nui || "";
  const vatNo =
    fiscal.taxpayer_vat ||
    fiscal.taxpayer_vat_number ||
    order.taxpayer_vat ||
    "";

  const operatorName = order.operator_name || order.waiter_name || fiscal.operator_name || "";
  const operatorId = order.operator_id || fiscal.operator_id || "";

  const { date, time } = formatFiscalDateTime(
    order.closed_at || order.fiscal_date || fiscal.fiscal_date || order.created_at
  );
  const timeStr =
    fiscal.fiscal_time || order.fiscal_time
      ? String(fiscal.fiscal_time || order.fiscal_time).slice(0, 5)
      : time;
  const dateStr = fiscal.fiscal_date && /^\d{2}\.\d{2}\.\d{4}$/.test(String(fiscal.fiscal_date))
    ? String(fiscal.fiscal_date)
    : date;

  const dailyNumber = fiscal.daily_number ?? order.daily_number ?? "";
  const totalNumber = fiscal.total_number ?? order.total_number ?? "";
  let nuikf = String(fiscal.nuikf || "").trim().toUpperCase();
  if (/^\d{8}-\d{6}$/.test(nuikf) || !/^[A-Z0-9]{16}$/.test(nuikf)) {
    try {
      nuikf = String(generateNUIKF() || "")
        .trim()
        .toUpperCase();
    } catch {
      nuikf = "";
    }
  }
  let sefId = fiscal.sef_id || fiscal.sef_identifier || order.sef_id || "";
  if (!sefId) {
    sefId = getSefIdentifier() || "";
  }

  const subtotal = Number(
    order.subtotal ?? fiscal.subtotal ?? order.subtotal_before_discount ?? 0
  );
  const discount = Number(order.discount_amount ?? order.discount_total ?? fiscal.discount_amount ?? 0);
  const totalPay = Number(
    order.total_amount ?? order.total ?? fiscal.total_amount ?? subtotal - discount
  );
  const totalWithoutTax = Number(
    order.total_without_tax ?? fiscal.total_without_tax ?? totalPay
  );

  const vatBreak = resolveVatTaxForPrint(
    items,
    fiscal.vat_breakdown || order.vat_breakdown || null
  );

  const paymentMethod = order.payment_method || fiscal.payment_method || "cash";
  const paidAmount = Number(order.amount_paid ?? order.paid_amount ?? totalPay);
  const totalRounded = Math.round(totalPay * 100) / 100;
  const paidRounded = Math.round(paidAmount * 100) / 100;
  const changeDue = Math.round((paidRounded - totalRounded) * 100) / 100;

  const lines = [];

  // 1) Emri biznesit — bold + qendër, madhësi NORMALE (pa GS ! 0x11 / ^L)
  lines.push(`^C^B${pad(String(brandName).toUpperCase(), w, "center")}`);
  // 2) Emri i njësisë / degës (ATK Neni 25) — rresht i veçantë
  if (unitName) {
    lines.push(`^C${pad(unitName, w, "center")}`);
  }
  // 3) Emri ligjor (nëse ndryshon nga brand)
  if (
    legalName &&
    String(legalName).trim().toUpperCase() !== String(brandName).trim().toUpperCase()
  ) {
    lines.push(`^C${pad(legalName, w, "center")}`);
  }
  for (const al of addressLines) {
    lines.push(`^C${pad(al, w, "center")}`);
  }
  if (unitPhone) {
    lines.push(`^C${pad(`${t("phone_label")} ${unitPhone}`, w, "center")}`);
  }
  if (city) {
    lines.push(`^C${pad(city, w, "center")}`);
  }

  lines.push("");
  lines.push(`^C${pad(`${t("fiscal_no_label")} ${nui || "-"}`, w, "center")}`);
  lines.push(`^C${pad(`${t("vat_no_label")} ${vatNo || "-"}`, w, "center")}`);
  lines.push("");

  lines.push(`${t("operator")} ${operatorName}${operatorId ? ` (ID: ${operatorId})` : ""}`);
  lines.push(`${t("date_label")} ${dateStr} ${t("time_label")} ${timeStr}`);
  if (isOffline) {
    lines.push(`^C${pad(t("offline"), w, "center")}`);
  }
  if (isCorrective) {
    lines.push(`^C${pad(t("receipt_corrective"), w, "center")}`);
    const orig = fiscal.original_nuikf || order.original_nuikf || "";
    lines.push(`${t("reference")} NUIKF ${orig || "-"}`);
    lines.push(`${t("coupon_type")} ${receiptTypeLabel(receiptType)}`);
    const reason = String(
      fiscal.correction_reason || order.correction_reason || ""
    ).trim();
    if (reason) {
      lines.push(`${t("reason_label")}: ${reason}`);
    }
  }

  lines.push(divider("-", w));
  lines.push(
    padLine(
      `${t("item")}  ${t("qty")}  ${t("price")}`,
      `${t("value")}  ${t("vat")}`,
      w
    )
  );
  for (const item of items) {
    lines.push(formatItemRow(item, w));
    const ld = Number(item.line_discount_amount) || 0;
    const ls = Number(item.line_surcharge_amount) || 0;
    if (ld > 0) {
      lines.push(padLine(`  ${t("line_discount")}:`, `-${moneyAmt(ld)}`, w));
    }
    if (ls > 0) {
      lines.push(padLine(`  ${t("line_surcharge")}:`, `+${moneyAmt(ls)}`, w));
    }
  }

  lines.push(divider("-", w));
  const surcharge = Number(
    order.surcharge_amount ?? fiscal.surcharge_amount ?? 0
  );
  if (discount > 0) {
    lines.push(padLine(`${t("discount")}:`, `-${moneyAmt(discount)}`, w));
  }
  if (surcharge > 0) {
    lines.push(padLine(`${t("surcharge")}:`, `+${moneyAmt(surcharge)}`, w));
  }
  // TOTALI — bold (ESC E/G global), madhësi normale — gjithmonë përmes t()
  lines.push(`^B${padLine(`${t("TOTALI_NE_EURO")}:`, moneyAmt(totalRounded), w)}`);
  // Pagesa — një metodë ose e përzier (Cash + POS + Voucher/Çek)
  const splits = Array.isArray(order.payment_splits)
    ? order.payment_splits
    : Array.isArray(fiscal.payment_splits)
      ? fiscal.payment_splits
      : [];
  if (splits.length > 1) {
    for (const sp of splits) {
      const amt = Number(sp.amount) || 0;
      if (amt <= 0) continue;
      lines.push(
        `^B${padLine(paymentLabelSq(sp.method), moneyAmt(amt), w)}`
      );
      lines.push(
        `${t("payment_method_line")} ${atkPaymentModeShort(sp.method)}`
      );
    }
  } else {
    const payLabel = paymentLabelSq(paymentMethod);
    lines.push(`^B${padLine(payLabel, moneyAmt(paidRounded), w)}`);
    lines.push(
      `${t("payment_method_line")} ${atkPaymentModeShort(paymentMethod)}`
    );
  }
  if (isCashPayment(paymentMethod) && changeDue > 0.004 && splits.length <= 1) {
    lines.push(padLine(`${t("change_due")}:`, moneyAmt(changeDue), w));
  }

  lines.push("");
  appendPositiveVatRateLines(lines, vatBreak, w, items);
  lines.push(padLine(`${t("TOT_PA_TVSH")}:`, moneyAmt(totalWithoutTax), w));

  lines.push(divider("-", w));
  // Hapësirë pas ^B — që NUIKF: të mbetet fjalë e qartë (jo ^BNUIKF:)
  lines.push(`^B ${t("nuikf_label")} ${nuikf || "-"}`);
  lines.push(`${t("sef_no")} ${sefId || "-"}`);
  // (a) Numri rendor total — nuk rifillon kurrë
  lines.push(
    `^C^B${pad(`${t("fiscal_coupon_nr")} ${totalNumber !== "" ? totalNumber : "-"}`, w, "center")}`
  );
  // (b) Numri ditor — rifillon pas Z / ditë e re
  lines.push(
    `^C${pad(`${t("fiscal_coupon_daily_nr")} ${dailyNumber !== "" ? dailyNumber : "-"}`, w, "center")}`
  );
  // Shtojca F — "e-kuponi" pranë logos RKS/MF (logo si imazh pas QR)
  lines.push(`^C${pad(t("e_kuponi"), w, "center")}`);
  lines.push("");
  // QR → logo RKS/MF: fiscal-main.js

  let text = lines.join("\n") + "\n";
  // Njësia: deri 4 presje; totalet: 2. Ruaj datat DD.MM.YYYY.
  text = text.replace(/\b(\d+)\.(\d+)\b/g, (full, whole, frac, offset, src) => {
    const before = src.slice(Math.max(0, offset - 3), offset);
    const after = src.slice(offset + full.length, offset + full.length + 5);
    // Data: DD.MM.YYYY
    if (/^\d{2}$/.test(whole) && /^\d{2}$/.test(frac) && /^\.\d{4}\b/.test(after)) {
      return full;
    }
    if (/^\d{2}\.\d{2}$/.test(`${before.slice(-2)}.${whole}`) && /^\d{4}\b/.test(frac + after)) {
      return full;
    }
    if (frac.length <= 2) {
      return `${whole}.${frac.padEnd(2, "0")}`;
    }
    if (frac.length <= 4) {
      return `${whole}.${frac.padEnd(4, "0").slice(0, 4)}`;
    }
    return formatUnitPrice(`${whole}.${frac}`);
  });
  const moneyProbe = text
    .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, "")
    .replace(/\b\d{1,2}:\d{2}\b/g, "");
  if (/\d+\.\d{5,}/.test(moneyProbe)) {
    throw new Error("Kupon fiskal: çmim me më shumë se 4 presje dhjetore");
  }
  const { assertGeneratedReceiptText } = require("./fiscal-receipt-guard");
  assertGeneratedReceiptText(text);
  return text;
}

module.exports = {
  WIDTH,
  pad,
  padLine,
  divider,
  resolvePrintWidth,
  paymentLabelSq,
  moneyEur: (v) => moneyAmt(v),
  moneyAmt,
  generateFiscalReceipt,
};
