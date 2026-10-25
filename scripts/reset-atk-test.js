/**
 * Reset ATK test data — fshin kuponët / audit / pending, rivendos numrat nga 1,
 * fik dërgimin automatik. NUK prek certifikatën / NUI / URL ATK.
 *
 *   node scripts/reset-atk-test.js
 */
const path = require("path");

async function main() {
  const db = require(path.join(__dirname, "..", "database"));
  await db.initDatabase();
  const { resetFiscalTestData } = require(path.join(__dirname, "..", "fiscal", "fiscal-db"));
  const result = resetFiscalTestData();

  const settings = db.getFiscalSettingsRow();
  console.log("[reset-atk-test] OK");
  console.log(JSON.stringify(result, null, 2));
  console.log("[reset-atk-test] fiscal_enabled =", settings.fiscal_enabled);
  console.log("[reset-atk-test] atk_api_url    =", settings.atk_api_url);
  console.log("[reset-atk-test] taxpayer_nui   =", settings.taxpayer_nui);
  console.log("[reset-atk-test] certificate    =", settings.certificate_path || "(default)");
  console.log("[reset-atk-test] private_key    =", settings.private_key_path || "(default)");
  console.log("[reset-atk-test] atk_auto_send  =", db.getSetting("atk_auto_send"));
  console.log("[reset-atk-test] next coupon will be daily=1, total=1");
  process.exit(0);
}

main().catch((e) => {
  console.error("[reset-atk-test] FAIL:", e.message || e);
  process.exit(1);
});
