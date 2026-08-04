/**
 * fiscal/fiscal-numbering.js — HAPI 5: numri ditor, NUIKF, SEF identifier.
 * Thirret VETËM kur isFiscalEnabled()=true. Nuk prek raportin Z ekzistues.
 */
const crypto = require("crypto");
const { isFiscalEnabled } = require("./fiscal-config");

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const NUIKF_LEN = 16;
const NUIKF_MAX_TRIES = 32;

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ensureSettingsRow(sqlite) {
  const row = sqlite.prepare("SELECT id FROM fiscal_settings WHERE id = 1").get();
  if (!row) {
    sqlite
      .prepare(
        `INSERT INTO fiscal_settings (id, fiscal_enabled, language, developer_nui, daily_receipt_counter)
         VALUES (1, 0, 'sq', '811314567', 0)`
      )
      .run();
  }
}

function todayLocalYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function assertFiscalOn() {
  if (!isFiscalEnabled()) return false;
  return true;
}

/**
 * Numri i radhës ditor (1, 2, 3...).
 * Rrit daily_receipt_counter; nëse data ≠ last_z_report_date → fillon nga 1.
 * Kur fillon dita e re, përditësohet last_z_report_date=sot që numërimi të vazhdojë 2,3,...
 * (resetDailyCounter e vendos counter=0 + last_z=sot pas raportit Z).
 */
function getNextDailyNumber() {
  if (!assertFiscalOn()) return null;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);

  const row = sqlite
    .prepare(
      `SELECT daily_receipt_counter, last_z_report_date FROM fiscal_settings WHERE id = 1`
    )
    .get();

  const today = todayLocalYmd();
  const lastZ = row?.last_z_report_date ? String(row.last_z_report_date).slice(0, 10) : "";
  let next;
  let setDate = lastZ;

  if (!lastZ || lastZ !== today) {
    // Ditë e re që nga Z / dita e fundit e numërimit → fillo nga 1
    next = 1;
    setDate = today;
  } else {
    next = (Number(row.daily_receipt_counter) || 0) + 1;
    if (next < 1) next = 1;
  }

  sqlite
    .prepare(
      `UPDATE fiscal_settings SET
        daily_receipt_counter = ?,
        last_z_report_date = ?,
        updated_at = datetime('now','localtime')
      WHERE id = 1`
    )
    .run(next, setDate);

  return next;
}

/**
 * Reseton numrin ditor pas Përmbledhjes Ditore (mbyllja fiskale).
 * Thirret nga onDailySummaryPrinted — vetëm 1× në ditë.
 * NUK prek total_receipt_counter (numri rendor total nuk rifillon kurrë).
 */
function resetDailyCounter() {
  if (!assertFiscalOn()) return false;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);
  const today = todayLocalYmd();

  sqlite
    .prepare(
      `UPDATE fiscal_settings SET
        daily_receipt_counter = 0,
        last_z_report_date = ?,
        updated_at = datetime('now','localtime')
      WHERE id = 1`
    )
    .run(today);

  return true;
}

/**
 * Numri rendor total i kuponit (1, 2, 3...) — NUK rifillon kurrë (as pas Z).
 */
function getNextTotalNumber() {
  if (!assertFiscalOn()) return null;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);

  // Siguro kolonën në DB të vjetër
  try {
    sqlite
      .prepare(
        `ALTER TABLE fiscal_settings ADD COLUMN total_receipt_counter INTEGER DEFAULT 0`
      )
      .run();
  } catch {
    /* already exists */
  }

  const row = sqlite
    .prepare(`SELECT total_receipt_counter FROM fiscal_settings WHERE id = 1`)
    .get();
  let next = (Number(row?.total_receipt_counter) || 0) + 1;
  if (next < 1) next = 1;

  sqlite
    .prepare(
      `UPDATE fiscal_settings SET
        total_receipt_counter = ?,
        updated_at = datetime('now','localtime')
      WHERE id = 1`
    )
    .run(next);

  return next;
}

function randomAlphanum(len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHANUM[bytes[i] % ALPHANUM.length];
  }
  return out;
}

function nuikfExists(sqlite, nuikf) {
  const row = sqlite
    .prepare(`SELECT 1 AS ok FROM fiscal_receipts WHERE nuikf = ? LIMIT 1`)
    .get(nuikf);
  return !!row;
}

