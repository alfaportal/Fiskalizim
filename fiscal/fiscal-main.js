/**
 * fiscal/fiscal-main.js — HAPI FINAL: lidhja e moduleve fiskale PAS closeTable.
 * NUK thërret / NUK ndryshon closeTable. Kur isFiscalEnabled()=false → null.
 */
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const {
  getNextDailyNumber,
  getNextTotalNumber,
  generateNUIKF,
  getSefIdentifier,
} = require("./fiscal-numbering");
const {
  calculateVatBreakdown,
  calculateVatTaxBreakdown,
  distributeCartAdjustment,
  getVatRate,
  getVatNormLetter,
  round4,
  lineTotalAmount,
  normalizeQty,
  normalizeUnitPrice,
} = require("./fiscal-vat");
const { signReceipt } = require("./fiscal-crypto");
const { generateFiscalQR } = require("./fiscal-qr");
const { generateFiscalReceipt } = require("./fiscal-print");
const { syncLanguageFromSettings, normalizeLang } = require("./fiscal-i18n");
const {
  checkAtkReachable,
  checkInternetConnection,
  queueOfflineReceipt,
} = require("./fiscal-offline");
const { logFiscalAction } = require("./fiscal-audit");
const {
  insertFiscalReceipt,
  validateFiscalReceiptInsert,
  getFiscalReceiptById,
} = require("./fiscal-db");
const {
  isFiscalMemoryOnly,
  isAtkTransmissionBlocked,
  memGetReceiptBySaleId,
} = require("./fiscal-test-mode-store");
const { getFiscalTodayParts, getFiscalNowMs, formatFiscalDateTimeLocal } = require("./fiscal-time-sync");
const { attachChainToFiscalData } = require("./fiscal-hash-chain");
const {
  getAtkTestCouponItems,
  computeAtkTestCouponTotals,
  validateInternalTestCouponStructure,
} = require("./fiscal-test-coupon-data");

const PRINT_MODE_KEY = "sef_print_mode"; // addon | replace

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function getDbApi() {
  return require("../database");
}

/** addon = kupon normal + fiskal; replace = vetëm fiskal (default). */
function getFiscalPrintMode() {
  try {
    const dbApi = getDbApi();
    // Migrim një herë: default i vjetër "addon" → "replace" (vetëm kupon fiskal)
    if (String(dbApi.getSetting("sef_print_mode_migrated_v212", "0")) !== "1") {
      dbApi.setSetting(PRINT_MODE_KEY, "replace");
      dbApi.setSetting("sef_print_mode_migrated_v212", "1");
      return "replace";
    }
    const v = String(dbApi.getSetting(PRINT_MODE_KEY, "replace") || "replace")
      .trim()
      .toLowerCase();
    return v === "addon" ? "addon" : "replace";
  } catch {
    return "replace";
  }
}

function setFiscalPrintMode(mode) {
  const v = String(mode || "").toLowerCase() === "addon" ? "addon" : "replace";
  getDbApi().setSetting(PRINT_MODE_KEY, v);
  return v;
}

/**
 * Vetëm për kuponin e MBYLLJES (closing receipt / faturë).
 * ASNJËHERË për kuponin e porosisë (order ticket / bar / kuzhinë).
 * - fiscal OFF → true (printo kuponin normal të mbylljes)
 * - fiscal ON + addon → true (normal + fiskal)
 * - fiscal ON + replace → false (vetëm kupon fiskal në mbyllje)
 */
function shouldPrintClosingNormalReceipt() {
  if (!isFiscalEnabled()) return true;
  return getFiscalPrintMode() === "addon";
}

/** Alias — i njëjti kuptim: vetëm mbyllja, JO order ticket. */
function shouldPrintNormalReceipt() {
  return shouldPrintClosingNormalReceipt();
}

function todayParts() {
  return getFiscalTodayParts();
}

function parseItems(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const p = JSON.parse(raw || "[]");
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.items)) return p.items;
    return [];
  } catch {
    return [];
  }
}

function normalizeDiscountMeta(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "")
    .trim()
    .toLowerCase();
  const value = Number(raw.value);
  if (!type || type === "none" || !Number.isFinite(value) || value <= 0) return null;
  return { type, value };
}

function pickLineDiscountMeta(item) {
  if (!item || typeof item !== "object") return null;
  const fromObj = normalizeDiscountMeta(item.line_discount);
  if (fromObj) return fromObj;
  return normalizeDiscountMeta({
    type: item.discount_type,
    value: item.discount_value,
  });
}

function pickLineSurchargeMeta(item) {
  if (!item || typeof item !== "object") return null;
  const fromObj = normalizeDiscountMeta(item.line_surcharge);
  if (fromObj) return fromObj;
  return normalizeDiscountMeta({
    type: item.surcharge_type,
    value: item.surcharge_value,
  });
}

function parseOrderPayload(raw) {
  if (Array.isArray(raw)) {
    return { items: raw, cart_surcharge_amount: 0, cart_discount_amount: 0, cart_discount: null, payment_splits: [] };
  }
  try {
    const p = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    if (Array.isArray(p)) {
      return { items: p, cart_surcharge_amount: 0, cart_discount_amount: 0, cart_discount: null, payment_splits: [] };
    }
    return {
      items: Array.isArray(p.items) ? p.items : [],
      cart_surcharge_amount: Number(p.cart_surcharge_amount) || 0,
      cart_discount_amount: Number(p.cart_discount_amount) || 0,
      cart_discount: normalizeDiscountMeta(p.cart_discount),
      payment_splits: Array.isArray(p.payment_splits) ? p.payment_splits : [],
    };
  } catch {
    return { items: [], cart_surcharge_amount: 0, cart_discount_amount: 0, cart_discount: null, payment_splits: [] };
  }
}

