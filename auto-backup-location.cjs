/**
 * Vendndodhja e backup-it — Desktop (afër ikonës), jo e fshehur vetëm në Documents.
 * Pronari mund ta zhvendosë folderin më vonë; rrugë e ruajtur në auto_backup_dir (settings).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const STATE_MARKERS = ["backup-state.json", "backup-latest.db"];

function isInstalledDesktopApp() {
  if (!process.versions.electron) return false;
  try {
    const electron = require("electron");
    const app = electron && typeof electron === "object" ? electron.app : null;
    if (app && typeof app.isPackaged === "boolean") return !!app.isPackaged;
  } catch {}
  return false;
}

function desktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function legacyNestedDesktopDirectory(projectName) {
  return path.join(desktopDir(), "Revolution Backup", String(projectName || "APP"));
}

function defaultBackupDirectory(projectName) {
  const name = String(projectName || "APP");
  return path.join(desktopDir(), `Revolution Backup ${name}`);
}

function legacyDocumentsDirectory(projectName) {
  return path.join(os.homedir(), "Documents", "Revolution Backup", String(projectName || "APP"));
}

function legacyPosDesktopDirectory(projectName) {
  const name = String(projectName || "APP");
  return path.join(desktopDir(), `Revolution-POS-Backup-${name}`);
}

function legacyPosDocumentsDirectory(projectName) {
  const name = String(projectName || "APP");
  return path.join(os.homedir(), "Documents", `Revolution-POS-Backup-${name}`);
}

function backupDirectoryCandidates(projectName) {
  const name = String(projectName || "APP");
  const seen = new Set();
  const out = [];
  for (const p of [
    defaultBackupDirectory(name),
    legacyNestedDesktopDirectory(name),
    legacyDocumentsDirectory(name),
    legacyPosDesktopDirectory(name),
    legacyPosDocumentsDirectory(name),
  ]) {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function dirHasBackupData(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  for (const name of STATE_MARKERS) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

function dirHasBiznesBackupTree(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  for (const sub of ["daily", "monthly"]) {
    try {
      const p = path.join(dir, sub);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.readdirSync(p).length) {
        return true;
      }
    } catch {}
  }
  return false;
}

function dirHasAnyBackupData(dir) {
  return dirHasBackupData(dir) || dirHasBiznesBackupTree(dir);
}

function canonicalBackupDirectory(projectName) {
  return path.resolve(defaultBackupDirectory(projectName));
}

function isCanonicalBackupDirectory(projectName, dir) {
  try {
    return path.resolve(dir).toLowerCase() === canonicalBackupDirectory(projectName).toLowerCase();
  } catch {
    return false;
  }
}

function isKnownLegacyCandidate(projectName, dir) {
  try {
    const r = path.resolve(dir).toLowerCase();
    for (const c of backupDirectoryCandidates(projectName)) {
      if (path.resolve(c).toLowerCase() === r) return true;
    }
  } catch {}
  return false;
}

function isPathOnDesktop(dir) {
  try {
    const desk = path.resolve(desktopDir()).toLowerCase();
    const r = path.resolve(dir).toLowerCase();
    return r === desk || r.startsWith(`${desk}${path.sep}`);
  } catch {
    return false;
  }
}

function copyBackupEntry(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyBackupEntry(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
}

function mergeLegacyIntoCanonical(projectName) {
  const canonical = canonicalBackupDirectory(projectName);
  if (!isInstalledDesktopApp()) return canonical;
  fs.mkdirSync(canonical, { recursive: true });
  for (const legacy of backupDirectoryCandidates(projectName)) {
    const leg = path.resolve(legacy);
    if (leg.toLowerCase() === canonical.toLowerCase()) continue;
    if (!dirHasAnyBackupData(leg)) continue;
    try {
      for (const name of fs.readdirSync(leg)) {
        const src = path.join(leg, name);
        const dst = path.join(canonical, name);
        if (fs.existsSync(dst)) continue;
        copyBackupEntry(src, dst);
      }
    } catch (e) {
      console.warn("[backup] migrate legacy:", e.message || e);
    }
  }
  return canonical;
}

function resolveBackupDirectory({ projectName, getPersistedDir } = {}) {
  const name = String(projectName || "APP");
  const canonical = canonicalBackupDirectory(name);
  const persisted =
    typeof getPersistedDir === "function" ? String(getPersistedDir() || "").trim() : "";
  if (persisted) {
    try {
      const resolved = path.resolve(persisted);
      if (fs.existsSync(resolved)) {
        if (isCanonicalBackupDirectory(name, resolved)) {
          mergeLegacyIntoCanonical(name);
          return canonical;
        }
        if (isKnownLegacyCandidate(name, resolved) || isPathOnDesktop(resolved)) {
          mergeLegacyIntoCanonical(name);
          return canonical;
        }
        return resolved;
      }
    } catch {}
  }
  mergeLegacyIntoCanonical(name);
  return canonical;
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
      } catch {}
      continue;
    }
    if (lower.endsWith(".db") || lower.endsWith(".json")) continue;
    const ext = path.extname(lower);
    if (DENIED_SOURCE_EXTENSIONS.has(ext) || lower === "package.json" || lower === "package-lock.json") {
      try {
        fs.unlinkSync(full);
        console.warn("[backup] hequr skedar jo-të-dhëna nga folderi backup:", name);
      } catch {}
    }
  }
}

function removeLegacyReadmeFiles(backupDir) {
  for (const name of ["LEXO-KETU.txt", "lexo-ketu.txt", "README.txt", "readme.txt"]) {
    try {
      const p = path.join(backupDir, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

function revealInExplorerOnce(_backupDir, _explorerRevealMarkerPath) {}

function ensureVisibleBackupHome({
  backupDir,
  productName,
  setPersistedDir,
  revealExplorerOnce = false,
  explorerRevealMarkerPath = null,
} = {}) {
  const dir = path.resolve(String(backupDir || ""));
  if (!dir) return { ok: false };
  if (!isInstalledDesktopApp()) return { ok: false, skipped: true, backupDir: dir };
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
  if (revealExplorerOnce) revealInExplorerOnce(dir, explorerRevealMarkerPath);
  return { ok: true, backupDir: dir };
}

module.exports = {
  defaultBackupDirectory,
  legacyNestedDesktopDirectory,
  legacyDocumentsDirectory,
  resolveBackupDirectory,
  ensureVisibleBackupHome,
  dirHasBackupData,
  removeAccidentalSourceFiles,
  isInstalledDesktopApp,
};
