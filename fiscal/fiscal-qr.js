/**
 * fiscal/fiscal-qr.js — HAPI 8: QR fiskal me nënshkrim + ESC/POS për printer termik.
 * NUK prek QR-në e porosive (tavolina/kiosk). Kur isFiscalEnabled()=false → null.
 *
 * Format ATK (default): base64(CitizenCoupon protobuf) + "|" + base64(ECDSA sig)
 * Format legacy (debug): URL + meta (nuikf, total, date, nui, sig)
 */
const QRCode = require("qrcode");
const { isFiscalEnabled } = require("./fiscal-config");
const { signReceipt } = require("./fiscal-crypto");
const { money4 } = require("./fiscal-vat");
const {
  buildCitizenCoupon,
  getCitizenCouponType,
  resolveAtkCouponBuildOpts,
} = require("./atk-model-builder");

const SIATK_VERIFY_BASE = "https://efiskalizimi.atk-ks.org/verify";

/**
 * true = format zyrtar ATK (protobuf|sig).
 * false = URL+meta i vjetër (vetëm debug).
 * Env: ATK_QR_FORMAT=0|false → legacy.
 */
let ATK_QR_FORMAT = !(
  process.env.ATK_QR_FORMAT === "0" ||
  String(process.env.ATK_QR_FORMAT || "").toLowerCase() === "false"
);

function setAtkQrFormat(enabled) {
  ATK_QR_FORMAT = !!enabled;
  return ATK_QR_FORMAT;
}

function isAtkQrFormat() {
  return !!ATK_QR_FORMAT;
}

/** Kapacitet i arsyeshëm për QR Model 2 (ECC M) — pa prerë payload ATK. */
const QR_PAYLOAD_MAX_ATK = 2048;
const QR_PAYLOAD_MAX_LEGACY = 700;

/** PNG i mprehtë; raster termik ~20 mm (160 dots @ 203 DPI) — skanueshmëri ATK. */
const FISCAL_QR_PNG_WIDTH = 320;
const FISCAL_QR_MAX_WIDTH_DOTS = 160;
const FISCAL_QR_MAX_HEIGHT_DOTS = 160;
const FISCAL_QR_MODULE_SIZE = 4;
/** Binarizim QR raster — si 1.0.10 (78): zi/bardhë pa gray në module. */
const FISCAL_QR_BLACK_LUM_MAX = 78;
const FISCAL_QR_ALPHA_MIN = 96;

function getFiscalQrPrintOpts(extra = {}) {
  const {
    normalizePrintDensity,
    blackLumMaxFromPrintDensity,
    qrDarkHexFromPrintDensity,
  } = require("../receipt-text");
  const printDensity =
    extra.printDensity != null ? normalizePrintDensity(extra.printDensity) : null;
  const d = printDensity ?? normalizePrintDensity(10);
  const blackLumMax =
    printDensity != null ? blackLumMaxFromPrintDensity(printDensity) : FISCAL_QR_BLACK_LUM_MAX;
  const alphaMin =
    printDensity != null
      ? Math.min(120, Math.max(48, 128 - printDensity * 4))
      : FISCAL_QR_ALPHA_MIN;
  let printerName = "";
  try {
    printerName = require("../database").getSetting("printer_name", "") || "";
  } catch {
    /* */
  }
  let preferNativeQr =
    extra.preferNativeQr != null ? !!extra.preferNativeQr : d >= 8;
  const { isRongtaPrinterName } = require("../receipt-text");
  if (isRongtaPrinterName(printerName) && d <= 7) {
    preferNativeQr = false;
  }
  return {
    moduleSize: FISCAL_QR_MODULE_SIZE,
    maxWidthDots: FISCAL_QR_MAX_WIDTH_DOTS,
    maxHeightDots: FISCAL_QR_MAX_HEIGHT_DOTS,
    blackLumMax,
    alphaMin,
    printDensity: d,
    printerName,
    /** Si 1.0.10 për errësira ≥8; raster + dither për 1–7 (PNG #000 ishte gjithmonë zi). */
    preferNativeQr,
    solidRaster: true,
    ...extra,
    blackLumMax,
    alphaMin,
    printDensity: d,
    preferNativeQr,
    solidRaster: extra.solidRaster !== false,
  };
}

function withQrPrintDensity(buffer, printDensity) {
  const { prependPrintDensityEscPos } = require("../receipt-text");
  let printerName = "";
  try {
    printerName = require("../database").getSetting("printer_name", "") || "";
  } catch {
    /* */
  }
  return prependPrintDensityEscPos(buffer, printDensity, printerName);
}

