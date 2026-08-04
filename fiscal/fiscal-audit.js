/**
 * fiscal/fiscal-audit.js — HAPI 10: audit log WRITE-ONCE + eksport CSV/PDF.
 * Vetëm INSERT në fiscal_audit_log. Kur isFiscalEnabled()=false → null.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { isFiscalEnabled } = require("./fiscal-config");

const ALLOWED_ACTIONS = Object.freeze([
  "receipt_created",
  "receipt_sent",
  "receipt_send_failed",
  "z_report",
  "x_report",
  "periodic_report",
  "short_periodic_report",
  "monthly_memory_report",
  "power_recovery",
  "setting_changed",
  "correction_created",
  "offline_start",
  "offline_end",
  "login",
  "error",
  "write_once_violation",
]);

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function getDocumentsDir() {
  const home = os.homedir();
  const docs = path.join(home, "Documents");
  if (fs.existsSync(docs)) return docs;
  // Fallback
  const alt = path.join(home, "Dokumentet");
  if (fs.existsSync(alt)) return alt;
  fs.mkdirSync(docs, { recursive: true });
  return docs;
}

function normalizeDateBound(value, endOfDay) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s} 23:59:59` : `${s} 00:00:00`;
  }
  return s;
}

/**
 * INSERT write-once në fiscal_audit_log.
 */
function logFiscalAction(action, details, operatorName, operatorId) {
  if (!isFiscalEnabled()) return null;

  const act = String(action || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_ACTIONS.includes(act)) {
    throw new Error(
      `Veprim i panjohur audit: ${action}. Lejohen: ${ALLOWED_ACTIONS.join(", ")}`
    );
  }

  const sqlite = getSqlite();
  const detailsJson = JSON.stringify(
    details && typeof details === "object" ? details : { value: details }
  );
  const result = sqlite
    .prepare(
      `INSERT INTO fiscal_audit_log (action, details_json, operator_name, operator_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      act,
      detailsJson,
      operatorName != null ? String(operatorName) : null,
      operatorId != null ? String(operatorId) : null
    );

  return {
    id: result.lastInsertRowid,
    action: act,
    details,
    operator_name: operatorName || null,
    operator_id: operatorId || null,
  };
}

/**
 * Lista e veprimeve brenda datave (YYYY-MM-DD ose datetime).
 */
function getAuditLog(fromDate, toDate) {
  if (!isFiscalEnabled()) return null;

  const sqlite = getSqlite();
  const from = normalizeDateBound(fromDate, false);
  const to = normalizeDateBound(toDate, true);

  let sql = `SELECT id, action, details_json, operator_name, operator_id, created_at
             FROM fiscal_audit_log WHERE 1=1`;
  const params = [];
  if (from) {
    sql += ` AND created_at >= ?`;
    params.push(from);
  }
  if (to) {
    sql += ` AND created_at <= ?`;
    params.push(to);
  }
  sql += ` ORDER BY id ASC`;

  const rows = sqlite.prepare(sql).all(...params);
  return rows.map((r) => {
    let details = {};
    try {
      details = JSON.parse(r.details_json || "{}");
    } catch {
      details = { raw: r.details_json };
    }
    return {
      id: r.id,
      action: r.action,
      details,
      details_json: r.details_json,
      operator_name: r.operator_name,
      operator_id: r.operator_id,
      created_at: r.created_at,
    };
  });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Eksport CSV → Documents. Kthen shtegun e fajllit.
 */
function exportAuditCSV(fromDate, toDate) {
  if (!isFiscalEnabled()) return null;

  const rows = getAuditLog(fromDate, toDate) || [];
  const header = [
    "id",
    "created_at",
    "action",
    "operator_name",
    "operator_id",
    "details_json",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.created_at,
        r.action,
        r.operator_name,
        r.operator_id,
        r.details_json || JSON.stringify(r.details || {}),
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(
    getDocumentsDir(),
    `fiscal-audit-${stamp}.csv`
  );
  fs.writeFileSync(filePath, "\uFEFF" + lines.join("\r\n") + "\r\n", "utf8");
  return filePath;
}

/** PDF minimal (tekst) pa dependency të jashtëm — A4, shumë faqe. */
function buildSimplePdf(lines) {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 40;
  const fontSize = 9;
  const lineHeight = 12;
  const usableHeight = pageHeight - margin * 2;
  const linesPerPage = Math.floor(usableHeight / lineHeight);

  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (!pages.length) pages.push(["(nuk ka regjistrime)"]);

  const objects = [];
  const addObj = (content) => {
    objects.push(content);
    return objects.length;
  };

  // 1: Catalog
  addObj("<< /Type /Catalog /Pages 2 0 R >>");
  // 2: Pages (placeholder, patched later)
  addObj("PAGES_PLACEHOLDER");

  const fontId = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageIds = [];
  const contentIds = [];

  for (const pageLines of pages) {
    const escaped = pageLines
      .map((ln) =>
        String(ln)
          .replace(/\\/g, "\\\\")
          .replace(/\(/g, "\\(")
          .replace(/\)/g, "\\)")
          .slice(0, 110)
      );
    let y = pageHeight - margin - fontSize;
    const streamParts = [`BT /F1 ${fontSize} Tf 0 Tg`];
    for (const ln of escaped) {
      streamParts.push(`1 0 0 1 ${margin} ${y} Tm (${ln}) Tj`);
      y -= lineHeight;
    }
    streamParts.push("ET");
    const stream = streamParts.join("\n");
    const contentId = addObj(
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
    );
    contentIds.push(contentId);
    const pageId = addObj(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    );
    pageIds.push(pageId);
  }

  objects[1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

/**
 * Eksport PDF → Documents. Kthen shtegun e fajllit.
 */
function exportAuditPDF(fromDate, toDate) {
  if (!isFiscalEnabled()) return null;

  const rows = getAuditLog(fromDate, toDate) || [];
  const title = `Fiscal Audit Log  ${fromDate || "..."} - ${toDate || "..."}`;
  const lines = [
    title,
    "=".repeat(90),
    "ID | Data | Veprimi | Operatori | Detaje",
    "-".repeat(90),
  ];
  for (const r of rows) {
    const det = JSON.stringify(r.details || {}).slice(0, 80);
    lines.push(
      `${r.id} | ${r.created_at || ""} | ${r.action} | ${r.operator_name || "-"} | ${det}`
    );
  }
  lines.push("-".repeat(90));
  lines.push(`Totali: ${rows.length} regjistrime`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(
    getDocumentsDir(),
    `fiscal-audit-${stamp}.pdf`
  );
  fs.writeFileSync(filePath, buildSimplePdf(lines));
  return filePath;
}

module.exports = {
  ALLOWED_ACTIONS,
  logFiscalAction,
  getAuditLog,
  exportAuditCSV,
  exportAuditPDF,
  getDocumentsDir,
};
