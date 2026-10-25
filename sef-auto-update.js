/**
 * sef-auto-update.js — electron-updater për Revolution POS SEF (generic: revolution-pos.com).
 * Vetëm në build të paketuar (app.isPackaged).
 */
const { app, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const UPDATE_FEED_URL = "https://revolution-pos.com/sef/update/";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 45 * 1000;

let autoUpdater = null;
let checkTimer = null;
let getMainWindow = () => null;

const state = {
  status: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  progress: 0,
  error: null,
  snoozedUntil: 0,
  snoozedVersion: null,
};

function snoozePath() {
  return path.join(app.getPath("userData"), "sef-update-snooze.json");
}

function loadSnooze() {
  try {
    const raw = fs.readFileSync(snoozePath(), "utf8");
    const j = JSON.parse(raw);
    state.snoozedUntil = Number(j.until) || 0;
    state.snoozedVersion = j.version ? String(j.version) : null;
  } catch {
    state.snoozedUntil = 0;
    state.snoozedVersion = null;
  }
}

function saveSnooze(version) {
  state.snoozedUntil = Date.now() + SNOOZE_MS;
  state.snoozedVersion = version ? String(version) : state.availableVersion;
  try {
    fs.mkdirSync(path.dirname(snoozePath()), { recursive: true });
    fs.writeFileSync(
      snoozePath(),
      JSON.stringify({
        until: state.snoozedUntil,
        version: state.snoozedVersion,
      }),
      "utf8"
    );
  } catch (e) {
    console.warn("[sef-update] snooze save:", e.message || e);
  }
}

function clearSnooze() {
  state.snoozedUntil = 0;
  state.snoozedVersion = null;
  try {
    if (fs.existsSync(snoozePath())) fs.unlinkSync(snoozePath());
  } catch {
    /* */
  }
}

function isSnoozedForVersion(version) {
  if (!version) return false;
  if (Date.now() >= state.snoozedUntil) return false;
  if (!state.snoozedVersion) return true;
  return String(state.snoozedVersion) === String(version);
}

function broadcast(payload) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("sef-update-event", {
      ...getPublicState(),
      ...payload,
    });
  } catch {
    /* */
  }
}

function getPublicState() {
  return {
    status: state.status,
    currentVersion: state.currentVersion,
    availableVersion: state.availableVersion,
    progress: state.progress,
    error: state.error,
    feedUrl: UPDATE_FEED_URL,
    snoozed: isSnoozedForVersion(state.availableVersion),
  };
}

function setStatus(next, extra) {
  state.status = next;
  if (extra && typeof extra === "object") {
    if (extra.error !== undefined) state.error = extra.error;
    if (extra.progress !== undefined) state.progress = extra.progress;
    if (extra.availableVersion !== undefined) state.availableVersion = extra.availableVersion;
  }
  broadcast(extra || {});
}

function loadAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    console.warn("[sef-update] electron-updater nuk u ngarkua:", e.message || e);
    return null;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => {
    setStatus("checking", { error: null });
  });

  autoUpdater.on("update-not-available", () => {
    setStatus("idle", { availableVersion: null, error: null, progress: 0 });
  });

  autoUpdater.on("update-available", (info) => {
    const ver = info?.version ? String(info.version) : null;
    state.availableVersion = ver;
    state.progress = 0;
    state.error = null;
    if (ver && isSnoozedForVersion(ver)) {
      setStatus("snoozed", { availableVersion: ver });
      return;
    }
    setStatus("available", { availableVersion: ver });
  });

  autoUpdater.on("download-progress", (prog) => {
    const pct = Math.round(Number(prog?.percent) || 0);
    state.progress = pct;
    setStatus("downloading", { progress: pct, error: null });
  });

  autoUpdater.on("update-downloaded", (info) => {
    state.progress = 100;
    state.availableVersion = info?.version ? String(info.version) : state.availableVersion;
    setStatus("downloaded", { progress: 100, error: null });
    try {
      setImmediate(() => {
        autoUpdater.quitAndInstall(false, true);
      });
    } catch (e) {
      setStatus("error", { error: e.message || String(e) });
    }
  });

  autoUpdater.on("error", (err) => {
    const msg = err?.message || String(err || "Gabim update");
    console.warn("[sef-update]", msg);
    setStatus("error", { error: msg });
  });

  return autoUpdater;
}

async function checkForUpdates(reason) {
  if (!app.isPackaged) return getPublicState();
  const au = loadAutoUpdater();
  if (!au) return getPublicState();
  try {
    loadSnooze();
    console.log("[sef-update] check:", reason || "manual");
    await au.checkForUpdates();
  } catch (e) {
    setStatus("error", { error: e.message || String(e) });
  }
  return getPublicState();
}

async function downloadUpdate() {
  if (!app.isPackaged) return getPublicState();
  const au = loadAutoUpdater();
  if (!au) return getPublicState();
  clearSnooze();
  try {
    setStatus("downloading", { progress: 0, error: null });
    await au.downloadUpdate();
  } catch (e) {
    setStatus("error", { error: e.message || String(e) });
  }
  return getPublicState();
}

function scheduleChecks() {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    checkForUpdates("interval-6h").catch(() => {});
  }, CHECK_INTERVAL_MS);
}

function registerSefUpdateIpc() {
  ipcMain.handle("sef-update-get-state", () => getPublicState());

  ipcMain.handle("sef-update-check", async () => {
    return checkForUpdates("renderer");
  });

  ipcMain.handle("sef-update-download", async () => downloadUpdate());

  ipcMain.handle("sef-update-snooze", async () => {
    saveSnooze(state.availableVersion);
    setStatus("snoozed", {});
    return getPublicState();
  });
}

function initSefAutoUpdate(opts = {}) {
  if (typeof opts.getMainWindow === "function") {
    getMainWindow = opts.getMainWindow;
  }
  if (!app.isPackaged) {
    console.log("[sef-update] dev mode — auto-update çaktivizuar");
    registerSefUpdateIpc();
    return;
  }

  loadSnooze();
  registerSefUpdateIpc();
  loadAutoUpdater();

  setTimeout(() => {
    checkForUpdates("startup").catch(() => {});
  }, STARTUP_DELAY_MS);

  scheduleChecks();
}

module.exports = {
  initSefAutoUpdate,
  registerSefUpdateIpc,
  checkForUpdates,
  getPublicState,
  UPDATE_FEED_URL,
};
