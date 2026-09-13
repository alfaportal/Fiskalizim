/**
 * fiscal/fiscal-offline-compliance.js
 * Procedurat e brendshme për Neni 44.5 (48 orë) dhe Neni 44.6 (ditë 10 e muajit vijues).
 * Gjeneron raport, audit log, dhe gjendje për UI — pa prekur WRITE-ONCE të kuponëve.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { logFiscalAction } = require("./fiscal-audit");
const { getTimeSyncStatus } = require("./fiscal-time-sync");
const { getSefIdentifier } = require("./fiscal-numbering");

const HOURS_48 = 48;
const DAY10_DEADLINE = 10;
const COMPLIANCE_MONITOR_MS = 60 * 1000;

const SETTING_KEYS = Object.freeze({
  h48_triggered: "offline_comp_48h_triggered_at",
  h48_report: "offline_comp_48h_report_path",
  h48_ack_at: "offline_comp_48h_ack_at",
  h48_ack_by: "offline_comp_48h_ack_by",
  d10_triggered: "offline_comp_day10_triggered_at",
  d10_report: "offline_comp_day10_report_path",
  d10_ack_at: "offline_comp_day10_ack_at",
  d10_ack_by: "offline_comp_day10_ack_by",
});

const ATK_CONTACT = Object.freeze({
  web: "https://www.atk-ks.org",
  sef_app: "https://apps.atk-ks.org/sefaplikimi",
  note_sq:
    "Njoftoni ATK-në elektronikisht ose personalisht në zyrën ku jeni të regjistruar, sipas Udhëzimit MF 01/2026.",
  note_day10_sq:
    "Paraqitni të gjithë kuponët e pafiskalizuar te ATK, sipas Udhëzimit MF 01/2026.",
});

let _complianceTimer = null;

function getDb() {
  return require("../database");
}

function getSqlite() {
  const database = getDb();
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function getSetting(key, fallback = null) {
  try {
    return getDb().getSetting(key, fallback);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  getDb().setSetting(key, value);
}

function clearSetting(key) {
  try {
    getSqlite().prepare(`DELETE FROM settings WHERE key = ?`).run(String(key));
  } catch {
    /* ignore */
  }
}

function getDocumentsDir() {
  const home = os.homedir();
  for (const name of ["Documents", "Dokumentet"]) {
    const dir = path.join(home, name);
    if (fs.existsSync(dir)) return dir;
  }
  const docs = path.join(home, "Documents");
  fs.mkdirSync(docs, { recursive: true });
  return docs;
}

function parseCreatedAt(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function listPendingReceipts() {
  const sqlite = getSqlite();
  return sqlite
    .prepare(
      `SELECT id, nuikf, created_at, is_offline, total_amount, fiscal_date, fiscal_time,
              receipt_type, sent_to_atk
       FROM fiscal_receipts
       WHERE sent_to_atk = 0
       ORDER BY id ASC`
    )
    .all();
}

function getOldestPendingMeta(pending) {
  const rows = Array.isArray(pending) ? pending : listPendingReceipts();
  if (!rows.length) {
    return {
      count: 0,
      oldest_at: null,
      oldest_hours: 0,
      oldest_month: null,
    };
  }
  let oldest = null;
  for (const r of rows) {
    const d = parseCreatedAt(r.created_at);
    if (!d) continue;
    if (!oldest || d.getTime() < oldest.getTime()) oldest = d;
  }
  if (!oldest) {
    return {
      count: rows.length,
      oldest_at: null,
      oldest_hours: 0,
      oldest_month: null,
    };
  }
  const hours = (Date.now() - oldest.getTime()) / (1000 * 60 * 60);
  return {
    count: rows.length,
    oldest_at: oldest.toISOString(),
    oldest_hours: Math.round(hours * 10) / 10,
    oldest_month: `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, "0")}`,
  };
}

function getOfflineAnchorHours() {
  const ts = getTimeSyncStatus();
  const anchor = ts?.offline_anchor_utc ? new Date(ts.offline_anchor_utc) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) return 0;
  return Math.round(((Date.now() - anchor.getTime()) / (1000 * 60 * 60)) * 10) / 10;
}

