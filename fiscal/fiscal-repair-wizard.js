/**
 * fiscal/fiscal-repair-wizard.js — udhëzues i unifikuar për riparimin e SEF-it (48h).
 */
const { isFiscalEnabled } = require("./fiscal-config");
const { getPaperBlockStatus, HOURS_48 } = require("./fiscal-paper-block");
const { getOfflineStatus } = require("./fiscal-offline");
const { runWizardStepAtk, runWizardStepDb } = require("./fiscal-self-test");
const { logFiscalAction } = require("./fiscal-audit");

function getRepairDeadlineInfo() {
  const paper = getPaperBlockStatus();
  if (paper && paper.active) {
    return {
      hours_total: HOURS_48,
      hours_remaining: paper.restore_deadline_hours,
      hours_elapsed: paper.hours_since_failure,
      past_deadline: !!paper.past_restore_48h,
      started_at: paper.started_at,
      source: "paper_block",
      message: paper.message,
      level: paper.level,
    };
  }

  const offline = getOfflineStatus();
  let hoursRemaining = HOURS_48;
  let pastDeadline = false;
  let startedAt = null;
  if (offline && offline.oldest_pending_at) {
    const h = Number(offline.oldest_hours) || 0;
    hoursRemaining = Math.max(0, Math.round((HOURS_48 - h) * 10) / 10);
    pastDeadline = h > HOURS_48;
    startedAt = offline.oldest_pending_at;
  }

  return {
    hours_total: HOURS_48,
    hours_remaining: hoursRemaining,
    hours_elapsed:
      offline && offline.oldest_hours != null
        ? Math.round(Number(offline.oldest_hours) * 10) / 10
        : 0,
    past_deadline: pastDeadline,
    started_at: startedAt,
    source: offline?.pending_count ? "offline_queue" : "none",
    message: null,
    level: pastDeadline ? "urgent" : "ok",
  };
}

function getRepairWizardContext() {
  if (!isFiscalEnabled()) {
    return {
      ok: false,
      error: "Fiskalizimi nuk është aktiv",
      deadline: null,
      offline_queue_count: 0,
    };
  }

  const deadline = getRepairDeadlineInfo();
  const offline = getOfflineStatus();
  const paper = getPaperBlockStatus();

  return {
    ok: true,
    deadline,
    offline_queue_count: Number(offline?.offline_queue_count) || 0,
    pending_count: Number(offline?.pending_count) || 0,
    paper_block_active: !!(paper && paper.active),
    paper_block_pending: Number(paper?.pending_count) || 0,
    steps: [
      { id: 1, title: "Kontrollo lidhjen me ATK" },
      { id: 2, title: "Kontrollo databazën" },
      { id: 3, title: "Dërgo kuponët offline" },
      { id: 4, title: "Kthe nga backup" },
      { id: 5, title: "Konfirmo riparimin" },
    ],
  };
}

