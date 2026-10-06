/**
 * Backup automatik — Desktop\Revolution Backup\<PRODUKTI> (afër ikonës së programit).
 * Minutë (rotacion 3) + ditor (30 ditë) + mujor (12 muaj).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
let backupLoc;
try {
  backupLoc = require(path.join(__dirname, "auto-backup-location.cjs"));
} catch (e) {
  console.warn("[backup] auto-backup-location.cjs:", e.message || e);
  backupLoc = require(path.join(__dirname, "scripts", "auto-backup-location.cjs"));
}

const PROJECT_NAME = "FISKALIZIMI";
const DEFAULT_INTERVAL_MS = 60 * 1000;
const BACKUP_DB_NAMES = ["backup-latest.db", "backup-previous.db", "backup-oldest.db"];
const CRYPTO_SIDECARS = [".db-master.dpapi", ".db-master.scrypt", ".db-install-salt"];
const STATE_FILE = "backup-state.json";
const LAST_DAILY_MARKER = ".last-daily-backup";
const DAILY_RETENTION_DAYS = 30;
const MONTHLY_RETENTION_MONTHS = 12;
const DAILY_SUBDIR = "daily";
const MONTHLY_SUBDIR = "monthly";
const BUNDLE_DB_NAME = "backup.db";

/** Scope: vetëm .db, fiscal-keys/, settings-backup.json, sidecars .db-master.* — jo kod burimor. */
const LICENSE_RESTORE_MESSAGE =
  "Duhet licencë aktive për me rikthy të dhënat. Aktivizoni licencën fillimisht.";
const DENIED_BACKUP_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".vue",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".map",
  ".exe",
  ".dll",
  ".asar",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
  ".py",
]);
const DENIED_BACKUP_BASENAMES = new Set(["package.json", "package-lock.json", "node_modules"]);

function getDefaultBackupDir(projectName = PROJECT_NAME) {
  return backupLoc.defaultBackupDirectory(projectName);
}

