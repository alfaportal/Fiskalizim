/**
 * fiscal/fiscal-print.js — HAPI 6: gjenerimi i tekstit të kuponit fiskal (layout ATK).
 * NUK printon — vetëm kthen stringun. Thirret kur isFiscalEnabled()=true.
 * ESC/POS: ESC E/G (bold) për krejt; emri biznesit bold + madhësi NORMALE (pa GS ! 0x11).
 */
const { isFiscalEnabled } = require("./fiscal-config");
const {
  round4,
  lineTotalAmount,
  normalizeQty,
  normalizeUnitPrice,
  getVatNormLetter,
  calculateVatTaxBreakdown,
} = require("./fiscal-vat");
const { getSefIdentifier, generateNUIKF } = require("./fiscal-numbering");
const { formatHashShort } = require("./fiscal-hash-chain");
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

/** Vijë e plotë termike — `-` (=` shpesh nuk shihet në Tysso). */
function atkBar(width = WIDTH, char = "-") {
  const c = char === "=" ? "-" : char;
  return receiptDivider(width, c);
}

/** Vijë e dukshme në printer termik — një rresht ^B bold (jo 3 rreshta). */
function appendAtkRule(lines, width = WIDTH, opts = {}) {
  const bar = atkBar(width, opts.char || "-");
  lines.push(`^B${bar}`);
  if (opts.double === true) {
    lines.push(`^B${bar}`);
  }
}

/** @deprecated — përdor appendAtkRule */
function atkLine(width = WIDTH) {
  return `^B${atkBar(width)}`;
}

/** Vijë para footer-it (ARTIKUJ) — e plotë, jo `- - -` (nuk shihet në Tysso). */
function dividerDashed(width = WIDTH) {
  return `^B${atkBar(width)}`;
}

/** Shtojca F — kolona fikse si origjinali ATK (42 char / 80mm). */
function atkColWidths(width = WIDTH) {
  if (width >= 42) {
    return { nameW: 12, midW: 18, sumW: 12 };
  }
  if (width >= 32) {
    return { nameW: 9, midW: 14, sumW: 9 };
  }
  const nameW = Math.max(8, Math.floor(width * 0.28));
  const sumW = Math.max(8, Math.floor(width * 0.29));
  const midW = Math.max(10, width - nameW - sumW);
  return { nameW, midW, sumW };
}

/** Emri artikullit — kufi i rreptë (12 char / 80mm). Pa "..." — vetëm germa deri në fund të kolonës (Shtojca F). */
function truncateAtkColText(text, maxLen) {
  const s = String(text ?? "").trim();
  if (maxLen <= 0) return "";
  return s.slice(0, maxLen);
}

/** Tre kolona: ARTIKULLI (majtas) | SASIA X CMIMI (qendër) | SHUMA (djathtas). */
function padThreeCol(left, center, right, width = WIDTH) {
  const { nameW, midW, sumW } = atkColWidths(width);
  const l = truncateAtkColText(left, nameW);
  const c = pad(String(center ?? ""), midW, "center").slice(0, midW);
  const r = pad(String(right ?? ""), sumW, "right").slice(0, sumW);
  return `${pad(l, nameW, "left").slice(0, nameW)}${c}${r}`;
}

/** Markera — qendër + lartësi +1 + bold (logo, KUPON FISKAL). */
const ATK_TITLE_CENTER = "^C^H^B";
/** Markera — lartësi +1 + bold (TOTALI PER PAGESE — ^H hequr: € i njëjtë me numrat). */
const ATK_EMPHASIS = "^B";

/** Hapësirë vertikale (frymë) si origjinali ATK. */
function atkGap(lines, count = 1) {
  for (let i = 0; i < count; i += 1) {
    lines.push("");
  }
}

function resolvePrintOfflineBanner(order, fiscal) {
  const o = order && typeof order === "object" ? order : {};
  const f = fiscal && typeof fiscal === "object" ? fiscal : {};
  if (
    f.local_only === true ||
    f.is_local_only === true ||
    o.local_only === true ||
    o.is_local_only === true
  ) {
    return false;
  }
  return (
    f.print_offline_banner === true ||
    f.print_offline_banner === 1 ||
    o.print_offline_banner === true ||
    o.print_offline_banner === 1
  );
}

/** Vetëm pa internet — jo LOKAL/test. Shkruan OFFLINE (pa prefiks ATK). */
function appendOfflineBanner(lines, width) {
  atkGap(lines);
  lines.push(`${ATK_TITLE_CENTER}${pad("OFFLINE", width, "center")}`);
  atkGap(lines);
}

/** Rresht i centruar — TATIMPAGUESI, ADRESA, etj. (madhësi normale). */
function appendAtkCenterLine(lines, text, width) {
  lines.push(pad(String(text ?? ""), width, "center"));
}

/** Çmimi njësi — 2 presje + simboli € */
function formatAtkUnitPrice(price) {
  return `${moneyPrint(price)} €`;
}

