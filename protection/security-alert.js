/**
 * Njoftime sigurie — tentativa licence / DevTools.
 * Online → POST cloud → email te Naseri (nga sistemi).
 * Offline → queue lokale, dërgo kur kthehet neti.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const LICENSE_STORAGE_REL = path.join("RevolutionInvest", "FiskalizimLicense");
const QUEUE_BASENAME = ".security-alerts-queue.json";
const ATTEMPTS_BASENAME = ".hw-activate-attempts.json";
const DEVTOOLS_BASENAME = ".devtools-attempts.json";
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS_URGENT = 3;
const NASER_NOTIFY_EMAIL = "revolutioninvest05@gmail.com";

/** SECRET për HMAC alert — i ndarë nga SECURITY. */
function getAlertHmacSecret() {
  const bytes = [
    72, 69, 74, 22, 44, 36, 93, 47, 61, 203, 213, 202, 243, 148, 133, 252, 225, 205, 195, 175, 85, 104,
    75, 105, 25, 20, 55, 115, 45, 75, 35, 95, 205, 185, 165, 145,
  ];
  return Buffer.from(bytes.map((x, i) => x ^ ((i * 11 + 37) & 0xff))).toString("utf8");
}

/** Watermark i fshehtë — identifikues build Fiskalizim. */
const BUILD_WATERMARK = (() => {
  const seed = "FISKALIZIM-WM-2026-v1";
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
})();

function appDataRoot(app) {
  if (app) {
    try {
      return app.getPath("appData");
    } catch {
      /* fall through */
    }
  }
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function storageRoot(app) {
  const root = path.join(appDataRoot(app), LICENSE_STORAGE_REL);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function queuePath(app) {
  return path.join(storageRoot(app), QUEUE_BASENAME);
}

function attemptsPath(app) {
  return path.join(storageRoot(app), ATTEMPTS_BASENAME);
}

function devtoolsPath(app) {
  return path.join(storageRoot(app), DEVTOOLS_BASENAME);
}

function readJsonFile(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 0), "utf8");
}