function resolveBackupDir(opts = {}) {
  if (opts.backupDir) return path.resolve(opts.backupDir);
  return backupLoc.resolveBackupDirectory({
    projectName: PROJECT_NAME,
    getPersistedDir: opts.getPersistedBackupDir,
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function localDateYmd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localMonthYm(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fileFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const st = fs.statSync(filePath);
  return `${st.size}:${Math.floor(st.mtimeMs)}`;
}

function readState(backupDir) {
  const p = path.join(backupDir, STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeState(backupDir, patch) {
  const prev = readState(backupDir);
  const next = { ...prev, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(path.join(backupDir, STATE_FILE), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function copyFileSafe(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function isDeniedBackupEntry(name) {
  const base = String(name || "").toLowerCase();
  if (DENIED_BACKUP_BASENAMES.has(base)) return true;
  return DENIED_BACKUP_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function assertDbPathForBackup(dbPath) {
  const resolved = path.resolve(String(dbPath || ""));
  if (path.extname(resolved).toLowerCase() !== ".db") {
    throw new Error("Backup: lejohet vetëm skedar databaze (.db).");
  }
  return resolved;
}

function resolveFiscalKeysPath(opts, dataDir) {
  const fiscalKeysPath = opts.fiscalKeysPath
    ? path.resolve(opts.fiscalKeysPath)
    : path.join(dataDir, "fiscal-keys");
  if (path.basename(fiscalKeysPath).toLowerCase() !== "fiscal-keys") {
    throw new Error("Backup: fiscalKeysPath duhet të jetë folder 'fiscal-keys'.");
  }
  return fiscalKeysPath;
}

/** Kopjon vetëm përmbajtjen e fiscal-keys (anashkalon .js/.html/css dhe node_modules). */
function copyFiscalKeysDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false;
  ensureDir(destDir);
  for (const name of fs.readdirSync(srcDir)) {
    if (isDeniedBackupEntry(name)) {
      console.warn(`[backup] Anashkaluar (jo të dhëna): ${name}`);
      continue;
    }
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      if (String(name).toLowerCase() === "node_modules") continue;
      copyFiscalKeysDir(src, dest);
    } else {
      copyFileSafe(src, dest);
    }
  }
  return true;
}

function enforceRestoreLicense(opts = {}) {
  if (opts.licenseActive === true || opts.skipLicenseCheck === true) return null;
  if (opts.licenseActive === false) {
    return {
      ok: false,
      restored: false,
      error: LICENSE_RESTORE_MESSAGE,
      code: "license_required",
    };
  }
  if (typeof opts.assertLicenseActive === "function") {
    try {
      const r = opts.assertLicenseActive();
      if (r && r.ok === false) {
        return {
          ok: false,
          restored: false,
          error: r.message || LICENSE_RESTORE_MESSAGE,
          code: "license_required",
        };
      }
    } catch {
      return {
        ok: false,
        restored: false,
        error: LICENSE_RESTORE_MESSAGE,
        code: "license_required",
      };
    }
  }
  return null;
}

function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) rmDirRecursive(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

function rotateDbBackups(backupDir, stagedLatestPath) {
  const paths = BACKUP_DB_NAMES.map((n) => path.join(backupDir, n));
  const [latest, previous, oldest] = paths;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  if (fs.existsSync(previous)) fs.renameSync(previous, oldest);
  if (fs.existsSync(latest)) fs.renameSync(latest, previous);
  fs.renameSync(stagedLatestPath, latest);
}

function snapshotSidecars(dataDir, destDir) {
  for (const name of CRYPTO_SIDECARS) {
    const src = path.join(dataDir, name);
    if (!fs.existsSync(src)) continue;
    copyFileSafe(src, path.join(destDir, name));
  }
}

function restoreSidecars(bundleDir, dataDir) {
  for (const name of CRYPTO_SIDECARS) {
    const src = path.join(bundleDir, name);
    if (!fs.existsSync(src)) continue;
    copyFileSafe(src, path.join(dataDir, name));
  }
}

function formatMb(bytes) {
  return (Number(bytes) / (1024 * 1024)).toFixed(2);
}

function buildSettingsPayload(opts, extra = {}) {
  let settings = {};
  try {
    settings = typeof opts.getSettingsSnapshot === "function" ? opts.getSettingsSnapshot() : {};
  } catch (e) {
    settings = { snapshot_error: e.message };
  }
  const backedAt = new Date().toISOString();
  return {
    ...settings,
    ...extra,
    backed_up_at: backedAt,
    last_backup_at: backedAt,
    source_db: opts.dbPath,
    backup_dir: opts.backupDir,
  };
}

function writeSettingsFile(dir, payload) {
  fs.writeFileSync(
    path.join(dir, "settings-backup.json"),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

/** Kopjon DB + fiscal-keys + sidecars + settings në një folder bundle. */
function copyBackupBundle(bundleDir, opts) {
  const dbPath = assertDbPathForBackup(opts.dbPath);
  const dataDir = path.dirname(dbPath);
  const fiscalKeysPath = resolveFiscalKeysPath(opts, dataDir);

  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error("Databaza nuk u gjet për backup.");
  }
  ensureDir(bundleDir);
  const destDb = path.join(bundleDir, BUNDLE_DB_NAME);
  copyFileSafe(dbPath, destDb);
  const size = fs.statSync(destDb).size;
  if (!size) throw new Error("Backup i databazës doli bosh.");

  snapshotSidecars(dataDir, bundleDir);
  copyFiscalKeysDir(fiscalKeysPath, path.join(bundleDir, "fiscal-keys"));
  writeSettingsFile(bundleDir, buildSettingsPayload(opts, { bundle_dir: bundleDir }));
  return { size, destDb };
}

function flushIfNeeded(opts) {
  if (typeof opts.flushSave === "function") {
    try {
      opts.flushSave();
    } catch (e) {
      console.warn("[backup] flushSave:", e.message);
    }
  }
}

function purgeOldDailyBackups(backupDir) {
  const root = path.join(backupDir, DAILY_SUBDIR);
  if (!fs.existsSync(root)) return [];
  const cutoff = new Date();
  cutoff.setHours(12, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - DAILY_RETENTION_DAYS);
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const folderDate = new Date(`${name}T12:00:00`);
    if (Number.isNaN(folderDate.getTime()) || folderDate >= cutoff) continue;
    const full = path.join(root, name);
    try {
      rmDirRecursive(full);
      removed.push(name);
      console.log(`[backup] Fshirë backup ditor: ${name} (> ${DAILY_RETENTION_DAYS} ditë)`);
    } catch (e) {
      console.warn(`[backup] purge daily ${name}:`, e.message);
    }
  }
  return removed;
}

function purgeOldMonthlyBackups(backupDir) {
  const root = path.join(backupDir, MONTHLY_SUBDIR);
  if (!fs.existsSync(root)) return [];
  const cutoff = new Date();
  cutoff.setDate(1);
  cutoff.setHours(12, 0, 0, 0);
  cutoff.setMonth(cutoff.getMonth() - MONTHLY_RETENTION_MONTHS);
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^\d{4}-\d{2}$/.test(name)) continue;
    const folderDate = new Date(`${name}-01T12:00:00`);
    if (Number.isNaN(folderDate.getTime()) || folderDate >= cutoff) continue;
    const full = path.join(root, name);
    try {
      rmDirRecursive(full);
      removed.push(name);
      console.log(`[backup] Fshirë backup mujor: ${name} (> ${MONTHLY_RETENTION_MONTHS} muaj)`);
    } catch (e) {
      console.warn(`[backup] purge monthly ${name}:`, e.message);
    }
  }
  return removed;
}

function runDailyBackupIfNeeded(opts) {
  const backupDir = resolveBackupDir(opts);
  const today = localDateYmd();
  const state = readState(backupDir);
  if (state.lastDailyBackupDate === today) {
    return { ok: true, skipped: true, reason: "daily_done" };
  }

  flushIfNeeded(opts);
  const bundleDir = path.join(backupDir, DAILY_SUBDIR, today);
  const { size } = copyBackupBundle(bundleDir, { ...opts, backupDir });
  fs.writeFileSync(path.join(backupDir, LAST_DAILY_MARKER), today, "utf8");
  writeState(backupDir, { lastDailyBackupDate: today });
  purgeOldDailyBackups(backupDir);
  console.log(`[backup] Backup ditor: daily/${today}/backup.db (${formatMb(size)} MB)`);
  return { ok: true, skipped: false, daily: today, size };
}

function runMonthlyBackupIfNeeded(opts) {
  const backupDir = resolveBackupDir(opts);
  const month = localMonthYm();
  const state = readState(backupDir);
  if (state.lastMonthlyBackupMonth === month) {
    return { ok: true, skipped: true, reason: "monthly_done" };
  }

  flushIfNeeded(opts);
  const bundleDir = path.join(backupDir, MONTHLY_SUBDIR, month);
  const { size } = copyBackupBundle(bundleDir, { ...opts, backupDir });
  writeState(backupDir, { lastMonthlyBackupMonth: month });
  purgeOldMonthlyBackups(backupDir);
  console.log(`[backup] Backup mujor: monthly/${month}/backup.db (${formatMb(size)} MB)`);
  return { ok: true, skipped: false, monthly: month, size };
}

function runScheduledDailyMonthly(opts) {
  try {
    runDailyBackupIfNeeded(opts);
  } catch (e) {
    console.warn("[backup] daily:", e.message);
  }
  try {
    runMonthlyBackupIfNeeded(opts);
  } catch (e) {
    console.warn("[backup] monthly:", e.message);
  }
}

function runBackupCycle(opts = {}) {
  const dbPath = opts.dbPath ? assertDbPathForBackup(opts.dbPath) : "";
  const dataDir = dbPath ? path.dirname(dbPath) : "";
  const backupDir = resolveBackupDir(opts);
  const fiscalKeysPath = dbPath ? resolveFiscalKeysPath(opts, dataDir) : "";

  runScheduledDailyMonthly({ ...opts, backupDir, dbPath, fiscalKeysPath });

  if (!dbPath || !fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: "db_missing" };
  }

  const fp = fileFingerprint(dbPath);
  const state = readState(backupDir);
  if (fp && fp === state.last_db_fingerprint) {
    return { ok: true, skipped: true, reason: "unchanged" };
  }

  flushIfNeeded(opts);

  const fpAfter = fileFingerprint(dbPath);
  if (!fpAfter) return { ok: false, skipped: true, reason: "db_missing_after_flush" };

  ensureDir(backupDir);
  const staged = path.join(backupDir, `.staging-${Date.now()}.db`);
  copyFileSafe(dbPath, staged);
  const size = fs.statSync(staged).size;
  if (!size) {
    try { fs.unlinkSync(staged); } catch { /* ignore */ }
    return { ok: false, error: "Backup i databazës doli bosh." };
  }

  rotateDbBackups(backupDir, staged);
  snapshotSidecars(dataDir, backupDir);

  copyFiscalKeysDir(fiscalKeysPath, path.join(backupDir, "fiscal-keys"));
  writeSettingsFile(backupDir, buildSettingsPayload({ ...opts, backupDir, dbPath }));

  const backedAt = new Date().toISOString();
  writeState(backupDir, {
    last_db_fingerprint: fpAfter,
    last_backup_at: backedAt,
    last_backup_size: size,
    last_backup_file: BACKUP_DB_NAMES[0],
  });

  console.log(`[backup] Kopje e re: ${BACKUP_DB_NAMES[0]} (${formatMb(size)} MB)`);
  return {
    ok: true,
    skipped: false,
    path: path.join(backupDir, BACKUP_DB_NAMES[0]),
    size,
    backed_up_at: backedAt,
  };
}

let autoBackupTimer = null;
let autoBackupOpts = null;

function startAutoBackup(opts = {}) {
  stopAutoBackup();
  const backupDir = resolveBackupDir(opts);
  backupLoc.ensureVisibleBackupHome({
    backupDir,
    productName: PROJECT_NAME,
    setPersistedDir: opts.setPersistedBackupDir,
    revealExplorerOnce: opts.revealBackupFolder !== false,
  });
  autoBackupOpts = {
    intervalMs: Number(opts.intervalMs) || DEFAULT_INTERVAL_MS,
    ...opts,
    backupDir,
  };
  const tick = () => {
    try {
      runBackupCycle(autoBackupOpts);
    } catch (e) {
      console.warn("[backup] cycle:", e.message);
    }
  };
  setTimeout(tick, 5000);
  autoBackupTimer = setInterval(tick, autoBackupOpts.intervalMs);
  console.log(
    `[backup] Auto-backup çdo ${Math.round(autoBackupOpts.intervalMs / 1000)}s → ${autoBackupOpts.backupDir}`,
  );
  return { ok: true, backupDir: autoBackupOpts.backupDir };
}

function stopAutoBackup() {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer);
    autoBackupTimer = null;
  }
}

function bundleHasDb(bundleDir) {
  const p = path.join(bundleDir, BUNDLE_DB_NAME);
  return fs.existsSync(p) && fs.statSync(p).size > 0;
}

function readBundleBackedAt(bundleDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(bundleDir, "settings-backup.json"), "utf8"));
    return s.last_backup_at || s.backed_up_at || null;
  } catch {
    return null;
  }
}