/**
 * Siguron string valid për librarinë qrcode (pa objekte/Buffer të papritur).
 */
function toQrSafeString(value, maxLen = 2048) {
  let s = value == null ? "" : String(value);
  // Hiq karaktere kontrolli që mund të prishin gjenerimin
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/**
 * Format legacy: URL + meta tekst (debug / kthim prapa).
 */
function buildQrPayload(receiptData, signatureBase64) {
  const d = receiptData && typeof receiptData === "object" ? receiptData : {};
  const nuikf = toQrSafeString(d.nuikf || "").trim();
  const total = money4(d.total_amount ?? d.total ?? 0);
  const date = toQrSafeString(d.fiscal_date || d.date || "");
  const nui = toQrSafeString(d.taxpayer_nui || d.nui || "");
  // SIG në QR: mbaj base64 të pastër, kufizo gjatësinë (ESC/POS QR max ~708 bytes)
  const sig = toQrSafeString(signatureBase64 || "", 512).replace(/\s+/g, "");
  const verifyUrl = `${SIATK_VERIFY_BASE}?nuikf=${encodeURIComponent(nuikf)}`;

  return toQrSafeString(
    [
      verifyUrl,
      `NUIKF:${nuikf}`,
      `TOTAL:${total}`,
      `DATE:${date}`,
      `NUI:${nui}`,
      `SIG:${sig}`,
    ].join("|"),
    QR_PAYLOAD_MAX_LEGACY
  );
}

/**
 * Format zyrtar ATK:
 * base64(CitizenCoupon protobuf) + "|" + base64(ECDSA signature e atij base64)
 */
function buildAtkQrPayload(receiptData) {
  const d = receiptData && typeof receiptData === "object" ? receiptData : {};
  const atkOpts = resolveAtkCouponBuildOpts(d);
  const citizen = buildCitizenCoupon(d, atkOpts);
  const Type = getCitizenCouponType();
  const message = Type.fromObject(citizen);
  const errMsg = Type.verify(message);
  if (errMsg) {
    throw new Error("CitizenCoupon invalid për QR: " + errMsg);
  }
  const binary = Type.encode(message).finish();
  const base64EncodedProto = Buffer.from(binary).toString("base64");
  const base64Signature = signReceipt(base64EncodedProto);
  if (!base64Signature || typeof base64Signature !== "string") {
    throw new Error("Nënshkrimi digjital ATK dështoi");
  }
  const qrString = `${base64EncodedProto}|${base64Signature}`;
  console.log('[QR-DEBUG] payload length:', qrString.length, 'chars');
  console.log('[QR-DEBUG] payload preview:', qrString.substring(0, 50) + '...');
  return toQrSafeString(qrString, QR_PAYLOAD_MAX_ATK);
}

/**
 * Gjerësia e printuar e QR (dots) — vlerësim nga module size + gjatësia e payload.
 */
function estimateQrPrintWidthDots(moduleSize, dataByteLength) {
  const size = Math.min(16, Math.max(1, Number(moduleSize) || 4));
  const bytes = Math.max(1, Number(dataByteLength) || 1);
  let modules = 21;
  if (bytes > 80) modules = 25;
  if (bytes > 150) modules = 29;
  if (bytes > 250) modules = 33;
  if (bytes > 400) modules = 37;
  if (bytes > 600) modules = 41;
  if (bytes > 900) modules = 45;
  if (bytes > 1200) modules = 49;
  return modules * size;
}

function buildQrCenterPrefix() {
  const { buildGsLeftMarginReset, buildEscLeftMarginChars } = require("./fiscal-logo");
  return Buffer.concat([
    buildGsLeftMarginReset(),
    buildEscLeftMarginChars(0),
    Buffer.from([0x1b, 0x61, 0x01]),
  ]);
}

/** PNG i QR nga generateFiscalQR ose reprint. */
function resolveQrPngBuffer(qrResult) {
  if (!qrResult || typeof qrResult !== "object") return null;
  if (Buffer.isBuffer(qrResult.png_buffer) && qrResult.png_buffer.length) {
    return qrResult.png_buffer;
  }
  if (qrResult.png_base64) {
    try {
      const b = Buffer.from(String(qrResult.png_base64), "base64");
      if (b.length) return b;
    } catch (e) {
      console.error('[QR-DEBUG] resolveQrPngBuffer FAILED:', e.message);
    }
  }
  return null;
}

/**
 * Buffer ESC/POS për QR fiskal — raster i qendruar (preferuar), pastaj native GS ( k.
 * E njëjta rrugë për Tysso, Epson, Star, etj. (mos nda fazat pas printimit).
 * @param {object} qrResult
 * @param {{ moduleSize?: number, maxWidthDots?: number }} [opts]
 * @returns {Buffer|null}
 */
function buildFiscalQrEscPosBuffer(qrResult, opts = {}) {
  if (!qrResult) return null;
  const printOpts = getFiscalQrPrintOpts(opts);
  const moduleSize = Number(printOpts.moduleSize) || FISCAL_QR_MODULE_SIZE;

  const density = printOpts.printDensity;
  const payload = qrResult.payload ? String(qrResult.payload) : "";
  if (payload && printOpts.preferNativeQr !== false) {
    return withQrPrintDensity(buildEscPosQrCommands(payload, moduleSize), density);
  }

  const png = resolveQrPngBuffer(qrResult);
  if (png) {
    const raster = buildEscPosQrRasterForPrint(png, printOpts);
    if (raster && raster.buffer && raster.buffer.length) {
      return withQrPrintDensity(raster.buffer, density);
    }
  }

  if (payload) return withQrPrintDensity(buildEscPosQrCommands(payload, moduleSize), density);

  if (Buffer.isBuffer(qrResult.escpos_buffer) && qrResult.escpos_buffer.length) {
    return withQrPrintDensity(qrResult.escpos_buffer, density);
  }
  if (qrResult.escpos_base64) {
    try {
      const b = Buffer.from(String(qrResult.escpos_base64), "base64");
      if (b.length) return withQrPrintDensity(b, density);
    } catch (e) {
      console.error("[QR-DEBUG] buildFiscalQrEscPosBuffer decode FAILED:", e.message);
    }
  }
  return null;
}

/**
 * QR si bitmap GS v 0 i qendruar (native GS ( k shpesh ignoron ESC a 1 / GS L).
 * @param {Buffer|string} pngInput — PNG buffer ose base64
 * @returns {{ buffer: Buffer, width: number, height: number, marginLeft: number }|null}
 */
function buildEscPosQrRasterForPrint(pngInput, opts = {}) {
  try {
    const png = Buffer.isBuffer(pngInput)
      ? pngInput
      : Buffer.from(String(pngInput || ""), "base64");
    if (!png.length) return null;
    const { buildCenteredRasterPrintFromPng } = require("./fiscal-logo");
    return buildCenteredRasterPrintFromPng(png, getFiscalQrPrintOpts(opts));
  } catch (e) {
    console.error('[QR-DEBUG] buildEscPosQrRasterForPrint FAILED:', e.message);
    return null;
  }
}

/**
 * ESC/POS native QR (Epson GS ( k) — Model 2.
 * @param {string} data
 * @param {number} [moduleSize=4] 1–16
 * @returns {Buffer}
 */
function buildEscPosQrCommands(data, moduleSize = 4) {
  const text = Buffer.from(String(data), "utf8");
  const size = Math.min(16, Math.max(1, Number(moduleSize) || 4));
  const cn = 0x31; // 49
  const chunks = [];

  // Model: fn 65 — model 2
  chunks.push(Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, cn, 0x41, 0x32, 0x00]));
  // Module size: fn 67
  chunks.push(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, cn, 0x43, size]));
  // Error correction: fn 69 — level M (48)
  chunks.push(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, cn, 0x45, 0x30]));

  // Store data: fn 80
  const storeLen = text.length + 3;
  const pL = storeLen & 0xff;
  const pH = (storeLen >> 8) & 0xff;
  chunks.push(
    Buffer.from([0x1d, 0x28, 0x6b, pL, pH, cn, 0x50, 0x30]),
    text
  );

  // Print: fn 81
  chunks.push(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, cn, 0x51, 0x30]));

  const qrBody = Buffer.concat(chunks);
  return Buffer.concat([
    buildQrCenterPrefix(),
    qrBody,
    Buffer.from("\n\n", "ascii"),
    Buffer.from([0x1d, 0x4c, 0x00, 0x00]),
    Buffer.from([0x1b, 0x61, 0x00]),
  ]);
}

