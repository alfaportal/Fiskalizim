/**
 * Logo fiskale RKS/MF nga stema zyrtare e Kosovës → 160×80 B/W (ATK max 20×10mm).
 * Layout si në kupon: mburojë majtas | RKS / MF djathtas — mbush të gjithë kanavacën.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_W = 160;
const OUT_H = 80;

const REF = path.join(
  process.env.USERPROFILE || "",
  ".cursor/projects/c-Users-1-Desktop-firmat-biznes/assets",
  "c__Users_1_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_Screenshot_2026-08-04_194554-9ece7e4b-93dd-4524-8bac-0906d2821d46.png",
);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return out;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, typeBuf, data, crc32(Buffer.concat([typeBuf, data]))]);
}

function decodePngRgba(filePath) {
  const file = fs.readFileSync(filePath);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatParts = [];
  while (offset + 8 <= file.length) {
    const len = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") idatParts.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset += 12 + len;
  }
  const bpp = colorType === 2 ? 3 : 4;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const rgba = Buffer.alloc(width * height * 4);
  let inPos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[inPos++];
    const row = Buffer.alloc(stride);
    inflated.copy(row, 0, inPos, inPos + stride);
    inPos += stride;
    if (filter === 1) {
      for (let i = bpp; i < stride; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + Math.floor((a + prev[i]) / 2)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[i] = (row[i] + pr) & 0xff;
      }
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      if (bpp === 3) {
        rgba[di] = row[si];
        rgba[di + 1] = row[si + 1];
        rgba[di + 2] = row[si + 2];
        rgba[di + 3] = 255;
      } else {
        rgba[di] = row[si];
        rgba[di + 1] = row[si + 1];
        rgba[di + 2] = row[si + 2];
        rgba[di + 3] = row[si + 3];
      }
    }
    prev = row;
  }
  return { width, height, rgba };
}

function pix(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
}

function isGold(r, g, b) {
  return r > 140 && g > 100 && b < 150 && r > b + 25;
}

function isWhite(r, g, b) {
  return r > 200 && g > 200 && b > 200;
}

function nearBg(r, g, b, br, bg, bb) {
  return Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) < 55;
}

/** Stema → maskë B/W (1=zi për print). */
function extractShieldBw(img) {
  const { width: w, height: h } = img;
  const [br, bg, bb] = pix(img, 2, 2);
  const bgMask = new Uint8Array(w * h);
  const q = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]];
  for (const [sx, sy] of q) {
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (bgMask[i]) continue;
      const [r, g, b] = pix(img, x, y);
      if (isGold(r, g, b) || isWhite(r, g, b)) continue;
      if (!nearBg(r, g, b, br, bg, bb)) continue;
      bgMask[i] = 1;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  // Distanca Chebyshev deri te sfondi — ari afër skajit = kufi (zi), ari brenda = hartë (bardhë)
  const dist = new Int16Array(w * h);
  dist.fill(32767);
  const dq = [];
  for (let i = 0; i < w * h; i++) {
    if (!bgMask[i]) continue;
    dist[i] = 0;
    dq.push(i);
  }
  for (let qi = 0; qi < dq.length; qi++) {
    const i = dq[qi];
    const x = i % w;
    const y = (i / w) | 0;
    const nd = dist[i] + 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (nd < dist[j]) {
          dist[j] = nd;
          dq.push(j);
        }
      }
    }
  }

  const BORDER_GOLD_MAX = 6; // px nga sfondi → kufi i zi; më brenda → hartë
  const cutout = new Uint8Array(w * h);
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bgMask[i]) continue;
      const [r, g, b] = pix(img, x, y);
      if (isWhite(r, g, b)) {
        cutout[i] = 1;
        continue;
      }
      if (isGold(r, g, b)) {
        if (dist[i] <= BORDER_GOLD_MAX) ink[i] = 1;
        else cutout[i] = 1;
        continue;
      }
      ink[i] = 1;
    }
  }

  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  // zgjero pak për cutout që del jashtë ink bbox
  for (let y = Math.max(0, minY - 4); y <= Math.min(h - 1, maxY + 4); y++) {
    for (let x = Math.max(0, minX - 4); x <= Math.min(w - 1, maxX + 4); x++) {
      if (!cutout[y * w + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const sw = maxX - minX + 1;
  const sh = maxY - minY + 1;
  const mask = Buffer.alloc(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      mask[y * sw + x] = ink[(minY + y) * w + (minX + x)] ? 1 : 0;
    }
  }
  return { width: sw, height: sh, mask };
}

/** Font 5×7 — trashësi për termik (RKS/MF lexohen në letër). */
const FONT = {
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
};

function setBlack(out, x, y) {
  if (x < 0 || y < 0 || x >= OUT_W || y >= OUT_H) return;
  const di = (y * OUT_W + x) * 4;
  out[di] = 0;
  out[di + 1] = 0;
  out[di + 2] = 0;
  out[di + 3] = 255;
}

function blitGlyph(out, ox, oy, ch, scale) {
  const g = FONT[ch];
  if (!g) return 5 * scale;
  // Qeliza e plotë + 1px djathtas (më e zezë në printer termik)
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (g[row][col] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          setBlack(out, ox + col * scale + dx, oy + row * scale + dy);
        }
        setBlack(out, ox + col * scale + scale, oy + row * scale + dy);
      }
    }
  }
  return 5 * scale;
}

