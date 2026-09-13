/**
 * Cloud license — heartbeat, offline 7 ditë, terminal limit, revoke.
 * Storage: %APPDATA%\RevolutionInvest\FiskalizimLicense\
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cloudHealth = require("./cloud-health");
const { factoryWipeLocalData, NO_LICENSE_MESSAGE } = require("./factory-wipe");

const LICENSE_STORAGE_REL = path.join("RevolutionInvest", "FiskalizimLicense");
const KEY_FILE = ".cloud-lic";
const DEVICE_FILE = ".install-device-id";
const ACTIVATION_FILE = ".cloud-activation.json";
const REVOKED_FILE = ".lic-revoked";
const CLOUD_OFFLINE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const APP_TYPE = "fiskalizim";

const HARD_LICENSE_FAIL_CODES = new Set([
  "REVOKED",
  "SUSPENDED",
  "EXPIRED",
  "TERMINAL_LIMIT_EXCEEDED",
  "DEVICE_MISMATCH",
  "NOT_FOUND",
  "OFFLINE_EXPIRED",
]);

/** Kodet që anulojnë licencën lokalisht (fshirje e plotë + mbyllje). */
const REVOCATION_FAIL_CODES = new Set(["NOT_FOUND", "REVOKED"]);

let _electronApp = null;
let _watchdogTimer = null;

function registerInstallContext(app) {
  _electronApp = app || _electronApp;
}

function storageRoot(app) {
  const ea = app || _electronApp;
  const base = ea ? ea.getPath("appData") : process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const root = path.join(base, LICENSE_STORAGE_REL);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function createInstallDeviceId() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

function getMachineId(app) {
  const p = path.join(storageRoot(app), DEVICE_FILE);
  try {
    if (fs.existsSync(p)) {
      const id = String(fs.readFileSync(p, "utf8") || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-F0-9]/g, "");
      if (id.length >= 8) return id.slice(0, 12).padEnd(12, "0").slice(0, 12);
    }
  } catch {
    /* ignore */
  }
  const id = createInstallDeviceId();
  try {
    fs.writeFileSync(p, id, "utf8");
  } catch {
    /* ignore */
  }
  return id;
}

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function readStoredLicense(app) {
  try {
    const p = path.join(storageRoot(app), KEY_FILE);
    if (!fs.existsSync(p)) return "";
    return normalizeKey(fs.readFileSync(p, "utf8"));
  } catch {
    return "";
  }
}

function writeStoredLicense(app, key) {
  const k = normalizeKey(key);
  if (!k) throw new Error("Çelësi i licencës është bosh.");
  fs.writeFileSync(path.join(storageRoot(app), KEY_FILE), k, "utf8");
}

function clearStoredLicense(app) {
  try {
    fs.unlinkSync(path.join(storageRoot(app), KEY_FILE));
  } catch {
    /* ignore */
  }
}

function writeActivationRecord(app, key, extra = {}) {
  const row = {
    celesi: normalizeKey(key),
    device_id: getMachineId(app),
    last_ok_at: new Date().toISOString(),
    app_type: APP_TYPE,
    ...extra,
  };
  fs.writeFileSync(path.join(storageRoot(app), ACTIVATION_FILE), JSON.stringify(row), "utf8");
}

function clearActivationRecord(app) {
  try {
    fs.unlinkSync(path.join(storageRoot(app), ACTIVATION_FILE));
  } catch {
    /* ignore */
  }
}

