/**
 * fiscal/fiscal-logo.js — logo fiskale RKS/MF për kupon (ATK: min 15×8mm, max 20×10mm).
 * Opsioni 1: ESC/POS GS v 0 (raster). Opsioni 2: tekst i stilizuar.
 * NUK prek printerin ekzistues — vetëm gjeneron buffer/tekst.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { isFiscalEnabled } = require("./fiscal-config");

/** 203 DPI ≈ 8 dots/mm (printer termik tipik). */
const DOTS_PER_MM = 8;
const PAPER_DOTS_80MM = 576; // ~72mm printable @ 80mm
const PAPER_DOTS_58MM = 384; // ~48mm printable @ 58mm
/** Tysso 80mm — ~42 kolona × 12 dots ≈ 504 (përputhet me gjerësinë e tekstit). */
const PAPER_DOTS_TYSSO_80MM = 504;
const MIN_W_DOTS = Math.round(15 * DOTS_PER_MM); // 120
const MIN_H_DOTS = Math.round(8 * DOTS_PER_MM); // 64
const MAX_W_DOTS = Math.round(20 * DOTS_PER_MM); // 160
const MAX_H_DOTS = Math.round(10 * DOTS_PER_MM); // 80

const LOGO_PATH = path.join(__dirname, "assets", "logo_rks_mf.png");

const FALLBACK_TEXT = "Logo Fiskale\nRKS\nMF";

function assertFiscalOn() {
  return !!isFiscalEnabled();
}

/** Gjerësia e printueshme në dots — e njëjtë me kolonat e tekstit të kuponit. */
function resolvePaperDotsForPrint() {
  try {
    const database = require("../database");
    const printer = require("../printer");
    const { paperChars } = require("../receipt-text");
    let paper = "80mm";
    try {
      paper = String(printer.getPrinterConfig(database).paper || "80mm").trim() || "80mm";
    } catch {
      /* */
    }
    if (paper === "auto") paper = "80mm";
    if (paper === "58mm") return PAPER_DOTS_58MM;
    if (paper === "a4" || paper === "100mm") return PAPER_DOTS_80MM;
    const cols = paperChars(paper);
    return Math.max(PAPER_DOTS_TYSSO_80MM, Math.round(cols * 12));
  } catch {
    return PAPER_DOTS_TYSSO_80MM;
  }
}

/** GS L nL nH — margjinë majtas në dots. */
function buildGsLeftMarginDots(dots) {
  const n = Math.max(0, Math.min(65535, Math.round(dots)));
  return Buffer.from([0x1d, 0x4c, n & 0xff, (n >> 8) & 0xff]);
}

function buildGsLeftMarginReset() {
  return Buffer.from([0x1d, 0x4c, 0x00, 0x00]);
}

/** ESC l n — margjinë majtas në kolona (Tysso). */
function buildEscLeftMarginChars(chars) {
  const n = Math.max(0, Math.min(255, Math.round(chars)));
  return Buffer.from([0x1b, 0x6c, n]);
}

function buildLogoCenterPrefix(marginLeft) {
  const margin = Math.max(0, Math.round(marginLeft));
  const marginChars = Math.max(0, Math.min(255, Math.floor(margin / 12)));
  return Buffer.concat([
    Buffer.from([0x1b, 0x61, 0x00]),
    buildGsLeftMarginReset(),
    buildEscLeftMarginChars(marginChars),
    buildGsLeftMarginDots(margin),
  ]);
}

/**
 * Lexon IHDR të PNG (pa lib të jashtëm).
 * @returns {{ width: number, height: number }|null}
 */
function readPngIhdr(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length < 24) return null;
    // Signature PNG
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      return null;
    }
    // IHDR length=13, type at offset 12
    const type = buf.toString("ascii", 12, 16);
    if (type !== "IHDR") return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Dekodon PNG 8-bit RGB/RGBA/Gray (zlib IDAT) → { width, height, rgba: Buffer }.
 * Placeholder 1×1 ose formate të panjohura → null.
 */
