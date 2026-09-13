/**
 * Fshirje e plotë e të dhënave lokale pas revokimit / factory reset.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const LICENSE_STORAGE_REL = path.join("RevolutionInvest", "FiskalizimLicense");
const USER_DATA_DIRNAME = "Revolution Fiskalizim";
const PROGRAMDATA_LAUNCH = path.join("RevolutionInvest", "Revolution Fiskalizim-Launch");
const ROAMING_DATA_DIR = path.join("Revolution-Fiskalizim");

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

function wipeDirContents(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    let left = 0;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        left += 1;
      }
    }
    if (left === 0) return;
  }
}

function wipePathRecursive(target) {
  if (!target || !fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    wipeDirContents(target);
  }
}

function wipeProgramDataLaunchStub() {
  try {
    const pd = process.env.PROGRAMDATA || "";
    if (!pd) return;
    wipePathRecursive(path.join(pd, PROGRAMDATA_LAUNCH));
  } catch {
    /* ignore */
  }
}

function wipeBiznesDataDir() {
  try {
    const roaming = appDataRoot(null);
    wipePathRecursive(path.join(roaming, ROAMING_DATA_DIR));
  } catch {
    /* ignore */
  }
}

/**
 * Fshi krejt memorie lokale — si instalim i parë.
 * @param {object} opts
 * @param {boolean} opts.wipeLicenseDir — fshi krejt FiskalizimLicense (salt, device-id, licenca)
 */
function factoryWipeLocalData(app, { wipeLicenseDir = true } = {}) {
  if (!app) return;

  const licRoot = licenseStorageRoot(app);

  if (wipeLicenseDir) {
    wipePathRecursive(licRoot);
  } else {
    const licenseFiles = [
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
    for (const base of licenseFiles) {
      try {
        const p = path.join(licRoot, base);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }

  wipeBiznesDataDir();

  try {
    const ud = app.getPath("userData");
    wipePathRecursive(ud);
    fs.mkdirSync(ud, { recursive: true });
  } catch {
    /* ignore */
  }

  try {
    const local = process.env.LOCALAPPDATA || "";
    if (local) {
      wipePathRecursive(path.join(local, USER_DATA_DIRNAME));
    }
  } catch {
    /* ignore */
  }

  wipeProgramDataLaunchStub();
}

module.exports = {
  factoryWipeLocalData,
  wipeDirContents,
  wipePathRecursive,
  licenseStorageRoot,
  NO_LICENSE_MESSAGE: "Ky program nuk ka licencë aktive. Kontaktoni Revolution Invest.",
};
