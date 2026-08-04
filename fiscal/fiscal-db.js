/**
 * fiscal/fiscal-db.js — HAPI 1: tabela fiskale (SQLite).
 * Mos importo module ekzistuese (database.js, cloud-sync, etj.).
 *
 * ⛔ WRITE-ONCE: fiscal_receipts dhe fiscal_audit_log
 * UPDATE lejohet VETËM për: sent_to_atk, sent_at, atk_response_json
 * DELETE nuk lejohet (përjashtim: rreshta TEST/SELFTEST për self-test)
 * Kuponi korrigjues = INSERT i ri, JO update i vjetrit
 *
 * Ky skedar NUK obfuskohet (shih obfuscate-build.mjs).
 */
const fs = require("fs");
const path = require("path");

/** Fushat e vetme që lejohen me UPDATE në fiscal_receipts. */
const RECEIPT_UPDATE_ALLOWED_MAP = {
  sent_to_atk: true,
  sent_at: true,
  atk_response_json: true,
};
const RECEIPT_UPDATE_ALLOWED = Object.keys(RECEIPT_UPDATE_ALLOWED_MAP);

const REQUIRED_RECEIPT_FIELDS = [
  "sale_id",
  "nuikf",
  "sef_id",
  "daily_number",
  "fiscal_date",
  "fiscal_time",
  "operator_name",
  "operator_id",
  "taxpayer_nui",
  "taxpayer_name",
  "taxpayer_address",
  "items_json",
  "subtotal",
  "total_amount",
  "total_without_tax",
  "vat_breakdown_json",
  "payment_method",
  "qr_code_data",
];

function isAllowedReceiptUpdateField(key) {
  return RECEIPT_UPDATE_ALLOWED_MAP[String(key)] === true;
}

function getFiscalDbPath() {
  return (
    process.env.DB_PATH ||
    process.env.BIZNES_DB_PATH ||
    path.join(__dirname, "..", "biznes.db")
  );
}

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function logWriteOnceViolation(details) {
  try {
    const { logFiscalAction } = require("./fiscal-audit");
    logFiscalAction(
      "write_once_violation",
      details && typeof details === "object" ? details : { detail: details },
      "SYSTEM",
      "WRITE_ONCE"
    );
  } catch (e) {
    console.warn("[fiscal-db] write_once_violation audit:", e.message);
  }
}

/**
 * UPDATE i mbrojtur për fiscal_receipts — VETËM sent_to_atk, sent_at, atk_response_json.
 */
function fiscalReceiptUpdate(id, data) {
  const rid = Number(id);
  if (!Number.isFinite(rid) || rid < 1) {
    throw new Error("fiscalReceiptUpdate: id i pavlefshëm");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("fiscalReceiptUpdate: data duhet të jetë objekt");
  }

  const keys = [];
  for (const k in data) {
    if (data[k] !== undefined) keys.push(k);
  }
  if (!keys.length) {
    throw new Error("fiscalReceiptUpdate: asnjë fushë për update");
  }

  const forbidden = [];
  for (let i = 0; i < keys.length; i++) {
    if (!isAllowedReceiptUpdateField(keys[i])) forbidden.push(keys[i]);
  }
  if (forbidden.length) {
    logWriteOnceViolation({
      table: "fiscal_receipts",
      op: "UPDATE",
      id: rid,
      forbidden_fields: forbidden,
    });
    throw new Error(
      "fiscalReceiptUpdate: WRITE-ONCE — fusha të ndaluara: " +
        forbidden.join(", ") +
        ". Lejohen vetëm: sent_to_atk, sent_at, atk_response_json"
    );
  }

  const sets = [];
  const values = [];
  const allowedKeys = ["sent_to_atk", "sent_at", "atk_response_json"];
  for (let i = 0; i < allowedKeys.length; i++) {
    const key = allowedKeys[i];
    if (data[key] === undefined) continue;
    sets.push(key + " = ?");
    let val = data[key];
    if (key === "sent_to_atk") {
      val = val === true || val === 1 || val === "1" ? 1 : 0;
    } else if (key === "atk_response_json" && val != null && typeof val === "object") {
      val = JSON.stringify(val);
    } else if (val != null) {
      val = String(val);
    }
    values.push(val);
  }

  if (!sets.length) {
    throw new Error("fiscalReceiptUpdate: asnjë fushë e lejuar për update");
  }

  values.push(rid);
  const sqlite = getSqlite();
  const sql =
    "UPDATE fiscal_receipts SET " + sets.join(", ") + " WHERE id = ?";
  const stmt = sqlite.prepare(sql);
  const result = stmt.run.apply(stmt, values);

  return { id: rid, changes: result.changes || 0 };
}