function listRestoreCatalog(backupDirOrOpts = null) {
  const dir =
    backupDirOrOpts && typeof backupDirOrOpts === "object"
      ? resolveBackupDir(backupDirOrOpts)
      : path.resolve(backupDirOrOpts || getDefaultBackupDir());
  const items = [];

  const latestPath = path.join(dir, BACKUP_DB_NAMES[0]);
  if (fs.existsSync(latestPath) && fs.statSync(latestPath).size > 0) {
    const st = fs.statSync(latestPath);
    let backedAt = st.mtime.toISOString();
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, "settings-backup.json"), "utf8"));
      backedAt = s.last_backup_at || s.backed_up_at || backedAt;
    } catch { /* ignore */ }
    items.push({
      source_type: "latest",
      source_id: "latest",
      label: `Minutë (latest) — ${new Date(backedAt).toLocaleString("sq-AL")}`,
      backed_at: backedAt,
    });
  }

  const dailyRoot = path.join(dir, DAILY_SUBDIR);
  if (fs.existsSync(dailyRoot)) {
    const days = fs.readdirSync(dailyRoot)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, DAILY_RETENTION_DAYS);
    for (const day of days) {
      const bundle = path.join(dailyRoot, day);
      if (!bundleHasDb(bundle)) continue;
      items.push({
        source_type: "daily",
        source_id: day,
        label: `Ditor — ${day}`,
        backed_at: readBundleBackedAt(bundle),
      });
    }
  }

  const monthlyRoot = path.join(dir, MONTHLY_SUBDIR);
  if (fs.existsSync(monthlyRoot)) {
    const months = fs.readdirSync(monthlyRoot)
      .filter((n) => /^\d{4}-\d{2}$/.test(n))
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, MONTHLY_RETENTION_MONTHS);
    for (const month of months) {
      const bundle = path.join(monthlyRoot, month);
      if (!bundleHasDb(bundle)) continue;
      items.push({
        source_type: "monthly",
        source_id: month,
        label: `Mujor — ${month}`,
        backed_at: readBundleBackedAt(bundle),
      });
    }
  }

  return {
    ok: true,
    backup_dir: dir,
    items,
    latest: items.filter((i) => i.source_type === "latest"),
    daily: items.filter((i) => i.source_type === "daily"),
    monthly: items.filter((i) => i.source_type === "monthly"),
  };
}