function decodePngToRgba(filePathOrBuffer) {
  try {
    const file = Buffer.isBuffer(filePathOrBuffer)
      ? filePathOrBuffer
      : fs.readFileSync(filePathOrBuffer);
    if (file.length < 33) return null;
    if (file[0] !== 0x89 || file.toString("ascii", 1, 4) !== "PNG") return null;

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    const idatParts = [];

    while (offset + 8 <= file.length) {
      const len = file.readUInt32BE(offset);
      const type = file.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > file.length) break;
      const chunk = file.subarray(dataStart, dataEnd);

      if (type === "IHDR") {
        width = chunk.readUInt32BE(0);
        height = chunk.readUInt32BE(4);
        bitDepth = chunk[8];
        colorType = chunk[9];
      } else if (type === "IDAT") {
        idatParts.push(Buffer.from(chunk));
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4; // skip CRC
    }

    if (!width || !height || bitDepth !== 8) return null;
    if (![0, 2, 4, 6].includes(colorType)) return null;
    if (!idatParts.length) return null;

    const inflated = zlib.inflateSync(Buffer.concat(idatParts));
    const bpp = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
    const stride = width * bpp;
    const expected = (stride + 1) * height;
    if (inflated.length < expected) return null;

    const rgba = Buffer.alloc(width * height * 4);
    let inPos = 0;
    let prevRow = Buffer.alloc(stride);

    for (let y = 0; y < height; y++) {
      const filter = inflated[inPos++];
      const row = Buffer.alloc(stride);
      inflated.copy(row, 0, inPos, inPos + stride);
      inPos += stride;

      // Pa filter / Sub / Up / Average / Paeth — mbështetje bazë
      if (filter === 1) {
        for (let i = bpp; i < stride; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
      } else if (filter === 2) {
        for (let i = 0; i < stride; i++) row[i] = (row[i] + prevRow[i]) & 0xff;
      } else if (filter === 3) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prevRow[i];
          row[i] = (row[i] + Math.floor((a + b) / 2)) & 0xff;
        }
      } else if (filter === 4) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prevRow[i];
          const c = i >= bpp ? prevRow[i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          let pr = c;
          if (pa <= pb && pa <= pc) pr = a;
          else if (pb <= pc) pr = b;
          row[i] = (row[i] + pr) & 0xff;
        }
      } else if (filter !== 0) {
        return null;
      }

      for (let x = 0; x < width; x++) {
        const o = y * width * 4 + x * 4;
        const i = x * bpp;
        if (colorType === 0) {
          const g = row[i];
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = 255;
        } else if (colorType === 2) {
          rgba[o] = row[i];
          rgba[o + 1] = row[i + 1];
          rgba[o + 2] = row[i + 2];
          rgba[o + 3] = 255;
        } else if (colorType === 4) {
          const g = row[i];
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = row[i + 1];
        } else {
          rgba[o] = row[i];
          rgba[o + 1] = row[i + 1];
          rgba[o + 2] = row[i + 2];
          rgba[o + 3] = row[i + 3];
        }
      }
      prevRow = row;
    }

    return { width, height, rgba };
  } catch {
    return null;
  }
}

/**
 * Scale nearest-neighbor që të mbetet brenda ATK max, dhe ≥ min nëse burimi e lejon.
 */
function scaleRgba(src, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / tw));
      const si = (sy * src.width + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = src.rgba[si];
      out[di + 1] = src.rgba[si + 1];
      out[di + 2] = src.rgba[si + 2];
      out[di + 3] = src.rgba[si + 3];
    }
  }
  return { width: tw, height: th, rgba: out };
}

/**
 * RGBA → ESC/POS GS v 0 (1-bit raster, m=0 normal).
 * Pixel i zi (luminancë < 128 ose alpha e lartë + errët) = bit 1.
 */
