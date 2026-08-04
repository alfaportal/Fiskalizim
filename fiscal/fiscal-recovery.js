/**
 * fiscal-recovery.js — Neni 11 / pika 7: rikuperim pas ndërprerjes (mungesë rryme).
 * Checkpoint në pending_txn midis hapave kritikë; pa dublikim kuponësh.
 */
const { isFiscalEnabled } = require("./fiscal-config");

const STAGES = Object.freeze({
  STARTED: "started",
  COUPON_READY: "coupon_ready",
  PRINTING: "printing",
  DONE: "done",
  ABANDONED: "abandoned",
});

const STATUS = Object.freeze({
  OPEN: "open",
  DONE: "done",
  ABANDONED: "abandoned",
});

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ensurePendingTxnTable(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pending_txn (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      fiscal_receipt_id INTEGER,
      nuikf TEXT,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      print_text TEXT,
      last_printed_line TEXT,
      operator_name TEXT,
      operator_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  try {
    sqlite.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_txn_open ON pending_txn(status, stage)`
    );
  } catch {
    /* */
  }
}

function nowLocal() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function extractLastPrintedLine(printText) {
  const lines = String(printText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\^[A-Z]+/, "").trim())
    .filter((l) => l.length > 0 && !/^[=-]{3,}$/.test(l));
  return lines.length ? lines[lines.length - 1] : "";
}

function powerLossLabel() {
  try {
    const { t, syncLanguageFromSettings } = require("./fiscal-i18n");
    syncLanguageFromSettings();
    return String(t("power_loss") || "MUNGESË RRYME").trim() || "MUNGESË RRYME";
  } catch {
    return "MUNGESË RRYME";
  }
}

/**
 * Tekst rikuperimi: rreshti special + përsëritja e rreshtit të fundit + kuponi.
 */
function buildRecoveryPrintText(originalText, lastPrintedLine) {
  const w = 42;
  const line = "=".repeat(w);
  const label = powerLossLabel();
  const last = String(lastPrintedLine || extractLastPrintedLine(originalText) || "").trim();
  const head = [
    line,
    `^C^B*** ${label} ***`,
    last ? String(last) : "",
    line,
    "",
  ]
    .filter((x, i, arr) => !(x === "" && arr[i - 1] === ""))
    .join("\n");
  return `${head}\n${String(originalText || "")}`;
}

function beginPending({ orderId, operatorName, operatorId }) {
  if (!isFiscalEnabled()) return null;
  const sqlite = getSqlite();
  ensurePendingTxnTable(sqlite);

  // Mbyll pending të vjetra të hapura për të njëjtën porosi
  sqlite
    .prepare(
      `UPDATE pending_txn SET status = ?, stage = ?, updated_at = ?
       WHERE order_id = ? AND status = ?`
    )
    .run(STATUS.ABANDONED, STAGES.ABANDONED, nowLocal(), Number(orderId), STATUS.OPEN);

  const result = sqlite
    .prepare(
      `INSERT INTO pending_txn
         (order_id, stage, status, operator_name, operator_id, details_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(orderId) || null,
      STAGES.STARTED,
      STATUS.OPEN,
      operatorName != null ? String(operatorName) : null,
      operatorId != null ? String(operatorId) : null,
      JSON.stringify({ checkpoint: "before_coupon" }),
      nowLocal(),
      nowLocal()
    );
  return Number(result.lastInsertRowid);
}

function updatePending(pendingId, patch) {
  if (!pendingId) return;
  const sqlite = getSqlite();
  ensurePendingTxnTable(sqlite);
  const row = sqlite.prepare(`SELECT * FROM pending_txn WHERE id = ?`).get(Number(pendingId));
  if (!row || row.status !== STATUS.OPEN) return;

  const stage = patch.stage != null ? String(patch.stage) : row.stage;
  const status = patch.status != null ? String(patch.status) : row.status;
  let details = {};
  try {
    details = JSON.parse(row.details_json || "{}");
  } catch {
    details = {};
  }
  if (patch.details && typeof patch.details === "object") {
    details = { ...details, ...patch.details };
  }

  sqlite
    .prepare(
      `UPDATE pending_txn SET
         stage = ?,
         status = ?,
         fiscal_receipt_id = COALESCE(?, fiscal_receipt_id),
         nuikf = COALESCE(?, nuikf),
         print_text = COALESCE(?, print_text),
         last_printed_line = COALESCE(?, last_printed_line),
         details_json = ?,
         updated_at = ?
       WHERE id = ?`
    )
    .run(
      stage,
      status,
      patch.fiscal_receipt_id != null ? Number(patch.fiscal_receipt_id) : null,
      patch.nuikf != null ? String(patch.nuikf) : null,
      patch.print_text != null ? String(patch.print_text) : null,
      patch.last_printed_line != null ? String(patch.last_printed_line) : null,
      JSON.stringify(details),
      nowLocal(),
      Number(pendingId)
    );
}

function markCouponReady(pendingId, { fiscalReceiptId, nuikf, printText }) {
  const last = extractLastPrintedLine(printText);
  updatePending(pendingId, {
    stage: STAGES.COUPON_READY,
    fiscal_receipt_id: fiscalReceiptId,
    nuikf,
    print_text: printText,
    last_printed_line: last,
    details: { checkpoint: "coupon_created_before_print" },
  });
}

function markPrinting(pendingId) {
  updatePending(pendingId, {
    stage: STAGES.PRINTING,
    details: { checkpoint: "print_started" },
  });
}

function markDone(pendingId, extra) {
  updatePending(pendingId, {
    stage: STAGES.DONE,
    status: STATUS.DONE,
    details: { checkpoint: "completed", ...(extra || {}) },
  });
}

function abandonPending(pendingId, reason) {
  updatePending(pendingId, {
    stage: STAGES.ABANDONED,
    status: STATUS.ABANDONED,
    details: { reason: reason || "abandoned" },
  });
}

function listOpenPending() {
  if (!isFiscalEnabled()) return [];
  const sqlite = getSqlite();
  ensurePendingTxnTable(sqlite);
  return sqlite
    .prepare(
      `SELECT * FROM pending_txn
       WHERE status = ?
         AND stage IN (?, ?)
       ORDER BY id ASC`
    )
    .all(STATUS.OPEN, STAGES.COUPON_READY, STAGES.PRINTING);
}

function getOpenPendingForOrder(orderId) {
  if (!isFiscalEnabled()) return null;
  const sqlite = getSqlite();
  ensurePendingTxnTable(sqlite);
  return (
    sqlite
      .prepare(
        `SELECT * FROM pending_txn
         WHERE order_id = ? AND status = ?
           AND stage IN (?, ?, ?)
         ORDER BY id DESC LIMIT 1`
      )
      .get(
        Number(orderId),
        STATUS.OPEN,
        STAGES.STARTED,
        STAGES.COUPON_READY,
        STAGES.PRINTING
      ) || null
  );
}

/**
 * Rifillon printimin për një pending me kupon të krijuar (pa INSERT të ri).
 */
async function resumePendingPrint(pending, opts = {}) {
  if (!pending || !pending.print_text) {
    return { ok: false, error: "Nuk ka tekst kupon për rikuperim" };
  }
  if (pending.stage === STAGES.STARTED && !pending.fiscal_receipt_id) {
    abandonPending(pending.id, "no_coupon_yet");
    return { ok: false, abandoned: true, error: "Transaksioni u ndërpre para kuponit — ribëjeni checkout" };
  }

  const { printFiscalBundle } = require("./fiscal-main");
  const recoveryText = buildRecoveryPrintText(
    pending.print_text,
    pending.last_printed_line
  );

  markPrinting(pending.id);

  let printed = false;
  let printMessage = "";
  if (!opts.skip_print) {
    const pr = await printFiscalBundle(recoveryText, null, {
      recovery: true,
      skipGuardStrict: false,
    });
    printed = !!pr.printed;
    printMessage = pr.printMessage || "";
  } else {
    printed = false;
    printMessage = "skip_print";
  }

  if (printed || opts.skip_print) {
    markDone(pending.id, { recovered: true, printed });
  }

  try {
    const { logFiscalAction } = require("./fiscal-audit");
    logFiscalAction(
      "power_recovery",
      {
        pending_id: pending.id,
        order_id: pending.order_id,
        nuikf: pending.nuikf,
        fiscal_receipt_id: pending.fiscal_receipt_id,
        printed,
        last_printed_line: pending.last_printed_line,
      },
      pending.operator_name || "System",
      pending.operator_id || "RECOVERY"
    );
  } catch {
    /* */
  }

  return {
    ok: true,
    recovered: true,
    pending_id: pending.id,
    order_id: pending.order_id,
    nuikf: pending.nuikf,
    fiscal_receipt_id: pending.fiscal_receipt_id,
    printed,
    printMessage,
    recovery_text: recoveryText,
  };
}

/**
 * Pas boot: rikuperon të gjitha pending të hapura me kupon.
 * Pending në stage=started (pa kupon) → abandon (pa dublikim).
 */
async function resumeAllPendingOnBoot(opts = {}) {
  if (!isFiscalEnabled()) return { ok: true, resumed: [], abandoned: [] };

  const sqlite = getSqlite();
  ensurePendingTxnTable(sqlite);

  const started = sqlite
    .prepare(
      `SELECT * FROM pending_txn WHERE status = ? AND stage = ? ORDER BY id ASC`
    )
    .all(STATUS.OPEN, STAGES.STARTED);

  const abandoned = [];
  for (const p of started) {
    abandonPending(p.id, "boot_no_coupon");
    abandoned.push(p.id);
  }

  const open = listOpenPending();
  const resumed = [];
  for (const p of open) {
    try {
      const r = await resumePendingPrint(p, opts);
      resumed.push(r);
    } catch (e) {
      resumed.push({ ok: false, pending_id: p.id, error: e.message });
    }
  }

  return { ok: true, resumed, abandoned };
}

module.exports = {
  STAGES,
  STATUS,
  ensurePendingTxnTable,
  extractLastPrintedLine,
  buildRecoveryPrintText,
  beginPending,
  updatePending,
  markCouponReady,
  markPrinting,
  markDone,
  abandonPending,
  listOpenPending,
  getOpenPendingForOrder,
  resumePendingPrint,
  resumeAllPendingOnBoot,
};
