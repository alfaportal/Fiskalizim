/**
 * fiscal/fiscal-config.js — HAPI 2: lexon/ruan fiscal_settings (SQLite).
 * Kur fiscal_enabled=0, asgjë fiskale nuk aktivizohet.
 */
const EDITABLE_KEYS = [
  "fiscal_enabled",
  "taxpayer_nui",
  "taxpayer_nf",
  "taxpayer_vat_number",
  "taxpayer_legal_name",
  "taxpayer_address",
  "business_unit_number",
  "unit_number",
  "unit_name",
  "unit_phone",
  "pos_id",
  "language",
  "atk_api_url",
  "fiscalization_number",
  "application_id",
];

const DEFAULTS = {
  id: 1,
  fiscal_enabled: false,
  taxpayer_nui: "",
  taxpayer_nf: "",
  taxpayer_vat_number: "",
  taxpayer_legal_name: "",
  taxpayer_address: "",
  business_unit_number: "",
  unit_number: "",
  unit_name: "",
  unit_phone: "",
  pos_id: "",
  fiscalization_number: "",
  application_id: "",
  sef_code: "",
  developer_nui: "811314567",
  sef_identifier: "",
  certificate_path: "",
  private_key_path: "",
  atk_api_url: "https://fiskalizimi-test.atk-ks.org",
  daily_receipt_counter: 0,
  total_receipt_counter: 0,
  last_z_report_date: "",
  language: "sq",
  created_at: null,
  updated_at: null,
};

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ensureRow(sqlite) {
  const row = sqlite.prepare("SELECT id FROM fiscal_settings WHERE id = 1").get();
  if (!row) {
    sqlite
      .prepare(
        `INSERT INTO fiscal_settings (id, fiscal_enabled, language, developer_nui)
         VALUES (1, 0, 'sq', '811314567')`
      )
      .run();
  }
}

function normalizeRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    id: Number(row.id) || 1,
    fiscal_enabled: Number(row.fiscal_enabled) === 1,
    taxpayer_nui: row.taxpayer_nui != null ? String(row.taxpayer_nui) : "",
    taxpayer_nf: row.taxpayer_nf != null ? String(row.taxpayer_nf) : "",
    taxpayer_vat_number: row.taxpayer_vat_number != null ? String(row.taxpayer_vat_number) : "",
    taxpayer_legal_name: row.taxpayer_legal_name != null ? String(row.taxpayer_legal_name) : "",
    taxpayer_address: row.taxpayer_address != null ? String(row.taxpayer_address) : "",
    business_unit_number: row.business_unit_number != null ? String(row.business_unit_number) : "",
    unit_number: row.unit_number != null ? String(row.unit_number) : "",
    unit_name: row.unit_name != null ? String(row.unit_name) : "",
    unit_phone: row.unit_phone != null ? String(row.unit_phone) : "",
    pos_id: row.pos_id != null ? String(row.pos_id) : "",
    fiscalization_number: row.fiscalization_number != null ? String(row.fiscalization_number) : "",
    application_id: row.application_id != null ? String(row.application_id) : "",
    sef_code: row.sef_code != null ? String(row.sef_code) : "",
    developer_nui: row.developer_nui != null ? String(row.developer_nui) : "811314567",
    sef_identifier: row.sef_identifier != null ? String(row.sef_identifier) : "",
    certificate_path: row.certificate_path != null ? String(row.certificate_path) : "",
    private_key_path: row.private_key_path != null ? String(row.private_key_path) : "",
    atk_api_url:
      row.atk_api_url != null && String(row.atk_api_url).trim()
        ? String(row.atk_api_url)
        : "https://fiskalizimi-test.atk-ks.org",
    daily_receipt_counter: Number(row.daily_receipt_counter) || 0,
    total_receipt_counter: Number(row.total_receipt_counter) || 0,
    last_z_report_date: row.last_z_report_date != null ? String(row.last_z_report_date) : "",
    language: row.language === "sr" ? "sr" : "sq",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function getFiscalSettings() {
  const sqlite = getSqlite();
  ensureRow(sqlite);
  const row = sqlite.prepare("SELECT * FROM fiscal_settings WHERE id = 1").get();
  return normalizeRow(row);
}

function isFiscalEnabled() {
  try {
    return !!getFiscalSettings().fiscal_enabled;
  } catch {
    return false;
  }
}