/** Çmimi për shfaqje në kupon — çmimi i raftit / bruto, jo neto 4-presje. */
function resolveAtkReceiptUnitPrice(item, opts = {}) {
  const ld = Number(item.line_discount_amount) || 0;
  const ls = Number(item.line_surcharge_amount) || 0;
  const useGross = !!opts.gross || ld > 0 || ls > 0;
  if (useGross) {
    return round2Print(itemGrossUnit(item));
  }
  const shelf =
    item?.base_price != null && Number(item.base_price) > 0
      ? Number(item.base_price)
      : itemUnit(item);
  return round2Print(shelf);
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
  if (v === "debit_card") return t("payment_mode_debit");
  if (v === "credit_card") return t("payment_mode_credit");
  if (
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
  if (v === "sms") return t("payment_mode_sms");
  if (v === "bank_account") return t("payment_mode_bank");
  return t("payment_mode_other");
}

/** Për pagesë të përzier — liston të gjitha mënyrat e përdorura (p.sh. KESH + DEBIT + SMS). */
function formatPaymentMethodsSummary(splits) {
  const seen = new Set();
  const labels = [];
  for (const sp of splits || []) {
    const label = atkPaymentModeShort(sp?.method);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels.length ? labels.join(" + ") : t("mixed_payment");
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
 * Shfaqje në letër (klienti) — 2 presje.
 * Llogaritja fiskale / ATK mbetet me round4 (4 dec) — vetëm teksti i printuar ndryshon.
 */
function round2Print(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function moneyPrint(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return round2Print(n).toFixed(2);
}

function formatUnitPricePrint(price) {
  return moneyPrint(price);
}

function formatQtyPrint(qty) {
  const n = normalizeQty(qty);
  if (Number.isInteger(n)) return String(n);
  return moneyPrint(n);
}

function parseJsonField(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function parseOrderItemsPayload(raw) {
  if (Array.isArray(raw)) return { items: raw, payment_splits: [] };
  if (typeof raw === "string") {
    const parsed = parseJsonField(raw, null);
    if (Array.isArray(parsed)) return { items: parsed, payment_splits: [] };
    if (parsed && typeof parsed === "object") {
      return {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        payment_splits: Array.isArray(parsed.payment_splits) ? parsed.payment_splits : [],
      };
    }
    return { items: [], payment_splits: [] };
  }
  if (raw && typeof raw === "object") {
    return {
      items: Array.isArray(raw.items) ? raw.items : [],
      payment_splits: Array.isArray(raw.payment_splits) ? raw.payment_splits : [],
    };
  }
  return { items: [], payment_splits: [] };
}

function computeAdjAmountPrint(base, type, value) {
  const t0 = String(type || "none")
    .trim()
    .toLowerCase();
  const v = Number(value) || 0;
  if (!t0 || t0 === "none" || v <= 0) return 0;
  if (t0 === "percent" || t0 === "pct" || t0 === "%") {
    return round2Print((Number(base) || 0) * (v / 100));
  }
  return round2Print(v);
}

function pickAdjMeta(item, kind) {
  if (!item || typeof item !== "object") return null;
  const fromObj =
    kind === "discount"
      ? item.line_discount ||
        (item.discount_type
          ? { type: item.discount_type, value: item.discount_value }
          : null)
      : item.line_surcharge ||
        (item.surcharge_type
          ? { type: item.surcharge_type, value: item.surcharge_value }
          : null);
  if (!fromObj || typeof fromObj !== "object") return null;
  const type = String(fromObj.type || "")
    .trim()
    .toLowerCase();
  const value = Number(fromObj.value);
  if (!type || type === "none" || !Number.isFinite(value) || value <= 0) return null;
  return { type, value };
}

function resolveSaleId(order, fiscal) {
  const raw =
    order.sale_id ??
    order.order_id ??
    fiscal.sale_id ??
    fiscal.order_id ??
    null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function loadFiscalReceiptRowHints(order, fiscal) {
  try {
    const nuikf = String(fiscal.nuikf || order.nuikf || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9]{16}$/.test(nuikf)) return null;
    const { isFiscalMemoryOnly } = require("./fiscal-test-mode-store");
    if (isFiscalMemoryOnly()) return null;
    const db = require("../database");
    const sqlite = db.db;
    return (
      sqlite
        .prepare(
          `SELECT sale_id, payment_splits_json FROM fiscal_receipts WHERE nuikf = ? LIMIT 1`
        )
        .get(nuikf) || null
    );
  } catch {
    return null;
  }
}

function loadSaleOrderPayload(order, fiscal) {
  try {
    const hints = loadFiscalReceiptRowHints(order, fiscal);
    const saleId = resolveSaleId(order, fiscal) || Number(hints?.sale_id) || null;
    if (!saleId) return { items: [], payment_splits: [] };
    const db = require("../database");
    if (typeof db.getOrder !== "function") return { items: [], payment_splits: [] };
    const row = db.getOrder(saleId);
    if (!row?.items_json) return { items: [], payment_splits: [] };
    return parseOrderItemsPayload(row.items_json);
  } catch {
    return { items: [], payment_splits: [] };
  }
}

/** Pasuron artikullin vetëm për tekstin e printuar (pa ndryshuar logjikën e shitjes). */
function enrichItemForPrint(item) {
  const qty = normalizeQty(itemQty(item));
  const netUnit = normalizeUnitPrice({ unit_price: itemUnit(item) });
  const discMeta = pickAdjMeta(item, "discount");
  const surMeta = pickAdjMeta(item, "surcharge");

  let baseUnit =
    item?.base_price != null && Number(item.base_price) > 0
      ? normalizeUnitPrice({ unit_price: Number(item.base_price) })
      : null;

  let ld = round2Print(
    Number(item.line_discount_amount ?? item.lineDiscountAmount ?? 0) || 0
  );
  let ls = round2Print(
    Number(item.line_surcharge_amount ?? item.lineSurchargeAmount ?? 0) || 0
  );

  const grossBase =
    baseUnit != null ? round2Print(baseUnit * qty) : round2Print(netUnit * qty);

  if (ld <= 0 && discMeta) {
    ld = computeAdjAmountPrint(grossBase, discMeta.type, discMeta.value);
  }
  if (ls <= 0 && surMeta) {
    ls = computeAdjAmountPrint(grossBase, surMeta.type, surMeta.value);
  }

  if (baseUnit == null) {
    if (ld > 0 && qty > 0) baseUnit = round4(netUnit + ld / qty);
    else if (ls > 0 && qty > 0) baseUnit = round4(netUnit - ls / qty);
    else baseUnit = netUnit;
  }

  if (ld <= 0 && ls <= 0 && qty > 0 && baseUnit > netUnit + 0.0005) {
    ld = round2Print((baseUnit - netUnit) * qty);
  }
  if (ls <= 0 && ld <= 0 && qty > 0 && netUnit > baseUnit + 0.0005) {
    ls = round2Print((netUnit - baseUnit) * qty);
  }

  const enriched = { ...item };
  enriched.quantity = qty;
  enriched.qty = qty;
  enriched.unit_price = netUnit;
  enriched.price = netUnit;
  enriched.base_price = baseUnit;
  if (ld > 0) {
    enriched.line_discount_amount = ld;
    if (discMeta) enriched.line_discount = discMeta;
    else {
      const inferred = inferPercentFromAmount(ld, grossBase);
      if (inferred != null) {
        enriched.line_discount = { type: "percent", value: inferred };
      }
    }
  }
  if (ls > 0) {
    enriched.line_surcharge_amount = ls;
    if (surMeta) enriched.line_surcharge = surMeta;
    else {
      const inferred = inferPercentFromAmount(ls, grossBase);
      if (inferred != null) {
        enriched.line_surcharge = { type: "percent", value: inferred };
      }
    }
  }
  return enriched;
}

/** Kupon korrigjues: vetëm çmimi neto i shitjes/kthimit — pa zbritje të nxjerrë nga shitja origjinale. */
function enrichItemForPrintNetOnly(item) {
  const qty = normalizeQty(itemQty(item));
  const netUnit = normalizeUnitPrice({ unit_price: itemUnit(item) });
  const enriched = { ...item };
  enriched.quantity = qty;
  enriched.qty = qty;
  enriched.unit_price = netUnit;
  enriched.price = netUnit;
  enriched.base_price = netUnit;
  enriched.line_discount_amount = 0;
  enriched.line_surcharge_amount = 0;
  delete enriched.line_discount;
  delete enriched.line_surcharge;
  delete enriched.discount_type;
  delete enriched.discount_value;
  delete enriched.surcharge_type;
  delete enriched.surcharge_value;
  return enriched;
}

function isCorrectiveReceiptType(order, fiscal) {
  const receiptType = String(fiscal?.receipt_type || order?.receipt_type || "regular")
    .trim()
    .toLowerCase();
  return receiptType !== "regular";
}

function mergeItemPrintHints(item, hint) {
  if (!hint || typeof hint !== "object") return item;
  return {
    ...item,
    base_price: item.base_price ?? hint.base_price ?? hint.price,
    line_discount_amount: item.line_discount_amount ?? hint.line_discount_amount,
    line_surcharge_amount: item.line_surcharge_amount ?? hint.line_surcharge_amount,
    line_discount: item.line_discount ?? hint.line_discount,
    line_surcharge: item.line_surcharge ?? hint.line_surcharge,
    discount_type: item.discount_type ?? hint.discount_type,
    discount_value: item.discount_value ?? hint.discount_value,
    surcharge_type: item.surcharge_type ?? hint.surcharge_type,
    surcharge_value: item.surcharge_value ?? hint.surcharge_value,
  };
}

function enrichItemsForPrint(rawItems, order, fiscal) {
  const list = Array.isArray(rawItems) ? rawItems.map((it) => ({ ...it })) : [];
  if (isCorrectiveReceiptType(order, fiscal)) {
    return list.map(enrichItemForPrintNetOnly);
  }

  const salePayload = loadSaleOrderPayload(order, fiscal);
  const saleItems = salePayload.items || [];

  const merged = list.map((it, idx) => {
    const byIndex = saleItems[idx];
    const byName = saleItems.find(
      (s) => String(s?.name || "").trim() === String(it?.name || "").trim()
    );
    const hint =
      byIndex &&
      String(byIndex?.name || "").trim() === String(it?.name || "").trim()
        ? byIndex
        : byName || null;
    return hint ? mergeItemPrintHints(it, hint) : it;
  });

  return merged.map(enrichItemForPrint);
}

function normalizeSplitMethod(method) {
  const v = String(method || "cash")
    .trim()
    .toLowerCase();
  if (["card", "karte", "kartë", "pos", "debit", "credit"].includes(v)) return "card";
  if (v === "debit_card") return "debit_card";
  if (v === "credit_card") return "credit_card";
  if (v === "cheque" || v === "cek" || v === "çek") return "check";
  return v || "cash";
}

/** Etiketë për ndarjen e pagesës (Cash, Kartelë, SMS, Voucher, …). */
function paymentSplitPrintLabel(method) {
  const v = normalizeSplitMethod(method);
  if (v === "cash" || v === "gotovina") return t("pay_cash");
  if (v === "debit_card") return t("pay_debit");
  if (v === "credit_card") return t("pay_credit");
  if (v === "card" || v === "karte" || v === "pos") return t("pay_debit");
  if (v === "voucher" || v === "vaucer") return t("pay_voucher");
  if (v === "check") return t("pay_check");
  if (v === "bank_account") return t("pay_bank");
  if (v === "sms") return t("pay_sms");
  return paymentLabelSq(method);
}

function resolvePaymentSplits(order, fiscal) {
  const collected = [];
  const pushUnique = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const sp of arr) collected.push(sp);
  };

  pushUnique(order.payment_splits);
  if (!collected.length) pushUnique(fiscal.payment_splits);

  if (!collected.length) {
    pushUnique(parseJsonField(order.payment_splits_json, []));
  }
  if (!collected.length) {
    pushUnique(parseJsonField(fiscal.payment_splits_json, []));
  }

  if (!collected.length) {
    const hints = loadFiscalReceiptRowHints(order, fiscal);
    if (hints?.payment_splits_json) {
      pushUnique(parseJsonField(hints.payment_splits_json, []));
    }
  }

  if (!collected.length) {
    const salePayload = loadSaleOrderPayload(order, fiscal);
    pushUnique(salePayload.payment_splits);
  }

  return collected
    .map((p) => ({
      method: normalizeSplitMethod(p?.method ?? p?.id),
      amount: round2Print(Number(p?.amount) || 0),
    }))
    .filter((p) => p.amount > 0);
}

function isPercentDiscountType(type) {
  const t0 = String(type || "")
    .trim()
    .toLowerCase();
  return t0 === "percent" || t0 === "pct" || t0 === "%";
}

/** Nëse lloji mungon, provo të nxjerrë % nga shuma dhe baza (p.sh. 10% e 12.00 = 1.20). */
function inferPercentFromAmount(amount, baseAmount) {
  const amt = Number(amount) || 0;
  const base = Number(baseAmount) || 0;
  if (amt <= 0 || base <= 0) return null;
  const pct = Math.round((amt / base) * 10000) / 100;
  const computed = Math.round((base * pct) / 100 * 100) / 100;
  if (Math.abs(computed - round2Print(amt)) <= 0.011) return pct;
  return null;
}

/**
 * Etiketë zbritje/rritje: "Zbritje 10%:" / "Rritje 5%:" / etj.
 */
function formatAdjustLabel(baseLabel, meta, amount, baseAmount) {
  const label = String(baseLabel || "Zbritje").trim();
  const type = meta?.type;
  const value = Number(meta?.value);
  if (isPercentDiscountType(type) && value > 0) {
    return `${label} ${value}%:`;
  }
  if (String(type || "").toLowerCase() === "value" && value > 0) {
    return `${label} ${moneyPrint(value)}:`;
  }
  const inferred = inferPercentFromAmount(amount, baseAmount);
  if (inferred != null) {
    return `${label} ${inferred}%:`;
  }
  return `${label}:`;
}

/** Çmimi origjinal njësi (para zbritjes së rreshtit). */
function itemGrossUnit(item) {
  const qty = normalizeQty(itemQty(item));
  if (item?.base_price != null && Number(item.base_price) > 0) {
    return normalizeUnitPrice({ unit_price: Number(item.base_price) });
  }
  const netUnit = normalizeUnitPrice({ unit_price: itemUnit(item) });
  const ld = Number(item.line_discount_amount) || 0;
  const ls = Number(item.line_surcharge_amount) || 0;
  if (qty > 0) {
    if (ld > 0) return round4(netUnit + ld / qty);
    if (ls > 0) return round4(netUnit - ls / qty);
  }
  return netUnit;
}

/**
 * Rresht artikulli: emri … sasia  çmimi  vlera  TVSH
 * Me zbritje rreshti → çmimi/totali bruto (origjinal).
 */
function formatItemRow(item, width = WIDTH, opts = {}) {
  const qty = normalizeQty(itemQty(item));
  const ld = Number(item.line_discount_amount) || 0;
  const ls = Number(item.line_surcharge_amount) || 0;
  const useGross = !!opts.gross || ld > 0 || ls > 0;
  const unit = useGross
    ? itemGrossUnit(item)
    : normalizeUnitPrice({ unit_price: itemUnit(item) });
  const lineTotal = lineTotalAmount(qty, unit);
  const unitStr = formatUnitPricePrint(unit);
  const valStr = moneyPrint(lineTotal);
  const letter = itemVatLetter(item);
  const qtyStr = formatQtyPrint(qty);
  const tail = `${qtyStr}  ${unitStr}  ${valStr}  ${letter}`;
  const nameMax = Math.max(4, width - tail.length - 1);
  let name = String(item.name || item.emri || "").trim() || "-";
  if (name.length > nameMax) {
    name = `${name.slice(0, Math.max(3, nameMax - 1))}…`;
  }
  const gap = Math.max(1, width - name.length - tail.length);
  return `${name}${" ".repeat(gap)}${tail}`;
}

function appendLineDiscountDetailLines(lines, item, width) {
  const ld = Number(item.line_discount_amount) || 0;
  if (ld <= 0) return;
  const qty = normalizeQty(itemQty(item));
  const grossTotal = lineTotalAmount(qty, itemGrossUnit(item));
  const netTotal = lineTotalAmount(
    qty,
    normalizeUnitPrice({ unit_price: itemUnit(item) })
  );
  const letter = itemVatLetter(item);
  const discLabel = formatAdjustLabel(
    t("discount_line_short"),
    item.line_discount,
    ld,
    grossTotal
  );
  lines.push(padLine(`  ${discLabel}`, `-${moneyAmt(ld)}`, width));
  lines.push(
    padLine(`  ${t("after_discount")}:`, `${moneyAmt(netTotal)} ${letter}`, width)
  );
}

function appendLineSurchargeDetailLines(lines, item, width) {
  const ls = Number(item.line_surcharge_amount) || 0;
  if (ls <= 0) return;
  const qty = normalizeQty(itemQty(item));
  const grossTotal = lineTotalAmount(qty, itemGrossUnit(item));
  const netTotal = lineTotalAmount(
    qty,
    normalizeUnitPrice({ unit_price: itemUnit(item) })
  );
  const letter = itemVatLetter(item);
  const surLabel = formatAdjustLabel(
    t("surcharge_line_short"),
    item.line_surcharge,
    ls,
    grossTotal
  );
  lines.push(padLine(`  ${surLabel}`, `+${moneyAmt(ls)}`, width));
  lines.push(
    padLine(`  ${t("after_surcharge")}:`, `${moneyAmt(netTotal)} ${letter}`, width)
  );
}

/** Shuma në kupon (letër) — 2 presje. */
function moneyAmt(v) {
  return moneyPrint(v);
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
    A: round4(Number(vatBreak?.A ?? vatBreak?.a ?? 0)),
    B: round4(Number(vatBreak?.B ?? vatBreak?.b ?? 0)),
    C: round4(Number(vatBreak?.C ?? vatBreak?.c ?? 0)),
    D: round4(Number(vatBreak?.D ?? vatBreak?.d ?? 0)),
    E: round4(Number(vatBreak?.E ?? vatBreak?.e ?? 0)),
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
      A: round4(Number(raw.A ?? raw.a ?? 0)),
      B: round4(Number(raw.B ?? raw.b ?? 0)),
      C: round4(Number(raw.C ?? raw.c ?? 0)),
      D: round4(Number(raw.D ?? raw.d ?? 0)),
      E: round4(Number(raw.E ?? raw.e ?? 0)),
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
  const comma = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (comma.length >= 2) {
    return { lines: [comma.slice(0, -1).join(", ")], city: comma[comma.length - 1] };
  }
  return { lines: [raw], city: "" };
}

function formatAtkDateSlash(dateStr) {
  return String(dateStr || "").replace(/\./g, "/");
}

function formatAtkSerialNumber(n) {
  if (n === "" || n == null) return "-";
  const num = Number(n);
  if (Number.isFinite(num) && num >= 0) {
    return String(Math.floor(num)).padStart(10, "0");
  }
  const s = String(n).replace(/\D/g, "");
  return s ? s.padStart(10, "0") : String(n);
}

function formatAtkDailyNumber(n) {
  if (n === "" || n == null) return "-";
  const num = Number(n);
  if (Number.isFinite(num) && num >= 0) {
    return String(Math.floor(num)).padStart(4, "0");
  }
  return String(n);
}

function formatAtkMoneyEuro(v) {
  return `${moneyAmt(v)} €`;
}

/** Etiketë bold (^B) — vetëm markerët ^ (jo ESC raw) që printeri i njeh. */
function padLineBoldLabelNormalAmount(label, amount, width = WIDTH) {
  const l = String(label ?? "");
  const r = String(amount ?? "");
  const gap = Math.max(1, width - l.length - r.length);
  return `^B${l}${" ".repeat(gap)}${r}`;
}

function formatAtkUljeLabel(meta, amount, baseAmount) {
  const type = meta?.type;
  const value = Number(meta?.value);
  if (isPercentDiscountType(type) && value > 0) {
    return `${t("discount_cart")} ${value}%`;
  }
  if (String(type || "").toLowerCase() === "value" && value > 0) {
    return `${t("discount_cart")} ${moneyAmt(value)}`;
  }
  const inferred = inferPercentFromAmount(amount, baseAmount);
  if (inferred != null) return `${t("discount_cart")} ${inferred}%`;
  return t("discount_cart");
}

function formatAtkLineUljeLabel(meta, amount, baseAmount) {
  const type = meta?.type;
  let value = Number(meta?.value);
  if (isPercentDiscountType(type) && value > 0) {
    if (value > 0 && value <= 1) value = Math.round(value * 10000) / 100;
    const pct =
      Number.isInteger(value) || Math.abs(value - Math.round(value)) < 0.001
        ? Math.round(value)
        : Math.round(value * 100) / 100;
    return `${t("discount_line_word")} ${pct}%`;
  }
  if (String(type || "").toLowerCase() === "value" && value > 0) {
    return `${t("discount_line_word")} ${moneyAmt(value)}`;
  }
  const inferred = inferPercentFromAmount(amount, baseAmount);
  if (inferred != null) {
    const pct =
      Number.isInteger(inferred) || Math.abs(inferred - Math.round(inferred)) < 0.001
        ? Math.round(inferred)
        : inferred;
    return `${t("discount_line_word")} ${pct}%`;
  }
  return t("discount_line_word");
}

function formatAtkLineRritjeLabel(meta, amount, baseAmount) {
  const type = meta?.type;
  let value = Number(meta?.value);
  if (isPercentDiscountType(type) && value > 0) {
    if (value > 0 && value <= 1) value = Math.round(value * 10000) / 100;
    const pct =
      Number.isInteger(value) || Math.abs(value - Math.round(value)) < 0.001
        ? Math.round(value)
        : Math.round(value * 100) / 100;
    return `${t("surcharge_line_word")} ${pct}%`;
  }
  if (String(type || "").toLowerCase() === "value" && value > 0) {
    return `${t("surcharge_line_word")} ${moneyAmt(value)}`;
  }
  const inferred = inferPercentFromAmount(amount, baseAmount);
  if (inferred != null) {
    const pct =
      Number.isInteger(inferred) || Math.abs(inferred - Math.round(inferred)) < 0.001
        ? Math.round(inferred)
        : inferred;
    return `${t("surcharge_line_word")} ${pct}%`;
  }
  return t("surcharge_line_word");
}

/** Kolona SHUMA — i njëjti format gjerësie si artikujt (€ / TVSH). */
function formatAtkSumCol(amount, opts = {}) {
  const negative = !!opts.negative;
  const noEuro = !!opts.noEuro;
  const letter = String(opts.letter || "").trim();
  const abs = moneyPrint(Math.abs(Number(amount) || 0));
  if (negative) {
    if (noEuro) return letter ? `-${abs} ${letter}` : `-${abs}`;
    return letter ? `-${abs} ${letter}` : `-${abs}€`;
  }
  if (noEuro) return letter ? `${abs} ${letter}` : abs;
  return letter ? `${abs} ${letter}` : `${abs}€`;
}

function couponTitleForReceiptType(rt) {
  const type = String(rt || "regular").trim().toLowerCase();
  if (type === "return") return t("receipt_fiscal_return");
  if (type === "cancel" || type === "storno") return t("receipt_fiscal_cancelled");
  return t("receipt_fiscal");
}

function formatOriginalCouponRefLine(original, fallback = {}) {
  const totalNum =
    original?.total_number ??
    fallback.original_total_number ??
    fallback.original_total ??
    null;
  if (totalNum === null || totalNum === "") return "";
  const nr = formatAtkSerialNumber(totalNum);
  const d = formatAtkDateSlash(
    original?.fiscal_date ||
      fallback.original_fiscal_date ||
      fallback.fiscal_date ||
      ""
  );
  const tm = String(
    original?.fiscal_time ||
      fallback.original_fiscal_time ||
      fallback.fiscal_time ||
      ""
  ).slice(0, 5);
  return `${t("atk_coupon_nr")} ${nr} ${t("atk_date_label")}: ${d} ${tm}`;
}

/** Kthim — NR. dhe DATE në rreshta të veçantë (Shtojca F). */
function appendOriginalCouponRefLines(lines, width, original, fallback = {}, opts = {}) {
  const totalNum =
    original?.total_number ??
    fallback.original_total_number ??
    fallback.original_total ??
    null;
  if (totalNum === null || totalNum === "") return;
  const nr = formatAtkSerialNumber(totalNum);
  const d = formatAtkDateSlash(
    original?.fiscal_date ||
      fallback.original_fiscal_date ||
      fallback.fiscal_date ||
      ""
  );
  const tm = String(
    original?.fiscal_time ||
      fallback.original_fiscal_time ||
      fallback.fiscal_time ||
      ""
  ).slice(0, 5);
  if (opts.splitDate) {
    lines.push(`${t("atk_coupon_nr")} ${nr}`);
    lines.push(padLine(t("atk_date_label"), `${d} ${tm}`, width));
    return;
  }
  lines.push(`${t("atk_coupon_nr")} ${nr} ${t("atk_date_label")}: ${d} ${tm}`);
}

/** Përmbledhje kthimi — TOTALI I KTHIMIT + TOTALI I MBETUR (origjinali ATK). */
function appendAtkReturnSummary(lines, width, returnTotal, remaining) {
  appendAtkRule(lines, width);
  lines.push(padLine(t("atk_return_total"), `-${moneyAmt(returnTotal)}€`, width));
  lines.push(
    padLineBoldLabelNormalAmount(t("atk_remaining_total"), formatAtkMoneyEuro(remaining), width)
  );
}

function loadOriginalReceiptByNuikf(nuikf) {
  const key = String(nuikf || "")
    .trim()
    .toUpperCase();
  if (!key) return null;
  try {
    const { isFiscalMemoryOnly } = require("./fiscal-test-mode-store");
    if (isFiscalMemoryOnly()) return null;
    const db = require("../database");
    const row = db.db
      .prepare(
        `SELECT * FROM fiscal_receipts
         WHERE UPPER(nuikf) = ? AND receipt_type = 'regular'
         LIMIT 1`
      )
      .get(key);
    if (!row) return null;
    return {
      nuikf: row.nuikf,
      total_number: row.total_number,
      daily_number: row.daily_number,
      fiscal_date: row.fiscal_date,
      fiscal_time: row.fiscal_time,
      items: parseJsonField(row.items_json, []),
      subtotal: Number(row.subtotal) || 0,
      discount_amount: Number(row.discount_amount) || 0,
      total_amount: Number(row.total_amount) || 0,
      total_without_tax: Number(row.total_without_tax) || 0,
      vat_breakdown: parseJsonField(row.vat_breakdown_json, {}),
      payment_method: row.payment_method || "cash",
      payment_splits_json: row.payment_splits_json,
    };
  } catch {
    return null;
  }
}

/** Rresht artikulli Shtojca F — 3 kolona si origjinali ATK */
function formatAtkItemRow(item, width = WIDTH, opts = {}) {
  const qty = normalizeQty(itemQty(item));
  const ld = Number(item.line_discount_amount) || 0;
  const ls = Number(item.line_surcharge_amount) || 0;
  const useGross = !!opts.gross || ld > 0 || ls > 0;
  const calcUnit = useGross
    ? itemGrossUnit(item)
    : normalizeUnitPrice({ unit_price: itemUnit(item) });
  const displayUnit = resolveAtkReceiptUnitPrice(item, { gross: useGross });
  let lineTotal = lineTotalAmount(qty, calcUnit);
  if (opts.negative) lineTotal = -Math.abs(lineTotal);
  const letter = itemVatLetter(item);
  const qtyStr = formatQtyPrint(Math.abs(qty));
  const mid = `${qtyStr} X ${formatAtkUnitPrice(displayUnit)}`;
  const right = `${moneyPrint(lineTotal)} ${letter}`;
  let name = String(item.name || item.emri || "").trim() || "-";
  return padThreeCol(name, mid, right, width);
}

function appendAtkItemTableHeader(lines, width) {
  lines.push(
    padThreeCol(t("atk_item_col"), t("atk_qty_price_col"), t("atk_sum_col"), width)
  );
  appendAtkRule(lines, width);
}

function appendAtkLineDiscountRow(lines, item, width) {
  const ld = Number(item.line_discount_amount) || 0;
  if (ld <= 0) return;
  const qty = normalizeQty(itemQty(item));
  const baseUnit =
    item?.base_price != null && Number(item.base_price) > 0
      ? normalizeUnitPrice({ unit_price: Number(item.base_price) })
      : itemGrossUnit(item);
  const grossTotal = lineTotalAmount(qty, baseUnit);
  const label = formatAtkLineUljeLabel(item.line_discount, ld, grossTotal);
  lines.push(
    padThreeCol(label, "", formatAtkSumCol(ld, { negative: true, noEuro: true }), width)
  );
}

function appendAtkLineSurchargeRow(lines, item, width) {
  const ls = Number(item.line_surcharge_amount) || 0;
  if (ls <= 0) return;
  const qty = normalizeQty(itemQty(item));
  const baseUnit = normalizeUnitPrice({ unit_price: itemUnit(item) });
  const netTotal = lineTotalAmount(qty, baseUnit);
  const label = formatAtkLineRritjeLabel(item.line_surcharge, ls, netTotal);
  lines.push(
    padThreeCol(label, "", formatAtkSumCol(ls, { noEuro: true }), width)
  );
}

function appendAtkVatLines(lines, vatBreak, width, items) {
  const tax = {
    A: round4(Number(vatBreak?.A ?? vatBreak?.a ?? 0)),
    B: round4(Number(vatBreak?.B ?? vatBreak?.b ?? 0)),
    C: round4(Number(vatBreak?.C ?? vatBreak?.c ?? 0)),
    D: round4(Number(vatBreak?.D ?? vatBreak?.d ?? 0)),
    E: round4(Number(vatBreak?.E ?? vatBreak?.e ?? 0)),
  };
  const present = new Set();
  for (const it of items || []) {
    const L = itemVatLetter(it);
    if (/^[A-E]$/.test(L)) present.add(L);
  }
  for (const L of ["A", "B", "C", "D", "E"]) {
    const show = present.has(L) || Number(tax[L] || 0) > 0;
    if (!show) continue;
    const pct = L === "D" ? "8" : L === "E" ? "18" : "0";
    lines.push(padLine(`${String(t("vat") || "TVSH").trim() || "TVSH"} ${L} ${pct}%`, formatAtkMoneyEuro(tax[L] || 0), width));
  }
}

function appendAtkHeader(lines, width, ctx) {
  lines.push(`${ATK_TITLE_CENTER}${pad(String(ctx.brandName).toUpperCase(), width, "center")}`);
  appendAtkCenterLine(lines, `${t("atk_taxpayer")}: ${legalNameDisplay(ctx.legalName)}`, width);
  if (ctx.unitName) {
    appendAtkCenterLine(lines, `${t("atk_unit_name")}: ${ctx.unitName}`, width);
  }
  for (const al of ctx.addressLines) {
    appendAtkCenterLine(lines, `${t("atk_unit_address")}: ${al}`, width);
  }
  if (ctx.city) appendAtkCenterLine(lines, `${t("atk_place")}: ${ctx.city}`, width);
  if (ctx.unitPhone) appendAtkCenterLine(lines, `${t("atk_phone")}: ${ctx.unitPhone}`, width);
  appendAtkCenterLine(lines, `${t("atk_nf_nui")}: ${ctx.nui || "-"}`, width);
  appendAtkCenterLine(lines, `${t("atk_vat_number")}: ${ctx.vatNo || "-"}`, width);
  appendAtkRule(lines, width);
  lines.push(padLine(`${t("atk_worker_name")}:`, ctx.operatorName || "-", width));
}

function legalNameDisplay(name) {
  return String(name || "-").trim() || "-";
}

function resolveCartDiscountAmount(items, orderDiscount) {
  const disc = round2Print(Number(orderDiscount) || 0);
  if (disc <= 0) return 0;
  const lineDisc = round2Print(
    (items || []).reduce((s, it) => s + (Number(it.line_discount_amount) || 0), 0)
  );
  if (lineDisc > 0 && disc <= lineDisc + 0.001) return 0;
  return round2Print(Math.max(0, disc - lineDisc));
}

function appendAtkItemsBlock(lines, width, items, opts = {}) {
  atkGap(lines, 1);
  appendAtkItemTableHeader(lines, width);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const ld = Number(item.line_discount_amount) || 0;
    const ls = Number(item.line_surcharge_amount) || 0;
    lines.push(
      formatAtkItemRow(item, width, {
        gross: ld > 0 || ls > 0,
        negative: !!opts.negative,
      })
    );
    if (ld > 0 && !opts.skipLineDiscount) {
      appendAtkLineDiscountRow(lines, item, width);
    }
    if (ls > 0 && !opts.skipLineDiscount) {
      appendAtkLineSurchargeRow(lines, item, width);
    }
  }
  // Origjinali ATK: një vijë pas artikujve të fundit (jo midis artikujve).
  if (items.length > 0) {
    appendAtkRule(lines, width);
  }
}

function resolveAtkPaymentSplits(order, fiscal, paymentMethod, totalPay) {
  let splits = resolvePaymentSplits(order, fiscal);
  if (!splits.length) {
    const pm = String(paymentMethod || "cash").trim().toLowerCase();
    if (pm && pm !== "mixed") {
      splits = [{ method: pm, amount: round2Print(totalPay) }];
    }
  }
  return splits;
}

/** Pagesë e vetme: MENYRA E PAGESES | KESH. E përzier: etiketë + një rresht për çdo mënyrë me shumën. */
function appendAtkPaymentLines(lines, width, order, fiscal, paymentMethod, totalPay) {
  const splits = resolveAtkPaymentSplits(order, fiscal, paymentMethod, totalPay);
  if (splits.length >= 2) {
    lines.push(padLine(t("atk_payment_method"), "", width));
    for (const sp of splits) {
      lines.push(
        padLine(atkPaymentModeShort(sp.method), formatAtkMoneyEuro(sp.amount), width)
      );
    }
    return;
  }
  if (splits.length === 1) {
    lines.push(
      padLine(t("atk_payment_method"), atkPaymentModeShort(splits[0].method), width)
    );
    return;
  }
  lines.push(padLine(t("atk_payment_method"), atkPaymentModeShort(paymentMethod), width));
}

function appendAtkTotalsBlock(lines, width, block) {
  const {
    items,
    totalPay,
    totalWithoutTax,
    vatBreak,
    paymentMethod,
    order,
    fiscal,
    cartDiscount,
    rentotal,
    cartDiscountMeta,
  } = block;

  if (cartDiscount > 0) {
    lines.push(padLine(t("atk_subtotal"), moneyAmt(rentotal), width));
    const uljeLabel = formatAtkUljeLabel(
      cartDiscountMeta,
      cartDiscount,
      rentotal
    );
    lines.push(padLine(uljeLabel, `-${moneyAmt(cartDiscount)}`, width));
  }

  atkGap(lines);
  lines.push(padLineBoldLabelNormalAmount(t("atk_total_pay"), formatAtkMoneyEuro(totalPay), width));

  appendAtkPaymentLines(
    lines,
    width,
    order || {},
    fiscal || {},
    paymentMethod,
    totalPay
  );
  appendAtkVatLines(lines, vatBreak, width, items);
  lines.push(padLine(t("atk_total_no_vat"), formatAtkMoneyEuro(totalWithoutTax), width));
}

function appendAtkFooter(lines, width, footer) {
  const {
    itemLineCount,
    totalNumber,
    dateStr,
    timeStr,
    sefId,
    nuikf,
    dailyNumber,
    articleLabel,
  } = footer;

  const artLabel = articleLabel || `${t("atk_items_count")} - ${itemLineCount}`;
  appendAtkRule(lines, width);
  lines.push(`^R${artLabel}`);
  lines.push(formatAtkSerialNumber(totalNumber));
  lines.push(
    padLine(t("atk_date_time"), `${formatAtkDateSlash(dateStr)} ${timeStr}`, width)
  );
  lines.push(padLine(t("atk_sef_id"), sefId || "-", width));
  lines.push(`^BNUIKF: ${nuikf || "-"}`);
  lines.push(
    `^C${pad(`${t("fiscal_coupon_daily_nr")} ${formatAtkDailyNumber(dailyNumber)}`, width, "center")}`
  );
  lines.push(`^C${t("e_kuponi")}`);
}

function buildSaleBlockContext(order, fiscal, items) {
  const subtotal = Number(
    order.subtotal ?? fiscal.subtotal ?? order.subtotal_before_discount ?? 0
  );
  const discount = Number(
    order.discount_amount ?? order.discount_total ?? fiscal.discount_amount ?? 0
  );
  const totalPay = Number(
    order.total_amount ?? order.total ?? fiscal.total_amount ?? subtotal - discount
  );
  const totalWithoutTax = Number(
    order.total_without_tax ?? fiscal.total_without_tax ?? totalPay
  );
  const cartDiscount = resolveCartDiscountAmount(items, discount);
  const rentotal =
    cartDiscount > 0 ? round2Print(totalPay + cartDiscount) : round2Print(totalPay);
  const paymentMethod = order.payment_method || fiscal.payment_method || "cash";
  const vatBreak = resolveVatTaxForPrint(
    items,
    fiscal.vat_breakdown || order.vat_breakdown || null
  );
  return {
    subtotal,
    discount,
    totalPay: round4(totalPay),
    totalWithoutTax,
    cartDiscount,
    rentotal,
    cartDiscountMeta: order.cart_discount || fiscal.cart_discount || null,
    paymentMethod,
    vatBreak,
  };
}

function formatAtkPaymentLine(order, fiscal, paymentMethod, totalPay) {
  const lines = [];
  appendAtkPaymentLines(
    lines,
    WIDTH,
    order || {},
    fiscal || {},
    paymentMethod,
    totalPay
  );
  return lines.join("\n");
}

/**
 * Gjeneron kuponin fiskal si string (layout Shtojca F / ATK).
 * Markerë: ^C^H^B = logo + KUPON FISKAL; ^B = TOTALI PER PAGESE (bold, madhësi normale).
 * @returns {string|null}
 */
function generateFiscalReceipt(orderData, fiscalData) {
  if (!isFiscalEnabled()) return null;

  const order = orderData && typeof orderData === "object" ? orderData : {};
  const fiscal = fiscalData && typeof fiscalData === "object" ? fiscalData : {};

  syncLanguageFromSettings(fiscal.language || order.language);

  const w = Number(fiscal.print_width) > 0
    ? Number(fiscal.print_width)
    : resolvePrintWidth();

  const items = enrichItemsForPrint(
    Array.isArray(order.items) ? order.items : [],
    order,
    fiscal
  );
  const receiptType = String(fiscal.receipt_type || order.receipt_type || "regular")
    .trim()
    .toLowerCase();
  const isReturn = receiptType === "return";
  const isCancel = receiptType === "cancel" || receiptType === "storno";

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
  const unitName = String(fiscal.unit_name || order.unit_name || "").trim();
  const unitPhone = String(fiscal.unit_phone || order.unit_phone || "").trim();
  const address = fiscal.taxpayer_address || order.taxpayer_address || "";
  const { lines: addressLines, city } = splitAddressLines(address);
  const nui = fiscal.taxpayer_nui || order.taxpayer_nui || "";
  const vatNo =
    fiscal.taxpayer_vat ||
    fiscal.taxpayer_vat_number ||
    order.taxpayer_vat ||
    "";

  const operatorName = order.operator_name || order.waiter_name || fiscal.operator_name || "";

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

  const saleCtx = buildSaleBlockContext(order, fiscal, items);
  const originalNuikf = fiscal.original_nuikf || order.original_nuikf || "";
  const originalReceipt = (isReturn || isCancel)
    ? loadOriginalReceiptByNuikf(originalNuikf)
    : null;
  const correctionReason = String(
    fiscal.correction_reason || order.correction_reason || ""
  ).trim();

  const lines = [];

  appendAtkHeader(lines, w, {
    brandName,
    legalName,
    unitName,
    addressLines,
    city,
    unitPhone,
    nui,
    vatNo,
    operatorName,
  });

  lines.push(`${ATK_TITLE_CENTER}${pad(couponTitleForReceiptType(receiptType), w, "center")}`);
  if (resolvePrintOfflineBanner(order, fiscal)) {
    appendOfflineBanner(lines, w);
  }

  if (isReturn || isCancel) {
    if (isReturn) {
      appendOriginalCouponRefLines(lines, w, originalReceipt, { ...order, ...fiscal }, {
        splitDate: true,
      });
    } else {
      const refLine = formatOriginalCouponRefLine(originalReceipt, {
        ...order,
        ...fiscal,
      });
      if (refLine) lines.push(refLine);
    }
  }
  if (isCancel && correctionReason) {
    lines.push(`${t("atk_cancel_reason")}: ${correctionReason}`);
  }

  if (isReturn && originalReceipt) {
    const origItems = enrichItemsForPrint(
      Array.isArray(originalReceipt.items) ? originalReceipt.items : [],
      {},
      originalReceipt
    );
    const origCtx = buildSaleBlockContext(
      {
        subtotal: originalReceipt.subtotal,
        discount_amount: originalReceipt.discount_amount,
        total_amount: originalReceipt.total_amount,
        total_without_tax: originalReceipt.total_without_tax,
        payment_method: originalReceipt.payment_method,
        vat_breakdown: originalReceipt.vat_breakdown,
      },
      originalReceipt,
      origItems
    );

    appendAtkItemsBlock(lines, w, origItems);
    appendAtkTotalsBlock(lines, w, {
      items: origItems,
      totalPay: origCtx.totalPay,
      totalWithoutTax: origCtx.totalWithoutTax,
      vatBreak: origCtx.vatBreak,
      paymentMethod: origCtx.paymentMethod,
      order: { payment_method: origCtx.paymentMethod },
      fiscal: originalReceipt,
      cartDiscount: origCtx.cartDiscount,
      rentotal: origCtx.rentotal,
      cartDiscountMeta: origCtx.cartDiscountMeta,
    });

    appendAtkRule(lines, w);
    lines.push(`${ATK_TITLE_CENTER}${pad(t("atk_return_items_title"), w, "center")}`);
    appendAtkItemsBlock(lines, w, items, { negative: true, skipLineDiscount: true });

    const returnTotal = Math.abs(saleCtx.totalPay);
    const remaining = round2Print(
      Math.max(0, origCtx.totalPay - returnTotal)
    );
    appendAtkReturnSummary(lines, w, returnTotal, remaining);

    appendAtkFooter(lines, w, {
      itemLineCount: items.length,
      totalNumber,
      dateStr,
      timeStr,
      sefId,
      nuikf,
      dailyNumber,
      articleLabel: `${t("atk_returned_items")} - ${items.length}`,
    });
  } else if (isCancel && originalReceipt) {
    const origItems = enrichItemsForPrint(
      Array.isArray(originalReceipt.items) ? originalReceipt.items : [],
      {},
      originalReceipt
    );
    const origCtx = buildSaleBlockContext(
      {
        subtotal: originalReceipt.subtotal,
        discount_amount: originalReceipt.discount_amount,
        total_amount: originalReceipt.total_amount,
        total_without_tax: originalReceipt.total_without_tax,
        payment_method: originalReceipt.payment_method,
        vat_breakdown: originalReceipt.vat_breakdown,
      },
      originalReceipt,
      origItems
    );

    appendAtkItemsBlock(lines, w, origItems);
    appendAtkTotalsBlock(lines, w, {
      items: origItems,
      totalPay: origCtx.totalPay,
      totalWithoutTax: origCtx.totalWithoutTax,
      vatBreak: origCtx.vatBreak,
      paymentMethod: origCtx.paymentMethod,
      order: { payment_method: origCtx.paymentMethod },
      fiscal: originalReceipt,
      cartDiscount: origCtx.cartDiscount,
      rentotal: origCtx.rentotal,
      cartDiscountMeta: origCtx.cartDiscountMeta,
    });

    appendAtkFooter(lines, w, {
      itemLineCount: origItems.length,
      totalNumber,
      dateStr,
      timeStr,
      sefId,
      nuikf,
      dailyNumber,
    });
  } else if (isReturn) {
    appendOriginalCouponRefLines(lines, w, originalReceipt, { ...order, ...fiscal }, {
      splitDate: !!originalReceipt,
    });
    lines.push(`${ATK_TITLE_CENTER}${pad(t("atk_return_items_title"), w, "center")}`);
    appendAtkItemsBlock(lines, w, items, { negative: true, skipLineDiscount: true });
    const returnTotal = Math.abs(saleCtx.totalPay);
    let remaining = returnTotal;
    if (originalReceipt) {
      remaining = round2Print(
        Math.max(0, Number(originalReceipt.total_amount) - returnTotal)
      );
    }
    appendAtkReturnSummary(lines, w, returnTotal, remaining);
    appendAtkFooter(lines, w, {
      itemLineCount: items.length,
      totalNumber,
      dateStr,
      timeStr,
      sefId,
      nuikf,
      dailyNumber,
      articleLabel: `${t("atk_returned_items")} - ${items.length}`,
    });
  } else {
    appendAtkItemsBlock(lines, w, items);
    appendAtkTotalsBlock(lines, w, {
      items,
      totalPay: saleCtx.totalPay,
      totalWithoutTax: saleCtx.totalWithoutTax,
      vatBreak: saleCtx.vatBreak,
      paymentMethod: saleCtx.paymentMethod,
      order,
      fiscal,
      cartDiscount: saleCtx.cartDiscount,
      rentotal: saleCtx.rentotal,
      cartDiscountMeta: saleCtx.cartDiscountMeta,
    });

    appendAtkFooter(lines, w, {
      itemLineCount: items.length,
      totalNumber,
      dateStr,
      timeStr,
      sefId,
      nuikf,
      dailyNumber,
    });
  }

  let text = lines.join("\n") + "\n";
  const moneyProbe = text
    .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, "")
    .replace(/\b\d{1,2}:\d{2}\b/g, "")
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, "");
  if (/\d+\.\d{3,}/.test(moneyProbe)) {
    throw new Error("Kupon fiskal: shuma me më shumë se 2 presje në printim");
  }
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