/**
 * Gjeneron QR fiskal: nënshkrim + payload + buffer PNG + ESC/POS.
 * @returns {Promise<object|null>}
 */
async function generateFiscalQR(receiptData) {
  if (!isFiscalEnabled()) return null;

  const d = receiptData && typeof receiptData === "object" ? receiptData : {};
  if (!d.nuikf) {
    throw new Error("NUIKF mungon për QR fiskal");
  }

  let signature;
  let payload;

  if (ATK_QR_FORMAT) {
    payload = buildAtkQrPayload(d);
    const parts = String(payload).split("|");
    signature = parts.length >= 2 ? parts.slice(1).join("|") : "";
    if (!signature) {
      throw new Error("Nënshkrimi digjital dështoi");
    }
  } else {
    signature = signReceipt(d);
    if (!signature || typeof signature !== "string") {
      throw new Error("Nënshkrimi digjital dështoi");
    }
    payload = buildQrPayload(d, signature);
  }

  if (!payload || typeof payload !== "string") {
    throw new Error("QR payload i pavlefshëm");
  }

  let printDensity = 10;
  try {
    const database = require("../database");
    printDensity = database.getSetting("printer_density", "10");
  } catch {
    /* */
  }

  // PNG — zi/bardhë të pastër (#000/#fff); kontrasti termik në raster (solidRaster).
  const pngBuffer = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: "M",
    type: "png",
    margin: 2,
    width: FISCAL_QR_PNG_WIDTH,
    color: { dark: "#000000", light: "#ffffff" },
  });
  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) {
    throw new Error("QR PNG buffer dështoi");
  }
  const escpos = buildFiscalQrEscPosBuffer(
    { payload, png_buffer: pngBuffer, png_base64: pngBuffer.toString("base64") },
    getFiscalQrPrintOpts({ printDensity }),
  );

  // ASCII opsional — dështimi nuk prish QR-në (utf8 renderer ka bug me array length)
  let ascii = "";
  try {
    ascii = await QRCode.toString(payload, {
      type: "terminal",
      errorCorrectionLevel: "M",
      small: true,
    });
    ascii = typeof ascii === "string" ? ascii : "";
  } catch {
    ascii = "";
  }

  return {
    payload,
    signature: String(signature),
    atk_format: !!ATK_QR_FORMAT,
    verify_url: `${SIATK_VERIFY_BASE}?nuikf=${encodeURIComponent(toQrSafeString(d.nuikf))}`,
    png_buffer: pngBuffer,
    png_base64: pngBuffer.toString("base64"),
    escpos_buffer: escpos,
    escpos_base64: escpos.toString("base64"),
    ascii,
  };
}

