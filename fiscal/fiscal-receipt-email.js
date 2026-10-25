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

/**
 * Dërgon kuponin fiskal te email i konsumatorit.
 * Kthen { ok, error?, nuikf?, email? } — nuk hedh gabim (mos blloko programin).
 */
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
      nuikf: preview.nuikf || "",
      email,
      message: remote.message || "Kuponi u dërgua me email.",
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message || String(e),
      nuikf: preview.nuikf || "",
      email,
    };
  }
}

module.exports = {
  DEFAULT_EMAIL_API_URL,
  isValidConsumerEmail,
  emailFiscalReceiptToConsumer,
  resolveReceiptEmailApiUrl,
};