function resolveRestoreBundle(backupDir, sourceType, sourceId) {
  const dir = path.resolve(backupDir || getDefaultBackupDir());
  const type = String(sourceType || "latest").trim().toLowerCase();
  const id = String(sourceId || "").trim();

  if (type === "latest" || !type) {
    const dbFile = path.join(dir, BACKUP_DB_NAMES[0]);
    if (!fs.existsSync(dbFile)) return null;
    return { bundleDir: dir, dbFile, label: "latest" };
  }
  if (type === "daily") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return null;
    const bundleDir = path.join(dir, DAILY_SUBDIR, id);
    const dbFile = path.join(bundleDir, BUNDLE_DB_NAME);
    if (!fs.existsSync(dbFile)) return null;
    return { bundleDir, dbFile, label: `daily/${id}` };
  }
  if (type === "monthly") {
    if (!/^\d{4}-\d{2}$/.test(id)) return null;
    const bundleDir = path.join(dir, MONTHLY_SUBDIR, id);
    const dbFile = path.join(bundleDir, BUNDLE_DB_NAME);
    if (!fs.existsSync(dbFile)) return null;
    return { bundleDir, dbFile, label: `monthly/${id}` };
  }
  return null;
}

function getBackupStatus(backupDirOrOpts = null) {
  const dir =
    backupDirOrOpts && typeof backupDirOrOpts === "object"
      ? resolveBackupDir(backupDirOrOpts)
      : path.resolve(backupDirOrOpts || getDefaultBackupDir());
  const state = readState(dir);
  const catalog = listRestoreCatalog(dir);
  const latest = path.join(dir, BACKUP_DB_NAMES[0]);
  let latestMeta = null;
  if (fs.existsSync(latest)) {
    const st = fs.statSync(latest);
    latestMeta = { size: st.size, mtime: st.mtime.toISOString() };
  }
  return {
    ok: true,
    backup_dir: dir,
    last_backup_at: state.last_backup_at || null,
    last_daily_backup_date: state.lastDailyBackupDate || null,
    last_monthly_backup_month: state.lastMonthlyBackupMonth || null,
    latest_db: fs.existsSync(latest) ? latest : null,
    latest_meta: latestMeta,
    daily_count: catalog.daily.length,
    monthly_count: catalog.monthly.length,
    state,
  };
}

