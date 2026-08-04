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
const MIN_W_DOTS = Math.round(15 * DOTS_PER_MM); // 120
const MIN_H_DOTS = Math.round(8 * DOTS_PER_MM); // 64
const MAX_W_DOTS = Math.round(20 * DOTS_PER_MM); // 160
const MAX_H_DOTS = Math.round(10 * DOTS_PER_MM); // 80

const LOGO_PATH = path.join(__dirname, "assets", "logo_rks_mf.png");

const FALLBACK_TEXT = "Logo Fiskale\nRKS\nMF";

function assertFiscalOn() {
  return !!isFiscalEnabled();
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
function decodePngToRgba(filePath) {
  try {
    const file = fs.readFileSync(filePath);
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
function rgbaToGsV0(img) {
  const w = img.width;
  const h = img.height;
  const widthBytes = Math.ceil(w / 8);
  const data = Buffer.alloc(widthBytes * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = img.rgba[i + 3];
      const lum = (img.rgba[i] * 299 + img.rgba[i + 1] * 587 + img.rgba[i + 2] * 114) / 1000;
      const black = a > 32 && lum < 160;
      if (black) {
        data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
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
function getFiscalLogo() {
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

  // Scale brenda max 20×10mm; kërko ≥ min 15×8mm
  let tw = Math.min(MAX_W_DOTS, Math.max(MIN_W_DOTS, decoded.width));
  let th = Math.min(MAX_H_DOTS, Math.max(MIN_H_DOTS, decoded.height));
  // Ruaj aspektin brenda kutisë max
  const scale = Math.min(MAX_W_DOTS / decoded.width, MAX_H_DOTS / decoded.height, 1);
  if (decoded.width > MAX_W_DOTS || decoded.height > MAX_H_DOTS) {
    tw = Math.max(1, Math.round(decoded.width * scale));
    th = Math.max(1, Math.round(decoded.height * scale));
  } else if (decoded.width >= MIN_W_DOTS && decoded.height >= MIN_H_DOTS) {
    tw = decoded.width;
    th = decoded.height;
  } else {
    // Shumë i vogël për ATK → fallback tekst derisa të vijë logo zyrtare
    return buildTextFallbackLogo();
  }

  const scaled =
    tw === decoded.width && th === decoded.height
      ? decoded
      : scaleRgba(decoded, tw, th);
  const escposRaster = rgbaToGsV0(scaled);

  return {
    type: "bitmap",
    width: tw,
    height: th,
    width_mm: tw / DOTS_PER_MM,
    height_mm: th / DOTS_PER_MM,
    escposRaster,
    path: LOGO_PATH,
  };
}

/**
 * ESC/POS: ESC a 1 (center) + ESC E 1 (bold) + logo (raster ose tekst) + reset.
 * @returns {{ buffer: Buffer, mode: 'bitmap'|'text', textMarkers: string }}
 */
function getFiscalLogoForPrint() {
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

  const logo = getFiscalLogo();

  if (logo.type === "bitmap" && logo.escposRaster && logo.escposRaster.length) {
    return {
      mode: "bitmap",
      buffer: Buffer.concat([
        centerOn,
        boldOn,
        logo.escposRaster,
        Buffer.from([0x0a]),
        boldOff,
        centerOff,
      ]),
      textMarkers,
      width_mm: logo.width_mm,
      height_mm: logo.height_mm,
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
  getFiscalLogo,
  getFiscalLogoForPrint,
};
