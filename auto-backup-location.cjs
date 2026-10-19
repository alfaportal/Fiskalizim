/**
 * Vendndodhja e backup-it — Desktop (afër ikonës), jo e fshehur vetëm në Documents.
 * Pronari mund ta zhvendosë folderin më vonë; rrugë e ruajtur në auto_backup_dir (settings).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const STATE_MARKERS = ["backup-state.json", "backup-latest.db"];

function desktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function defaultBackupDirectory(projectName) {
  return path.join(desktopDir(), "Revolution Backup", String(projectName || "APP"));
}

function legacyDocumentsDirectory(projectName) {
  return path.join(os.homedir(), "Documents", "Revolution Backup", String(projectName || "APP"));
}

function dirHasBackupData(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  for (const name of STATE_MARKERS) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

function resolveBackupDirectory({ projectName, getPersistedDir } = {}) {
  const name = String(projectName || "APP");
  const persisted =
    typeof getPersistedDir === "function" ? String(getPersistedDir() || "").trim() : "";
  if (persisted) {
    try {
      const resolved = path.resolve(persisted);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      /* ignore */
    }
  }
  const legacy = legacyDocumentsDirectory(name);
  if (dirHasBackupData(legacy)) return legacy;
  return defaultBackupDirectory(name);
}

const DENIED_SOURCE_EXTENSIONS = new Set([
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

const ALLOWED_BACKUP_ROOT_FILES = new Set([
  "backup-state.json",
  "settings-backup.json",
  "backup-latest.db",
  "backup-previous.db",
  "backup-oldest.db",
  ".folder-shown-once",
  ".last-daily-backup",
  ".db-master.dpapi",
  ".db-master.scrypt",
  ".db-install-salt",
]);

/** Heq skedarë burim/kod që nuk duhet të jenë kurrë në folder backup. */
function removeAccidentalSourceFiles(backupDir) {
  let names;
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return;
  }
  for (const name of names) {
    const lower = String(name || "").toLowerCase();
    const full = path.join(backupDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) continue;
    if (ALLOWED_BACKUP_ROOT_FILES.has(lower)) continue;
    if (lower === "lexo-ketu.txt" || lower === "readme.txt") {
      try {
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (lower.endsWith(".db") || lower.endsWith(".json")) continue;
    const ext = path.extname(lower);
    if (DENIED_SOURCE_EXTENSIONS.has(ext) || lower === "package.json" || lower === "package-lock.json") {
      try {
        fs.unlinkSync(full);
        console.warn("[backup] hequr skedar jo-të-dhëna nga folderi backup:", name);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Heq LEXO-KETU.txt të vjetër — backup vetëm të dhëna, pa skedarë shpjegues. */
function removeLegacyReadmeFiles(backupDir) {
  for (const name of ["LEXO-KETU.txt", "lexo-ketu.txt", "README.txt", "readme.txt"]) {
    try {
      const p = path.join(backupDir, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

function revealInExplorerOnce(backupDir) {
  const marker = path.join(backupDir, ".folder-shown-once");
  if (fs.existsSync(marker)) return;
  if (process.platform === "win32") {
    execFile("explorer.exe", [backupDir], { windowsHide: true }, () => {});
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  } catch {
    /* ignore */
  }
}

function ensureVisibleBackupHome({
  backupDir,
  productName,
  setPersistedDir,
  revealExplorerOnce = true,
} = {}) {
  const dir = path.resolve(String(backupDir || ""));
  if (!dir) return { ok: false };
  fs.mkdirSync(dir, { recursive: true });
  removeLegacyReadmeFiles(dir);
  removeAccidentalSourceFiles(dir);
  if (typeof setPersistedDir === "function") {
    try {
      setPersistedDir(dir);
    } catch (e) {
      console.warn("[backup] setPersistedDir:", e.message || e);
    }
  }
  if (revealExplorerOnce) revealInExplorerOnce(dir);
  return { ok: true, backupDir: dir };
}

module.exports = {
  defaultBackupDirectory,
  legacyDocumentsDirectory,
  resolveBackupDirectory,
  ensureVisibleBackupHome,
  dirHasBackupData,
  removeAccidentalSourceFiles,
};
