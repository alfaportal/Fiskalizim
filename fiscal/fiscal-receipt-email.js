/**
 * fiscal/fiscal-receipt-email.js — dërgim elektronik i kuponit fiskal te konsumatori (email).
 * Përdor revolution-restaurant-server (Resend) — nuk dërgon te ATK.
 */
const fs = require("fs");
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { logFiscalAction, buildTextReportPdfBuffer } = require("./fiscal-audit");
const { getFiscalReceiptPreviewWithQr } = require("./fiscal-receipts-list");
const { LOGO_PATH } = require("./fiscal-logo");

const DEFAULT_EMAIL_API_URL = "https://revolution-pos.com/api/sef/receipt-email";
const EMAIL_HTTP_TIMEOUT_MS = 35000;

function resolveReceiptEmailApiUrl() {
  return String(process.env.SEF_RECEIPT_EMAIL_URL || "").trim() || DEFAULT_EMAIL_API_URL;
}

function resolveEmailApiKey() {
  return String(process.env.SEF_EMAIL_API_KEY || "").trim();
}

function isValidConsumerEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function readLogoPngBase64() {
  try {
    if (fs.existsSync(LOGO_PATH)) {
      return fs.readFileSync(LOGO_PATH).toString("base64");
    }
  } catch {
    /* */
  }
  return null;
}