function saveFiscalSettings(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Të dhënat mungojnë");
  }

  const sqlite = getSqlite();
  ensureRow(sqlite);
  const current = getFiscalSettings();
  const next = { ...current };

  for (const key of EDITABLE_KEYS) {
    if (data[key] === undefined) continue;

    if (key === "fiscal_enabled") {
      next.fiscal_enabled = data[key] === true || data[key] === 1 || data[key] === "1";
      continue;
    }

    if (key === "language") {
      const lang = String(data[key] || "").toLowerCase();
      if (lang !== "sq" && lang !== "sr") {
        throw new Error("Gjuha duhet të jetë sq ose sr");
      }
      next.language = lang;
      continue;
    }

    if (key === "taxpayer_nui") {
      const nui = String(data[key] ?? "").trim();
      if (nui && !/^\d{9}$/.test(nui)) {
        throw new Error("NUI duhet të ketë saktësisht 9 shifra");
      }
      next.taxpayer_nui = nui;
      continue;
    }

    next[key] = String(data[key] ?? "").trim();
  }

  const changedKeys = EDITABLE_KEYS.filter((k) => data[k] !== undefined);
  const wasEnabled = !!current.fiscal_enabled;

  // Audit PARA update nëse po fiket — logFiscalAction kërkon fiscal ON
  if (wasEnabled && changedKeys.length) {
    try {
      const { logFiscalAction } = require("./fiscal-audit");
      logFiscalAction(
        "setting_changed",
        {
          fiscal_enabled: next.fiscal_enabled,
          keys: changedKeys,
          taxpayer_nui: next.taxpayer_nui,
          language: next.language,
          pos_id: next.pos_id,
        },
        "Pronari",
        "OWNER"
      );
    } catch (e) {
      console.warn("[fiscal-config] audit:", e.message);
    }
  }

  // Siguro kolonat e reja në DB të vjetër
  for (const colSql of [
    `ALTER TABLE fiscal_settings ADD COLUMN language TEXT DEFAULT 'sq'`,
    `ALTER TABLE fiscal_settings ADD COLUMN unit_name TEXT`,
    `ALTER TABLE fiscal_settings ADD COLUMN unit_phone TEXT`,
    `ALTER TABLE fiscal_settings ADD COLUMN unit_number TEXT`,
    `ALTER TABLE fiscal_settings ADD COLUMN total_receipt_counter INTEGER DEFAULT 0`,
    `ALTER TABLE fiscal_settings ADD COLUMN application_id TEXT`,
    `ALTER TABLE fiscal_settings ADD COLUMN atk_api_url TEXT`,
    `ALTER TABLE fiscal_settings ADD COLUMN fiscalization_number TEXT`,
  ]) {
    try {
      sqlite.prepare(colSql).run();
    } catch {
      /* already exists */
    }
  }

  // SEF ID ndërtohet nga unit_number-nui-pos — pastro vlerën e vjetër NUI-NUI nëse ka
  let sefIdentifier = null;
  try {
    const unitNum = String(next.unit_number || next.business_unit_number || "")
      .trim()
      .replace(/[^\d]/g, "");
    const nuiDigits = String(next.taxpayer_nui || "").replace(/[^\d]/g, "");
    let posId = String(next.pos_id || "").trim() || "01";
    if (/^\d+$/.test(posId) && posId.length === 1) posId = posId.padStart(2, "0");
    if (unitNum && nuiDigits) {
      sefIdentifier = `${unitNum}-${nuiDigits}-${posId}`;
    }
  } catch {
    sefIdentifier = null;
  }

  sqlite
    .prepare(
      `UPDATE fiscal_settings SET
        fiscal_enabled = ?,
        taxpayer_nui = ?,
        taxpayer_nf = ?,
        taxpayer_vat_number = ?,
        taxpayer_legal_name = ?,
        taxpayer_address = ?,
        business_unit_number = ?,
        unit_number = ?,
        unit_name = ?,
        unit_phone = ?,
        pos_id = ?,
        sef_identifier = ?,
        language = ?,
        atk_api_url = ?,
        fiscalization_number = ?,
        application_id = ?,
        updated_at = datetime('now','localtime')
      WHERE id = 1`
    )
    .run(
      next.fiscal_enabled ? 1 : 0,
      next.taxpayer_nui || null,
      next.taxpayer_nf || null,
      next.taxpayer_vat_number || null,
      next.taxpayer_legal_name || null,
      next.taxpayer_address || null,
      next.business_unit_number || null,
      next.unit_number || null,
      next.unit_name || null,
      next.unit_phone || null,
      next.pos_id || null,
      sefIdentifier,
      next.language || "sq",
      next.atk_api_url || "https://fiskalizimi-test.atk-ks.org",
      next.fiscalization_number || null,
      next.application_id || null
    );

  // Sinkronizo cache i18n nga DB (pa rishkruar)
  try {
    const i18n = require("./fiscal-i18n");
    if (typeof i18n.syncLanguageFromSettings === "function") {
      i18n.syncLanguageFromSettings();
    }
  } catch (_e) { /* */ }

  // Audit PAS update kur sapo u ndez fiscal
  if (!wasEnabled && next.fiscal_enabled) {
    try {
      const { logFiscalAction } = require("./fiscal-audit");
      logFiscalAction(
        "setting_changed",
        { fiscal_enabled: true, keys: changedKeys },
        "Pronari",
        "OWNER"
      );
    } catch (e) {
      console.warn("[fiscal-config] audit:", e.message);
    }
  }

  return getFiscalSettings();
}

module.exports = {
  getFiscalSettings,
  saveFiscalSettings,
  isFiscalEnabled,
};
