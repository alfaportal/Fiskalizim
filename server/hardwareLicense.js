const crypto = require("crypto");

const SECRET_SALT =
  process.env.FISKALIZIM_HW_LICENSE_SALT || "FISKALIZIM-HWLOCK-2026-NASER-7d3e8b1a";

function normalizeHardwareId(input) {
  return String(input || "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase()
    .slice(0, 16);
}

function formatGrouped16(raw16) {
  const hex = String(raw16 || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .padEnd(16, "0")
    .slice(0, 16);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function toYmd(dateInput) {
  if (dateInput instanceof Date) {
    if (Number.isNaN(dateInput.getTime())) {
      throw new Error("Data e skadimit është e pavlefshme.");
    }
    const y = dateInput.getUTCFullYear();
    const m = String(dateInput.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dateInput.getUTCDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }
  const raw = String(dateInput || "").replace(/\D/g, "");
  if (raw.length === 8) return raw;
  const parsed = new Date(dateInput);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Data e skadimit është e pavlefshme.");
  }
  return toYmd(parsed);
}

function generateKeyFromId(hardwareId, expiryDate) {
  const id = normalizeHardwareId(hardwareId);
  if (id.length !== 16) {
    throw new Error("ID duhet 16 shenja (XXXX-XXXX-XXXX-XXXX).");
  }
  const ymd = toYmd(expiryDate);
  const material = id + SECRET_SALT + "|annual|" + ymd;
  const hash = crypto.createHash("sha256").update(material).digest("hex").toUpperCase();
  return formatGrouped16(hash.slice(0, 16));
}

function validateKey(hardwareId, key) {
  const id = normalizeHardwareId(hardwareId);
  const want = String(key || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
  if (id.length !== 16 || want.length !== 16) return false;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCFullYear(start.getUTCFullYear() - 2);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCFullYear(end.getUTCFullYear() + 2);
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= end.getTime()) {
    const got = generateKeyFromId(id, cursor).replace(/[^A-Z0-9]/g, "");
    if (got === want) return true;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return false;
}

module.exports = {
  SECRET_SALT,
  normalizeHardwareId,
  generateKeyFromId,
  validateKey,
};