/**
 * Konverton të dhënat e QR në format printimi termik ESC/POS.
 * Pranon output nga generateFiscalQR ose string payload.
 * @returns {Promise<object|null>} { escpos_base64, escpos_buffer, ascii, png_base64? }
 */
async function generateQRForPrint(qrData) {
  if (!isFiscalEnabled()) return null;

  if (qrData == null) return null;

  // Tashmë i gjeneruar nga generateFiscalQR
  if (typeof qrData === "object" && qrData.escpos_buffer) {
    return {
      escpos_buffer: qrData.escpos_buffer,
      escpos_base64: qrData.escpos_base64 || qrData.escpos_buffer.toString("base64"),
      ascii: qrData.ascii || "",
      png_base64: qrData.png_base64 || null,
      payload: qrData.payload || null,
    };
  }

  let payload;
  if (typeof qrData === "string") {
    payload = qrData;
  } else if (qrData.payload) {
    payload = qrData.payload;
  } else if (ATK_QR_FORMAT) {
    payload = buildAtkQrPayload(qrData);
  } else {
    payload = buildQrPayload(
      qrData,
      qrData.signature || signReceipt(qrData) || ""
    );
  }

  const maxLen = ATK_QR_FORMAT ? QR_PAYLOAD_MAX_ATK : QR_PAYLOAD_MAX_LEGACY;
  const safePayload = toQrSafeString(payload, maxLen);
  let pngBuffer = null;
  let png_base64 = null;
  try {
    pngBuffer = await QRCode.toBuffer(safePayload, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 2,
      width: FISCAL_QR_PNG_WIDTH,
      color: { dark: "#000000", light: "#ffffff" },
    });
    if (Buffer.isBuffer(pngBuffer) && pngBuffer.length) {
      png_base64 = pngBuffer.toString("base64");
    }
  } catch {
    /* optional */
  }
  const escpos = buildFiscalQrEscPosBuffer(
    {
      payload: safePayload,
      png_buffer: pngBuffer,
      png_base64,
    },
    getFiscalQrPrintOpts(),
  );
  let ascii = "";
  try {
    ascii = await QRCode.toString(safePayload, {
      type: "terminal",
      errorCorrectionLevel: "M",
      small: true,
    });
    ascii = typeof ascii === "string" ? ascii : "";
  } catch {
    ascii = "";
  }

  return {
    escpos_buffer: escpos,
    escpos_base64: escpos ? escpos.toString("base64") : "",
    ascii,
    png_base64,
    payload: safePayload,
  };
}