function rgbaToGsV0(img, opts = {}) {
  const w = img.width;
  const h = img.height;
  const widthBytes = Math.ceil(w / 8);
  const data = Buffer.alloc(widthBytes * h);
  const blackLumMax = Number(opts.blackLumMax) > 0 ? Number(opts.blackLumMax) : 150;
  const alphaMin = Number(opts.alphaMin) > 0 ? Number(opts.alphaMin) : 48;
  /** QR/logo fiskal — zi/bardhë pa dither (1.0.10); dither vetëm kur solidRaster=false. */
  const solidRaster = opts.solidRaster !== false;
  let inkByte = 255;
  if (!solidRaster) {
    let ink = 1;
    if (opts.printDensity != null) {
      const {
        inkLevelFromPrintDensity,
        normalizePrintDensity,
      } = require("../receipt-text");
      let printerName = opts.printerName || "";
      if (!printerName) {
        try {
          printerName = require("../database").getSetting("printer_name", "") || "";
        } catch {
          /* */
        }
      }
      ink = inkLevelFromPrintDensity(
        normalizePrintDensity(opts.printDensity),
        printerName,
      );
    } else if (Number(opts.inkLevel) > 0) {
      ink = Math.min(1, Number(opts.inkLevel));
    }
    inkByte = Math.round(ink * 255);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = img.rgba[i + 3];
      const lum = (img.rgba[i] * 299 + img.rgba[i + 1] * 587 + img.rgba[i + 2] * 114) / 1000;
      const isInk = a >= alphaMin && lum <= blackLumMax;
      if (!isInk) continue;
      if (!solidRaster && inkByte < 255) {
        const hsh = (x * 73 + y * 41 + y * w) & 0xff;
        if (hsh >= inkByte) continue;
      }
      data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const xL = widthBytes & 0xff;
  const xH = (widthBytes >> 8) & 0xff;
  const yL = h & 0xff;
  const yH = (h >> 8) & 0xff;
  // GS v 0 m xL xH yL yH d1..dk
  return Buffer.concat([
    Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]),
    data,
  ]);
}

/**
 * GS v 0 raster nuk respekton ESC a 1 (center) — shto padding majtas që logo të dalë në mes të kuponit.
 */
function centerRgbaOnPaper(img, paperWidthDots = PAPER_DOTS_80MM) {
  if (!img || !img.rgba || img.width >= paperWidthDots) return img;
  const padLeft = Math.floor((paperWidthDots - img.width) / 2);
  const outW = paperWidthDots;
  const outH = img.height;
  const rgba = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4;
      const di = (y * outW + padLeft + x) * 4;
      rgba[di] = img.rgba[si];
      rgba[di + 1] = img.rgba[si + 1];
      rgba[di + 2] = img.rgba[si + 2];
      rgba[di + 3] = img.rgba[si + 3];
    }
  }
  return { width: outW, height: outH, rgba };
}

/** Prek vetëm zonën me bojë (zi) — hiq hapësirën e bardhë anash para centring. */
function trimInkBounds(img) {
  const { width: w, height: h, rgba } = img;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3];
      const lum = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
      if (a > 32 && lum < 160) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX) return img;
  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const si = ((minY + y) * w + (minX + x)) * 4;
      const di = (y * tw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { width: tw, height: th, rgba: out };
}

/** Scale brenda kutisë ATK max (20×10mm) duke ruajtur aspektin. */
function fitWithinAtkMax(img) {
  const scale = Math.min(MAX_W_DOTS / img.width, MAX_H_DOTS / img.height, 1);
  const tw = Math.max(1, Math.round(img.width * scale));
  const th = Math.max(1, Math.round(img.height * scale));
  if (tw === img.width && th === img.height) return img;
  return scaleRgba(img, tw, th);
}

function buildTextFallbackLogo() {
  return {
    type: "text",
    text: FALLBACK_TEXT,
    width_mm: null,
    height_mm: null,
    path: LOGO_PATH,
  };
}

/**
 * Logo gati për print:
 * - type:'bitmap' + escposRaster (GS v 0) kur PNG zyrtar i disponueshëm dhe brenda ATK
 * - type:'text' fallback për placeholder / gabim / fiscal OFF
 */
