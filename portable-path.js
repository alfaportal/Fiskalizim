/**
 * portable-path.js — USB / portable: të dhënat në ./data/ (jo %AppData%).
 * Aktivizohet me PORTABLE_MODE=1 ose skedarin .portable në rrënjë të projektit.
 */
const fs = require("fs");
const path = require("path");

function getAppRoot() {
  return path.resolve(__dirname);
}

function isPortableMode() {
  const env = process.env.PORTABLE_MODE;
  if (env !== undefined && env !== null && String(env).trim() !== "") {
    const s = String(env).trim().toLowerCase();
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  }
  return fs.existsSync(path.join(getAppRoot(), ".portable"));
}

function getDataDir() {
  if (process.env.BIZNES_DATA_DIR) {
    return path.resolve(process.env.BIZNES_DATA_DIR);
  }
  if (isPortableMode()) {
    return path.join(getAppRoot(), "data");
  }
  // Folder i dedikuar klientit SEF — mos përdor biznes-sef (të dhëna dev/test).
  return path.join(require("os").homedir(), "AppData", "Roaming", "Revolution-Fiskalizim");
}

function getDbPath() {
  if (process.env.BIZNES_DB_PATH) return path.resolve(process.env.BIZNES_DB_PATH);
  return path.join(getDataDir(), "biznes.db");
}

/** Vendos env para require(database) / server. */
function applyPortableEnv() {
  if (!isPortableMode()) return false;
  process.env.PORTABLE_MODE = "1";
  const dataDir = getDataDir();
  const dbPath = getDbPath();
  if (!process.env.BIZNES_DB_PATH) {
    process.env.BIZNES_DB_PATH = dbPath;
  }
  if (!process.env.DB_PATH) {
    process.env.DB_PATH = dbPath;
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return true;
}

module.exports = {
  getAppRoot,
  isPortableMode,
  getDataDir,
  getDbPath,
  applyPortableEnv,
};
