/**
 * Pastrim vetëm i skedarëve të licencës — RREGULL ABSOLUT: userData/DB klienti NUK preken.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const LICENSE_STORAGE_REL = path.join("RevolutionInvest", "FiskalizimLicense");

const LICENSE_ARTIFACT_BASENAMES = [
  ".hw-lic",
  ".cloud-lic",
  ".cloud-activation.json",
  ".install-device-id",
  ".install-salt",
  ".hw-grace.json",
  ".hw-trial-used",
  ".hw-audit.log",
  ".lic-revoked",
  ".security-alerts-queue.json",
  ".hw-activate-attempts.json",
  ".devtools-attempts.json",
];

function appDataRoot(app) {
  try {
    return app.getPath("appData");
  } catch {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
}

function licenseStorageRoot(app) {
  return path.join(appDataRoot(app), LICENSE_STORAGE_REL);
}

function wipeLicenseArtifactsOnly(app) {
  if (!app) return;
  const licRoot = licenseStorageRoot(app);
  for (const base of LICENSE_ARTIFACT_BASENAMES) {
    try {
      const p = path.join(licRoot, base);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Emri i vjetër — tani vetëm licenca (jo userData, jo Revolution-Fiskalizim, jo ProgramData).
 * @param {object} _opts — injorohet; mbetet për API të vjetër.
 */
function factoryWipeLocalData(app, _opts = {}) {
  wipeLicenseArtifactsOnly(app);
}

function wipeDirContents(_dir) {
  return;
}

function wipePathRecursive(_target) {
  return;
}

module.exports = {
  factoryWipeLocalData,
  wipeDirContents,
  wipePathRecursive,
  licenseStorageRoot,
  wipeLicenseArtifactsOnly,
  NO_LICENSE_MESSAGE: "Ky program nuk ka licencë aktive. Kontaktoni Revolution Invest.",
};