/**
 * NUIKF — max 16 karaktere alfanumerike, unik në fiscal_receipts.
 * Format: timestamp(base36) + counter + random → padded/trimmed në 16.
 */
function generateNUIKF() {
  if (!assertFiscalOn()) return null;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);

  const counterRow = sqlite
    .prepare(`SELECT daily_receipt_counter FROM fiscal_settings WHERE id = 1`)
    .get();
  const counter = Number(counterRow?.daily_receipt_counter) || 0;

  for (let attempt = 0; attempt < NUIKF_MAX_TRIES; attempt++) {
    const ts = Date.now().toString(36).toUpperCase(); // ~8–9 chars
    const ctr = counter.toString(36).toUpperCase().padStart(2, "0");
    const rnd = randomAlphanum(8);
    // timestamp + counter + random, pastaj trim/pad në 16
    let candidate = (ts + ctr + rnd).replace(/[^A-Z0-9]/g, "");
    if (candidate.length > NUIKF_LEN) {
      candidate = candidate.slice(0, NUIKF_LEN);
    } else if (candidate.length < NUIKF_LEN) {
      candidate = (candidate + randomAlphanum(NUIKF_LEN)).slice(0, NUIKF_LEN);
    }

    if (!nuikfExists(sqlite, candidate)) {
      return candidate;
    }
  }

  throw new Error("Nuk u gjenerua NUIKF unik pas disa përpjekjeve");
}

/**
 * Nr. Identifikues SEF (ATK Neni 25): [Numri i Njësisë ARBK]-[NUI]-[PosID]
 * p.sh. "5130484-812345678-11"
 * JO NUI-NUI-PosID.
 */
function getSefIdentifier() {
  if (!assertFiscalOn()) return null;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);

  // Siguro kolonën unit_number në DB të vjetër
  try {
    sqlite
      .prepare(`ALTER TABLE fiscal_settings ADD COLUMN unit_number TEXT`)
      .run();
  } catch {
    /* already exists */
  }

  let row;
  try {
    row = sqlite
      .prepare(
        `SELECT unit_number, business_unit_number, taxpayer_nui, developer_nui, pos_id
         FROM fiscal_settings WHERE id = 1`
      )
      .get();
  } catch {
    row = sqlite
      .prepare(
        `SELECT business_unit_number, taxpayer_nui, developer_nui, pos_id
         FROM fiscal_settings WHERE id = 1`
      )
      .get();
  }

  const unitNumber = String(
    (row && row.unit_number) ||
      (row && row.business_unit_number) ||
      ""
  )
    .trim()
    .replace(/[^\d]/g, "");

  const nui = String(
    (row?.taxpayer_nui && String(row.taxpayer_nui).trim()) ||
      (row?.developer_nui && String(row.developer_nui).trim()) ||
      ""
  ).replace(/[^\d]/g, "");

  if (!unitNumber || !nui) {
    return null;
  }

  let posId = row?.pos_id != null ? String(row.pos_id).trim() : "";
  if (!posId) posId = "01";
  // Normë e shkurtër për POS (p.sh. 1 → 01) — shembulli ATK lejon edhe "11"
  if (/^\d+$/.test(posId) && posId.length === 1) {
    posId = posId.padStart(2, "0");
  }

  return `${unitNumber}-${nui}-${posId}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Akumulimi ditor i kuponëve fiskalë (lexim — pa reset, pa mbyllje).
 * TVSH = shuma e vat_breakdown të ruajtur (residual tashmë në çdo kupon).
 */
function getDailyFiscalAccumulated(dateYmd) {
  if (!assertFiscalOn()) return null;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);
  const day = dateYmd || todayLocalYmd();

  const rows = sqlite
    .prepare(
      `SELECT total_amount, total_without_tax, vat_breakdown_json, is_offline
       FROM fiscal_receipts
       WHERE date(created_at) = date(?)`
    )
    .all(day);

  const vat_breakdown = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let coupon_count = 0;
  let total_amount = 0;
  let total_without_tax = 0;
  let offline_count = 0;

  for (const r of rows) {
    coupon_count += 1;
    total_amount += Number(r.total_amount) || 0;
    total_without_tax += Number(r.total_without_tax) || 0;
    if (Number(r.is_offline) === 1) offline_count += 1;
    let vb = {};
    try {
      vb =
        typeof r.vat_breakdown_json === "string"
          ? JSON.parse(r.vat_breakdown_json || "{}")
          : r.vat_breakdown_json || {};
    } catch {
      vb = {};
    }
    for (const L of ["A", "B", "C", "D", "E"]) {
      vat_breakdown[L] += Number(vb[L] ?? vb[L.toLowerCase()] ?? 0) || 0;
    }
  }

  for (const L of ["A", "B", "C", "D", "E"]) {
    vat_breakdown[L] = round2(vat_breakdown[L]);
  }

  return {
    date: day,
    coupon_count,
    total_amount: round2(total_amount),
    total_without_tax: round2(total_without_tax),
    vat_breakdown,
    offline_count,
  };
}

function parseDateRange(fromDate, toDate) {
  const from = String(fromDate || "").slice(0, 10);
  const to = String(toDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("Datat duhet YYYY-MM-DD");
  }
  if (from > to) throw new Error("Data Nga duhet ≤ Deri");
  return { from, to };
}

function emptyVatMap() {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function nowFiscalStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return {
    fiscalization_date: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`,
    fiscalization_time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    fiscalization_datetime: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Akumulim i plotë për raportet periodike (qarkullim + tatim + pagesa).
 */