function getFiscalLogo(opts = {}) {
  const { blackLumMaxFromPrintDensity, normalizePrintDensity } = require("../receipt-text");
  const printDensity = normalizePrintDensity(opts.printDensity ?? 10);
  const logoBlackLum = Math.min(200, blackLumMaxFromPrintDensity(printDensity) + 24);
  const logoAlphaMin = Math.min(100, Math.max(40, 108 - printDensity * 3));

  if (!assertFiscalOn()) {
    return { type: "text", text: FALLBACK_TEXT, disabled: true };
  }

  const ihdr = readPngIhdr(LOGO_PATH);
  if (!ihdr || ihdr.width < 8 || ihdr.height < 8) {
    // Placeholder 1×1 ose mungon — fallback tekst (ATK min 15×8mm)
    return buildTextFallbackLogo();
  }

  const decoded = decodePngToRgba(LOGO_PATH);
  if (!decoded) return buildTextFallbackLogo();
  if (decoded.width < 8 || decoded.height < 8) return buildTextFallbackLogo();

  // Bitmap kompakt + qendër me GS L / ESC l (padding në bitmap Tysso e pret)
  const trimmed = trimInkBounds(decoded);
  const fitted = fitWithinAtkMax(trimmed);
  const paperDots = resolvePaperDotsForPrint();
  const centered = centerRgbaOnPaper(fitted, paperDots);
  let printerName = "";
  try {
    printerName = require("../database").getSetting("printer_name", "") || "";
  } catch {
    /* */
  }
  const escposRaster = rgbaToGsV0(centered, {
    blackLumMax: logoBlackLum,
    alphaMin: logoAlphaMin,
    printDensity,
    printerName,
    solidRaster: true,
  });

  return {
    type: "bitmap",
    width: centered.width,
    height: centered.height,
    width_mm: fitted.width / DOTS_PER_MM,
    height_mm: fitted.height / DOTS_PER_MM,
    marginLeft: 0,
    paperDots,
    escposRaster,
    path: LOGO_PATH,
  };
}

/**
 * GS v 0 raster i qendruar (QR, logo, etj.) — i njëjti mekanizëm si logo RKS/MF.
 * @returns {{ buffer: Buffer, width: number, height: number, marginLeft: number }|null}
 */
function buildCenteredRasterPrintBuffer(decoded, opts = {}) {
  if (!decoded || !decoded.rgba || !decoded.width || !decoded.height) return null;
  const paperDots = opts.paperDots || resolvePaperDotsForPrint();
  const maxW = Number(opts.maxWidthDots) > 0 ? Number(opts.maxWidthDots) : paperDots;
  const maxH = Number(opts.maxHeightDots) > 0 ? Number(opts.maxHeightDots) : 320;
  const trimmed = trimInkBounds(decoded);
  const scale = Math.min(maxW / trimmed.width, maxH / trimmed.height, 1);
  const fitted =
    scale < 1
      ? scaleRgba(
          trimmed,
          Math.max(1, Math.round(trimmed.width * scale)),
          Math.max(1, Math.round(trimmed.height * scale))
        )
      : trimmed;
  const centered = centerRgbaOnPaper(fitted, paperDots);
  const { blackLumMaxFromPrintDensity, normalizePrintDensity } = require("../receipt-text");
  const pd =
    opts.printDensity != null
      ? normalizePrintDensity(opts.printDensity)
      : opts.blackLumMax != null
        ? null
        : 10;
  const lumMax =
    opts.blackLumMax ??
    (pd != null ? blackLumMaxFromPrintDensity(pd) : blackLumMaxFromPrintDensity(10));
  const escposRaster = rgbaToGsV0(centered, {
    blackLumMax: opts.solidRaster !== false ? Math.max(lumMax, 78) : lumMax,
    alphaMin:
      opts.alphaMin ??
      (pd != null
        ? Math.min(120, Math.max(48, 128 - pd * 4))
        : 96),
    printDensity: pd != null ? pd : opts.printDensity,
    printerName: opts.printerName || "",
    solidRaster: opts.solidRaster !== false,
  });
  return {
    buffer: Buffer.concat([
      buildGsLeftMarginReset(),
      buildEscLeftMarginChars(0),
      Buffer.from([0x1b, 0x61, 0x01]),
      escposRaster,
      Buffer.from([0x0a]),
      buildGsLeftMarginReset(),
      Buffer.from([0x1b, 0x61, 0x00]),
    ]),
    width: centered.width,
    height: centered.height,
    marginLeft: 0,
    mode: "bitmap",
  };
}

