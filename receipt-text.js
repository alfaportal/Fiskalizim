function paperChars(paper) {
  if (paper === "58mm") return 32;
  if (paper === "100mm") return 48;
  if (paper === "a4") return 72;
  return 42; // 80mm default
}

function pad(str, width, align = "left") {
  const s = String(str ?? "");
  if (s.length >= width) return s.slice(0, width);
  const gap = width - s.length;
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

function divider(width, char = "-") {
  return char.repeat(width);
}

function formatMoney(n) {
  return Number(n || 0).toFixed(2);
}

const RECEIPT_TIMEZONE = "Europe/Belgrade";

function formatReceiptDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) {
    return formatReceiptDateTime(new Date().toISOString());
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: RECEIPT_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d).map(p => [p.type, p.value]),
  );
  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function itemUnitPrice(item) {
  return Number(item.price ?? item.cmimi ?? item.unit_price ?? 0) || 0;
}

function formatItemLine(item, width) {
  const qty = Number(item.quantity) || 1;
  const price = itemUnitPrice(item);
  const unit = formatMoney(price);
  const lineTotal = formatMoney(price * qty);
  const tail = `${qty}x  ${unit}  =  ${lineTotal}`;
  const nameMax = Math.max(6, width - tail.length - 1);
  let name = String(item.name || "").trim();
  if (name.length > nameMax) {
    name = `${name.slice(0, Math.max(4, nameMax - 1))}…`;
  }
  const gap = Math.max(1, width - name.length - tail.length);
  return `${name}${" ".repeat(gap)}${tail}`;
}

function formatTotalLine(total, width) {
  const totalLabel = "TOTALI:";
  const totalVal = `${formatMoney(total)} EUR`;
  const gap = Math.max(1, width - totalLabel.length - totalVal.length);
  return `${totalLabel}${" ".repeat(gap)}${totalVal}`;
}

function labelValueLine(label, value, width) {
  const gap = Math.max(1, width - label.length - value.length);
  return `${label}${" ".repeat(gap)}${value}`;
}

/** Njësoj si labelValueLine, por shkurton etiketën me "…" nëse s'hyn brenda
 * gjerësisë — përdoret kudo ku vlera (emër artikulli/kamarieri/kategorie) mund
 * të jetë e gjatë e paparashikueshme, për të shmangur prerjen e tekstit. */
function truncatedLabelValueLine(label, value, width) {
  const v = String(value ?? "");
  const labelMax = Math.max(4, width - v.length - 1);
  let l = String(label ?? "").trim();
  if (l.length > labelMax) {
    l = `${l.slice(0, Math.max(3, labelMax - 1))}…`;
  }
  const gap = Math.max(1, width - l.length - v.length);
  return `${l}${" ".repeat(gap)}${v}`;
}

function stripEscPosMarkers(line) {
  return String(line ?? "")
    .replace(/^\^[CRLB]+/g, "")
    .replace(/\^b/g, "");
}

function plainTextFromServerBundle(bundle) {
  if (bundle?.text && String(bundle.text).trim()) {
    return String(bundle.text);
  }
  if (Array.isArray(bundle?.lines) && bundle.lines.length) {
    return bundle.lines.map(stripEscPosMarkers).join("\n");
  }
  return "";
}