/**
 * Neni 44.6: ndërprerja në muajin M, afati ditë 10 e muajit M+1.
 * Kthyer true kur jemi pas ditës 10 (d.m.th. ditë 11+ ose pas datës 10 nëse s'ka lidhje).
 */
function isPastDay10AfterOfflineMonth(oldestPendingDate) {
  if (!oldestPendingDate) return false;
  const start = parseCreatedAt(oldestPendingDate);
  if (!start) return false;

  const now = new Date();
  let deadlineYear = start.getFullYear();
  let deadlineMonth = start.getMonth() + 1; // 0-based → +1 = next month index
  if (deadlineMonth > 11) {
    deadlineMonth = 0;
    deadlineYear += 1;
  }
  const deadline = new Date(deadlineYear, deadlineMonth, DAY10_DEADLINE, 23, 59, 59, 999);
  return now.getTime() > deadline.getTime();
}

function buildReportPayload(type, pending, meta) {
  const settings = getFiscalSettings();
  const sefId = getSefIdentifier() || "";
  const timeSync = getTimeSyncStatus();
  const rows = (pending || []).map((r) => ({
    id: r.id,
    nuikf: r.nuikf,
    created_at: r.created_at,
    fiscal_date: r.fiscal_date,
    fiscal_time: r.fiscal_time,
    total_amount: r.total_amount,
    is_offline: !!Number(r.is_offline),
    receipt_type: r.receipt_type,
  }));

  const totalAmount = rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);

  return {
    report_type: type,
    generated_at: new Date().toISOString(),
    legal_basis:
      type === "day10"
        ? "Udhëzim Administrativ MF 01/2026"
        : "Udhëzim Administrativ MF 01/2026",
    business: {
      nui: settings.taxpayer_nui || "",
      name: settings.taxpayer_legal_name || "",
      sef_id: sefId,
      address: settings.taxpayer_address || "",
    },
    offline: {
      anchor_utc: timeSync?.offline_anchor_utc || null,
      anchor_hours: getOfflineAnchorHours(),
      oldest_pending_at: meta.oldest_at,
      oldest_pending_hours: meta.oldest_hours,
      pending_count: meta.count,
    },
    pending_receipts: rows,
    pending_total_amount: Math.round(totalAmount * 100) / 100,
    operator_instructions:
      type === "day10"
        ? [
            ATK_CONTACT.note_day10_sq,
            "1. Eksportoni/printoni këtë raport dhe listën e kuponëve.",
            "2. Paraqitni kuponët e pafiskalizuar te ATK (zyra e regjistrimit ose kanali zyrtar).",
            "3. Pas dorëzimit, rivendosni lidhjen dhe dërgoni kuponët te SIATK kur të jetë e mundur.",
            "4. Klikoni «Konfirmo — e njoftova / e dorëzova ATK-së» në program.",
          ]
        : [
            ATK_CONTACT.note_sq,
            "1. Provoni të rivendosni internetin dhe dërgoni kuponët në pritje.",
            "2. Nëse nuk mundet brenda 48 orëve, njoftoni ATK-në me këtë raport.",
            "3. Ruani provat (fatura ISP, foto, etj.) sipas nevojës.",
            "4. Klikoni «Konfirmo — e njoftova ATK-në» pas njoftimit.",
          ],
    atk_links: ATK_CONTACT,
  };
}

function writeReportFile(type, payload) {
  const dir = path.join(getDocumentsDir(), "Revolution-SEF-ATK");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = ymdLocal(new Date()).replace(/-/g, "");
  const time = String(new Date().toTimeString().slice(0, 8)).replace(/:/g, "");
  const fname = `ATK-offline-${type}-${stamp}-${time}.json`;
  const full = path.join(dir, fname);
  fs.writeFileSync(full, JSON.stringify(payload, null, 2), "utf8");
  return full;
}