function buildCenteredRasterPrintFromPng(pngBuffer, opts = {}) {
  const decoded = decodePngToRgba(pngBuffer);
  if (!decoded) return null;
  return buildCenteredRasterPrintBuffer(decoded, opts);
}

/**
 * ESC/POS: ESC a 1 (center) + ESC E 1 (bold) + logo (raster ose tekst) + reset.
 * @returns {{ buffer: Buffer, mode: 'bitmap'|'text', textMarkers: string }}
 */
function getFiscalLogoForPrint(opts = {}) {
  const { normalizePrintDensity, prependPrintDensityEscPos } = require("../receipt-text");
  const printDensity = normalizePrintDensity(opts.printDensity ?? 10);
  const ESC = 0x1b;
  const centerOn = Buffer.from([ESC, 0x61, 0x01]);
  const centerOff = Buffer.from([ESC, 0x61, 0x00]);
  const boldOn = Buffer.from([ESC, 0x45, 0x01]);
  const boldOff = Buffer.from([ESC, 0x45, 0x00]);

  const textMarkers = ["^C^BLogo Fiskale", "^CRKS", "^CMF"].join("\n");

  if (!assertFiscalOn()) {
    return {
      mode: "text",
      buffer: Buffer.concat([
        centerOn,
        boldOn,
        Buffer.from("Logo Fiskale\nRKS\nMF\n", "ascii"),
        boldOff,
        centerOff,
      ]),
      textMarkers,
      disabled: true,
    };
  }

  const logo = getFiscalLogo({ printDensity });

  if (logo.type === "bitmap" && logo.escposRaster && logo.escposRaster.length) {
    const body = Buffer.concat([
      buildGsLeftMarginReset(),
      buildEscLeftMarginChars(0),
      Buffer.from([0x1b, 0x61, 0x01]),
      logo.escposRaster,
      Buffer.from([0x0a]),
      buildGsLeftMarginReset(),
      Buffer.from([0x1b, 0x61, 0x00]),
    ]);
    return {
      mode: "bitmap",
      buffer: prependPrintDensityEscPos(
        body,
        printDensity,
        require("../database").getSetting("printer_name", "") || "",
      ),
      textMarkers,
      width_mm: logo.width_mm,
      height_mm: logo.height_mm,
      marginLeft: 0,
    };
  }

  // Fallback tekst i stilizuar (center + bold)
  const textBody = Buffer.from(`${FALLBACK_TEXT}\n`, "ascii");
  return {
    mode: "text",
    buffer: Buffer.concat([centerOn, boldOn, textBody, boldOff, centerOff]),
    textMarkers,
  };
}

module.exports = {
  LOGO_PATH,
  MIN_W_DOTS,
  MIN_H_DOTS,
  MAX_W_DOTS,
  MAX_H_DOTS,
  FALLBACK_TEXT,
  PAPER_DOTS_80MM,
  PAPER_DOTS_58MM,
  PAPER_DOTS_TYSSO_80MM,
  centerRgbaOnPaper,
  resolvePaperDotsForPrint,
  buildGsLeftMarginDots,
  buildGsLeftMarginReset,
  buildEscLeftMarginChars,
  buildLogoCenterPrefix,
  buildCenteredRasterPrintBuffer,
  buildCenteredRasterPrintFromPng,
  getFiscalLogo,
  getFiscalLogoForPrint,
};