/**
 * Validon rreshtin para INSERT në fiscal_receipts.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateFiscalReceiptInsert(row) {
  if (!row || typeof row !== "object") {
    return { ok: false, error: "rreshti mungon" };
  }
  const missing = [];
  for (let i = 0; i < REQUIRED_RECEIPT_FIELDS.length; i++) {
    const f = REQUIRED_RECEIPT_FIELDS[i];
    const v = row[f];
    if (v === undefined || v === null || v === "") missing.push(f);
  }
  if (missing.length) {
    return { ok: false, error: "fusha të detyrueshme mungojnë: " + missing.join(", ") };
  }

  const nuikf = String(row.nuikf || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{16}$/.test(nuikf)) {
    return { ok: false, error: "NUIKF duhet 16 karaktere alfanumerike, morëm: " + nuikf };
  }
  // Mos lejo formatin e faturës lokale YYYYMMDD-NNNNNN
  if (/^\d{8}-\d{6}$/.test(String(row.nuikf))) {
    return { ok: false, error: "NUIKF nuk mund të jetë numri i faturës (YYYYMMDD-NNNNNN)" };
  }

  const total = Number(row.total_amount);
  // Regular: > 0; korrigjues mund të ketë shenjë negative — mos lejo 0
  if (!Number.isFinite(total) || Math.abs(total) < 0.0001) {
    return { ok: false, error: "total_amount duhet ≠ 0" };
  }

  const date = String(row.fiscal_date || "");
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
    return { ok: false, error: "fiscal_date duhet DD.MM.YYYY, morëm: " + date };
  }

  return { ok: true, nuikf };
}

/**
 * INSERT i validuar në fiscal_receipts.
 */
function insertFiscalReceipt(row) {
  const check = validateFiscalReceiptInsert(row);
  if (!check.ok) {
    throw new Error("fiscal INSERT invalid: " + check.error);
  }

  const sqlite = getSqlite();
  const nuikf = check.nuikf;
  const exists = sqlite
    .prepare("SELECT 1 AS ok FROM fiscal_receipts WHERE nuikf = ? LIMIT 1")
    .get(nuikf);
  if (exists) {
    throw new Error("fiscal INSERT: NUIKF nuk është unik: " + nuikf);
  }

  const result = sqlite
    .prepare(
      `INSERT INTO fiscal_receipts (
        sale_id, nuikf, sef_id, receipt_type, original_nuikf,
        daily_number, total_number, fiscal_date, fiscal_time,
        operator_name, operator_id,
        taxpayer_nui, taxpayer_vat, taxpayer_name, taxpayer_address,
        items_json, subtotal, discount_amount, total_amount, total_without_tax,
        vat_breakdown_json, payment_method, currency,
        qr_code_data, digital_signature,
        is_offline, sent_to_atk
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?
      )`
    )
    .run(
      Number(row.sale_id) || 0,
      nuikf,
      String(row.sef_id || ""),
      String(row.receipt_type || "regular"),
      row.original_nuikf != null ? String(row.original_nuikf) : null,
      Number(row.daily_number) || 0,
      Number(row.total_number) || 0,
      String(row.fiscal_date),
      String(row.fiscal_time),
      String(row.operator_name),
      String(row.operator_id),
      String(row.taxpayer_nui),
      row.taxpayer_vat != null ? String(row.taxpayer_vat) : null,
      String(row.taxpayer_name),
      String(row.taxpayer_address),
      typeof row.items_json === "string" ? row.items_json : JSON.stringify(row.items_json || []),
      Number(row.subtotal) || 0,
      Number(row.discount_amount) || 0,
      Number(row.total_amount),
      Number(row.total_without_tax) || 0,
      typeof row.vat_breakdown_json === "string"
        ? row.vat_breakdown_json
        : JSON.stringify(row.vat_breakdown_json || {}),
      String(row.payment_method || "cash"),
      String(row.currency || "EUR"),
      String(row.qr_code_data || ""),
      row.digital_signature != null ? String(row.digital_signature) : null,
      row.is_offline ? 1 : 0,
      row.sent_to_atk ? 1 : 0
    );

  return result.lastInsertRowid;
}

