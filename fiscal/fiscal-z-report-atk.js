/**
 * fiscal/fiscal-z-report-atk.js — dërgim / ruajtje Raporti Z te ATK.
 * atk-models.proto: vetëm PosCoupon/CitizenCoupon — pa endpoint ZReport.
 */
const fs = require("fs");
const path = require("path");
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { logFiscalAction, writeTextReportPdf } = require("./fiscal-audit");
const { isAtkTransmissionBlocked } = require("./fiscal-test-mode-store");
const { getDataDir } = require("../portable-path");

/** Override vetëm kur ATK publikon endpoint (p.sh. /pos/z-report). */
const ATK_Z_REPORT_HTTP_PATH = String(process.env.ATK_Z_REPORT_PATH || "").trim();

const ATK_Z_UNSUPPORTED_MSG =
  "ATK nuk pranon raporte Z përmes sistemit — raporti është ruajtur lokalisht.";

function getSqlite() {
  const database = require("../database");
  if (!database?.db) throw new Error("Databaza nuk është e gatshme");
  return database.db;
}

/**
 * atk-models.proto nuk përmban mesazh/endpoint për Raport Z.
 */
function isZReportAtkEndpointAvailable() {
  return !!ATK_Z_REPORT_HTTP_PATH;
}

function getZReportsDir() {
  return path.join(getDataDir(), "z-reports");
}

