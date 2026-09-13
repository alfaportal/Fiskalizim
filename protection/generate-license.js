#!/usr/bin/env node
/**
 * GJENERUESI I LICENCËS FISKALIZIM — VETËM PËR NASERIN
 *
 *   node protection/generate-license.js [HARDWARE_ID] [--type trial|annual]
 *
 * SECRET_SALT i ndarë nga SECURITY — çelësi Security nuk punon këtu.
 */
const crypto = require("crypto");

const SECRET_SALT = Buffer.from("RklTS0FMSVpJTS1IV0xPQ0stMjAyNi1OQVNFUi1hN2MzZTkxZg==", "base64").toString(
  "utf8",
);
const TRIAL_DAYS = 7;
const ANNUAL_DAYS = 365;

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
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function expectedLicenseKey(formattedOrRawHardwareId, licenseType, expiresYmd) {
  const id = normalizeHardwareId(formattedOrRawHardwareId);
  const type = String(licenseType || "")
    .trim()
    .toLowerCase();
  let material = id + SECRET_SALT;
  if (type === "trial") {
    material = id + SECRET_SALT + "|trial";
  } else if (type === "annual") {
    const ymd = String(expiresYmd || "").replace(/\D/g, "");
    if (ymd.length !== 8) throw new Error("expiresYmd i detyrueshëm për licencë vjetore (YYYYMMDD).");
    material = id + SECRET_SALT + "|annual|" + ymd;
  }
  const hash = crypto.createHash("sha256").update(material).digest("hex").toUpperCase();
  return formatGrouped16(hash.slice(0, 16));
}

function main() {
  const args = process.argv.slice(2);
  const hwArg = args.find((a) => !a.startsWith("--")) || "";
  const typeArg = (args.find((a) => a.startsWith("--type=")) || "").split("=")[1] || "annual";
  const hw = normalizeHardwareId(hwArg);
  if (hw.length < 16) {
    console.error("Përdorimi: node protection/generate-license.js XXXX-XXXX-XXXX-XXXX [--type=trial|annual]");
    process.exit(1);
  }
  const formatted = formatGrouped16(hw);
  let expiresYmd = null;
  if (typeArg === "annual") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ANNUAL_DAYS);
    expiresYmd = toYmd(d);
  }
  const key = expectedLicenseKey(formatted, typeArg === "trial" ? "trial" : "annual", expiresYmd);
  console.log("Hardware ID:", formatted);
  console.log("License Key:", key);
  if (typeArg === "trial") console.log("Tipi: trial (7 ditë)");
  if (typeArg === "annual") console.log("Tipi: annual, skadon:", expiresYmd);
}

if (require.main === module) main();

module.exports = { expectedLicenseKey, formatGrouped16, normalizeHardwareId, SECRET_SALT };