function isDbMissingOrCorrupt(dbPath) {
  const p = path.resolve(String(dbPath || ""));
  if (!p || !fs.existsSync(p)) {
    return { needRestore: true, reason: "missing" };
  }
  const st = fs.statSync(p);
  if (!st.size || st.size < 64) {
    return { needRestore: true, reason: "empty" };
  }
  try {
    const dbCrypto = require("./db-crypto");
    const loaded = dbCrypto.loadDatabaseBytes(p);
    if (!loaded?.bytes?.length) {
      return { needRestore: true, reason: "decrypt_failed" };
    }
    if (loaded.wasPlain) {
      const head = loaded.bytes.slice(0, 15).toString("utf8");
      if (!head.startsWith("SQLite format 3")) {
        return { needRestore: true, reason: "invalid_sqlite" };
      }
    }
  } catch (e) {
    return { needRestore: true, reason: "load_error", message: e.message };
  }
  return { needRestore: false };
}

function restoreFromBackup(opts = {}) {
  const licenseBlock = enforceRestoreLicense(opts);
  if (licenseBlock) return licenseBlock;

  const backupDir = resolveBackupDir(opts);
  const targetDbPath = path.resolve(String(opts.targetDbPath || ""));
  const targetKeysPath = opts.targetKeysPath
    ? path.resolve(opts.targetKeysPath)
    : path.join(path.dirname(targetDbPath), "fiscal-keys");
  const dataDir = path.dirname(targetDbPath);

  const source = resolveRestoreBundle(
    backupDir,
    opts.source_type || opts.sourceType || "latest",
    opts.source_id || opts.sourceId || "latest",
  );
  if (!source) {
    return { ok: false, restored: false, error: "Backup i zgjedhur nuk u gjet." };
  }

  const st = fs.statSync(source.dbFile);
  if (!st.size) {
    return { ok: false, restored: false, error: "Skedari i backup-it është bosh." };
  }

  ensureDir(dataDir);
  copyFileSafe(source.dbFile, targetDbPath);
  restoreSidecars(source.bundleDir, dataDir);

  const keysSrc = path.join(source.bundleDir, "fiscal-keys");
  if (fs.existsSync(keysSrc)) {
    copyFiscalKeysDir(keysSrc, targetKeysPath);
  }

  let backedAt = st.mtime.toISOString();
  const settingsPath = path.join(source.bundleDir, "settings-backup.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings?.last_backup_at) backedAt = settings.last_backup_at;
      else if (settings?.backed_up_at) backedAt = settings.backed_up_at;
    } catch { /* ignore */ }
  }

  const message = `Të dhënat u rikthyen nga backup (${source.label}) i datës ${backedAt}`;
  console.log(`[backup] ${message}`);
  return {
    ok: true,
    restored: true,
    message,
    restored_at: backedAt,
    source_type: opts.source_type || opts.sourceType || "latest",
    source_id: opts.source_id || opts.sourceId,
    db_path: targetDbPath,
    keys_path: targetKeysPath,
  };
}

function maybeRestoreOnStartup(opts = {}) {
  const dbPath = path.resolve(String(opts.targetDbPath || opts.dbPath || ""));
  if (!dbPath) return { restored: false, skipped: true };
  const check = isDbMissingOrCorrupt(dbPath);
  if (!check.needRestore) return { restored: false, skipped: true, reason: "db_ok" };
  console.warn("[backup] DB kërkon restore:", check.reason, check.message || "");
  const result = restoreFromBackup({
    ...opts,
    backupDir: opts.backupDir,
    targetDbPath: dbPath,
    targetKeysPath: opts.targetKeysPath,
    source_type: "latest",
    source_id: "latest",
  });
  return { ...result, trigger: check.reason };
}

module.exports = {
  PROJECT_NAME,
  getDefaultBackupDir,
  resolveBackupDir,
  runBackupCycle,
  runDailyBackupIfNeeded,
  runMonthlyBackupIfNeeded,
  startAutoBackup,
  stopAutoBackup,
  getBackupStatus,
  listRestoreCatalog,
  isDbMissingOrCorrupt,
  restoreFromBackup,
  maybeRestoreOnStartup,
  LICENSE_RESTORE_MESSAGE,
  enforceRestoreLicense,
};