function sanitizeFilePart(s) {
  return String(s || "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
}

function saveZReportPdfLocally(text, details) {
  if (!isFiscalEnabled()) return null;
  const dir = getZReportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const datePart = sanitizeFilePart(details?.date || new Date().toISOString().slice(0, 10));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `Z-raport-${datePart}-${ts}`;
  const pdfPath = path.join(dir, `${baseName}.pdf`);
  const txtPath = path.join(dir, `${baseName}.txt`);
  writeTextReportPdf(text, pdfPath);
  fs.writeFileSync(txtPath, String(text || ""), "utf8");
  return { pdf_path: pdfPath, text_path: txtPath };
}

async function sendZReportToAtkHttp(details, settings, text) {
  if (!isZReportAtkEndpointAvailable()) {
    return { ok: false, unsupported: true, error: ATK_Z_UNSUPPORTED_MSG };
  }
  if (isAtkTransmissionBlocked()) {
    return {
      ok: false,
      error: "Modalitet lokal — dërgimi te ATK është i çaktivizuar te Cilësimet SEF.",
    };
  }

  const { httpJsonPost, resolveAtkBaseUrl } = require("./fiscal-atk-api");
  const base = resolveAtkBaseUrl(settings?.atk_api_url || getFiscalSettings().atk_api_url);
  const url = `${base.replace(/\/$/, "")}${ATK_Z_REPORT_HTTP_PATH.startsWith("/") ? "" : "/"}${ATK_Z_REPORT_HTTP_PATH}`;

  const body = {
    report_type: "Z",
    date: details?.date || null,
    sef_id: details?.sef_id || null,
    coupon_count: details?.coupon_count ?? null,
    total_amount: details?.total_amount ?? null,
    total_tax: details?.total_tax ?? null,
    vat_breakdown: details?.vat_breakdown || null,
    text: String(text || "").slice(0, 12000),
  };

  try {
    const resp = await httpJsonPost(url, body);
    if (resp.ok) {
      return { ok: true, message: "Raporti Z u dërgua te ATK", response: resp.json || resp.body };
    }
    return {
      ok: false,
      error: resp.error || resp.body || `ATK HTTP ${resp.status || "?"}`,
      status: resp.status,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/**
 * Pas gjenerimit të Z: provo ATK (nëse endpoint ekziston), përndryshe PDF + audit z_report_generated.
 */
async function processZReportDelivery(opts = {}) {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }

  const text = String(opts.text || "");
  const details = opts.details && typeof opts.details === "object" ? { ...opts.details } : {};
  const settings = opts.settings || getFiscalSettings();
  const operatorName = String(opts.operator_name || "Operator").trim() || "Operator";
  const operatorId = String(opts.operator_id || "POS").trim() || "POS";
  const manual = !!opts.manual;

  const result = {
    atk_supported: isZReportAtkEndpointAvailable(),
    atk_sent: false,
    atk_message: "",
    pdf_path: null,
    text_path: null,
    unsupported: false,
    manual,
  };

  if (result.atk_supported && !isAtkTransmissionBlocked()) {
    const send = await sendZReportToAtkHttp(details, settings, text);
    if (send.ok) {
      result.atk_sent = true;
      result.atk_message = send.message || "Raporti Z u dërgua te ATK";
      try {
        logFiscalAction(
          "z_report_generated",
          {
            ...details,
            atk_supported: true,
            atk_sent: true,
            manual,
            delivery: "atk_http",
          },
          operatorName,
          operatorId
        );
      } catch {
        /* */
      }
      return result;
    }
    result.atk_message = send.error || send.message || "Dërgimi te ATK dështoi";
    if (send.unsupported) {
      result.atk_supported = false;
      result.unsupported = true;
    }
  } else if (!result.atk_supported) {
    result.unsupported = true;
    result.atk_message = ATK_Z_UNSUPPORTED_MSG;
  } else if (isAtkTransmissionBlocked()) {
    result.atk_message = "Modalitet lokal — raporti ruhet vetëm lokalisht (PDF).";
  }

  try {
    const saved = saveZReportPdfLocally(text, details);
    result.pdf_path = saved?.pdf_path || null;
    result.text_path = saved?.text_path || null;
  } catch (e) {
    result.atk_message = (result.atk_message ? result.atk_message + " " : "") + (e.message || "PDF dështoi");
  }

  if (!result.atk_message) {
    result.atk_message = result.pdf_path
      ? `Raporti u ruajt lokalisht: ${result.pdf_path}`
      : ATK_Z_UNSUPPORTED_MSG;
  }

  try {
    logFiscalAction(
      "z_report_generated",
      {
        ...details,
        pdf_path: result.pdf_path,
        text_path: result.text_path,
        atk_supported: result.atk_supported,
        atk_sent: false,
        unsupported: result.unsupported,
        manual,
        delivery: "local_pdf",
      },
      operatorName,
      operatorId
    );
  } catch {
    /* */
  }

  return result;
}

function parseAuditDetails(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function readTextFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch {
    /* */
  }
  return "";
}

/** Raporti Z i fundit nga audit (pa rigjeneruar numëratorin). */
function getLatestZReportForSend() {
  if (!isFiscalEnabled()) return null;
  const sqlite = getSqlite();

  const genRow = sqlite
    .prepare(
      `SELECT id, details_json, created_at FROM fiscal_audit_log
       WHERE action = 'z_report_generated'
       ORDER BY id DESC LIMIT 1`
    )
    .get();

  if (genRow) {
    const details = parseAuditDetails(genRow.details_json);
    let text = readTextFileSafe(details.text_path);
    if (!text && details.pdf_path) {
      text = readTextFileSafe(String(details.pdf_path).replace(/\.pdf$/i, ".txt"));
    }
    return {
      details,
      text,
      pdf_path: details.pdf_path || null,
      text_path: details.text_path || null,
      audit_id: genRow.id,
      created_at: genRow.created_at,
    };
  }

  const zRow = sqlite
    .prepare(
      `SELECT id, details_json, created_at FROM fiscal_audit_log
       WHERE action = 'z_report'
       ORDER BY id DESC LIMIT 1`
    )
    .get();
  if (!zRow) return null;

  const details = parseAuditDetails(zRow.details_json);
  return {
    details,
    text: "",
    pdf_path: null,
    text_path: null,
    audit_id: zRow.id,
    created_at: zRow.created_at,
  };
}

module.exports = {
  ATK_Z_UNSUPPORTED_MSG,
  isZReportAtkEndpointAvailable,
  saveZReportPdfLocally,
  sendZReportToAtkHttp,
  processZReportDelivery,
  getLatestZReportForSend,
  getZReportsDir,
};