function ymdToFiscalDate(ymd) {
  const s = String(ymd || "").trim().slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s;
}

function buildReportVerificationNo(details, mode) {
  const crypto = require("crypto");
  const { getSefIdentifier } = require("./fiscal-numbering");
  const d = details && typeof details === "object" ? details : {};
  const seed = [
    String(mode || d.mode || "X").toUpperCase(),
    d.date || "",
    d.from_date || "",
    d.to_date || "",
    Number(d.total_amount) || 0,
    Number(d.coupon_count) || 0,
    getSefIdentifier() || "",
  ].join("|");
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16).toUpperCase();
}

/**
 * QR për Raport X / Z / Periodik — i njëjti format ATK: base64(CitizenCoupon)|base64(ECDSA).
 */
async function generateFiscalReportQR(reportDetails, opts = {}) {
  if (!isFiscalEnabled()) return null;

  const { getFiscalSettings } = require("./fiscal-config");
  const { getSefIdentifier } = require("./fiscal-numbering");
  const settings = getFiscalSettings();
  const d = reportDetails && typeof reportDetails === "object" ? reportDetails : {};
  const mode = String(opts.reportMode || d.mode || "X").toUpperCase();
  const nuikf = buildReportVerificationNo(d, mode);
  const dateRaw = String(d.date || d.from_date || "")
    .split("→")[0]
    .trim()
    .slice(0, 10);
  const fiscal_date =
    ymdToFiscalDate(dateRaw) ||
    ymdToFiscalDate(new Date().toISOString().slice(0, 10));
  const now = new Date();
  const fiscal_time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const row = {
    nuikf,
    total_amount: Number(d.total_amount) || 0,
    total_without_tax: Number(d.total_without_tax) || 0,
    vat_breakdown_json: JSON.stringify(d.vat_breakdown || {}),
    items_json: "[]",
    receipt_type: "regular",
    payment_method: "cash",
    fiscal_date,
    fiscal_time,
    sef_id: getSefIdentifier() || "",
    daily_number: Number(d.coupon_count) || 0,
    taxpayer_nui: settings.taxpayer_nui || "",
    taxpayer_address: settings.taxpayer_address || "",
    operator_id: String(opts.operatorId || "POS"),
  };

  return generateFiscalQR({
    ...row,
    total: row.total_amount,
    nui: row.taxpayer_nui,
    taxpayer_nui: row.taxpayer_nui,
  });
}

module.exports["SIATK_VERIFY_BASE"] = SIATK_VERIFY_BASE;
module.exports["setAtkQrFormat"] = setAtkQrFormat;
module.exports["isAtkQrFormat"] = isAtkQrFormat;
module.exports["buildQrPayload"] = buildQrPayload;
module.exports["buildAtkQrPayload"] = buildAtkQrPayload;
module.exports["buildEscPosQrCommands"] = buildEscPosQrCommands;
module.exports["buildFiscalQrEscPosBuffer"] = buildFiscalQrEscPosBuffer;
module.exports["resolveQrPngBuffer"] = resolveQrPngBuffer;
module.exports["buildEscPosQrRasterForPrint"] = buildEscPosQrRasterForPrint;
module.exports["estimateQrPrintWidthDots"] = estimateQrPrintWidthDots;
module.exports["buildQrCenterPrefix"] = buildQrCenterPrefix;
module.exports["generateFiscalQR"] = generateFiscalQR;
module.exports["generateFiscalReportQR"] = generateFiscalReportQR;
module.exports["generateQRForPrint"] = generateQRForPrint;
module.exports["getFiscalQrPrintOpts"] = getFiscalQrPrintOpts;
module.exports["FISCAL_QR_PNG_WIDTH"] = FISCAL_QR_PNG_WIDTH;
module.exports["FISCAL_QR_MAX_WIDTH_DOTS"] = FISCAL_QR_MAX_WIDTH_DOTS;
module.exports["toQrSafeString"] = toQrSafeString;
Object.defineProperty(module.exports, "ATK_QR_FORMAT", {
  enumerable: true,
  get() {
    return ATK_QR_FORMAT;
  },
  set(v) {
    ATK_QR_FORMAT = !!v;
  },
});