async function runRepairWizardStep(step, opts = {}) {
  const n = Number(step);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    throw new Error("Hapi i pavlefshëm");
  }
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }

  const operatorName = String(opts.operator_name || "Operator").trim() || "Operator";
  const operatorId = String(opts.operator_id || "POS").trim() || "POS";

  if (n === 1) {
    const result = await runWizardStepAtk();
    try {
      logFiscalAction(
        "repair_wizard",
        { phase: "step", step: 1, ok: result.ok, status: result.status },
        operatorName,
        operatorId
      );
    } catch {
      /* */
    }
    return { step: 1, ...result };
  }

  if (n === 2) {
    const result = runWizardStepDb();
    try {
      logFiscalAction(
        "repair_wizard",
        { phase: "step", step: 2, ok: result.ok, status: result.status },
        operatorName,
        operatorId
      );
    } catch {
      /* */
    }
    return { step: 2, ...result };
  }

  if (n === 3) {
    const { isAtkTransmissionBlocked } = require("./fiscal-test-mode-store");
    if (isAtkTransmissionBlocked()) {
      return {
        step: 3,
        ok: false,
        status: "Problem",
        skipped: false,
        detail: "Modalitet lokal — dërgimi te ATK është i çaktivizuar te Cilësimet SEF.",
        sent: 0,
        failed: 0,
        pending_before: getOfflineStatus()?.pending_count || 0,
      };
    }
    const before = getOfflineStatus();
    const pendingBefore = Number(before?.pending_count) || 0;
    if (pendingBefore === 0) {
      return {
        step: 3,
        ok: true,
        status: "OK",
        skipped: true,
        detail: "Nuk ka kuponë në radhë offline.",
        sent: 0,
        failed: 0,
        pending_before: 0,
      };
    }
    const { processOfflineQueue } = require("./fiscal-offline");
    const flush = await processOfflineQueue({ manual: true });
    const after = getOfflineStatus();
    const sent = Number(flush?.sent) || 0;
    const failed = Number(flush?.failed) || 0;
    const ok = failed === 0 && sent >= 0;
    const result = {
      step: 3,
      ok,
      status: ok && sent > 0 ? "OK" : sent === 0 && failed > 0 ? "Problem" : ok ? "OK" : "Problem",
      skipped: false,
      detail: `Dërguar: ${sent}, dështuar: ${failed}, mbeten: ${Number(after?.pending_count) || 0}`,
      sent,
      failed,
      pending_before: pendingBefore,
      pending_after: Number(after?.pending_count) || 0,
      flush,
    };
    try {
      logFiscalAction(
        "repair_wizard",
        { phase: "step", step: 3, ok: result.ok, sent, failed },
        operatorName,
        operatorId
      );
    } catch {
      /* */
    }
    return result;
  }

  if (n === 4) {
    return {
      step: 4,
      ok: null,
      status: "Manual",
      detail:
        "Përdorni butonin «Hap rikthimin nga backup» për të zgjedhur folderin e backup-it. Pas rikthimit, rinisni programin.",
      manual: true,
    };
  }

  const steps = opts.step_results && typeof opts.step_results === "object" ? opts.step_results : {};
  const deadline = getRepairDeadlineInfo();
  const offline = getOfflineStatus();
  const atkOk = steps[1]?.ok === true;
  const dbOk = steps[2]?.ok === true;
  const sent = Number(steps[3]?.sent) || 0;
  const restoreDone = steps[4]?.restore_done === true;

  const summary = {
    step: 5,
    ok: atkOk && dbOk && !deadline.past_deadline,
    atk_connection: atkOk ? "OK" : "Problem",
    database: dbOk ? "OK" : "Problem",
    coupons_sent: sent,
    offline_remaining: Number(offline?.pending_count) || 0,
    restore_from_backup: restoreDone ? "Po" : "Jo",
    past_48h_deadline: !!deadline.past_deadline,
    hours_remaining: deadline.hours_remaining,
    hours_total: deadline.hours_total,
    detail: [
      `Lidhja ATK: ${atkOk ? "OK" : "Problem"}`,
      `Databaza: ${dbOk ? "OK" : "Problem"}`,
      `Kuponë të dërguar: ${sent}`,
      `Në radhë offline: ${Number(offline?.pending_count) || 0}`,
      `Afati 48h: ${deadline.past_deadline ? "TEJKALUAR" : `~${deadline.hours_remaining}h mbeten`}`,
      restoreDone ? "Rikthim nga backup: u krye" : "Rikthim nga backup: jo",
    ].join("\n"),
  };

  try {
    logFiscalAction(
      "repair_wizard",
      {
        phase: "complete",
        ok: summary.ok,
        atk_connection: summary.atk_connection,
        database: summary.database,
        coupons_sent: summary.coupons_sent,
        past_48h: summary.past_48h_deadline,
      },
      operatorName,
      operatorId
    );
  } catch {
    /* */
  }

  return summary;
}

module.exports = {
  HOURS_48,
  getRepairDeadlineInfo,
  getRepairWizardContext,
  runRepairWizardStep,
};
