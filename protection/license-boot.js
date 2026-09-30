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
  if (v?.code === "OFFLINE_NEED_ACTIVATION") return "no_license";
  return fallback;
}

function allowOfflineGrace(cloud, app) {
  return cloud.isWithinCloudOfflineWindow(app) && !!cloud.readStoredLicense(app);
}

async function isProdLicenseSatisfied(cloud, app) {
  const claimed = await cloud.claimByHardwareId(app);
  if (claimed?.valid) return true;
  const key = cloud.readStoredLicense(app);
  if (!key) return false;
  const v = await cloud.validateLicenseOnline(key, app);
  if (v.valid) return true;
  if (v.offline && allowOfflineGrace(cloud, app)) return true;
  return false;
}

async function runProdLicenseDialogUntilOk(app, initialReason = "no_license") {
  const cloud = loadCloud();
  cloud.registerInstallContext(app);
  if (await isProdLicenseSatisfied(cloud, app)) return true;
  const activated = await licenseGuard.promptHardwareActivation(app, { reason: initialReason });
  return !!activated;
}

module.exports = {
  loadCloud,
  isProdLicenseSatisfied,
  runProdLicenseDialogUntilOk,
  reasonFromValidation,
};