function latinizeForEscPos(str) {
  return String(str ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/€/g, " EUR")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

/** Përgatit tekst për CP1252 — ruan ë/ç/Ë/Ç (jo latinizim). */
function prepareCp1252Text(str) {
  return String(str ?? "")
    .normalize("NFC")
    .replace(/€/g, " EUR")
    .replace(/…/g, "...")
    .replace(/[""„]/g, '"')
    .replace(/[''‚]/g, "'")
    .replace(/[–—]/g, "-");
}

function displayReceiptNumber(receiptNumber, orderNumber, slipKind) {
  const raw = slipKind === "order"
    ? String(orderNumber || "").trim()
    : String(receiptNumber || orderNumber || "").trim();
  if (!raw) return "";
  const part = raw.includes("-") ? raw.split("-").pop() : raw;
  return String(part).replace(/\D/g, "").padStart(6, "0") || raw;
}

/** Tavolinë fizike, Takeaway, Online, etj. */
function resolveVenueLine({ tableNumber = 0, sourceLabel = "" } = {}) {
  const num = Number(tableNumber) || 0;
  const src = String(sourceLabel || "").trim();
  if (num >= 1) return `Tavolina: T${num}`;
  if (/takeaway/i.test(src)) return "Takeaway";
  if (/delivery/i.test(src)) return "Delivery";
  const onlineMatch = src.match(/online\s*\d+/i);
  if (onlineMatch) return onlineMatch[0].replace(/\s+/g, " ");
  if (/^online\b/i.test(src)) return src || "Online";
  const qrTable = src.match(/\bT\s*(\d+)\b/i);
  if (qrTable) return `Tavolina: T${qrTable[1]}`;
  if (/qr\s·\s*t(\d+)/i.test(src)) {
    const m = src.match(/t(\d+)/i);
    if (m) return `Tavolina: T${m[1]}`;
  }
  if (src) return src;
  return "";
}

function buildReceiptLineItems({
  restaurantName = "",
  phone = "",
  address = "",
  city = "",
  tableNumber = 0,
  sourceLabel = "",
  waiterName = "",
  acceptedBy = "",
  items = [],
  total = 0,
  receiptNumber = "",
  orderNumber = "",
  registerName = "",
  cashierName = "",
  closedAt = "",
  paymentMethod = "",
  slipKind = "",
  paper = "80mm",
  discountTotal = 0,
  promotionName = "",
  subtotalBeforeDiscount = null,
  markedTotal = true,
  tvshEnabled = false,
  tvshPercent = 0,
  subtotal = null,
  vat = null,
}) {
  const w = paperChars(paper);
  const { date, time } = formatReceiptDateTime(closedAt);
  const lines = [];
  const bizName = String(restaurantName || "Restorant").trim();
  const kind = slipKind === "order" ? "order" : "final";
  const nr = displayReceiptNumber(receiptNumber, orderNumber, kind);
  const venue = resolveVenueLine({ tableNumber, sourceLabel });

  lines.push(pad(bizName, w, "center"));
  const addrLine = [address, city].filter(Boolean).join(", ");
  if (addrLine) lines.push(pad(addrLine, w, "center"));
  if (phone) lines.push(pad(`Tel: ${phone}`, w, "center"));

  lines.push(divider(w));
  if (nr) lines.push(`Nr. Fatures: ${nr}`);
  if (venue) lines.push(venue);
  if (waiterName) {
    lines.push(kind === "order" ? `Klienti: ${waiterName}` : `Kamarieri: ${waiterName}`);
  }
  if (acceptedBy) lines.push(`Pranuar nga: ${acceptedBy}`);
  if (registerName) lines.push(`Arka: ${registerName}`);
  if (cashierName) lines.push(`Operatori: ${cashierName}`);
  lines.push(`Data: ${date}  Ora: ${time}`);
  lines.push(divider(w));

  for (const item of items || []) {
    lines.push(formatItemLine(item, w));
  }

  lines.push(divider(w));
  const disc = Number(discountTotal) || 0;
  const gross = subtotalBeforeDiscount != null ? Number(subtotalBeforeDiscount) : total + disc;
  if (disc > 0) {
    lines.push(formatTotalLine(gross, w).replace("TOTALI:", "NENTOTALI:"));
    const discLabel = promotionName ? `ZBRITJE (${promotionName}):` : "ZBRITJE:";
    const discVal = `-${formatMoney(disc)} EUR`;
    const gap = Math.max(1, w - discLabel.length - discVal.length);
    lines.push(`${discLabel}${" ".repeat(gap)}${discVal}`);
  } else if (kind === "final" && tvshEnabled && subtotal != null) {
    lines.push(labelValueLine("SUBTOTALI:", `${formatMoney(subtotal)} EUR`, w));
  }
  if (kind === "final" && tvshEnabled && vat != null) {
    lines.push(labelValueLine(`TVSH (${tvshPercent}%):`, `${formatMoney(vat)} EUR`, w));
  }
  const totalLine = formatTotalLine(total, w);
  lines.push(markedTotal ? `^R^B${totalLine}` : totalLine);

  const paymentLabel = kind === "final"
    ? (String(paymentMethod || "").toLowerCase() === "karte" ? "Kartë" : paymentMethod ? "Cash" : "")
    : "";
  if (paymentLabel) lines.push(`Pagesa: ${paymentLabel}`);
  lines.push(divider(w));
  lines.push(pad("Faleminderit!", w, "center"));

  return lines;
}

function buildReceiptText(opts) {
  return buildReceiptLineItems(opts).join("\n");
}

/** Heq Pagesa/Faleminderit nga mesi dhe i vendos në fund (normalizim). */
function finalizeReceiptText(text, paper = "80mm") {
  const w = paperChars(paper);
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let pagesaLine = "";
  let thanksLine = "";
  const body = [];

  for (const line of lines) {
    const trimmed = stripEscPosMarkers(line).trim();
    if (/^Pagesa:/i.test(trimmed)) {
      pagesaLine = trimmed;
      continue;
    }
    if (/Faleminderit!/i.test(trimmed)) {
      thanksLine = "Faleminderit!";
      continue;
    }
    body.push(line);
  }

  while (body.length && !String(body[body.length - 1] || "").trim()) {
    body.pop();
  }
  while (body.length && /^-+$/.test(stripEscPosMarkers(body[body.length - 1] || "").trim())) {
    body.pop();
  }

  const out = [...body];
  out.push(divider(w));
  if (pagesaLine) out.push(pagesaLine);
  out.push(divider(w));
  out.push(pad(thanksLine || "Faleminderit!", w, "center"));

  return out.join("\n");
}

function ensureReceiptFooter(text, paper = "80mm") {
  return finalizeReceiptText(text, paper);
}

function encodeCp1252(str) {
  const cleaned = String(str ?? "")
    .normalize("NFC")
    .replace(/€/g, "EUR")
    .replace(/…/g, "...")
    .replace(/[""„]/g, '"')
    .replace(/[''‚]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^\x00-\xFF]/g, "?");
  return Buffer.from(cleaned, "latin1");
}