/**
 * DELETE i lejuar VETËM për rreshta self-test (operator_name='TEST' + SELFTEST).
 */
function deleteTestFiscalReceipts() {
  const sqlite = getSqlite();
  const result = sqlite
    .prepare(
      `DELETE FROM fiscal_receipts
       WHERE operator_name = 'TEST'
         AND operator_id = 'SELFTEST'
         AND (
           items_json LIKE '%"__self_test__":true%'
           OR items_json LIKE '%"__self_test__": true%'
           OR digital_signature = 'TEST'
         )`
    )
    .run();
  return Number(result.changes) || 0;
}

function createExecutors(dbApi) {
  if (!dbApi) return null;
  const get =
    typeof dbApi.get === "function"
      ? (sql, params) => dbApi.get(sql, params)
      : null;
  if (typeof dbApi.exec === "function" && typeof dbApi.run === "function") {
    return {
      exec: (sql) => dbApi.exec(sql),
      run: (sql) => dbApi.run(sql),
      get,
    };
  }
  if (typeof dbApi.exec === "function") {
    return {
      exec: (sql) => dbApi.exec(sql),
      run: (sql) => dbApi.exec(sql),
      get,
    };
  }
  if (typeof dbApi.run === "function") {
    return {
      exec: (sql) => dbApi.run(sql),
      run: (sql) => dbApi.run(sql),
      get,
    };
  }
  return null;
}

const FISCAL_RECEIPTS_DDL = `
  CREATE TABLE IF NOT EXISTS fiscal_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    nuikf TEXT NOT NULL UNIQUE,
    sef_id TEXT NOT NULL,
    receipt_type TEXT NOT NULL DEFAULT 'regular',
    original_nuikf TEXT,
    daily_number INTEGER NOT NULL,
    total_number INTEGER NOT NULL DEFAULT 0,
    fiscal_date TEXT NOT NULL,
    fiscal_time TEXT NOT NULL,
    operator_name TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    taxpayer_nui TEXT NOT NULL,
    taxpayer_vat TEXT,
    taxpayer_name TEXT NOT NULL,
    taxpayer_address TEXT NOT NULL,
    items_json TEXT NOT NULL,
    subtotal REAL NOT NULL,
    discount_amount REAL DEFAULT 0,
    total_amount REAL NOT NULL,
    total_without_tax REAL NOT NULL,
    vat_breakdown_json TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    qr_code_data TEXT NOT NULL,
    digital_signature TEXT,
    is_offline INTEGER DEFAULT 0,
    sent_to_atk INTEGER DEFAULT 0,
    atk_response_json TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`;