function accumulateReceiptsInRange(from, to) {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      `SELECT total_amount, total_without_tax, vat_breakdown_json, items_json,
              payment_method, is_offline, sent_to_atk, created_at
       FROM fiscal_receipts
       WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)`
    )
    .all(from, to);

  const { calculateVatBreakdown } = require("./fiscal-vat");
  const vat_tax = emptyVatMap();
  const vat_turnover = emptyVatMap();
  const payments = Object.create(null);
  let coupon_count = 0;
  let total_amount = 0;
  let total_without_tax = 0;
  let offline_count = 0;
  let unsent_count = 0;

  for (const r of rows) {
    coupon_count += 1;
    total_amount += Number(r.total_amount) || 0;
    total_without_tax += Number(r.total_without_tax) || 0;
    if (Number(r.is_offline) === 1) offline_count += 1;
    if (Number(r.sent_to_atk) !== 1) unsent_count += 1;

    const pay = String(r.payment_method || "cash").toLowerCase();
    payments[pay] = round2((payments[pay] || 0) + (Number(r.total_amount) || 0));

    let vb = {};
    try {
      vb =
        typeof r.vat_breakdown_json === "string"
          ? JSON.parse(r.vat_breakdown_json || "{}")
          : r.vat_breakdown_json || {};
    } catch {
      vb = {};
    }
    for (const L of ["A", "B", "C", "D", "E"]) {
      vat_tax[L] += Number(vb[L] ?? vb[L.toLowerCase()] ?? 0) || 0;
    }

    let items = [];
    try {
      items =
        typeof r.items_json === "string"
          ? JSON.parse(r.items_json || "[]")
          : r.items_json || [];
    } catch {
      items = [];
    }
    const turnover = calculateVatBreakdown(Array.isArray(items) ? items : []) || emptyVatMap();
    for (const L of ["A", "B", "C", "D", "E"]) {
      vat_turnover[L] += Number(turnover[L]) || 0;
    }
  }

  for (const L of ["A", "B", "C", "D", "E"]) {
    vat_tax[L] = round2(vat_tax[L]);
    vat_turnover[L] = round2(vat_turnover[L]);
  }

  const total_tax = round2(
    ["A", "B", "C", "D", "E"].reduce((s, L) => s + vat_tax[L], 0)
  );

  return {
    coupon_count,
    rfd_count: coupon_count,
    total_amount: round2(total_amount),
    total_without_tax: round2(total_without_tax),
    total_tax,
    vat_breakdown: vat_tax,
    vat_turnover,
    payments,
    offline_count,
    unsent_count,
  };
}