/**
 * Mapo vat_category menu (0/8/18) → shkronjë A/D/E.
 * Pa këtë, krejt artikujt bëhen E dhe mungon TVSH D në kupon.
 */
function resolveItemVatNorm(item, vatByMenuId) {
  const direct = String(item?.vat_norm || item?.vat_letter || "")
    .trim()
    .toUpperCase();
  if (/^[A-E]$/.test(direct)) return direct;

  const pctRaw =
    item?.vat_category ??
    item?.vat_rate ??
    item?.vat_percent ??
    item?.tvsh_percent ??
    null;
  if (pctRaw != null && String(pctRaw).trim() !== "") {
    const fromPct = getVatNormLetter(pctRaw);
    if (fromPct) return fromPct;
  }

  const mid = item?.menu_item_id != null ? Number(item.menu_item_id) : null;
  if (mid != null && vatByMenuId && vatByMenuId.has(mid)) {
    const fromMenu = getVatNormLetter(vatByMenuId.get(mid));
    if (fromMenu) return fromMenu;
  }

  return "E";
}

function loadMenuVatMap(items) {
  const ids = [
    ...new Set(
      (items || [])
        .map((it) => (it?.menu_item_id != null ? Number(it.menu_item_id) : null))
        .filter((id) => id != null && Number.isFinite(id))
    ),
  ];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const sqlite = getSqlite();
    const ph = ids.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT id, COALESCE(vat_category, '18') AS vat_category
         FROM menu_items WHERE id IN (${ph})`
      )
      .all(...ids);
    for (const r of rows || []) {
      map.set(Number(r.id), r.vat_category);
    }
  } catch (e) {
    console.warn("[fiscal-main] loadMenuVatMap:", e.message);
  }
  return map;
}

function normalizeItems(items) {
  const list = items || [];
  const vatByMenuId = loadMenuVatMap(list);
  const { getVatRate } = require("./fiscal-vat");
  return list.map((item) => {
    const letter = resolveItemVatNorm(item, vatByMenuId);
    const fromLib = getVatRate(letter);
    const rate =
      fromLib != null
        ? Number(fromLib)
        : letter === "D"
          ? 8
          : letter === "E"
            ? 18
            : 0;
    const qty = normalizeQty(item.quantity ?? item.qty ?? 1);
    const unitPrice = normalizeUnitPrice(item);
    const lineDiscMeta = pickLineDiscountMeta(item);
    const lineSurMeta = pickLineSurchargeMeta(item);
    const { resolveItemUnitCategory } = require("./fiscal-item-meta");
    const meta = resolveItemUnitCategory(item, { authoritativeDb: true });
    const normalized = {
      name: String(item.name || item.emri || "-").trim(),
      quantity: qty,
      qty,
      price: unitPrice,
      unit_price: unitPrice,
      base_price:
        item.base_price != null ? round4(item.base_price) : unitPrice,
      line_discount_amount: Number(item.line_discount_amount) || 0,
      line_surcharge_amount: Number(item.line_surcharge_amount) || 0,
      vat_norm: letter,
      vat_letter: letter,
      vat_category: String(rate),
      vat_rate: rate,
      vat_percent: rate,
      menu_item_id: item.menu_item_id ?? item.product_id ?? null,
      product_id: item.product_id ?? item.menu_item_id ?? null,
      unit_code: meta.unit_code,
      category_code: meta.category_code,
    };
    if (lineDiscMeta) normalized.line_discount = lineDiscMeta;
    if (lineSurMeta) normalized.line_surcharge = lineSurMeta;
    return normalized;
  });
}

/** Tatimi (jo baza) — residual rounding në fiscal-vat. */
function taxFromBreakdown(items, turnoverBreak, opts = {}) {
  const result = calculateVatTaxBreakdown(items, opts);
  const tax = result
    ? result.tax
    : { A: 0, B: 0, C: 0, D: 0, E: 0 };
  return {
    tax,
    turnover: turnoverBreak || tax,
    totalTax: result ? result.totalTax : 0,
    totalWithoutTax: result ? result.totalWithoutTax : 0,
  };
}

/**
 * Printim fiskal me SAKTËSISHT të njëjtin pipeline ESC/POS si kuponi normal:
 * buildEscPosFromPlainText → ESC @ + CP1252 (ESC t 16) + markerë ^R/^B/^C → një cut.
 * Logo/QR bashkohen në të njëjtin job (pa font të ndryshëm, pa cut të shumëfishtë).
 */
/** Shmang printimin dyfish brenda 5 s (recovery + checkout). */
let lastFiscalPrintKey = "";
let lastFiscalPrintAt = 0;

async function printFiscalBundle(printText, qrResult, printOpts = {}) {
  const printer = require("../printer");
  const database = require("../database");
  const {
    buildEscPosFromPlainText,
    appendEscPosCut,
    bufferHasEscPosCut,
  } = require("../receipt-text");
  const { getFiscalLogoForPrint } = require("./fiscal-logo");
  const {
    validateReceiptBeforePrint,
  } = require("./fiscal-receipt-guard");

  let printed = false;
  let printMessage = "";
  let printMethod = "";
  const isRecovery = !!(printOpts && printOpts.recovery);
  try {
    if (!printText) {
      return { printed: false, printMessage: "Teksti i kuponit fiskal është bosh" };
    }

    if (!isRecovery && !printOpts.force) {
      const crypto = require("crypto");
      const key = crypto.createHash("md5").update(String(printText)).digest("hex");
      const now = Date.now();
      if (key === lastFiscalPrintKey && now - lastFiscalPrintAt < 5000) {
        console.warn("[fiscal-main] print skip duplicate (<5s)");
        return { printed: true, printMessage: "", printMethod: "dedup-skip" };
      }
      lastFiscalPrintKey = key;
      lastFiscalPrintAt = now;
    }

    let logo = null;
    try {
      logo = getFiscalLogoForPrint();
    } catch (e) {
      console.warn("[fiscal-main] Logo:", e.message);
    }
    const qrAttached = !!(
      qrResult &&
      (qrResult.escpos_base64 || qrResult.payload || qrResult.png_base64 || qrResult.png_buffer)
    );
    const logoAttached = !!(logo && logo.buffer && logo.buffer.length);

    // Rikuperimi pas mungesës së rrymës: lejo print edhe nëse QR mungon në retry
    const guard = validateReceiptBeforePrint(printText, {
      qrAttached: isRecovery ? true : qrAttached,
      logoAttached: isRecovery ? true : logoAttached,
      printOfflineBanner: !!printOpts.printOfflineBanner,
    });
    if (!guard.ok) {
      let printMsg = guard.gabim || "Validimi i kuponit fiskal dështoi";
      if ((guard.missing || []).includes("QR")) {
        try {
          const { verifyPrivateKeyReadable } = require("./fiscal-crypto");
          const kc = verifyPrivateKeyReadable();
          if (!kc.ok && !kc.skipped) {
            printMsg = kc.error || printMsg;
          } else {
            printMsg =
              "QR fiskal mungon — kontrolloni çelësin privat dhe printerin. " + printMsg;
          }
        } catch {
          /* */
        }
      }
      // ASNJË fallback print — formati i pavlefshëm nuk del në printer
      return {
        printed: false,
        printMessage: printMsg,
      };
    }

    const tysso = await printer.isTyssoReceiptPrinter(database);

    let textForPrint = printText;
    // QR printohet veç si binary (raster i qendruar) — ASCII vetëm nëse nuk ka QR binary
    if (tysso && qrResult?.ascii && !qrAttached) {
      textForPrint = `${printText}\n${String(qrResult.ascii).trim()}\n`;
    }

    // Tysso: i njëjti ESC/POS si test print (legacy) — fiscalEmphasized/GS density shpesh nuk printon
    const textBuf = buildEscPosFromPlainText(textForPrint, tysso
      ? { cut: false, keepAlbanian: true, dark: false, fiscalEmphasized: false }
      : {
          cut: false,
          dark: true,
          fiscalEmphasized: true,
          allowDoubleSize: true,
          keepAlbanian: true,
        });
    const parts = [textBuf];

    if (qrAttached) {
      try {
        const { buildFiscalQrEscPosBuffer, getFiscalQrPrintOpts } = require("./fiscal-qr");
        const qrBuf = buildFiscalQrEscPosBuffer(qrResult, getFiscalQrPrintOpts());
        if (qrBuf && qrBuf.length) {
          console.log('[QR-DEBUG] qrBuf length:', qrBuf.length, 'bytes');
          parts.push(qrBuf);
        } else {
          console.error('[QR-DEBUG] qrBuf is NULL or EMPTY — QR nuk printohet!');
        }
      } catch (e) {
        console.warn("[fiscal-main] QR print:", e.message);
      }
    }

    // Logo RKS/MF — bitmap ESC/POS (160×80) si kërkesa ATK
    if (logoAttached) {
      parts.push(logo.buffer);
    }

    // Vijë mbyllëse pas logos (si layout ATK)
    try {
      const { resolvePrintWidth, divider } = require("./fiscal-print");
      const w = resolvePrintWidth();
      parts.push(Buffer.from(`\n${divider("-", w)}\n`, "ascii"));
    } catch {
      parts.push(Buffer.from("\n==========================================\n", "ascii"));
    }

    let full = Buffer.concat(parts);
    if (!bufferHasEscPosCut(full)) {
      full = appendEscPosCut(full);
    }
    const send = await printer.printEscPosReceiptAt(full.toString("base64"), database, "bar");
    printed = true;
    printMethod = send?.method || send?.output || "";
  } catch (e) {
    printMessage = e.message || "Printimi fiskal dështoi";
    // Pa fallback plain-text — ruaj ESC/POS + guard (Rregulli #15)
  }
  return { printed, printMessage, printMethod };
}

/**
 * Printim Raporti X / Z / periodik — i njëjti fund si kuponi fiskal:
 * tekst ESC/POS → QR (CitizenCoupon + ECDSA) → logo RKS/MF → vijë mbyllëse → cut.
 */
async function printFiscalReportText(printText, printOpts = {}) {
  const printer = require("../printer");
  const database = require("../database");
  const {
    buildEscPosFromPlainText,
    appendEscPosCut,
    bufferHasEscPosCut,
  } = require("../receipt-text");
  const { getFiscalLogoForPrint } = require("./fiscal-logo");
  const {
    buildFiscalQrEscPosBuffer,
    generateFiscalReportQR,
    getFiscalQrPrintOpts,
  } = require("./fiscal-qr");

  let printed = false;
  let printMessage = "";
  const station = printOpts.station || "bar";
  try {
    if (!printText) {
      return { printed: false, printMessage: "Teksti i raportit fiskal është bosh" };
    }

    let qrResult = printOpts.qrResult || null;
    if (!qrResult && printOpts.reportDetails) {
      try {
        qrResult = await generateFiscalReportQR(printOpts.reportDetails, {
          reportMode: printOpts.reportMode || printOpts.reportDetails.mode,
          operatorId: printOpts.operatorId || "POS",
        });
      } catch (e) {
        console.warn("[fiscal-main] QR raport:", e.message);
      }
    }

    let logo = null;
    try {
      logo = getFiscalLogoForPrint();
    } catch (e) {
      console.warn("[fiscal-main] Logo raport:", e.message);
    }
    const logoAttached = !!(logo && logo.buffer && logo.buffer.length);
    const qrAttached = !!(
      qrResult &&
      (qrResult.escpos_base64 || qrResult.payload || qrResult.png_base64 || qrResult.png_buffer)
    );
    const tysso = await printer.isTyssoReceiptPrinter(database);

    const textBuf = buildEscPosFromPlainText(printText, tysso
      ? { cut: false, keepAlbanian: true, dark: false, fiscalEmphasized: false }
      : {
          cut: false,
          dark: true,
          fiscalEmphasized: true,
          allowDoubleSize: false,
          keepAlbanian: true,
        });
    const parts = [textBuf];

    if (qrAttached) {
      try {
        const qrBuf = buildFiscalQrEscPosBuffer(qrResult, getFiscalQrPrintOpts());
        if (qrBuf && qrBuf.length) parts.push(qrBuf);
      } catch (e) {
        console.warn("[fiscal-main] QR raport print:", e.message);
      }
    }

    // Logo RKS/MF — bitmap ESC/POS (160×80), poshtë QR-së
    if (logoAttached) {
      parts.push(logo.buffer);
    }

    try {
      const { resolvePrintWidth, divider } = require("./fiscal-print");
      const w = resolvePrintWidth();
      parts.push(Buffer.from(`\n${divider("-", w)}\n`, "ascii"));
    } catch {
      parts.push(Buffer.from("\n==========================================\n", "ascii"));
    }

    let full = Buffer.concat(parts);
    if (!bufferHasEscPosCut(full)) {
      full = appendEscPosCut(full);
    }
    const { printerName, paper } = await printer.ensureReceiptPrinter(database, station);
    await printer.printEscPosReceiptAt(full.toString("base64"), database, station);
    printed = true;
    return {
      printed: true,
      printMessage: "",
      printer: printerName,
      paper,
      output: "escpos-fiscal-report",
      station,
    };
  } catch (e) {
    printMessage = e.message || "Printimi i raportit fiskal dështoi";
  }
  return { printed, printMessage };
}

function insertOnlineReceipt(row) {
  return insertFiscalReceipt({
    ...row,
    receipt_type: row.receipt_type || "regular",
    original_nuikf: row.original_nuikf || null,
    currency: row.currency || "EUR",
    is_offline: 0,
    sent_to_atk: 0,
  });
}

/** Kupon vetëm lokal — pa radhë ATK (FISCAL_LOCAL_RUN). */
function insertLocalOnlyReceipt(row) {
  const sentAt = formatFiscalDateTimeLocal(getFiscalNowMs());
  return insertFiscalReceipt({
    ...row,
    receipt_type: row.receipt_type || "regular",
    original_nuikf: row.original_nuikf || null,
    currency: row.currency || "EUR",
    is_offline: 0,
    sent_to_atk: 1,
    sent_at: sentAt,
    atk_response_json: JSON.stringify({
      local_only: true,
      skipped: "FISCAL_LOCAL_RUN",
      note: "Kupon vetëm lokal — pa transmetim ATK",
    }),
  });
}

function assertValidNuikf(nuikf) {
  const s = String(nuikf || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{16}$/.test(s)) {
    throw new Error("NUIKF i pavlefshëm (duhet 16 alfanumerike): " + s);
  }
  if (/^\d{8}-\d{6}$/.test(String(nuikf))) {
    throw new Error("NUIKF nuk mund të jetë numri i faturës lokale");
  }
  return s;
}

/**
 * Proceson kuponin fiskal PAS closeTable.
 * @param {number} orderId — id e porosisë së mbyllur
 * @param {string} paymentMethod
 * @param {object} [opts] — operator_name, operator_id, items (override), skip_print
 */
async function processFiscalReceipt(orderId, paymentMethod, opts = {}) {
  if (!isFiscalEnabled()) {
    console.log("[fiscal-main] START processFiscalReceipt SKIP fiscal OFF orderId=", orderId);
    return null;
  }

  const { getAtkStatus } = require("./fiscal-atk-api");
  if (!getAtkStatus().ready_for_atk) {
    throw new Error("Bëni onboarding (Lidhu me ATK) para se të shtypni kupon fiskal.");
  }

  const sqlite = getSqlite();
  const id = Number(orderId);
  const memoryOnly = isFiscalMemoryOnly();
  const atkBlocked = isAtkTransmissionBlocked();
  console.log(
    "[fiscal-main] START processFiscalReceipt orderId=",
    id,
    "memory_only=",
    memoryOnly,
    "atk_blocked=",
    atkBlocked
  );
  try {
  if (!id) throw new Error("orderId mungon");

  if (isFiscalEnabled()) {
    const { verifyPrivateKeyReadable } = require("./fiscal-crypto");
    const keyCheck = verifyPrivateKeyReadable();
    if (!keyCheck.ok && !keyCheck.skipped) {
      throw new Error(
        keyCheck.error ||
          "Çelësi privat nuk lexohet — kuponi nuk krijohet. Rikthe nga backup-i."
      );
    }
  }

  const order = sqlite.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
  if (!order) throw new Error("Porosia nuk u gjet");

  // Idempotencë: mos krijo kupon të dytë — por rifillo printimin nëse pending i hapur
  if (Number(order.is_fiscalized) === 1 && order.fiscal_receipt_id && !memoryOnly) {
    const existing = sqlite
      .prepare(`SELECT id, nuikf, sef_id, daily_number FROM fiscal_receipts WHERE id = ?`)
      .get(Number(order.fiscal_receipt_id));
    if (existing) {
      console.log(
        "[fiscal-main] processFiscalReceipt SKIP already fiscalized orderId=",
        id,
        "fiscal_receipt_id=",
        existing.id,
        "nuikf=",
        existing.nuikf
      );
      try {
        const recovery = require("./fiscal-recovery");
        const pending = recovery.getOpenPendingForOrder(id);
        if (
          pending &&
          (pending.stage === recovery.STAGES.COUPON_READY ||
            pending.stage === recovery.STAGES.PRINTING) &&
          pending.print_text
        ) {
          const resumed = await recovery.resumePendingPrint(pending, {
            skip_print: !!opts.skip_print,
          });
          return {
            ok: true,
            already_fiscalized: true,
            recovered: true,
            fiscal_receipt_id: existing.id,
            nuikf: existing.nuikf,
            sef_id: existing.sef_id,
            daily_number: existing.daily_number,
            printed: resumed.printed,
            printMessage: resumed.printMessage || "Rikuperim printimi (MUNGESË RRYME)",
            recovery_text: resumed.recovery_text,
          };
        }
      } catch (re) {
        console.warn("[fiscal-main] recovery resume:", re.message);
      }
      return {
        ok: true,
        already_fiscalized: true,
        fiscal_receipt_id: existing.id,
        nuikf: existing.nuikf,
        sef_id: existing.sef_id,
        daily_number: existing.daily_number,
        printed: false,
        printMessage: "Porosia është tashmë e fiskalizuar",
      };
    }
  }

  if (memoryOnly) {
    const memExisting = memGetReceiptBySaleId(id);
    if (memExisting) {
      console.log(
        "[fiscal-main] TEST_MODE — kupon in-memory ekziston për orderId=",
        id,
        "nuikf=",
        memExisting.nuikf
      );
      return {
        ok: true,
        already_fiscalized: true,
        atk_test_mode: true,
        fiscal_local: true,
        fiscal_receipt_id: memExisting.id,
        nuikf: memExisting.nuikf,
        sef_id: memExisting.sef_id,
        daily_number: memExisting.daily_number,
        printed: false,
        printMessage: "ATK TEST_MODE — kuponi mbetet vetëm në memorie (session)",
      };
    }
  }

  const settings = getFiscalSettings();
  const receiptLang = syncLanguageFromSettings(
    opts.language != null && String(opts.language).trim() !== ""
      ? normalizeLang(opts.language)
      : settings && settings.language === "sr"
        ? "sr"
        : "sq"
  );
  console.log("[fiscal-main] processFiscalReceipt language=", receiptLang);
  const orderPayload = parseOrderPayload(order.items_json);
  const items = normalizeItems(opts.items || orderPayload.items);
  if (!items.length) {
    throw new Error("Porosia nuk ka artikuj për fiskalizim");
  }

  const payment = paymentMethod || order.payment_method || "cash";
  let paymentSplits =
    (Array.isArray(opts.payment_splits) && opts.payment_splits.length
      ? opts.payment_splits
      : orderPayload.payment_splits) || [];
  const operatorName =
    String(opts.operator_name || order.waiter_name || "Operator").trim() ||
    "Operator";
  const operatorId = String(opts.operator_id || "POS").trim() || "POS";

  const recovery = require("./fiscal-recovery");
  let pendingId = null;
  try {
    pendingId = recovery.beginPending({
      orderId: id,
      operatorName,
      operatorId,
    });
  } catch (e) {
    console.warn("[fiscal-main] beginPending:", e.message);
  }

  const dailyNumber = getNextDailyNumber();
  const totalNumber = getNextTotalNumber();
  // Gjithmonë NUIKF nga generateNUIKF() — JO receipt_number i faturës (YYYYMMDD-NNNNNN)
  const nuikf = assertValidNuikf(generateNUIKF());
  const sefId = getSefIdentifier() || "";
  if (dailyNumber == null || totalNumber == null || !nuikf) {
    throw new Error("Numërimi fiskal dështoi (daily/total/NUIKF)");
  }

  const subtotal =
    opts.subtotal != null
      ? round4(opts.subtotal)
      : round4(
          items.reduce(
            (s, it) => s + lineTotalAmount(it.quantity || it.qty, it.unit_price || it.price),
            0
          )
        );
  const discount = round4(Number(opts.discount_amount ?? order.discount_total ?? 0) || 0);
  const surcharge = round4(
    Number(opts.surcharge_amount ?? orderPayload.cart_surcharge_amount ?? 0) || 0
  );
  const totalAmount =
    opts.total_amount != null
      ? round4(opts.total_amount)
      : round4(Number(order.total) || subtotal - discount + surcharge);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("total_amount duhet > 0 para INSERT fiskal");
  }

  if (!paymentSplits.length && payment && String(payment).toLowerCase() !== "mixed") {
    paymentSplits = [{ method: payment, amount: totalAmount }];
  }

  // Zbritje/shtesë karroce → shpërndarje proporcionale; TVSH nga çmimet pas zbritjes
  const fiscalItems = distributeCartAdjustment(items, discount, surcharge);

  const turnoverBreak = calculateVatBreakdown(fiscalItems) || {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };
  const taxResult = taxFromBreakdown(fiscalItems, turnoverBreak, {
    totalAmount,
  });
  const vatTax = taxResult.tax;
  const totalTax = Number(taxResult.totalTax) || 0;
  const totalWithoutTax =
    taxResult.totalWithoutTax != null
      ? round4(taxResult.totalWithoutTax)
      : round4(totalAmount - totalTax);

  const { fiscal_date, fiscal_time } = todayParts();
  const taxpayerNui =
    settings.taxpayer_nui || settings.developer_nui || "";
  const taxpayerVat = settings.taxpayer_vat_number || "";
  const taxpayerName = settings.taxpayer_legal_name || "Biznesi";
  const taxpayerAddress = settings.taxpayer_address || "";
  const unitName = settings.unit_name || "";
  const unitPhone = settings.unit_phone || "";

  const signPayload = {
    nuikf,
    total_amount: totalAmount,
    fiscal_date,
    fiscal_time,
    taxpayer_nui: taxpayerNui,
    sef_id: sefId,
    daily_number: dailyNumber,
    total_number: totalNumber,
    receipt_type: "regular",
  };

  let signature = null;
  try {
    signature = signReceipt(signPayload);
  } catch (e) {
    console.warn("[fiscal-main] signReceipt:", e.message);
  }

  let qrResult = null;
  try {
    qrResult = await generateFiscalQR({
      ...signPayload,
      total: totalAmount,
      nui: taxpayerNui,
    });
  } catch (e) {
    console.warn("[fiscal-main] generateFiscalQR:", e.message);
  }

  const cartDiscountMeta =
    normalizeDiscountMeta(opts.cart_discount) ||
    orderPayload.cart_discount ||
    null;

  const orderData = {
    items,
    fiscal_items: fiscalItems,
    operator_name: operatorName,
    operator_id: operatorId,
    payment_method: payment,
    payment_splits: paymentSplits,
    subtotal,
    discount_amount: discount,
    cart_discount: cartDiscountMeta,
    surcharge_amount: surcharge,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    language: receiptLang,
    amount_paid:
      opts.amount_paid != null && Number.isFinite(Number(opts.amount_paid))
        ? round4(Number(opts.amount_paid))
        : totalAmount,
  };

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
    receipt_type: "regular",
    is_offline: false,
    fiscal_date,
    fiscal_time,
    vat_breakdown: vatTax,
    language: receiptLang,
  };

  let hasInternet = true;
  if (!atkBlocked) {
    hasInternet = (await checkInternetConnection()) !== false;
  }
  const atkReachable = !atkBlocked && (await checkAtkReachable());
  const online = atkReachable;
  let fiscalReceiptId = null;
  let isOffline = false;
  let isLocalOnly = false;
  let printOfflineBanner = false;
  let printText = null;
  let atkSent = false;
  let atkError = "";
  let atkAuto = false;
  let atkTestMode = atkBlocked;

  const qrPayload = JSON.stringify({
    placeholder: !qrResult,
    hapi: 8,
    verify_url: qrResult?.verify_url || null,
    signature: signature || qrResult?.signature || null,
  });

  const insertRow = {
    sale_id: id,
    nuikf,
    sef_id: sefId,
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
    items_json: JSON.stringify(fiscalItems),
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    vat_breakdown_json: JSON.stringify(vatTax),
    payment_method: payment,
    payment_splits_json:
      paymentSplits.length > 0 ? JSON.stringify(paymentSplits) : null,
    qr_code_data: qrPayload,
    digital_signature: signature || null,
  };

  if (atkBlocked) {
    isLocalOnly = true;
    fiscalData.local_only = true;
    fiscalData.print_offline_banner = false;
    console.log("[fiscal-main] Modalitet LOKAL — kupon pa ATK. orderId=", id);
    const preCheck = validateFiscalReceiptInsert(insertRow);
    if (!preCheck.ok) {
      throw new Error("Validimi para INSERT dështoi: " + preCheck.error);
    }
    fiscalReceiptId = insertLocalOnlyReceipt(insertRow);
    const chainRow = getFiscalReceiptById(fiscalReceiptId);
    attachChainToFiscalData(fiscalData, chainRow);
    printText = generateFiscalReceipt(orderData, fiscalData);
    try {
      logFiscalAction(
        "receipt_created",
        {
          nuikf,
          order_id: id,
          total: totalAmount,
          offline: false,
          local_only: true,
          fiscal_receipt_id: fiscalReceiptId,
          daily_number: dailyNumber,
          payment_method: payment,
        },
        operatorName,
        operatorId
      );
    } catch (e) {
      console.warn("[fiscal-main] audit:", e.message);
    }
  } else if (!online) {
    isOffline = true;
    printOfflineBanner = !hasInternet;
    fiscalData.is_offline = true;
    fiscalData.print_offline_banner = printOfflineBanner;
    console.log(
      "[fiscal-main] ATK i paarritshëm — kupon në radhë. orderId=",
      id,
      "no_internet=",
      !hasInternet
    );
    const queued = queueOfflineReceipt({
      sale_id: id,
      nuikf,
      sef_id: sefId,
      daily_number: dailyNumber,
      total_number: totalNumber,
      fiscal_date,
      fiscal_time,
      operator_name: operatorName,
      operator_id: operatorId,
      taxpayer_nui: taxpayerNui,
      taxpayer_vat: taxpayerVat,
      taxpayer_name: taxpayerName,
      taxpayer_address: taxpayerAddress,
      unit_name: unitName,
      unit_phone: unitPhone,
      items,
      subtotal,
      discount_amount: discount,
      total_amount: totalAmount,
      total_without_tax: totalWithoutTax,
      vat_breakdown: vatTax,
      payment_method: payment,
      payment_splits_json:
        paymentSplits.length > 0 ? JSON.stringify(paymentSplits) : null,
      print_offline_banner: printOfflineBanner,
    });
    fiscalReceiptId = queued?.id || null;
    console.log(
      "[fiscal-main] INSERT OK receiptId=",
      fiscalReceiptId,
      "(offline queue) daily_number=",
      dailyNumber,
      "total_number=",
      totalNumber,
      "nuikf=",
      nuikf
    );
    printText = queued?.print_text || generateFiscalReceipt(orderData, fiscalData);
  } else {
    const preCheck = validateFiscalReceiptInsert(insertRow);
    if (!preCheck.ok) {
      throw new Error("Validimi para INSERT dështoi: " + preCheck.error);
    }
    fiscalReceiptId = insertOnlineReceipt(insertRow);
    console.log(
      "[fiscal-main] INSERT OK receiptId=",
      fiscalReceiptId,
      "daily_number=",
      dailyNumber,
      "nuikf=",
      nuikf,
      "total=",
      totalAmount
    );

    const chainRow = getFiscalReceiptById(fiscalReceiptId);
    attachChainToFiscalData(fiscalData, chainRow);

    printText = generateFiscalReceipt(orderData, fiscalData);

    try {
      logFiscalAction(
        "receipt_created",
        {
          nuikf,
          order_id: id,
          total: totalAmount,
          offline: false,
          fiscal_receipt_id: fiscalReceiptId,
          daily_number: dailyNumber,
          payment_method: payment,
          chain_current_hash: chainRow?.chain_current_hash || null,
          chain_previous_hash: chainRow?.chain_previous_hash || null,
          chain_integrity_ok: chainRow?.chain_integrity_ok ?? null,
        },
        operatorName,
        operatorId
      );
    } catch (e) {
      console.warn("[fiscal-main] audit:", e.message);
    }

    const { isAtkAutoSendEnabled } = require("./fiscal-offline");
    atkAuto = isAtkAutoSendEnabled();
  }

  if (!memoryOnly) {
    try {
      sqlite
        .prepare(
          `UPDATE orders SET fiscal_receipt_id = ?, is_fiscalized = 1 WHERE id = ?`
        )
        .run(fiscalReceiptId, id);
    } catch (e) {
      console.warn("[fiscal-main] update orders:", e.message);
    }
  } else {
    console.log(
      "[fiscal-main] MEMORY_ONLY — orders.fiscal_receipt_id / is_fiscalized nuk u shkruan në SQLite. orderId=",
      id
    );
  }

  // Checkpoint: kuponi u krijua — nëse ndërpritet printimi, rifillohet pa INSERT të ri
  try {
    if (pendingId && printText) {
      recovery.markCouponReady(pendingId, {
        fiscalReceiptId,
        nuikf,
        printText,
      });
    }
  } catch (e) {
    console.warn("[fiscal-main] markCouponReady:", e.message);
  }

  // ATK para printimit — dërgo kur i lidhur (atk_send_allowed=1); pa varet nga auto-send.
  if (!isOffline && !atkBlocked && fiscalReceiptId && !memoryOnly) {
    const { sendReceiptToAtk } = require("./fiscal-offline");
    try {
      const fullRow = getFiscalReceiptById(fiscalReceiptId);
      if (fullRow) {
        const sendResult = await sendReceiptToAtk(fullRow);
        if (sendResult?.sent) {
          atkSent = true;
          atkError = "";
          const { fiscalReceiptUpdate } = require("./fiscal-db");
          fiscalReceiptUpdate(fiscalReceiptId, {
            sent_to_atk: 1,
            sent_at: formatFiscalDateTimeLocal(getFiscalNowMs()),
            atk_response_json: sendResult,
          });
          logFiscalAction(
            "receipt_sent",
            {
              nuikf,
              fiscal_receipt_id: fiscalReceiptId,
              transaction_id: sendResult.transaction_id,
            },
            operatorName,
            operatorId
          );
        } else if (sendResult?.test_mode) {
          atkTestMode = true;
          atkError = "";
        } else {
          atkError = String(sendResult?.error || sendResult?.status || "dështoi");
          printOfflineBanner = true;
          logFiscalAction(
            "receipt_send_failed",
            {
              nuikf,
              fiscal_receipt_id: fiscalReceiptId,
              error: atkError,
              status: sendResult?.status,
              queued_for_retry: true,
            },
            operatorName,
            operatorId
          );
          console.warn(
            "[fiscal-main] ATK fail para printit — print OFFLINE, në radhë ritransmetimi. nuikf=",
            nuikf,
            atkError
          );
        }
      }
    } catch (e) {
      atkError = e.message || "ATK send exception";
      printOfflineBanner = true;
      console.warn("[fiscal-main] ATK send:", atkError);
      try {
        logFiscalAction(
          "receipt_send_failed",
          {
            nuikf,
            fiscal_receipt_id: fiscalReceiptId,
            error: atkError,
            queued_for_retry: true,
          },
          operatorName,
          operatorId
        );
      } catch {
        /* */
      }
    }
  }

  let printResult = { printed: false, printMessage: "" };
  if (!opts.skip_print) {
    try {
      if (pendingId) recovery.markPrinting(pendingId);
    } catch {
      /* */
    }
    printResult = await printFiscalBundle(printText, qrResult, {
      printOfflineBanner,
    });
    if (printResult.printed && pendingId) {
      try {
        recovery.markDone(pendingId, { printed: true });
      } catch {
        /* */
      }
    }
  } else if (pendingId) {
    try {
      recovery.markDone(pendingId, { skip_print: true });
    } catch {
      /* */
    }
  }

  console.log(
    "[fiscal-main] DONE processFiscalReceipt orderId=",
    id,
    "receiptId=",
    fiscalReceiptId,
    "daily_number=",
    dailyNumber,
    "nuikf=",
    nuikf,
    "offline=",
    isOffline
  );

  try {
    const { clearSefFailureStreak } = require("./fiscal-paper-block");
    clearSefFailureStreak();
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    fiscal_receipt_id: fiscalReceiptId,
    nuikf,
    sef_id: sefId,
    daily_number: dailyNumber,
    is_offline: isOffline,
    is_local_only: isLocalOnly,
    print_mode: getFiscalPrintMode(),
    printed: printResult.printed,
    printMessage: printResult.printMessage,
    printMethod: printResult.printMethod || "",
    fiscal_date,
    taxpayer_nui: taxpayerNui,
    print_text: printText,
    pending_txn_id: pendingId,
    signature,
    atk_sent: atkSent,
    sent_to_atk: atkSent ? 1 : 0,
    atk_auto: atkAuto,
    atk_test_mode: atkTestMode,
    atk_error: atkError || null,
    atk_status: atkSent
      ? "sent_ok"
      : isLocalOnly
        ? "local_only"
        : atkTestMode
          ? "test_mode"
          : isOffline
            ? "offline_queued"
            : !atkSent && !isOffline && !atkBlocked && fiscalReceiptId && !memoryOnly
              ? "send_failed"
              : "pending_manual",
    atk_message: atkSent
      ? "ATK: SUKSES — kuponi u pranua"
      : isLocalOnly
        ? "LOKAL — kuponi u ruajt vetëm në këtë PC (pa ATK, pa radhë)"
        : atkTestMode
          ? "ATK: TEST_MODE — kuponi u ruajt lokalisht, pa dërgim te API"
          : isOffline
            ? printOfflineBanner
              ? "OFFLINE — kuponi në radhë (dërgohet kur rikthehet interneti)"
              : "Kuponi në radhë — ATK i paarritshëm (ka internet)"
            : !atkSent && !isOffline && !atkBlocked && fiscalReceiptId && !memoryOnly
              ? `ATK: DËSHTOI — ${atkError || "gabim"} (në radhë për ritransmetim)`
              : "ATK: në pritje — nuk je i lidhur me ATK",
    qr: qrResult
      ? {
          verify_url: qrResult.verify_url,
          escpos_base64: qrResult.escpos_base64,
        }
      : null,
    offline_queue: (() => {
      try {
        const { getOfflineStatus } = require("./fiscal-offline");
        const st = getOfflineStatus();
        return Number(st?.offline_queue_count ?? st?.pending_count) || 0;
      } catch {
        return 0;
      }
    })(),
  };
  } catch (err) {
    console.error("[fiscal-main] ERROR:", err.message || err, "orderId=", id);
    try {
      const { recordSefCriticalFailure } = require("./fiscal-paper-block");
      recordSefCriticalFailure(err, { source: "processFiscalReceipt", orderId: id });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Kupon fiskal provë (dummy) — printon në printer termik, pa INSERT në DB, pa HTTP te ATK.
 * Vetëm kur fiscal ON.
 */
async function printTestFiscalCoupon() {
  if (!isFiscalEnabled()) {
    return { ok: false, gabim: "Fiskalizimi është OFF" };
  }

  const settings = getFiscalSettings() || {};
  const receiptLang = syncLanguageFromSettings(
    settings.language === "sr" ? "sr" : "sq"
  );
  console.log("[fiscal-main] printTestFiscalCoupon language=", receiptLang);
  const rawItems = getAtkTestCouponItems();
  validateInternalTestCouponStructure(rawItems);
  const items = normalizeItems(rawItems);
  const totals = computeAtkTestCouponTotals(items);
  const totalRounded = totals.total;
  const tax = totals.tax;
  const taxTotal = Number(totals.totalTax) || 0;
  const totalWithoutTax = totals.totalWithoutTax;
  const nuikf = assertValidNuikf(generateNUIKF());
  const { fiscal_date, fiscal_time } = todayParts();
  // Mos rrit numrin ditor — kupon prove pa INSERT
  let dailyNumber = 0;
  try {
    dailyNumber = Number(settings.daily_receipt_counter) || 0;
  } catch {
    dailyNumber = 0;
  }

  const fiscalData = {
    taxpayer_nui: settings.taxpayer_nui || "123456789",
    taxpayer_nf: settings.taxpayer_nf || "",
    taxpayer_vat_number: settings.taxpayer_vat_number || "",
    taxpayer_legal_name: settings.taxpayer_legal_name || "PROVE FISKALE",
    taxpayer_address: settings.taxpayer_address || "Adresa prove",
    business_unit_number: settings.business_unit_number || "1",
    unit_name: settings.unit_name || "Njësia Prove",
    unit_phone: settings.unit_phone || "044 000 000",
    pos_id: settings.pos_id || "1",
    nuikf,
    daily_number: dailyNumber || "PROVE",
    total_number: Number(settings.total_receipt_counter) || 1,
    sef_id: getSefIdentifier() || "",
    fiscal_date,
    fiscal_time,
    receipt_type: "regular",
    vat_breakdown: tax,
    is_offline: 0,
    language: receiptLang,
  };

  const orderData = {
    items,
    operator_name: "Prove",
    operator_id: "0",
    payment_method: "cash",
    subtotal: totalRounded,
    total_amount: totalRounded,
    total_without_tax: totalWithoutTax,
    amount_paid: totalRounded,
  };

  const printText = generateFiscalReceipt(orderData, fiscalData);
  if (!printText) {
    return { ok: false, gabim: "Nuk u gjenerua teksti i kuponit" };
  }

  let qrResult = null;
  try {
    qrResult = await generateFiscalQR({
      nuikf,
      total_amount: totalRounded,
      fiscal_date,
      taxpayer_nui: fiscalData.taxpayer_nui,
    });
  } catch (qe) {
    console.warn("[fiscal-main] QR kupon prove:", qe.message);
  }

  const printResult = await printFiscalBundle(printText, qrResult);
  if (!printResult.printed) {
    return {
      ok: false,
      gabim: printResult.printMessage || "Printeri nuk është i lidhur",
    };
  }

  return { ok: true, message: "U printua", nuikf, printed: true };
}

module.exports = {
  processFiscalReceipt,
  getFiscalPrintMode,
  setFiscalPrintMode,
  shouldPrintClosingNormalReceipt,
  shouldPrintNormalReceipt,
  printFiscalBundle,
  printFiscalReportText,
  printTestFiscalCoupon,
  PRINT_MODE_KEY,
};
