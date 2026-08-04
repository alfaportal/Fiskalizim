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
const {
  buildCitizenCoupon,
  getCitizenCouponType,
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
  const totalNum = Number(d.total_amount ?? d.total ?? 0);
  const total = Number.isFinite(totalNum) ? totalNum.toFixed(2) : "0.00";
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
  const citizen = buildCitizenCoupon(d);
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
  return toQrSafeString(qrString, QR_PAYLOAD_MAX_ATK);
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

  // Center align before/after handled by caller; add newlines
  return Buffer.concat([
    Buffer.from([0x1b, 0x61, 0x01]), // center
    Buffer.concat(chunks),
    Buffer.from("\n\n", "ascii"),
    Buffer.from([0x1b, 0x61, 0x00]), // left
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

  // PNG — mos përdor toString(utf8): hedh "Invalid array length" për payload mesatar/të madh
  const pngBuffer = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: "M",
    type: "png",
    margin: 1,
    width: 180,
  });
  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) {
    throw new Error("QR PNG buffer dështoi");
  }

  const escpos = buildEscPosQrCommands(payload, 4);

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
  const escpos = buildEscPosQrCommands(safePayload, 4);
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
  let png_base64 = null;
  try {
    const png = await QRCode.toBuffer(safePayload, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 180,
    });
    png_base64 = png.toString("base64");
  } catch {
    /* optional */
  }

  return {
    escpos_buffer: escpos,
    escpos_base64: escpos.toString("base64"),
    ascii,
    png_base64,
    payload: safePayload,
  };
}

module.exports["SIATK_VERIFY_BASE"] = SIATK_VERIFY_BASE;
module.exports["setAtkQrFormat"] = setAtkQrFormat;
module.exports["isAtkQrFormat"] = isAtkQrFormat;
module.exports["buildQrPayload"] = buildQrPayload;
module.exports["buildAtkQrPayload"] = buildAtkQrPayload;
module.exports["buildEscPosQrCommands"] = buildEscPosQrCommands;
module.exports["generateFiscalQR"] = generateFiscalQR;
module.exports["generateQRForPrint"] = generateQRForPrint;
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
