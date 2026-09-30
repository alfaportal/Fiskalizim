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
  return (
    cloud.isWithinCloudOfflineWindow(app) &&
    !!cloud.readStoredLicense(app) &&
    cloud.hasServerConfirmedActivation(app)
  );
}

async function isProdLicenseSatisfied(cloud, app) {
  const claimed = await cloud.claimByHardwareId(app);
  if (claimed?.valid && !claimed.offline) return true;
  const key = cloud.readStoredLicense(app);
  if (!key || !cloud.hasServerConfirmedActivation(app)) return false;
  const v = await cloud.validateLicenseOnline(key, app);
  if (v.valid && !v.offline) return true;
  if (!v.valid && !v.offline) return false;
  if (v.offline && v.code === "OK" && allowOfflineGrace(cloud, app)) return true;
  return false;
}

async function runProdLicenseDialogUntilOk(app, initialReason = "no_license") {
  const cloud = loadCloud();
  cloud.registerInstallContext(app);
  let reason = initialReason;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isProdLicenseSatisfied(cloud, app)) return true;
    const probe = await cloud.validateLicenseOnline(cloud.readStoredLicense(app), app, {
      skipHardFail: true,
    });
    reason = reasonFromValidation(probe, cloud, reason);
    const activated = await licenseGuard.promptHardwareActivation(app, { reason });
    if (!activated) return false;
    if (await isProdLicenseSatisfied(cloud, app)) return true;
    const v = await cloud.validateLicenseOnline(cloud.readStoredLicense(app), app, {
      skipHardFail: true,
    });
    reason = reasonFromValidation(v, cloud, reason);
  }
  return false;
}

module.exports = {
  loadCloud,
  isProdLicenseSatisfied,
  runProdLicenseDialogUntilOk,
  reasonFromValidation,
};