async function postReceiptEmailPayload(payload) {
  const url = resolveReceiptEmailApiUrl();
  const headers = { "Content-Type": "application/json" };
  const key = resolveEmailApiKey();
  if (key) headers["X-SEF-Email-Key"] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data.error || data.gabim || data.message || `Dërgimi i emailit dështoi (HTTP ${res.status})`;
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Koha e dërgimit të emailit skadoi — provoni përsëri.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function emailFiscalReceiptToConsumer(opts = {}) {
  if (!isFiscalEnabled()) {
    return { ok: false, error: "Fiskalizimi nuk është aktiv" };
  }

  const receiptId = Number(opts.receipt_id);
  const email = String(opts.email || "")
    .trim()
    .toLowerCase();
  const operatorName = String(opts.operator_name || "Operator").trim() || "Operator";
  const operatorId = String(opts.operator_id || "POS").trim() || "POS";

  if (!Number.isFinite(receiptId) || receiptId < 1) {
    return { ok: false, error: "ID kuponit mungon ose është i pavlefshëm" };
  }
  if (!isValidConsumerEmail(email)) {
    return { ok: false, error: "Email i pavlefshëm — kontrolloni adresën." };
  }

  let preview;
  try {
    preview = await getFiscalReceiptPreviewWithQr(receiptId);
  } catch (e) {
    return { ok: false, error: e.message || "Kuponi nuk u gjet" };
  }
  if (!preview) {
    return { ok: false, error: "Kuponi nuk u gjet" };
  }

  const settings = getFiscalSettings();
  const receiptText = String(preview.print_text || "").trim();
  if (!receiptText) {
    return { ok: false, error: "Teksti i kuponit mungon" };
  }

  let pdfBase64 = null;
  try {
    pdfBase64 = buildTextReportPdfBuffer(receiptText).toString("base64");
  } catch (e) {
    console.warn("[fiscal-receipt-email] PDF:", e.message || e);
  }

  const payload = {
    to: email,
    nuikf: preview.nuikf || "",
    receipt_id: receiptId,
    receipt_text: receiptText,
    qr_png_base64: preview.qr_png_base64 || null,
    logo_png_base64: readLogoPngBase64(),
    pdf_base64: pdfBase64,
    business_name: settings.taxpayer_legal_name || "",
    taxpayer_nui: preview.taxpayer_nui || settings.taxpayer_nui || "",
    total_amount: preview.total_amount,
    fiscal_date: preview.fiscal_date || "",
  };

  try {
    const remote = await postReceiptEmailPayload(payload);
    try {
      logFiscalAction(
        "receipt_emailed",
        {
          nuikf: preview.nuikf || "",
          email,
          receipt_id: receiptId,
          remote_id: remote.id || remote.message_id || null,
        },
        operatorName,
        operatorId
      );
    } catch (auditErr) {
      console.warn("[fiscal-receipt-email] audit:", auditErr.message || auditErr);
    }
    return {
      ok: true,
      queued: false,
      nuikf: preview.nuikf || "",
      email,
      message: remote.message || "Kuponi u dërgua me email.",
    };
  } catch (e) {
    if (opts.skip_queue) {
      return {
        ok: false,
        error: e.message || String(e),
        nuikf: preview.nuikf || "",
        email,
      };
    }
    const queued = enqueueReceiptEmail({
      receipt_id: receiptId,
      email,
      nuikf: preview.nuikf || "",
      last_error: e.message || String(e),
    });
    if (!queued.ok) {
      return {
        ok: false,
        error: e.message || String(e),
        nuikf: preview.nuikf || "",
        email,
      };
    }
    return {
      ok: true,
      queued: true,
      nuikf: preview.nuikf || "",
      email,
      message:
        "Email u ruajt në radhë — dërgohet automatikisht kur kthehet interneti.",
    };
  }
}

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ensureEmailQueueTable() {
  const sqlite = getSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      nuikf TEXT,
      created_at TEXT NOT NULL,
      last_error TEXT,
      attempts INTEGER DEFAULT 0
    )
  `);
  return sqlite;
}

function enqueueReceiptEmail(row) {
  try {
    const sqlite = ensureEmailQueueTable();
    const email = String(row.email || "")
      .trim()
      .toLowerCase();
    const receiptId = Number(row.receipt_id);
    if (!isValidConsumerEmail(email) || !Number.isFinite(receiptId) || receiptId < 1) {
      return { ok: false };
    }
    const existing = sqlite
      .prepare(
        `SELECT id FROM fiscal_email_queue WHERE receipt_id = ? AND email = ? LIMIT 1`
      )
      .get(receiptId, email);
    if (existing) {
      return { ok: true, id: existing.id, already: true };
    }
    const createdAt = new Date().toISOString();
    const info = sqlite
      .prepare(
        `INSERT INTO fiscal_email_queue (receipt_id, email, nuikf, created_at, last_error, attempts)
         VALUES (?, ?, ?, ?, ?, 0)`
      )
      .run(receiptId, email, String(row.nuikf || ""), createdAt, String(row.last_error || ""));
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) {
    console.warn("[fiscal-receipt-email] queue:", e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

async function processQueuedReceiptEmails() {
  if (!isFiscalEnabled()) return { processed: 0, pending: 0 };
  let rows = [];
  try {
    const sqlite = ensureEmailQueueTable();
    rows = sqlite
      .prepare(`SELECT * FROM fiscal_email_queue ORDER BY id ASC LIMIT 20`)
      .all();
  } catch (e) {
    console.warn("[fiscal-receipt-email] queue read:", e.message || e);
    return { processed: 0, pending: 0, error: e.message || String(e) };
  }
  let processed = 0;
  for (const row of rows) {
    const sent = await emailFiscalReceiptToConsumer({
      receipt_id: row.receipt_id,
      email: row.email,
      skip_queue: true,
    });
    try {
      const sqlite = ensureEmailQueueTable();
      if (sent.ok && !sent.queued) {
        sqlite.prepare(`DELETE FROM fiscal_email_queue WHERE id = ?`).run(row.id);
        processed += 1;
      } else {
        sqlite
          .prepare(
            `UPDATE fiscal_email_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`
          )
          .run(String(sent.error || "dështoi"), row.id);
      }
    } catch (e) {
      console.warn("[fiscal-receipt-email] queue update:", e.message || e);
    }
  }
  return { processed, pending: rows.length };
}

module.exports = {
  DEFAULT_EMAIL_API_URL,
  isValidConsumerEmail,
  emailFiscalReceiptToConsumer,
  resolveReceiptEmailApiUrl,
  enqueueReceiptEmail,
  processQueuedReceiptEmails,
};