function drawTextBlock(out, lines, x0, y0, scale, gapY, letterGap) {
  let y = y0;
  for (const line of lines) {
    let x = x0;
    for (let i = 0; i < line.length; i++) {
      x += blitGlyph(out, x, y, line[i], scale) + letterGap;
    }
    y += 7 * scale + gapY;
  }
}


function composeLogo(shield) {
  const out = Buffer.alloc(OUT_W * OUT_H * 4, 255);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;

  // Mburoja: pothuajse max ATK (20×10mm = 160×80 @ 8 dots/mm)
  const targetH = 78;
  const scale = targetH / shield.height;
  const dw = Math.max(1, Math.round(shield.width * scale));
  const dh = Math.max(1, Math.round(shield.height * scale));

  const gapShieldText = 5;
  const textAreaMax = OUT_W - 2;
  let scaleT = Math.floor(textAreaMax / 20);
  while (scaleT > 2 && 2 * 7 * scaleT + 3 > 68) scaleT--;
  scaleT = Math.max(3, Math.min(scaleT, 5));
  const letterGap = Math.max(3, Math.floor(scaleT * 0.85) + 1);
  const lineGap = Math.max(2, Math.floor(scaleT * 0.55));
  const lineW = 3 * 5 * scaleT + 2 * letterGap + 3;
  const blockH = 2 * 7 * scaleT + lineGap;

  // Qendër: mburojë + RKS/MF si një bllok në mes të kanavacës 160×80
  const totalW = dw + gapShieldText + lineW;
  const ox = Math.max(0, Math.floor((OUT_W - totalW) / 2));
  const oy = Math.floor((OUT_H - dh) / 2);

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * shield.width) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * shield.width) / dw));
      const y0 = Math.floor((y * shield.height) / dh);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * shield.height) / dh));
      let ink = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < shield.height; sy++) {
        for (let sx = x0; sx < x1 && sx < shield.width; sx++) {
          n++;
          if (shield.mask[sy * shield.width + sx]) ink++;
        }
      }
      if (n === 0 || ink * 2 < n) continue;
      setBlack(out, ox + x, oy + y);
    }
  }

  const tx = ox + dw + gapShieldText;
  const ty = Math.floor((OUT_H - blockH) / 2);
  drawTextBlock(out, ["RKS", "MF"], tx, ty, scaleT, lineGap, letterGap);

  return out;
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(OUT_W, 0);
  ihdr.writeUInt32BE(OUT_H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = OUT_W * 3;
  const raw = Buffer.alloc((stride + 1) * OUT_H);
  for (let y = 0; y < OUT_H; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < OUT_W; x++) {
      const si = (y * OUT_W + x) * 4;
      const di = y * (stride + 1) + 1 + x * 3;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (!fs.existsSync(REF)) {
  console.error("Mungon fotoja e stemës:", REF);
  process.exit(1);
}

const img = decodePngRgba(REF);
const shield = extractShieldBw(img);
console.log("shield", { w: shield.width, h: shield.height });
const rgba = composeLogo(shield);
const out = path.join(__dirname, "logo_rks_mf.png");
fs.writeFileSync(out, encodePng(rgba));

// sa mbush ink
let minX = OUT_W;
let maxX = 0;
let minY = OUT_H;
let maxY = 0;
for (let y = 0; y < OUT_H; y++) {
  for (let x = 0; x < OUT_W; x++) {
    if (rgba[(y * OUT_W + x) * 4] > 40) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
}
console.log("OK", out);
console.log("ink fill", {
  w: maxX - minX + 1,
  h: maxY - minY + 1,
  mm: [((maxX - minX + 1) / 8).toFixed(1), ((maxY - minY + 1) / 8).toFixed(1)],
});
