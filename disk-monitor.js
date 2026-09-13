/**
 * disk-monitor.js — kontroll hapësire disku për biznes.db
 * Ky skedar NUK obfuskohet.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WARN_BYTES = 500 * 1024 * 1024;
const CRIT_BYTES = 100 * 1024 * 1024;

function getFreeBytesWindows(resolvedPath) {
  const root = path.parse(resolvedPath).root || "C:\\";
  const letter = root.replace(/[:\\]/g, "").charAt(0);
  if (!letter) return null;
  const script = `(Get-PSDrive -Name '${letter}').Free`;
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  const n = Number(String(out || "").trim());
  return Number.isFinite(n) ? n : null;
}

function getFreeBytesUnix(resolvedPath) {
  const statfsSync = fs.statfsSync;
  const st = statfsSync(resolvedPath);
  return (Number(st.bsize) || 0) * (Number(st.bavail) || 0);
}

function getFreeBytesForPath(anyPath) {
  const resolved = path.resolve(anyPath);
  const checkPath = fs.existsSync(resolved)
    ? resolved
    : path.dirname(resolved);
  try {
    if (process.platform === "win32") {
      const free = getFreeBytesWindows(checkPath);
      if (free != null) return free;
    }
    return getFreeBytesUnix(checkPath);
  } catch {
    return null;
  }
}

/**
 * @returns {{ level: 'ok'|'warn'|'critical', free_bytes: number|null, free_mb: number|null, message: string, path: string }}
 */
function getDiskStatus(dbPath) {
  const p = String(dbPath || "");
  const freeBytes = getFreeBytesForPath(p);
  if (freeBytes == null) {
    return {
      level: "ok",
      free_bytes: null,
      free_mb: null,
      message: "",
      path: p,
      unknown: true,
    };
  }

  const freeMb = Math.round(freeBytes / (1024 * 1024));
  if (freeBytes < CRIT_BYTES) {
    return {
      level: "critical",
      free_bytes: freeBytes,
      free_mb: freeMb,
      message: "Disku i mbushur — lironi hapësirë",
      path: p,
    };
  }
  if (freeBytes < WARN_BYTES) {
    return {
      level: "warn",
      free_bytes: freeBytes,
      free_mb: freeMb,
      message: "Disku po mbushet — ruani backup",
      path: p,
    };
  }
  return {
    level: "ok",
    free_bytes: freeBytes,
    free_mb: freeMb,
    message: "",
    path: p,
  };
}

function blocksNewRecords(status) {
  return status && status.level === "critical";
}

module.exports = {
  WARN_BYTES,
  CRIT_BYTES,
  getDiskStatus,
  blocksNewRecords,
};
