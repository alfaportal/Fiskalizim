"use strict";
const path = require("path");

function loadLocation(rootDir) {
  try {
    return require(path.join(rootDir, "auto-backup-location.cjs"));
  } catch {
    return require(path.join(rootDir, "scripts", "auto-backup-location.cjs"));
  }
}

/** Desktop\\Revolution Backup + shkurtore — edhe para nisjes së plotë të serverit. */
function ensureBackupHomeVisible(rootDir, opts = {}) {
  const productName = String(opts.productName || "APP");
  const loc = loadLocation(rootDir);
  const dir = loc.resolveBackupDirectory({
    projectName: productName,
    getPersistedDir: opts.getPersistedBackupDir,
  });
  return loc.ensureVisibleBackupHome({
    backupDir: dir,
    productName,
    setPersistedDir: opts.setPersistedBackupDir,
    revealExplorerOnce: opts.revealExplorerOnce !== false,
  });
}

function startDesktopAutoBackup(rootDir, opts = {}) {
  const autoBackup = require(path.join(rootDir, "auto-backup"));
  return autoBackup.startAutoBackup({
    intervalMs: 60 * 1000,
    revealBackupFolder: opts.revealBackupFolder !== false,
    ...opts,
  });
}

module.exports = {
  ensureBackupHomeVisible,
  startDesktopAutoBackup,
  loadLocation,
};