function logComplianceOnce(type, payload, reportPath) {
  const action = type === "day10" ? "offline_deadline_day10" : "offline_deadline_48h";
  try {
    logFiscalAction(
      action,
      {
        report_path: reportPath,
        pending_count: payload.offline.pending_count,
        oldest_hours: payload.offline.oldest_pending_hours,
        legal_basis: payload.legal_basis,
      },
      "SYSTEM",
      "COMPLIANCE"
    );
  } catch (e) {
    console.warn("[fiscal-offline-compliance] audit:", e.message);
  }
}

function triggerIfNeeded(type, pending, meta) {
  const triggeredKey =
    type === "day10" ? SETTING_KEYS.d10_triggered : SETTING_KEYS.h48_triggered;
  const reportKey = type === "day10" ? SETTING_KEYS.d10_report : SETTING_KEYS.h48_report;

  if (!getSetting(triggeredKey)) {
    const payload = buildReportPayload(type, pending, meta);
    const reportPath = writeReportFile(type, payload);
    setSetting(triggeredKey, new Date().toISOString());
    setSetting(reportKey, reportPath);
    clearSetting(type === "day10" ? SETTING_KEYS.d10_ack_at : SETTING_KEYS.h48_ack_at);
    clearSetting(type === "day10" ? SETTING_KEYS.d10_ack_by : SETTING_KEYS.h48_ack_by);
    logComplianceOnce(type, payload, reportPath);
    console.warn(
      `[fiscal-offline-compliance] ${type.toUpperCase()} — raporti: ${reportPath}`
    );
  }
}

function clearResolvedFlags() {
  for (const k of Object.values(SETTING_KEYS)) {
    clearSetting(k);
  }
}

/**
 * Vlerëson gjendjen aktuale të pajtueshmërisë offline (pa side-effects).
 */
function evaluateOfflineCompliance() {
  if (!isFiscalEnabled()) return null;

  const pending = listPendingReceipts();
  const meta = getOldestPendingMeta(pending);
  const anchorHours = getOfflineAnchorHours();

  const breach48h =
    meta.count > 0 &&
    (meta.oldest_hours > HOURS_48 || (anchorHours > HOURS_48 && anchorHours > 0));

  const breachDay10 =
    meta.count > 0 &&
    isPastDay10AfterOfflineMonth(meta.oldest_at);

  const h48Triggered = !!getSetting(SETTING_KEYS.h48_triggered);
  const d10Triggered = !!getSetting(SETTING_KEYS.d10_triggered);
  const h48Ack = getSetting(SETTING_KEYS.h48_ack_at);
  const d10Ack = getSetting(SETTING_KEYS.d10_ack_at);

  let level = "ok";
  let message = null;
  if (breachDay10 || d10Triggered) {
    level = "critical";
    message =
      "AFATI DITË 10 — paraqitni kuponët e pafiskalizuar te ATK";
  } else if (breach48h || h48Triggered) {
    level = "urgent";
    message = "48 ORË — njoftoni ATK-në për ndërprerjen e lidhjes";
  } else if (meta.count > 0 && meta.oldest_hours > 24) {
    level = "warning";
    message = `Kujdes: ${Math.floor(meta.oldest_hours)} orë pa dërguar kuponë (limiti 48h)`;
  } else if (meta.count > 0) {
    level = "info";
    message = `${meta.count} kupon(ë) në pritje për dërgim te SIATK`;
  }

  return {
    enabled: true,
    pending_count: meta.count,
    oldest_pending_at: meta.oldest_at,
    oldest_pending_hours: meta.oldest_hours,
    offline_anchor_hours: anchorHours,
    breach_48h: breach48h,
    breach_day10: breachDay10,
    deadline_48h: {
      active: breach48h || h48Triggered,
      triggered_at: getSetting(SETTING_KEYS.h48_triggered),
      report_path: getSetting(SETTING_KEYS.h48_report),
      acknowledged_at: h48Ack,
      acknowledged_by: getSetting(SETTING_KEYS.h48_ack_by),
      needs_ack: (breach48h || h48Triggered) && !h48Ack,
    },
    deadline_day10: {
      active: breachDay10 || d10Triggered,
      triggered_at: getSetting(SETTING_KEYS.d10_triggered),
      report_path: getSetting(SETTING_KEYS.d10_report),
      acknowledged_at: d10Ack,
      acknowledged_by: getSetting(SETTING_KEYS.d10_ack_by),
      needs_ack: (breachDay10 || d10Triggered) && !d10Ack,
    },
    level,
    message,
    instructions: ATK_CONTACT,
  };
}

