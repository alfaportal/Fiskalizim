/**
 * fiscal/fiscal-boot.js — profil nisjeje fiskale + sinkronizim ATK nga settings.
 */
const { getLocalRunStatus } = require("./fiscal-local-env");

function envTruthy(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function readAtkUrlFromDb(database) {
  try {
    const row = database.getFiscalSettingsRow();
    return String(row?.atk_api_url || "").trim();
  } catch {
    return "";
  }
}

/**
 * Lexon atk_send_allowed / atk_auto_send nga DB ose env dhe vendos FISCAL_LOCAL_RUN.
 * Thirret pas initDatabase() dhe pas ruajtjes së cilësimeve ATK.
 */
function syncAtkTransmissionFromSettings(database) {
  const db = database || require("../database");
  let sendAllowed =
    envTruthy("BIZNES_ATK_SEND_ALLOWED") || db.getSetting("atk_send_allowed", "0") === "1";
  let autoSend = envTruthy("ATK_AUTO_SEND") || db.getSetting("atk_auto_send", "0") === "1";

  const atkUrl = readAtkUrlFromDb(db);
  const isTestHost = /fiskalizimi-test/i.test(atkUrl);

  if (sendAllowed) {
    process.env.FISCAL_LOCAL_RUN = "0";
    process.env.BIZNES_ATK_SEND_ALLOWED = "1";
    process.env.ATK_AUTO_SEND = autoSend ? "1" : "0";
    db.setSetting("atk_send_allowed", "1");
    if (autoSend) db.setSetting("atk_auto_send", "1");

    if (isTestHost) {
      process.env.ATK_TEST_MODE = "1";
      process.env.FISCAL_TEST_MODE = "1";
      db.setSetting("atk_test_mode", "1");
    } else if (process.env.ATK_TEST_MODE == null || String(process.env.ATK_TEST_MODE).trim() === "") {
      process.env.ATK_TEST_MODE = db.getSetting("atk_test_mode", "0") === "1" ? "1" : "0";
      process.env.FISCAL_TEST_MODE = process.env.ATK_TEST_MODE;
    }

    console.log(
      `[fiscal-boot] ATK HTTP=ON · auto_send=${autoSend ? "ON" : "OFF"} · env=${isTestHost ? "TEST" : "LIVE"}`
    );
    return { allowed: true, autoSend, environment: isTestHost ? "TEST" : "LIVE" };
  }

  process.env.FISCAL_LOCAL_RUN = "1";
  process.env.BIZNES_ATK_SEND_ALLOWED = "0";
  process.env.ATK_AUTO_SEND = "0";
  db.setSetting("atk_send_allowed", "0");
  if (!autoSend) db.setSetting("atk_auto_send", "0");
  console.log("[fiscal-boot] ATK HTTP=BLOCKED — modalitet lokal (asgjë te serveri ATK)");
  return { allowed: false, autoSend: false, environment: isTestHost ? "TEST" : "LIVE" };
}

function applyStartupFiscalProfile() {
  try {
    const { patchExpressListenForFiscalUi } = require("./fiscal-ui-bridge");
    patchExpressListenForFiscalUi();
  } catch (e) {
    console.warn("[fiscal-boot] fiscal-ui:", e.message || e);
  }

  if (process.env.ATK_TEST_MODE == null || String(process.env.ATK_TEST_MODE).trim() === "") {
    process.env.ATK_TEST_MODE = "0";
  }
  if (process.env.FISCAL_TEST_MODE == null || String(process.env.FISCAL_TEST_MODE).trim() === "") {
    process.env.FISCAL_TEST_MODE = process.env.ATK_TEST_MODE;
  }
}

/** Pas initDatabase — sinkronizo env me settings (mos e fshi lejen e pronarit). */
function applyLocalRunDatabaseLockdown() {
  try {
    syncAtkTransmissionFromSettings(require("../database"));
  } catch (e) {
    console.warn("[fiscal-boot] atk sync:", e.message || e);
  }
  try {
    const { resetAutoPaperBlockOnStartup } = require("./fiscal-paper-block");
    resetAutoPaperBlockOnStartup();
  } catch (e) {
    console.warn("[fiscal-boot] paper-block reset:", e.message || e);
  }
}

/**
 * Teste të brendshme pas nisjes së serverit — jo-bllokuese për UI.
 */
function scheduleStartupSelfTest(delayMs = 2500) {
  const ms = Math.max(500, Number(delayMs) || 2500);
  setTimeout(async () => {
    try {
      const { isFiscalEnabled } = require("./fiscal-config");
      if (!isFiscalEnabled()) {
        console.log("[fiscal-boot] self-test anashkaluar — fiscal OFF");
        return;
      }
      const { runFiscalSelfTest } = require("./fiscal-self-test");
      const report = await runFiscalSelfTest({ print: false });
      const s = report.summary || {};
      console.log(
        `[fiscal-boot] self-test: ${s.passed}/${s.total} OK` +
          (report.ok ? "" : " — ka dështime (shiko log)")
      );
      if (!report.ok && Array.isArray(report.results)) {
        for (const r of report.results.filter((x) => !x.pass)) {
          console.warn(`[fiscal-boot]   FAIL ${r.name}: ${r.detail || ""}`);
        }
      }
    } catch (e) {
      console.warn("[fiscal-boot] self-test:", e.message || e);
    }
  }, ms);
}

function logStartupFiscalStatus() {
  try {
    const st = getLocalRunStatus();
    console.log(
      `[fiscal-boot] ATK HTTP=${st.atk_http} | test_mode=${st.atk_test_mode} | persistence=${st.fiscal_persistence}`
    );
  } catch (e) {
    console.warn("[fiscal-boot] status:", e.message);
  }
}

module.exports = {
  applyStartupFiscalProfile,
  applyLocalRunDatabaseLockdown,
  syncAtkTransmissionFromSettings,
  scheduleStartupSelfTest,
  logStartupFiscalStatus,
};