function appendEscPosCut(buffer) {
  const base = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
  return Buffer.concat([
    base,
    Buffer.from([0x1b, 0x64, 3]),
    Buffer.from([0x1d, 0x56, 0x42, 0x00]),
  ]);
}

function bufferHasEscPosCut(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return false;
  for (let i = buf.length - 2; i >= 0; i -= 1) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x56) return true;
  }
  return false;
}

function ensureEscPosCut(buffer) {
  return bufferHasEscPosCut(buffer) ? buffer : appendEscPosCut(buffer);
}

function buildEscPosInitChunks(opts = {}) {
  const ESC = 0x1b;
  const GS = 0x1d;
  const chunks = [
    Buffer.from([ESC, 0x40]), // reset
    Buffer.from([ESC, 0x74, 16]), // Code Page 1252 (WPC1252) — ë/ç
    Buffer.from([GS, 0x21, 0x00]), // madhësi normale
  ];
  // VETËM kupon fiskal — jo order ticket / kupon normal
  if (opts.dark || opts.fiscalEmphasized) {
    chunks.push(Buffer.from([ESC, 0x47, 0x01])); // double-strike ON
    chunks.push(Buffer.from([ESC, 0x45, 0x01])); // emphasized/bold ON
    chunks.push(Buffer.from([GS, 0x45, 0x04])); // densitet (kur mbështetet)
  }
  return chunks;
}

/**
 * Rruga LEGACY (si d9cf2c8) — kupon porositë + kupon normal mbylljeje.
 * latinize + ^B/^R/^L si para ndryshimeve fiskale. Pa fiscalEmphasized.
 */
function buildEscPosFromMarkedLinesLegacy(lines, opts = {}) {
  const ESC = 0x1b;
  const GS = 0x1d;
  const chunks = [Buffer.from([ESC, 0x40]), Buffer.from([ESC, 0x74, 16])];

  for (const raw of lines) {
    let s = String(raw ?? "");
    const resets = [];

    if (!s) {
      chunks.push(Buffer.from("\n", "ascii"));
      continue;
    }

    if (s.startsWith("^C")) {
      chunks.push(Buffer.from([ESC, 0x61, 1]));
      resets.push(Buffer.from([ESC, 0x61, 0]));
      s = s.slice(2);
    } else if (s.startsWith("^R")) {
      chunks.push(Buffer.from([ESC, 0x61, 2]));
      resets.push(Buffer.from([ESC, 0x61, 0]));
      s = s.slice(2);
    }

    if (s.startsWith("^L")) {
      chunks.push(Buffer.from([GS, 0x21, 0x11]));
      resets.unshift(Buffer.from([GS, 0x21, 0x00]));
      s = s.slice(2);
    }

    if (s.startsWith("^B")) {
      chunks.push(Buffer.from([ESC, 0x45, 1]));
      resets.unshift(Buffer.from([ESC, 0x45, 0]));
      s = s.slice(2);
    }

    s = latinizeForEscPos(s.replace(/\^b/g, ""));
    chunks.push(encodeCp1252(s), Buffer.from("\n", "ascii"), ...resets);
  }

  const body = Buffer.concat(chunks);
  return opts.cut === false ? body : appendEscPosCut(body);
}