/**
 * Tick periodik — gjeneron raport një herë për afat, pastron kur radha zbrazet.
 */
function runOfflineComplianceTick() {
  if (!isFiscalEnabled()) return null;

  const pending = listPendingReceipts();
  const meta = getOldestPendingMeta(pending);

  if (!meta.count) {
    clearResolvedFlags();
    return evaluateOfflineCompliance();
  }

  const breach48h =
    meta.oldest_hours > HOURS_48 ||
    (getOfflineAnchorHours() > HOURS_48 && getOfflineAnchorHours() > 0);

  if (breach48h) {
    triggerIfNeeded("48h", pending, meta);
  }

  if (isPastDay10AfterOfflineMonth(meta.oldest_at)) {
    triggerIfNeeded("day10", pending, meta);
  }

  return evaluateOfflineCompliance();
}

function acknowledgeOfflineCompliance(type, operatorName, notes) {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }
  const t = String(type || "").toLowerCase();
  if (t !== "48h" && t !== "day10") {
    throw new Error('type duhet të jetë "48h" ose "day10"');
  }
  const name = String(operatorName || "Operator").trim() || "Operator";
  const now = new Date().toISOString();

  if (t === "48h") {
    setSetting(SETTING_KEYS.h48_ack_at, now);
    setSetting(SETTING_KEYS.h48_ack_by, name);
  } else {
    setSetting(SETTING_KEYS.d10_ack_at, now);
    setSetting(SETTING_KEYS.d10_ack_by, name);
  }

  try {
    logFiscalAction(
      "atk_notification_ack",
      {
        compliance_type: t,
        notes: String(notes || "").slice(0, 500),
        acknowledged_at: now,
      },
      name,
      "OPERATOR"
    );
  } catch (e) {
    console.warn("[fiscal-offline-compliance] ack audit:", e.message);
  }

  return evaluateOfflineCompliance();
}

function exportOfflineComplianceReport(type) {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }
  const t = String(type || "").toLowerCase();
  if (t !== "48h" && t !== "day10") {
    throw new Error('type duhet të jetë "48h" ose "day10"');
  }
  const pending = listPendingReceipts();
  const meta = getOldestPendingMeta(pending);
  const payload = buildReportPayload(t, pending, meta);
  const reportPath = writeReportFile(t, payload);
  if (t === "48h") {
    setSetting(SETTING_KEYS.h48_report, reportPath);
  } else {
    setSetting(SETTING_KEYS.d10_report, reportPath);
  }
  return { report_path: reportPath, payload };
}

function startOfflineComplianceMonitor() {
  if (!isFiscalEnabled()) return false;
  if (_complianceTimer) return true;

  console.log("[fiscal-offline-compliance] monitor nisur (60s)");
  runOfflineComplianceTick();
  _complianceTimer = setInterval(() => {
    if (!isFiscalEnabled()) return;
    try {
      runOfflineComplianceTick();
    } catch (e) {
      console.warn("[fiscal-offline-compliance] tick:", e.message);
    }
  }, COMPLIANCE_MONITOR_MS);

  if (typeof _complianceTimer.unref === "function") {
    _complianceTimer.unref();
  }
  return true;
}

function stopOfflineComplianceMonitor() {
  if (_complianceTimer) {
    clearInterval(_complianceTimer);
    _complianceTimer = null;
  }
}

module.exports = {
  evaluateOfflineCompliance,
  runOfflineComplianceTick,
  acknowledgeOfflineCompliance,
  exportOfflineComplianceReport,
  startOfflineComplianceMonitor,
  stopOfflineComplianceMonitor,
  HOURS_48,
  DAY10_DEADLINE,
};
