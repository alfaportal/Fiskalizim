/**
 * fiscal/fiscal-ui-status.js — kontrata e UI për statusin ATK (modalitet lokal vs live).
 * Burimi i vetëm i së vërtetës për pill, mesazhe dhe çaktivizimin e dërgimit.
 */
const path = require("path");
const { isAtkTransmissionBlocked } = require("./fiscal-test-mode-store");
const { isFiscalLocalRun } = require("./fiscal-local-env");

function getAppVersion() {
  try {
    return String(require(path.join(__dirname, "..", "package.json")).version || "0.0.0").trim();
  } catch {
    return "0.0.0";
  }
}

function buildFiscalUiStatus(atkBase = {}) {
  const blocked = isAtkTransmissionBlocked();
  const localRun = isFiscalLocalRun();
  let autoSendEffective = false;
  if (!blocked) {
    const { isAtkAutoSendEnabled } = require("./fiscal-offline");
    autoSendEffective = isAtkAutoSendEnabled();
  }
  const env = String(atkBase.environment || "TEST");

  const pillText = blocked ? "ATK: LOKAL (pa dërgim)" : `ATK: ${env}`;
  const pillClass = blocked ? "warn" : env === "TEST" || env === "PROD" ? "ok" : "warn";

  const blockedMessage =
    "Transmetimi HTTP te ATK: BLLLOKUAR — asnjë kupon nuk dërgohet te serveri ATK. " +
    "Printimi dhe fiskalizimi lokal funksionojnë.";

  const autoHintHtml = blocked
    ? 'Modalitet <strong style="color:#f0a030">LOKAL</strong> — dërgimi automatik dhe manual te ATK është <strong>i çaktivizuar</strong>. Asnjë kupon nuk shkon te ATK.'
    : autoSendEffective
      ? 'Dërgimi automatik te ATK është <strong style="color:#3dd68c">ON</strong>. Pas printit, kuponi dërgohet te ATK.'
      : 'Dërgimi automatik te ATK është <strong>OFF</strong>. Kuponët ruhen lokalisht; dërgoji manualisht me butonin «Dërgo kuponët në pritje te ATK».';

  const footerMessage = blocked
    ? `STATUS: LOKAL\nATK HTTP: BLLLOKUAR · Auto-send: OFF · Mjedisi (konfig): ${env}\nAsnjë kupon nuk shkon te serveri ATK.`
    : atkBase.ready_for_atk
      ? `STATUS: MIRE\nGati për ATK: PO · Auto-send: ${autoSendEffective ? "ON" : "OFF"} · Mjedisi: ${env}`
      : "STATUS: GABIM / JO GATI\nBëni onboarding («Lidhu me ATK») dhe plotësoni Application ID para dërgimit të kuponëve.";

  const appVersion = getAppVersion();
  const headerBadge = blocked
    ? `Revolution Invest SH.P.K. · LOKAL (pa ATK) · v${appVersion}`
    : `Revolution Invest SH.P.K. · ATK ${env} · v${appVersion}`;

  const statusLines = blocked
    ? [
        blockedMessage,
        `Mjedisi (vetëm konfigurim): ${env} → ${atkBase.atk_pos_coupon_url || "—"}`,
        `NUI: ${atkBase.taxpayer_nui || "—"} · SEF ID: ${atkBase.sef_identifier || "—"}`,
        "Gati për dërgim te ATK: JO — HTTP i bllokuar (modalitet lokal)",
      ]
    : [
        `Mjedisi: ${env} → ${atkBase.atk_pos_coupon_url || "—"}`,
        `NUI: ${atkBase.taxpayer_nui || "—"} · SEF ID: ${atkBase.sef_identifier || "—"}`,
        `Gati për dërgim te ATK: ${atkBase.ready_for_atk ? "PO" : "JO — bëni onboarding («Lidhu me ATK») dhe plotësoni fushat"}`,
      ];

  return {
    blocked,
    local_run: localRun,
    pill_text: pillText,
    pill_class: pillClass,
    header_badge: headerBadge,
    blocked_message: blockedMessage,
    auto_send_enabled: autoSendEffective,
    auto_send_checked: autoSendEffective,
    auto_send_disabled: blocked,
    send_pending_disabled: blocked,
    send_pending_hidden: blocked,
    auto_hint_html: autoHintHtml,
    footer_message: footerMessage,
    footer_ok: blocked ? true : !!atkBase.ready_for_atk,
    status_lines: statusLines,
    status_ok: blocked ? true : !!atkBase.ready_for_atk,
    ready_for_atk_display: blocked ? false : !!atkBase.ready_for_atk,
  };
}

module.exports = {
  buildFiscalUiStatus,
};