function buildEscPosFromMarkedLines(lines, opts = {}) {
  // Order ticket / kupon normal → legacy (si para fiskalit)
  if (!opts.dark && !opts.fiscalEmphasized) {
    return buildEscPosFromMarkedLinesLegacy(lines, opts);
  }

  const ESC = 0x1b;
  const GS = 0x1d;
  const chunks = buildEscPosInitChunks(opts);
  const keepAlbanian = opts.keepAlbanian !== false;
  const fiscalEmph = true;
  const allowDouble = !!(opts.allowDoubleSize || opts.fiscalEmphasized);

  for (const raw of lines) {
    let s = String(raw ?? "");
    const resets = [];

    if (!s) {
      chunks.push(Buffer.from("\n", "ascii"));
      continue;
    }

    while (/^\^[CRLB]/.test(s)) {
      if (s.startsWith("^C")) {
        chunks.push(Buffer.from([ESC, 0x61, 1]));
        resets.push(Buffer.from([ESC, 0x61, 0]));
        s = s.slice(2);
        continue;
      }
      if (s.startsWith("^R")) {
        chunks.push(Buffer.from([ESC, 0x61, 2]));
        resets.push(Buffer.from([ESC, 0x61, 0]));
        s = s.slice(2);
        continue;
      }
      if (s.startsWith("^L")) {
        if (allowDouble) {
          chunks.push(Buffer.from([GS, 0x21, 0x11]));
          resets.unshift(Buffer.from([GS, 0x21, 0x00]));
        }
        s = s.slice(2);
        continue;
      }
      if (s.startsWith("^B")) {
        s = s.slice(2);
        continue;
      }
      break;
    }

    const rawLine = s.replace(/\^b/g, "");
    const lineText = keepAlbanian
      ? prepareCp1252Text(rawLine)
      : latinizeForEscPos(rawLine);
    chunks.push(encodeCp1252(lineText), Buffer.from("\n", "ascii"), ...resets);
    if (fiscalEmph) {
      chunks.push(Buffer.from([ESC, 0x47, 0x01]));
      chunks.push(Buffer.from([ESC, 0x45, 0x01]));
      chunks.push(Buffer.from([GS, 0x21, 0x00]));
    }
  }

  if (fiscalEmph) {
    chunks.push(Buffer.from([ESC, 0x45, 0x00]));
    chunks.push(Buffer.from([ESC, 0x47, 0x00]));
    chunks.push(Buffer.from([GS, 0x21, 0x00]));
  }

  const body = Buffer.concat(chunks);
  return opts.cut === false ? body : appendEscPosCut(body);
}

/** ESC/POS nga tekst plain — CP1252 (shqip) + prerje e plotë e letrës.
 *  opts.cut=false → pa GS V (për bashkim me logo/QR në një job).
 *  opts.dark / fiscalEmphasized → VETËM kupon fiskal.
 *  Pa ato opts → sjellja legacy d9cf2c8 (order ticket / kupon normal). */
function buildEscPosFromPlainText(text, opts = {}) {
  const ESC = 0x1b;
  const GS = 0x1d;
  const body = String(text || "").replace(/\r\n/g, "\n");
  const fiscalMode = !!(opts.dark || opts.fiscalEmphasized);

  if (!fiscalMode) {
    // LEGACY — si d9cf2c8: latinize në marked; plain = encodeCp1252 pa prepareCp1252
    if (/\^[BCRL]/.test(body)) {
      return buildEscPosFromMarkedLinesLegacy(body.split("\n"), opts);
    }
    const content = body.endsWith("\n") ? body : `${body}\n`;
    const buf = Buffer.concat([
      Buffer.from([ESC, 0x40]),
      Buffer.from([ESC, 0x74, 16]),
      encodeCp1252(content),
    ]);
    return opts.cut === false ? buf : appendEscPosCut(buf);
  }

  if (/\^[BCRL]/.test(body)) {
    return buildEscPosFromMarkedLines(body.split("\n"), opts);
  }
  const content = body.endsWith("\n") ? body : `${body}\n`;
  const textForCp = opts.keepAlbanian === false
    ? latinizeForEscPos(content)
    : prepareCp1252Text(content);
  const chunks = [
    ...buildEscPosInitChunks(opts),
    encodeCp1252(textForCp),
  ];
  chunks.push(Buffer.from([ESC, 0x45, 0x00]));
  chunks.push(Buffer.from([ESC, 0x47, 0x00]));
  chunks.push(Buffer.from([GS, 0x21, 0x00]));
  const buf = Buffer.concat(chunks);
  return opts.cut === false ? buf : appendEscPosCut(buf);
}

function cutOnlyEscPosBuffer() {
  return appendEscPosCut(Buffer.alloc(0));
}

module.exports = {
  paperChars,
  pad,
  divider,
  labelValueLine,
  truncatedLabelValueLine,
  buildReceiptText,
  buildReceiptLineItems,
  plainTextFromServerBundle,
  ensureReceiptFooter,
  finalizeReceiptText,
  buildEscPosFromPlainText,
  buildEscPosFromMarkedLines,
  appendEscPosCut,
  ensureEscPosCut,
  cutOnlyEscPosBuffer,
  bufferHasEscPosCut,
  stripEscPosMarkers,
  prepareCp1252Text,
  latinizeForEscPos,
  formatItemLine,
  formatTotalLine,
  formatReceiptDateTime,
  formatMoney,
  resolveVenueLine,
  displayReceiptNumber,
};