function migrateBrokenSalesOrdersFk(executors) {
  const { exec, run, get } = executors;
  try {
    let sql = "";
    if (typeof get === "function") {
      const row = get(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='fiscal_receipts'`
      );
      sql = row && row.sql ? String(row.sql) : "";
    }
    if (!/sales_orders/i.test(sql)) return;

    console.warn(
      "[fiscal-db] Migrim: heq FK sales_orders nga fiscal_receipts (bllokonte INSERT)"
    );
    exec(`
      CREATE TABLE IF NOT EXISTS fiscal_receipts__mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        nuikf TEXT NOT NULL UNIQUE,
        sef_id TEXT NOT NULL,
        receipt_type TEXT NOT NULL DEFAULT 'regular',
        original_nuikf TEXT,
        daily_number INTEGER NOT NULL,
        total_number INTEGER NOT NULL DEFAULT 0,
        fiscal_date TEXT NOT NULL,
        fiscal_time TEXT NOT NULL,
        operator_name TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        taxpayer_nui TEXT NOT NULL,
        taxpayer_vat TEXT,
        taxpayer_name TEXT NOT NULL,
        taxpayer_address TEXT NOT NULL,
        items_json TEXT NOT NULL,
        subtotal REAL NOT NULL,
        discount_amount REAL DEFAULT 0,
        total_amount REAL NOT NULL,
        total_without_tax REAL NOT NULL,
        vat_breakdown_json TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        qr_code_data TEXT NOT NULL,
        digital_signature TEXT,
        is_offline INTEGER DEFAULT 0,
        sent_to_atk INTEGER DEFAULT 0,
        atk_response_json TEXT,
        sent_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `);
    try {
      run(`INSERT OR IGNORE INTO fiscal_receipts__mig SELECT * FROM fiscal_receipts`);
    } catch (e) {
      console.warn("[fiscal-db] mig copy:", e.message);
    }
    exec(`DROP TABLE IF EXISTS fiscal_receipts`);
    exec(`ALTER TABLE fiscal_receipts__mig RENAME TO fiscal_receipts`);
  } catch (e) {
    console.warn("[fiscal-db] migrateBrokenSalesOrdersFk:", e.message);
  }
}

function installWriteOnceTriggers(executors) {
  const { exec } = executors;
  exec(`DROP TRIGGER IF EXISTS trg_fiscal_receipts_block_update`);
  exec(`
    CREATE TRIGGER trg_fiscal_receipts_block_update
    BEFORE UPDATE OF
      sale_id, nuikf, sef_id, receipt_type, original_nuikf, daily_number, total_number,
      fiscal_date, fiscal_time, operator_name, operator_id,
      taxpayer_nui, taxpayer_vat, taxpayer_name, taxpayer_address,
      items_json, subtotal, discount_amount, total_amount, total_without_tax,
      vat_breakdown_json, payment_method, currency, qr_code_data,
      digital_signature, is_offline, created_at
    ON fiscal_receipts
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'WRITE-ONCE: UPDATE i ndaluar në fiscal_receipts');
    END;
  `);

  exec(`DROP TRIGGER IF EXISTS trg_fiscal_receipts_block_delete`);
  exec(`
    CREATE TRIGGER trg_fiscal_receipts_block_delete
    BEFORE DELETE ON fiscal_receipts
    FOR EACH ROW
    WHEN NOT (OLD.operator_name = 'TEST' AND OLD.operator_id = 'SELFTEST')
    BEGIN
      SELECT RAISE(ABORT, 'WRITE-ONCE: DELETE i ndaluar në fiscal_receipts');
    END;
  `);

  exec(`DROP TRIGGER IF EXISTS trg_fiscal_audit_block_update`);
  exec(`
    CREATE TRIGGER trg_fiscal_audit_block_update
    BEFORE UPDATE ON fiscal_audit_log
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'WRITE-ONCE: UPDATE i ndaluar në fiscal_audit_log');
    END;
  `);

  exec(`DROP TRIGGER IF EXISTS trg_fiscal_audit_block_delete`);
  exec(`
    CREATE TRIGGER trg_fiscal_audit_block_delete
    BEFORE DELETE ON fiscal_audit_log
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'WRITE-ONCE: DELETE i ndaluar në fiscal_audit_log');
    END;
  `);
}

function applyFiscalSchema(executors) {
  const { exec, run } = executors;

  exec(FISCAL_RECEIPTS_DDL);

  exec(`
    CREATE TABLE IF NOT EXISTS fiscal_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      fiscal_enabled INTEGER DEFAULT 0,
      taxpayer_nui TEXT,
      taxpayer_nf TEXT,
      taxpayer_vat_number TEXT,
      taxpayer_legal_name TEXT,
      taxpayer_address TEXT,
      business_unit_number TEXT,
      unit_number TEXT,
      pos_id TEXT,
      fiscalization_number TEXT,
      sef_code TEXT,
      developer_nui TEXT DEFAULT '811314567',
      sef_identifier TEXT,
      certificate_path TEXT,
      private_key_path TEXT,
      atk_api_url TEXT,
      daily_receipt_counter INTEGER DEFAULT 0,
      total_receipt_counter INTEGER DEFAULT 0,
      last_z_report_date TEXT,
      language TEXT DEFAULT 'sq',
      unit_name TEXT,
      unit_phone TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  exec(`
    CREATE TABLE IF NOT EXISTS fiscal_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      operator_name TEXT,
      operator_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // Neni 11 / 7 — checkpoint rikuperimi pas ndërprerjes
  exec(`
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

  migrateBrokenSalesOrdersFk(executors);

  try {
    installWriteOnceTriggers(executors);
  } catch (e) {
    console.warn("[fiscal-db] triggers:", e.message);
  }

  const alterColumns = [
    "ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT 'cash'",
    "ALTER TABLE orders ADD COLUMN fiscal_receipt_id INTEGER",
    "ALTER TABLE orders ADD COLUMN is_fiscalized INTEGER DEFAULT 0",
    // Tabelat e vjetra u krijuan pa language — pa këtë, gjuha mbetet gjithmonë sq
    "ALTER TABLE fiscal_settings ADD COLUMN language TEXT DEFAULT 'sq'",
    "ALTER TABLE fiscal_settings ADD COLUMN unit_name TEXT",
    "ALTER TABLE fiscal_settings ADD COLUMN unit_phone TEXT",
    "ALTER TABLE fiscal_settings ADD COLUMN unit_number TEXT",
    "ALTER TABLE fiscal_settings ADD COLUMN total_receipt_counter INTEGER DEFAULT 0",
    "ALTER TABLE fiscal_receipts ADD COLUMN total_number INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of alterColumns) {
    try {
      run(sql);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (!/duplicate column|already exists|no such table/i.test(msg)) {
        console.warn("[fiscal-db] ALTER:", msg);
      }
    }
  }

  // Backfill total_number nga id; sinkronizo counter-in total
  try {
    run(
      `UPDATE fiscal_receipts SET total_number = id
       WHERE total_number IS NULL OR total_number = 0`
    );
  } catch (e) {
    /* ignore */
  }
  try {
    run(
      `UPDATE fiscal_settings
       SET total_receipt_counter = (
         SELECT CASE
           WHEN COALESCE((SELECT MAX(total_number) FROM fiscal_receipts), 0)
                > COALESCE(total_receipt_counter, 0)
           THEN COALESCE((SELECT MAX(total_number) FROM fiscal_receipts), 0)
           ELSE COALESCE(total_receipt_counter, 0)
         END
       )
       WHERE id = 1`
    );
  } catch (e) {
    /* ignore */
  }
}

/**
 * Inicializon skemën fiskale. Thirret gjatë startimit të aplikacionit.
 */
function initFiscalDB(dbApi) {
  const executors = createExecutors(dbApi);
  if (executors) {
    applyFiscalSchema(executors);
    return;
  }

  const initSqlJs = require("sql.js");
  const dbPath = getFiscalDbPath();

  return initSqlJs({
    locateFile: (file) =>
      path.join(__dirname, "..", "node_modules", "sql.js", "dist", file),
  }).then((SQL) => {
    let db;
    if (fs.existsSync(dbPath)) {
      db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      db = new SQL.Database();
    }
    try {
      applyFiscalSchema({
        exec: (sql) => db.exec(sql),
        run: (sql) => db.run(sql),
      });
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
    } finally {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

module.exports = {
  initFiscalDB,
  getFiscalDbPath,
  fiscalReceiptUpdate,
  deleteTestFiscalReceipts,
  validateFiscalReceiptInsert,
  insertFiscalReceipt,
  RECEIPT_UPDATE_ALLOWED,
  isAllowedReceiptUpdateField,
  REQUIRED_RECEIPT_FIELDS,
};
