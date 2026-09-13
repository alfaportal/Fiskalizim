/**
 * biznes-backup.js — kopjim i plotë i folderit të të dhënave + backup automatik ditor/mujor
 * Ky skedar NUK obfuskohet.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const BACKUP_FOLDER_NAME = "Revolution-POS-Backup";
const README_TEXT = "Backup automatik Revolution Fiskalizim — mos e fshini këtë folder\n";
const DAILY_MAX = 30;
const MONTHLY_MAX = 60;
const RESTORE_OWNER_CODE = "Ferizaji1234";

/** Rezultati i fundit i backup-it në startup (për njoftim UI). */
let lastStartupBackup = null;

function getBiznesSefDir() {
  const db = require("./database");
  return path.dirname(db.DB_PATH);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayYmd(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayYm(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function stampDirName() {
  const d = new Date();
  return (
    `biznes-sef-backup-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  );
}

function getDesktopPath() {
  try {
    const { app } = require("electron");
    return app.getPath("desktop");
  } catch {
    return path.join(os.homedir(), "Desktop");
  }
}

function getDocumentsPath() {
  try {
    const { app } = require("electron");
    return app.getPath("documents");
  } catch {
    return path.join(os.homedir(), "Documents");
  }
}

/**
 * Desktop\Revolution-POS-Backup — fallback Documents\Revolution-POS-Backup
 */
function getDefaultBackupRoot() {
  const candidates = [
    path.join(getDesktopPath(), BACKUP_FOLDER_NAME),
    path.join(getDocumentsPath(), BACKUP_FOLDER_NAME),
  ];
  for (const root of candidates) {
    try {
      fs.mkdirSync(root, { recursive: true });
      return root;
    } catch {
      /* provo Documents */
    }
  }
  throw new Error("Nuk u krijua folderi i backup-it automatik (Desktop/Documents)");
}

function getDailyBackupDir(root, dateYmd) {
  return path.join(root, "daily", dateYmd || todayYmd());
}

function getMonthlyBackupDir(root, ym) {
  return path.join(root, "monthly", ym || todayYm());
}

function ensureBackupRoot(root) {
  const r = root || getDefaultBackupRoot();
  fs.mkdirSync(path.join(r, "daily"), { recursive: true });
  fs.mkdirSync(path.join(r, "monthly"), { recursive: true });
  const readme = path.join(r, "README.txt");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, README_TEXT, "utf8");
  }
  return r;
}

function copyEntry(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyEntry(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function listCopiedFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full);
    const st = fs.statSync(full);
    if (st.isDirectory()) listCopiedFiles(full, base, out);
    else out.push(rel);
  }
  return out;
}

function flushDatabaseSafe() {
  const db = require("./database");
  if (typeof db.flushDatabase === "function") {
    db.flushDatabase();
  }
}

function prepareSourceDir() {
  const srcDir = getBiznesSefDir();
  if (!fs.existsSync(srcDir)) {
    throw new Error("Folderi i databazës nuk u gjet: " + srcDir);
  }
  flushDatabaseSafe();
  return srcDir;
}

function copyDataToDest(destDir) {
  const srcDir = prepareSourceDir();
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    copyEntry(path.join(srcDir, name), path.join(destDir, name));
  }
  const files = listCopiedFiles(destDir);
  return {
    ok: true,
    source_dir: srcDir,
    dest_dir: destDir,
    created_at: new Date().toISOString(),
    file_count: files.length,
    files,
  };
}

function dirHasBackupContent(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function hasDailyBackupToday(root) {
  return dirHasBackupContent(getDailyBackupDir(root, todayYmd()));
}

function hasMonthlyBackupThisMonth(root) {
  return dirHasBackupContent(getMonthlyBackupDir(root, todayYm()));
}

function isDailyFolderName(name) {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function isMonthlyFolderName(name) {
  return /^\d{4}-\d{2}$/.test(name);
}

/**
 * Fshin backup-et më të vjetër — vetëm brenda daily/ dhe monthly/ të root-it automatik.
 */
function pruneBackups(root, opts = {}) {
  const dailyMax = Number(opts.dailyMax) > 0 ? Number(opts.dailyMax) : DAILY_MAX;
  const monthlyMax = Number(opts.monthlyMax) > 0 ? Number(opts.monthlyMax) : MONTHLY_MAX;
  const base = root || getDefaultBackupRoot();

  function pruneParent(parentDir, isValidName, maxKeep) {
    const deleted = [];
    if (!fs.existsSync(parentDir)) return deleted;
    const names = fs
      .readdirSync(parentDir)
      .filter((n) => isValidName(n))
      .sort((a, b) => b.localeCompare(a));
    for (let i = maxKeep; i < names.length; i += 1) {
      const full = path.join(parentDir, names[i]);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        deleted.push(names[i]);
      } catch (e) {
        console.warn("[backup-auto] prune:", full, e.message);
      }
    }
    return deleted;
  }

  return {
    daily: pruneParent(path.join(base, "daily"), isDailyFolderName, dailyMax),
    monthly: pruneParent(path.join(base, "monthly"), isMonthlyFolderName, monthlyMax),
  };
}

/**
 * Backup automatik: 1× ditore + 1× mujore + pruning.
 * Thirret nga startup — gabimet nuk duhet të ndalojnë aplikacionin.
 */
function runAutoBackupOnStartup() {
  const root = ensureBackupRoot(getDefaultBackupRoot());
  const result = {
    ok: true,
    root,
    daily: null,
    monthly: null,
    skipped_daily: false,
    skipped_monthly: false,
    pruned: { daily: [], monthly: [] },
  };

  if (hasDailyBackupToday(root)) {
    result.skipped_daily = true;
  } else {
    result.daily = copyDataToDest(getDailyBackupDir(root, todayYmd()));
    result.daily.kind = "auto_daily";
  }

  if (hasMonthlyBackupThisMonth(root)) {
    result.skipped_monthly = true;
  } else {
    result.monthly = copyDataToDest(getMonthlyBackupDir(root, todayYm()));
    result.monthly.kind = "auto_monthly";
  }

  result.pruned = pruneBackups(root);
  lastStartupBackup = {
    ran_at: new Date().toISOString(),
    root,
    daily_created: !!result.daily,
    monthly_created: !!result.monthly,
    skipped_daily: result.skipped_daily,
    skipped_monthly: result.skipped_monthly,
    daily_dir: result.daily ? result.daily.dest_dir : getDailyBackupDir(root, todayYmd()),
    monthly_dir: result.monthly ? result.monthly.dest_dir : getMonthlyBackupDir(root, todayYm()),
    file_count: result.daily ? result.daily.file_count : null,
  };
  return result;
}

function getAutoBackupStatus() {
  const root = ensureBackupRoot(getDefaultBackupRoot());
  return {
    ok: true,
    auto_enabled: true,
    root,
    daily_dir: path.join(root, "daily"),
    monthly_dir: path.join(root, "monthly"),
    has_daily_today: hasDailyBackupToday(root),
    has_monthly_this_month: hasMonthlyBackupThisMonth(root),
    today: todayYmd(),
    month: todayYm(),
    last_startup: lastStartupBackup,
    db_decrypt_failed: !!global.DB_DECRYPT_FAILED,
  };
}

function openBackupFolder() {
  const root = ensureBackupRoot(getDefaultBackupRoot());
  const { exec } = require("child_process");
  exec(`explorer "${root}"`);
  return { ok: true, root };
}

/**
 * Kopjon krejt folderin e të dhënave në targetParent/biznes-sef-backup-<timestamp>/
 * (backup manual — USB / folder i zgjedhur).
 */
function runBackup(targetParentDir) {
  const parent = String(targetParentDir || "").trim();
  if (!parent) throw new Error("Folderi i backup-it mungon");

  const destDir = path.join(parent, stampDirName());
  const result = copyDataToDest(destDir);
  result.kind = "manual";
  return result;
}

/**
 * Dialog Electron për zgjedhje folderi (USB, Desktop, …).
 * Kthen null nëse anulohet ose jashtë Electron.
 */
function pickBackupFolderDialog() {
  try {
    const { dialog, BrowserWindow } = require("electron");
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const result = dialog.showOpenDialogSync(win, {
      title: "Backup — zgjidh folder (USB, Desktop, …)",
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result || !result[0]) return null;
    return result[0];
  } catch {
    return null;
  }
}

function verifyRestoreOwnerCode(code) {
  return String(code || "").trim() === RESTORE_OWNER_CODE;
}

/**
 * Zgjidh folderin që përmban biznes.db (daily, monthly, USB, …).
 */
function pickRestoreSourceDialog() {
  try {
    const { dialog, BrowserWindow } = require("electron");
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const result = dialog.showOpenDialogSync(win, {
      title: "Kthe nga backup-i — zgjidh folderin e backup-it",
      properties: ["openDirectory"],
    });
    if (!result || !result[0]) return null;
    return result[0];
  } catch {
    return null;
  }
}

/**
 * Mbledh kandidatë backup nga daily/YYYY-MM-DD dhe monthly/YYYY-MM.
 * @returns {{ path: string, sortKey: string, type: "daily"|"monthly" }[]}
 */
function collectDailyMonthlyBackupCandidates(baseDir) {
  const candidates = [];
  const addFromContainer = (containerDir, isValidName, type) => {
    if (!containerDir || !fs.existsSync(containerDir)) return;
    let names = [];
    try {
      names = fs.readdirSync(containerDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!isValidName(name)) continue;
      const inner = path.join(containerDir, name);
      try {
        if (!fs.statSync(inner).isDirectory()) continue;
      } catch {
        continue;
      }
      if (fs.existsSync(path.join(inner, "biznes.db"))) {
        candidates.push({ path: inner, sortKey: name, type });
      }
    }
  };

  const dailyInside = path.join(baseDir, "daily");
  const monthlyInside = path.join(baseDir, "monthly");
  const baseName = path.basename(baseDir).toLowerCase();

  if (fs.existsSync(dailyInside) || fs.existsSync(monthlyInside)) {
    addFromContainer(dailyInside, isDailyFolderName, "daily");
    addFromContainer(monthlyInside, isMonthlyFolderName, "monthly");
  } else if (baseName === "daily") {
    addFromContainer(baseDir, isDailyFolderName, "daily");
  } else if (baseName === "monthly") {
    addFromContainer(baseDir, isMonthlyFolderName, "monthly");
  }

  return candidates;
}

/** Zgjedh backup-in më të fundit — datë më e madhe; barazim → daily para monthly. */
function pickLatestDailyMonthlyBackup(baseDir) {
  const candidates = collectDailyMonthlyBackupCandidates(baseDir);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const byDate = b.sortKey.localeCompare(a.sortKey);
    if (byDate !== 0) return byDate;
    if (a.type === "daily" && b.type === "monthly") return -1;
    if (a.type === "monthly" && b.type === "daily") return 1;
    return 0;
  });
  return candidates[0].path;
}

function resolveBackupDataDir(sourcePath) {
  const p = path.resolve(String(sourcePath || "").trim());
  if (!p || !fs.existsSync(p)) {
    throw new Error("Folderi i backup-it nuk u gjet");
  }
  if (fs.existsSync(path.join(p, "biznes.db"))) {
    return p;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    throw new Error("Nuk lexohet folderi i backup-it: " + e.message);
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (isDailyFolderName(ent.name) || isMonthlyFolderName(ent.name)) continue;
    const inner = path.join(p, ent.name);
    if (fs.existsSync(path.join(inner, "biznes.db"))) {
      return inner;
    }
  }
  const latestDailyMonthly = pickLatestDailyMonthlyBackup(p);
  if (latestDailyMonthly) {
    return latestDailyMonthly;
  }
  throw new Error("Nuk u gjet biznes.db në folderin e zgjedhur");
}

function copyDirReplace(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false;
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  copyEntry(srcDir, destDir);
  return true;
}

function safetyStampDirName() {
  const d = new Date();
  return `pre-restore-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

const dbCrypto = require("./db-crypto");

/** Normalizon NUI — vetëm 9 shifra (si fiscal-config). */
function normalizeTaxpayerNui(value) {
  return String(value ?? "")
    .replace(/[^\d]/g, "")
    .trim();
}

function getCurrentTaxpayerNui() {
  try {
    const database = require("./database");
    const row = database.getFiscalSettingsRow();
    return row?.taxpayer_nui != null ? String(row.taxpayer_nui) : "";
  } catch {
    return "";
  }
}

let _sqlJsPromise = null;

function getSqlJs() {
  if (!_sqlJsPromise) {
    _sqlJsPromise = (async () => {
      const initSqlJs = require("sql.js");
      return initSqlJs({
        locateFile: (file) => {
          const packed = path.join(__dirname, "node_modules", "sql.js", "dist", file);
          if (fs.existsSync(packed)) return packed;
          const unpacked = packed.replace(
            `${path.sep}app.asar${path.sep}`,
            `${path.sep}app.asar.unpacked${path.sep}`
          );
          return unpacked;
        },
      });
    })();
  }
  return _sqlJsPromise;
}

/**
 * Lexon taxpayer_nui nga biznes.db (backup ose tjetër path) — pa prekur DB live.
 * @returns {Promise<{ nui: string, read_ok: boolean, error?: string }>}
 */
async function readTaxpayerNuiFromDbPath(dbPath) {
  let loaded;
  try {
    loaded = dbCrypto.loadDatabaseBytes(dbPath);
  } catch (e) {
    return { nui: "", read_ok: false, error: e.message || String(e) };
  }
  if (!loaded.bytes || !loaded.bytes.length) {
    return { nui: "", read_ok: true };
  }
  const SQL = await getSqlJs();
  let db;
  try {
    db = new SQL.Database(loaded.bytes);
    const stmt = db.prepare("SELECT taxpayer_nui FROM fiscal_settings WHERE id = 1");
    let nui = "";
    if (stmt.step()) {
      const row = stmt.getAsObject();
      nui = row.taxpayer_nui != null ? String(row.taxpayer_nui) : "";
    }
    stmt.free();
    return { nui, read_ok: true };
  } catch (e) {
    return { nui: "", read_ok: false, error: e.message || String(e) };
  } finally {
    if (db) db.close();
  }
}

/**
 * Kontrollon nëse backup-i i përket të njëjtit biznes (NUI) para rikthimit.
 * NUI aktuale bosh → lejo (instalim i ri). Përndryshe krahaso me backup-in.
 * @returns {Promise<object>}
 */
async function validateRestoreBackupNui(sourcePath) {
  const dataDir = resolveBackupDataDir(sourcePath);
  const biznesDbSrc = path.join(dataDir, "biznes.db");
  if (!fs.existsSync(biznesDbSrc)) {
    throw new Error("Mungon biznes.db në backup");
  }

  const currentNui = normalizeTaxpayerNui(getCurrentTaxpayerNui());
  const backupRead = await readTaxpayerNuiFromDbPath(biznesDbSrc);
  const backupNui = normalizeTaxpayerNui(backupRead.nui);

  if (currentNui.length === 0) {
    return {
      allowed: true,
      reason: "fresh_install",
      current_nui: "",
      backup_nui: backupNui,
      backup_read_ok: backupRead.read_ok,
    };
  }

  if (!backupRead.read_ok) {
    return {
      allowed: false,
      error:
        "Nuk mund të verifikohet NUI i backup-it. Rikthimi u ndal për siguri — përdorni backup të biznesit tuaj ose kontaktoni mbështetjen.",
      current_nui: currentNui,
      backup_nui: "",
      backup_read_ok: false,
    };
  }

  if (backupNui.length === 0 || backupNui !== currentNui) {
    const displayNui = backupNui || "—";
    return {
      allowed: false,
      error: `Ky backup i përket biznesit tjetër (NUI: ${displayNui}). Nuk lejohet rikthimi i të dhënave nga biznesi tjetër.`,
      current_nui: currentNui,
      backup_nui: backupNui,
    };
  }

  return {
    allowed: true,
    reason: "nui_match",
    current_nui: currentNui,
    backup_nui: backupNui,
    backup_read_ok: true,
  };
}

/**
 * Rikthen biznes.db + fiscal-keys nga backup. Safety copy para mbishkrimit.
 * @returns {Promise<object>}
 */
async function restoreFromBackup(sourcePath) {
  const nuiCheck = await validateRestoreBackupNui(sourcePath);
  if (!nuiCheck.allowed) {
    throw new Error(nuiCheck.error || "Rikthimi u ndal — NUI nuk përputhet.");
  }

  const dataDir = resolveBackupDataDir(sourcePath);
  const biznesDbSrc = path.join(dataDir, "biznes.db");
  if (!fs.existsSync(biznesDbSrc)) {
    throw new Error("Mungon biznes.db në backup");
  }

  const targetDir = getBiznesSefDir();
  fs.mkdirSync(targetDir, { recursive: true });

  const safetyParent = path.join(getDefaultBackupRoot(), "restore-safety");
  fs.mkdirSync(safetyParent, { recursive: true });
  const safetyDir = path.join(safetyParent, safetyStampDirName());
  const safety = copyDataToDest(safetyDir);
  safety.kind = "pre_restore";

  flushDatabaseSafe();

  fs.copyFileSync(biznesDbSrc, path.join(targetDir, "biznes.db"));

  const keysSrc = path.join(dataDir, "fiscal-keys");
  const keysDest = path.join(targetDir, "fiscal-keys");
  const keysRestored = copyDirReplace(keysSrc, keysDest);

  for (const name of [".db-master.dpapi", ".db-master.scrypt", ".db-install-salt"]) {
    const srcFile = path.join(dataDir, name);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(targetDir, name));
    }
  }

  const database = require("./database");
  if (typeof database.reloadDatabaseFromDisk === "function") {
    await database.reloadDatabaseFromDisk();
  }

  return {
    ok: true,
    restored_from: dataDir,
    safety_dir: safety.dest_dir,
    keys_restored: keysRestored,
    needs_restart: true,
  };
}

module.exports = {
  getBiznesSefDir,
  getDefaultBackupRoot,
  getDailyBackupDir,
  getMonthlyBackupDir,
  ensureBackupRoot,
  hasDailyBackupToday,
  hasMonthlyBackupThisMonth,
  pruneBackups,
  runAutoBackupOnStartup,
  getAutoBackupStatus,
  openBackupFolder,
  runBackup,
  pickBackupFolderDialog,
  verifyRestoreOwnerCode,
  pickRestoreSourceDialog,
  validateRestoreBackupNui,
  readTaxpayerNuiFromDbPath,
  normalizeTaxpayerNui,
  restoreFromBackup,
  DAILY_MAX,
  MONTHLY_MAX,
};