function clearHardwareLicenseFile(app) {
  try {
    const lg = require("../fiscal/license-guard");
    if (typeof lg.clearHardwareLicense === "function") {
      lg.clearHardwareLicense(app);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Fshi krejt artefaktet e licencës + të dhënat lokale (DB, cache, settings).
 */
function purgeAllLicenseArtifacts(app, message, opts = {}) {
  registerInstallContext(app);
  const allowReactivation = opts.allowReactivation !== false;
  if (allowReactivation) {
    clearLicenseRevokedLocally(app);
  } else {
    markLicenseRevokedLocally(app, String(message || NO_LICENSE_MESSAGE));
  }
  clearStoredLicense(app);
  clearActivationRecord(app);
  clearHardwareLicenseFile(app);
  try {
    factoryWipeLocalData(app, { wipeLicenseDir: opts.fullLocalReset !== false });
  } catch (e) {
    console.warn("[cloud-license] factory wipe:", e.message || e);
  }
}

function readActivationRecord(app) {
  try {
    const p = path.join(storageRoot(app), ACTIVATION_FILE);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isWithinCloudOfflineWindow(app) {
  const rec = readActivationRecord(app);
  if (!rec?.last_ok_at) return false;
  const t = new Date(rec.last_ok_at).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= CLOUD_OFFLINE_MAX_MS;
}

function offlineExpiredMessage() {
  return "Pa internet më shumë se 7 ditë. Lidhuni online për të vazhduar (licenca duhet të jetë aktive).";
}

function markLicenseRevokedLocally(app, message) {
  fs.writeFileSync(
    path.join(storageRoot(app), REVOKED_FILE),
    JSON.stringify({ at: new Date().toISOString(), message: String(message || "Licenca u çaktivizua.") }),
    "utf8",
  );
}

function clearLicenseRevokedLocally(app) {
  try {
    fs.unlinkSync(path.join(storageRoot(app), REVOKED_FILE));
  } catch {
    /* ignore */
  }
}

function readLocalRevokeBlock(app) {
  try {
    const p = path.join(storageRoot(app), REVOKED_FILE);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { blocked: true, message: j.message || "Licenca është e çaktivizuar." };
  } catch {
    return null;
  }
}

function getHardwareIdForDisplay(app) {
  try {
    const lg = require("../fiscal/license-guard");
    if (typeof lg.getHardwareId === "function") {
      const hw = lg.getHardwareId(app || _electronApp);
      if (typeof lg.formatHardwareId === "function") return lg.formatHardwareId(hw);
      return String(hw || "");
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function postLicense(endpoint, key, app) {
  const celesi = normalizeKey(key);
  const res = await cloudHealth.requestJson("POST", endpoint, {
    celesi,
    device_id: getMachineId(app),
    hardware_id: getHardwareIdForDisplay(app),
    hostname: os.hostname(),
    app_type: APP_TYPE,
  });
  let parsed = {};
  try {
    parsed = JSON.parse(res.data || "{}");
  } catch {
    parsed = {};
  }
  return { status: res.status, parsed };
}

async function validateLicenseOnline(key, app) {
  try {
    const { status, parsed } = await postLicense("/api/license/validate", key, app);
    if (status < 400 && parsed.valid) {
      clearLicenseRevokedLocally(app);
      writeStoredLicense(app, key);
      writeActivationRecord(app, key, {
        package_tier: parsed.package_tier || "",
        data_skadimit: parsed.data_skadimit || parsed.expires_at || null,
        client_name: parsed.client_name || parsed.clients?.emri || "",
      });
      return {
        valid: true,
        message: parsed.message || "Licenca aktive",
        code: parsed.code || "OK",
        data_skadimit: parsed.data_skadimit || null,
        package_tier: parsed.package_tier || "",
        terminal_warning: parsed.terminal_warning || null,
      };
    }
    if (parsed.code === "REVOKED" || parsed.code === "NOT_FOUND") {
      purgeAllLicenseArtifacts(app, parsed.message || NO_LICENSE_MESSAGE);
    }
    return {
      valid: false,
      code: parsed.code || "INVALID",
      message: parsed.message || parsed.gabim || "Licenca nuk është aktive.",
      force_logout: !!parsed.force_logout,
    };
  } catch (err) {
    if (isWithinCloudOfflineWindow(app) && readStoredLicense(app)) {
      return { valid: true, offline: true, message: "Pa internet — brenda 7 ditëve." };
    }
    return {
      valid: false,
      code: "OFFLINE_EXPIRED",
      message: err.message || offlineExpiredMessage(),
      offline: true,
    };
  }
}

async function validateLicenseHeartbeat(key, app) {
  const a = app || _electronApp;
  try {
    const { status, parsed } = await postLicense("/api/license/heartbeat", key, a);
    if (status < 400 && parsed.valid) {
      clearLicenseRevokedLocally(a);
      writeActivationRecord(a, key, {
        package_tier: parsed.package_tier || "",
        data_skadimit: parsed.data_skadimit || null,
      });
      if (parsed.celesi_updated) {
        writeStoredLicense(a, parsed.celesi_updated);
      }
      return {
        valid: true,
        offline: false,
        message: parsed.message || "OK",
        celesi_updated: parsed.celesi_updated || null,
        force_factory_reset: !!parsed.force_factory_reset,
        code: parsed.code || "OK",
      };
    }
    if (parsed.code === "REVOKED" || parsed.code === "NOT_FOUND") {
      purgeAllLicenseArtifacts(a, parsed.message || NO_LICENSE_MESSAGE);
    }
    return {
      valid: false,
      code: parsed.code || "INVALID",
      message: parsed.message || parsed.gabim || "Licenca nuk është aktive.",
      force_logout: !!parsed.force_logout,
      force_factory_reset: !!parsed.force_factory_reset,
    };
  } catch {
    const localRevoke = readLocalRevokeBlock(a);
    if (localRevoke?.blocked) {
      return { valid: false, code: "REVOKED", force_logout: true, message: localRevoke.message };
    }
    if (isWithinCloudOfflineWindow(a)) {
      return { valid: true, offline: true, message: "Pa internet — heartbeat (brenda 7 ditëve)." };
    }
    return { valid: false, offline: true, code: "OFFLINE_EXPIRED", message: offlineExpiredMessage() };
  }
}

async function claimByHardwareId(app) {
  registerInstallContext(app);
  const hardware_id = getHardwareIdForDisplay(app);
  if (!hardware_id) {
    return { valid: false, code: "MISSING_HARDWARE", message: "Mungon Hardware ID." };
  }
  try {
    const res = await cloudHealth.requestJson("POST", "/api/license/by-hardware", {
      hardware_id,
      device_id: getMachineId(app),
      hostname: os.hostname(),
      app_type: APP_TYPE,
    });
    let parsed = {};
    try {
      parsed = JSON.parse(res.data || "{}");
    } catch {
      parsed = {};
    }
    if (res.status < 400 && parsed.valid && (parsed.celesi || parsed.license_key)) {
      const key = parsed.celesi || parsed.license_key;
      clearLicenseRevokedLocally(app);
      writeStoredLicense(app, key);
      writeActivationRecord(app, key, {
        package_tier: parsed.package_tier || "",
        data_skadimit: parsed.data_skadimit || parsed.expires_at || null,
        client_name: parsed.client_name || parsed.clients?.emri || "",
      });
      return {
        valid: true,
        code: parsed.code || "OK",
        message: parsed.message || "Licenca u gjet nga Hardware ID.",
        celesi: key,
        license_key: key,
        client_id: parsed.client_id || parsed.clients?.id || null,
      };
    }
    return {
      valid: false,
      code: parsed.code || "NOT_FOUND",
      message: parsed.message || parsed.gabim || "Nuk ka licencë për këtë Hardware ID.",
    };
  } catch (err) {
    return {
      valid: false,
      code: "OFFLINE",
      message: err.message || "Nuk u lidh me serverin e licencës.",
    };
  }
}

async function activateWithKey(app, key) {
  registerInstallContext(app);
  try {
    const { status, parsed } = await postLicense("/api/license/activate", key, app);
    if (status < 400 && parsed.valid) {
      clearLicenseRevokedLocally(app);
      writeStoredLicense(app, key);
      writeActivationRecord(app, key, {
        package_tier: parsed.package_tier || "",
        data_skadimit: parsed.data_skadimit || parsed.expires_at || null,
        client_name: parsed.client_name || parsed.clients?.emri || "",
      });
      return {
        valid: true,
        message: parsed.message || "Licenca u aktivizua",
        code: parsed.code || "OK",
        data_skadimit: parsed.data_skadimit || parsed.expires_at || null,
        package_tier: parsed.package_tier || "",
        client_name: parsed.client_name || parsed.clients?.emri || "",
        client_id: parsed.client_id || parsed.clients?.id || null,
        clientId: parsed.client_id || parsed.clients?.id || null,
      };
    }
    if (status === 404 || status === 405) {
      const fallback = await validateLicenseOnline(key, app);
      if (!fallback.valid) {
        const e = new Error(fallback.message || "Aktivizimi dështoi.");
        e.code = fallback.code;
        throw e;
      }
      return fallback;
    }
    if (parsed.code === "REVOKED" || parsed.code === "NOT_FOUND") {
      purgeAllLicenseArtifacts(app, parsed.message || NO_LICENSE_MESSAGE);
    }
    const err = new Error(parsed.message || parsed.gabim || "Aktivizimi dështoi.");
    err.code = parsed.code || "INVALID";
    throw err;
  } catch (err) {
    if (err.code) throw err;
    const fallback = await validateLicenseOnline(key, app);
    if (!fallback.valid) {
      const e = new Error(fallback.message || "Aktivizimi dështoi.");
      e.code = fallback.code;
      throw e;
    }
    return fallback;
  }
}

function startLicenseWatchdog(app, onForceLogout) {
  registerInstallContext(app);
  if (_watchdogTimer) return;
  _watchdogTimer = setInterval(async () => {
    try {
      const key = readStoredLicense(app);
      if (!key) return;
      const beat = await validateLicenseHeartbeat(key, app);
      if (beat.force_factory_reset) {
        purgeAllLicenseArtifacts(app, beat.message || NO_LICENSE_MESSAGE);
        if (typeof onForceLogout === "function") onForceLogout(beat);
        return;
      }
      if (!beat.valid && beat.code && HARD_LICENSE_FAIL_CODES.has(beat.code)) {
        if (isRevocationCode(beat.code)) {
          purgeAllLicenseArtifacts(app, beat.message || NO_LICENSE_MESSAGE);
        } else {
          clearStoredLicense(app);
        }
        if (typeof onForceLogout === "function") onForceLogout(beat);
      }
    } catch (e) {
      console.warn("[cloud-license] watchdog:", e.message || e);
    }
  }, HEARTBEAT_MS);
  if (typeof _watchdogTimer.unref === "function") _watchdogTimer.unref();
}

function isRevocationCode(code) {
  return REVOCATION_FAIL_CODES.has(String(code || "").trim());
}

async function getLicenseStatusForApp(app) {
  const key = readStoredLicense(app);
  const rec = readActivationRecord(app);
  const revoked = readLocalRevokeBlock(app);
  return {
    has_key: !!key,
    machine_id: getMachineId(app),
    hardware_id: getHardwareIdForDisplay(app),
    last_ok_at: rec?.last_ok_at || null,
    data_skadimit: rec?.data_skadimit || null,
    offline_ok: isWithinCloudOfflineWindow(app),
    revoked: !!revoked?.blocked,
    revoked_message: revoked?.message || null,
    app_type: APP_TYPE,
  };
}

module.exports = {
  APP_TYPE,
  CLOUD_OFFLINE_MAX_MS,
  HEARTBEAT_MS,
  HARD_LICENSE_FAIL_CODES,
  REVOCATION_FAIL_CODES,
  registerInstallContext,
  getMachineId,
  getHardwareIdForDisplay,
  readStoredLicense,
  writeStoredLicense,
  clearStoredLicense,
  purgeAllLicenseArtifacts,
  isRevocationCode,
  activateWithKey,
  claimByHardwareId,
  validateLicenseOnline,
  validateLicenseHeartbeat,
  startLicenseWatchdog,
  getLicenseStatusForApp,
  isWithinCloudOfflineWindow,
  markLicenseRevokedLocally,
  clearLicenseRevokedLocally,
  readLocalRevokeBlock,
  offlineExpiredMessage,
  NO_LICENSE_MESSAGE,
};
