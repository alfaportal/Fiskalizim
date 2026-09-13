/**
 * Boot licence cloud — një dialog i errët, rihapet derisa OK ose përdoruesi mbyll.
 */
const licenseGuard = require("../fiscal/license-guard");

function loadCloud() {
  return require("./cloud-license");
}

function reasonFromValidation(v, cloud, fallback = "no_license") {
  if (cloud.isRevocationCode(v?.code)) return "revoked";
  if (v?.code === "EXPIRED") return "expired";
  if (v?.code === "OFFLINE_EXPIRED") return "offline_expired";
  return fallback;
}

async function isProdLicenseSatisfied(cloud, app) {
  const claimed = await cloud.claimByHardwareId(app);
  if (claimed?.valid) return true;
  const key = cloud.readStoredLicense(app);
  if (!key) return false;
  const v = await cloud.validateLicenseOnline(key, app);
  return !!(v.valid || v.offline);
}

async function runProdLicenseDialogUntilOk(app, initialReason = "no_license") {
  const cloud = loadCloud();
  cloud.registerInstallContext(app);

  let reason = initialReason;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isProdLicenseSatisfied(cloud, app)) return true;

    const activated = await licenseGuard.promptHardwareActivation(app, { reason });
    if (!activated) return false;

    if (await isProdLicenseSatisfied(cloud, app)) return true;

    const key = cloud.readStoredLicense(app);
    const v = key ? await cloud.validateLicenseOnline(key, app) : { valid: false };
    reason = reasonFromValidation(v, cloud, "no_license");
  }
  return false;
}

module.exports = {
  loadCloud,
  isProdLicenseSatisfied,
  runProdLicenseDialogUntilOk,
  reasonFromValidation,
};