function countRamResetsInRange(from, to) {
  const sqlite = getSqlite();
  try {
    const row = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM fiscal_audit_log
         WHERE action = 'z_report'
           AND date(created_at) >= date(?)
           AND date(created_at) <= date(?)`
      )
      .get(from, to);
    return Number(row?.c) || 0;
  } catch {
    return 0;
  }
}

/**
 * Raport periodik — akumulim mes dy datave (YYYY-MM-DD), pa reset / pa mbyllje.
 */
function getPeriodicFiscalReport(fromDate, toDate, operatorName, operatorId) {
  if (!assertFiscalOn()) return null;

  const { from, to } = parseDateRange(fromDate, toDate);
  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);

  const acc = accumulateReceiptsInRange(from, to);

  const details = {
    source: "periodic_report",
    mode: "PERIODIC",
    from_date: from,
    to_date: to,
    date: `${from} → ${to}`,
    coupon_count: acc.coupon_count,
    total_amount: acc.total_amount,
    total_without_tax: acc.total_without_tax,
    vat_breakdown: acc.vat_breakdown,
    offline_count: acc.offline_count,
    reset_applied: false,
    official_close: false,
  };

  try {
    const { logFiscalAction } = require("./fiscal-audit");
    logFiscalAction(
      "periodic_report",
      details,
      operatorName != null ? String(operatorName) : "Admin",
      operatorId != null ? String(operatorId) : "ADMIN"
    );
  } catch {
    /* */
  }

  return details;
}

/**
 * Raporti i shkurtër periodik (Neni 13 / 7) — përmbledhje totale, jo rresht-për-rresht.
 */
function getShortPeriodicFiscalReport(fromDate, toDate, operatorName, operatorId) {
  if (!assertFiscalOn()) return null;

  const { from, to } = parseDateRange(fromDate, toDate);
  ensureSettingsRow(getSqlite());
  const acc = accumulateReceiptsInRange(from, to);
  const stamp = nowFiscalStamp();

  const details = {
    source: "short_periodic_report",
    mode: "SHORT_PERIODIC",
    report_name: "RAPORT FISKAL PERIODIK I PËRMBLEDHUR",
    from_date: from,
    to_date: to,
    date: `${from} → ${to}`,
    ...stamp,
    coupon_count: acc.coupon_count,
    rfd_count: acc.rfd_count,
    total_amount: acc.total_amount,
    total_without_tax: acc.total_without_tax,
    total_tax: acc.total_tax,
    vat_turnover: acc.vat_turnover,
    vat_breakdown: acc.vat_breakdown,
    offline_count: acc.offline_count,
    reset_applied: false,
    official_close: false,
  };

  try {
    const { logFiscalAction } = require("./fiscal-audit");
    logFiscalAction(
      "short_periodic_report",
      details,
      operatorName != null ? String(operatorName) : "Admin",
      operatorId != null ? String(operatorId) : "ADMIN"
    );
  } catch {
    /* */
  }

  return details;
}

/**
 * Raporti mujor i memories fiskale të transferuar në ATK (Neni 11 / 9).
 */
function getMonthlyFiscalMemoryReport(fromDate, toDate, operatorName, operatorId) {
  if (!assertFiscalOn()) return null;

  let from;
  let to;
  if (fromDate && toDate) {
    ({ from, to } = parseDateRange(fromDate, toDate));
  } else {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const pad = (n) => String(n).padStart(2, "0");
    from = `${y}-${pad(m)}-01`;
    const last = new Date(y, m, 0).getDate();
    to = `${y}-${pad(m)}-${pad(last)}`;
  }

  ensureSettingsRow(getSqlite());
  const acc = accumulateReceiptsInRange(from, to);
  const stamp = nowFiscalStamp();
  const ram_resets = countRamResetsInRange(from, to);

  // Placeholder derisa ATK real: OK nëse s'ka kuponë të padërguar në periudhë
  const transmission_ok = acc.unsent_count === 0;
  const transmission_text = transmission_ok ? "Transmetimi OK" : "Transmetimi jo OK";

  const details = {
    source: "monthly_memory_report",
    mode: "MONTHLY_MEMORY",
    report_name: "RAPORTI MUJOR I MEMORIES FISKALE",
    from_date: from,
    to_date: to,
    date: `${from} → ${to}`,
    ...stamp,
    coupon_count: acc.coupon_count,
    rfd_count: acc.rfd_count,
    total_amount: acc.total_amount,
    total_without_tax: acc.total_without_tax,
    total_tax: acc.total_tax,
    vat_breakdown: acc.vat_breakdown,
    payments: acc.payments,
    ram_resets,
    transmission_ok,
    transmission_text,
    unsent_count: acc.unsent_count,
    offline_count: acc.offline_count,
    reset_applied: false,
    official_close: false,
  };

  try {
    const { logFiscalAction } = require("./fiscal-audit");
    logFiscalAction(
      "monthly_memory_report",
      details,
      operatorName != null ? String(operatorName) : "Admin",
      operatorId != null ? String(operatorId) : "ADMIN"
    );
  } catch {
    /* */
  }

  return details;
}

/**
 * Modi X (Neni 10 / 3.1) — gjendja aktuale e ditës, pa reset numri ditor.
 * Mund të thirret shumë herë. Nuk shënon mbyllje zyrtare.
 */
function getXReportSnapshot(operatorName, operatorId) {
  if (!assertFiscalOn()) return null;

  const acc = getDailyFiscalAccumulated();
  if (!acc) return null;

  const details = {
    source: "x_report",
    mode: "X",
    ...acc,
    reset_applied: false,
    official_close: false,
  };

  try {
    const { logFiscalAction } = require("./fiscal-audit");
    logFiscalAction(
      "x_report",
      details,
      operatorName != null ? String(operatorName) : "Admin",
      operatorId != null ? String(operatorId) : "ADMIN"
    );
  } catch {
    /* audit opsional — nuk bllokon printimin X */
  }

  return details;
}

/**
 * Pas Përmbledhjes Ditore (mbyllja fiskale ditore ATK).
 * - Logon stats në fiscal_audit_log (action=z_report)
 * - Reseton numrin ditor VETËM 1× në ditë (last_z_report_date !== sot)
 * Kur fiscal OFF → null (asnjë efekt).
 */
function onDailySummaryPrinted(operatorName, operatorId) {
  if (!assertFiscalOn()) return null;

  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);
  const today = todayLocalYmd();

  const settingsRow = sqlite
    .prepare(
      `SELECT last_z_report_date, daily_receipt_counter FROM fiscal_settings WHERE id = 1`
    )
    .get();
  const lastZ = settingsRow?.last_z_report_date
    ? String(settingsRow.last_z_report_date).slice(0, 10)
    : "";
  const alreadyClosedToday = lastZ === today;

  const acc = getDailyFiscalAccumulated(today) || {
    date: today,
    coupon_count: 0,
    total_amount: 0,
    total_without_tax: 0,
    vat_breakdown: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    offline_count: 0,
  };

  let rfdCreated = 0;
  try {
    const ctr = sqlite
      .prepare(`SELECT total_receipt_counter FROM fiscal_settings WHERE id = 1`)
      .get();
    const cnt = sqlite.prepare(`SELECT COUNT(*) AS c FROM fiscal_receipts`).get();
    rfdCreated = Math.max(
      Number(ctr?.total_receipt_counter) || 0,
      Number(cnt?.c) || 0
    );
  } catch {
    rfdCreated = Number(acc.coupon_count) || 0;
  }

  const details = {
    source: "daily_summary",
    mode: "Z",
    ...acc,
    daily_receipt_counter_before: Number(settingsRow?.daily_receipt_counter) || 0,
    rfd_created_count: rfdCreated,
    reset_applied: false,
    official_close: true,
  };

  let resetApplied = false;
  if (!alreadyClosedToday) {
    resetApplied = !!resetDailyCounter();
  }
  details.reset_applied = resetApplied;

  const { logFiscalAction } = require("./fiscal-audit");
  logFiscalAction(
    "z_report",
    details,
    operatorName != null ? String(operatorName) : "Admin",
    operatorId != null ? String(operatorId) : "ADMIN"
  );

  return details;
}

module.exports = {
  getNextDailyNumber,
  getNextTotalNumber,
  resetDailyCounter,
  generateNUIKF,
  getSefIdentifier,
  getDailyFiscalAccumulated,
  getXReportSnapshot,
  getPeriodicFiscalReport,
  getShortPeriodicFiscalReport,
  getMonthlyFiscalMemoryReport,
  onDailySummaryPrinted,
};