function hashAttemptKey(rawKey) {
  const s = String(rawKey || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return "empty";
  return crypto.createHash("sha256").update(`attempt:${s}`).digest("hex").slice(0, 16);
}

function getAppVersion() {
  try {
    return String(require("../package.json").version || "");
  } catch {
    return "";
  }
}

function getBuildFingerprint(app) {
  const parts = [BUILD_WATERMARK, getAppVersion(), app?.isPackaged ? "packaged" : "dev"];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

function isWatermarkOk() {
  return true;
}

function pruneWindow(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((t) => {
    const ts = typeof t === "number" ? t : Date.parse(t?.at || t?.ts || 0);
    return Number.isFinite(ts) && now - ts <= WINDOW_MS;
  });
}

function recordActivationAttempt(app, { hardwareId, rawKey } = {}) {
  const p = attemptsPath(app);
  const now = Date.now();
  const data = readJsonFile(p, { hardware_id: "", attempts: [] });
  const hw = String(hardwareId || data.hardware_id || "").trim();
  const attempts = pruneWindow(data.attempts, now);
  attempts.push({
    at: new Date(now).toISOString(),
    ts: now,
    key_hash: hashAttemptKey(rawKey),
  });
  writeJsonFile(p, { hardware_id: hw, attempts });
  const count = attempts.length;
  return {
    count_24h: count,
    urgent: count > MAX_ATTEMPTS_URGENT,
    key_hash: hashAttemptKey(rawKey),
  };
}

function recordDevtoolsAttempt(app, { hardwareId } = {}) {
  const p = devtoolsPath(app);
  const now = Date.now();
  const data = readJsonFile(p, { hardware_id: "", attempts: [] });
  const hw = String(hardwareId || data.hardware_id || "").trim();
  const attempts = pruneWindow(data.attempts, now);
  attempts.push({ at: new Date(now).toISOString(), ts: now });
  writeJsonFile(p, { hardware_id: hw, attempts });
  return { count_24h: attempts.length };
}

function localAudit(app, event, details = {}) {
  try {
    const { logHwLicenseAudit } = require("../fiscal/license-guard");
    logHwLicenseAudit(app, event, details);
  } catch (e) {
    console.warn("[security-alert] local audit:", e.message || e);
  }
}

function enqueueAlert(app, alert) {
  const p = queuePath(app);
  const q = readJsonFile(p, { items: [] });
  const items = Array.isArray(q.items) ? q.items : [];
  items.push({
    ...alert,
    queued_at: new Date().toISOString(),
    id: crypto.randomBytes(8).toString("hex"),
  });
  writeJsonFile(p, { items: items.slice(-200) });
}

function buildAlertPayload(app, type, details = {}) {
  const ts = Date.now();
  const hardware_id = String(details.hardware_id || "").trim();
  const body = {
    type: String(type || "unknown"),
    hardware_id,
    at: details.at || new Date(ts).toISOString(),
    count_24h: Number(details.count_24h) || 0,
    urgent: !!details.urgent,
    attempt_key_hash: details.attempt_key_hash || null,
    app_version: getAppVersion(),
    hostname: os.hostname(),
    platform: process.platform,
    build_fingerprint: getBuildFingerprint(app),
    watermark: BUILD_WATERMARK,
    watermark_ok: isWatermarkOk(app),
    notify_email: NASER_NOTIFY_EMAIL,
    message: details.message || null,
    ts,
  };
  body.alert_sig = crypto
    .createHmac("sha256", getAlertHmacSecret())
    .update(`${body.type}|${body.hardware_id}|${body.ts}`)
    .digest("hex");
  return body;
}

async function postAlertToCloud(payload) {
  const cloudHealth = require("./cloud-health");
  const res = await cloudHealth.requestJsonWithFallback(
    "POST",
    "/api/license/security-alert",
    payload,
    { timeoutMs: 12000 },
  );
  let parsed = {};
  try {
    parsed = JSON.parse(res.data || "{}");
  } catch {
    parsed = {};
  }
  if (res.status >= 400 || parsed.ok === false) {
    throw new Error(parsed.gabim || `security-alert HTTP ${res.status}`);
  }
  return parsed;
}

async function notifySecurityAlert(app, type, details = {}) {
  const payload = buildAlertPayload(app, type, details);
  localAudit(app, type, {
    hardware_id: payload.hardware_id,
    count_24h: payload.count_24h,
    urgent: payload.urgent,
    attempt_key_hash: payload.attempt_key_hash,
    build_fingerprint: payload.build_fingerprint,
    watermark_ok: payload.watermark_ok,
  });

  try {
    await postAlertToCloud(payload);
    return { ok: true, queued: false };
  } catch (e) {
    enqueueAlert(app, payload);
    console.warn("[security-alert] queued (offline/fail):", e.message || e);
    return { ok: false, queued: true, error: e.message || String(e) };
  }
}

async function flushSecurityAlerts(app) {
  const p = queuePath(app);
  const q = readJsonFile(p, { items: [] });
  const items = Array.isArray(q.items) ? q.items : [];
  if (!items.length) return { ok: true, sent: 0, left: 0 };

  const left = [];
  let sent = 0;
  for (const item of items) {
    try {
      const { queued_at, id, ...payload } = item;
      await postAlertToCloud(payload);
      sent += 1;
    } catch {
      left.push(item);
    }
  }
  writeJsonFile(p, { items: left });
  return { ok: true, sent, left: left.length };
}

async function reportLicenseActivationFailed(app, { hardwareId, rawKey, reason } = {}) {
  const hw = String(hardwareId || "").trim();
  const stats = recordActivationAttempt(app, { hardwareId: hw, rawKey });
  const base = {
    hardware_id: hw,
    count_24h: stats.count_24h,
    attempt_key_hash: stats.key_hash,
    urgent: stats.urgent,
    message: reason || "License activation failed",
  };

  await notifySecurityAlert(app, "license_activate_failed", base);

  if (stats.urgent) {
    await notifySecurityAlert(app, "license_activate_urgent", {
      ...base,
      urgent: true,
      message: `Dyshim për tentativë thyerjeje licence — Hardware ID: ${hw}, ${stats.count_24h} tentativa`,
    });
  }
  return stats;
}

let lastDevtoolsNotifyAt = 0;
const DEVTOOLS_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

async function reportDevtoolsAttempt(app, { hardwareId } = {}) {
  let hw = String(hardwareId || "").trim();
  if (!hw) {
    try {
      const lg = require("../fiscal/license-guard");
      hw = lg.formatHardwareId(lg.getHardwareId(app));
    } catch {
      hw = "";
    }
  }
  const stats = recordDevtoolsAttempt(app, { hardwareId: hw });
  const now = Date.now();
  const shouldEmail = now - lastDevtoolsNotifyAt >= DEVTOOLS_NOTIFY_COOLDOWN_MS;
  if (shouldEmail) {
    lastDevtoolsNotifyAt = now;
    await notifySecurityAlert(app, "devtools_attempt", {
      hardware_id: hw,
      count_24h: stats.count_24h,
      message: "DevTools attempt blocked",
    });
  } else {
    localAudit(app, "devtools_attempt", {
      hardware_id: hw,
      count_24h: stats.count_24h,
      throttled: true,
    });
  }
  return stats;
}

function startSecurityAlertFlush(app) {
  const run = () => {
    flushSecurityAlerts(app).catch(() => {});
  };
  run();
  const t = setInterval(run, 5 * 60 * 1000);
  if (typeof t.unref === "function") t.unref();
}

module.exports = {
  BUILD_WATERMARK,
  NASER_NOTIFY_EMAIL,
  hashAttemptKey,
  getBuildFingerprint,
  isWatermarkOk,
  recordActivationAttempt,
  recordDevtoolsAttempt,
  notifySecurityAlert,
  flushSecurityAlerts,
  reportLicenseActivationFailed,
  reportDevtoolsAttempt,
  startSecurityAlertFlush,
  getAlertHmacSecret,
};
