/**
 * fiscal/fiscal-local-env.js — profil ekzekutimi lokal (Hapi: çbllokim për testim).
 * FISCAL_LOCAL_RUN=1 → ATK HTTP i ndaluar plotësisht; transmetimi vetëm në memorie/console.
 */
const ATK_HOST_RE =
  /(?:^|\.)((?:fi|e)?fiskalizimi(?:-test)?\.atk-ks\.org)$/i;

function envTruthy(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Ekzekutim lokal i modulit fiskal (node fiscal/fiscal-run-local.js). */
function isFiscalLocalRun() {
  const direct = envTruthy("FISCAL_LOCAL_RUN") ?? envTruthy("FISCAL_LOCAL_TEST");
  if (direct === true) return true;
  if (direct === false) return false;
  return false;
}

function hostnameFromUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).hostname.toLowerCase();
  } catch {
    /* */
  }
  return raw.replace(/:\d+$/, "").toLowerCase();
}

/** Host i serverit ATK / fiskalizimi (TEST ose PROD). */
function isAtkHost(input) {
  const host = hostnameFromUrl(input);
  if (!host) return false;
  return ATK_HOST_RE.test(host) || /atk-ks\.org$/i.test(host);
}

/**
 * Vendos env para require() të moduleve fiskale.
 * Thirret nga fiscal-run-local.js ose manualisht për testim.
 */
function applyFiscalLocalRunEnvironment() {
  process.env.FISCAL_LOCAL_RUN = process.env.FISCAL_LOCAL_RUN || "0";
  // Mos e detyro ATK_TEST_MODE=1 — launcher vendos 0 (SQLite lokal, pa ATK HTTP).
  if (process.env.ATK_TEST_MODE == null || String(process.env.ATK_TEST_MODE).trim() === "") {
    process.env.ATK_TEST_MODE = "0";
  }
  if (process.env.FISCAL_TEST_MODE == null || String(process.env.FISCAL_TEST_MODE).trim() === "") {
    process.env.FISCAL_TEST_MODE = process.env.ATK_TEST_MODE;
  }
}

/**
 * Settings minimale që self-test / print provë të kalojnë lokalisht.
 * Vetëm brenda modulit fiskal — lexon/shkruan përmes fiscal-config + database.
 */
function ensureLocalDemoFiscalSettings() {
  const { getFiscalSettings, saveFiscalSettings } = require("./fiscal-config");
  let current;
  try {
    current = getFiscalSettings();
  } catch (e) {
    throw new Error(
      "Databaza nuk është gatshme për testim lokal. Nisni nga biznes/: node fiscal/fiscal-run-local.js"
    );
  }

  const needsEnable = !current.fiscal_enabled;
  const needsNui = !/^\d{9}$/.test(String(current.taxpayer_nui || ""));

  if (needsEnable || needsNui || !String(current.taxpayer_legal_name || "").trim()) {
    saveFiscalSettings({
      fiscal_enabled: true,
      taxpayer_nui: /^\d{9}$/.test(String(current.taxpayer_nui || ""))
        ? current.taxpayer_nui
        : "812345678",
      taxpayer_legal_name:
        String(current.taxpayer_legal_name || "").trim() || "Biznes Lokal Test",
      taxpayer_address:
        String(current.taxpayer_address || "").trim() || "Prishtine, Test",
      unit_number: String(current.unit_number || current.business_unit_number || "5130484"),
      business_unit_number: String(current.business_unit_number || "5130484"),
      pos_id: String(current.pos_id || "11"),
      unit_name: String(current.unit_name || "").trim() || "Njësia Lokal Test",
      unit_phone: String(current.unit_phone || "").trim() || "044 000 000",
      language: current.language === "sr" ? "sr" : "sq",
    });
  }

  try {
    const database = require("../database");
    if (typeof database.setSetting === "function") {
      database.setSetting("atk_test_mode", "1");
    }
  } catch {
    /* pa DB — env mjafton */
  }

  return getFiscalSettings();
}

function getLocalRunStatus() {
  const { isAtkTestMode, isAtkTransmissionBlocked, isFiscalMemoryOnly } =
    require("./fiscal-test-mode-store");
  let fiscalEnabled = false;
  let settings = null;
  try {
    settings = require("./fiscal-config").getFiscalSettings();
    fiscalEnabled = !!settings.fiscal_enabled;
  } catch {
    /* */
  }
  return {
    fiscal_local_run: isFiscalLocalRun(),
    atk_test_mode: isAtkTestMode(),
    atk_transmission_blocked: isAtkTransmissionBlocked(),
    fiscal_enabled: fiscalEnabled,
    fiscal_persistence: isFiscalMemoryOnly() ? "memory_only" : "sqlite",
    atk_http: isAtkTransmissionBlocked() ? "BLOCKED" : "ON",
    settings_summary: settings
      ? {
          nui: settings.taxpayer_nui,
          unit: settings.unit_name,
          language: settings.language,
        }
      : null,
  };
}

module.exports = {
  ATK_HOST_RE,
  isFiscalLocalRun,
  isAtkHost,
  applyFiscalLocalRunEnvironment,
  ensureLocalDemoFiscalSettings,
  getLocalRunStatus,
};
