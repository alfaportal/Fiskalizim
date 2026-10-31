"use strict";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeCashAmount(v) {
  const n = round2(v);
  if (n < 0) throw new Error("Shuma nuk mund të jetë negative.");
  return n;
}

function isCardPayment(method) {
  const m = String(method || "")
    .trim()
    .toLowerCase();
  return (
    m === "karte" ||
    m === "card" ||
    m === "kartë" ||
    m === "debit_card" ||
    m === "credit_card" ||
    m === "pos"
  );
}

function cashFromOrderRow(row) {
  const total = round2(row.total);
  let items = {};
  try {
    items = JSON.parse(row.items_json || "{}");
  } catch {
    items = {};
  }
  const splits = Array.isArray(items.payment_splits) ? items.payment_splits : [];
  if (splits.length) {
    return round2(
      splits
        .filter((p) => !isCardPayment(p.method))
        .reduce((s, p) => s + round2(p.amount), 0)
    );
  }
  return isCardPayment(row.payment_method) ? 0 : total;
}

function cardFromOrderRow(row) {
  const total = round2(row.total);
  let items = {};
  try {
    items = JSON.parse(row.items_json || "{}");
  } catch {
    items = {};
  }
  const splits = Array.isArray(items.payment_splits) ? items.payment_splits : [];
  if (splits.length) {
    return round2(
      splits
        .filter((p) => isCardPayment(p.method))
        .reduce((s, p) => s + round2(p.amount), 0)
    );
  }
  return isCardPayment(row.payment_method) ? total : 0;
}

function initPosShiftSchema(sqlite) {
  sqliteRef = sqlite;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pos_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL,
      operator_name TEXT NOT NULL DEFAULT '',
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      opening_cash REAL,
      closing_cash_actual REAL,
      expected_closing_cash REAL,
      cash_difference REAL,
      cash_sales_total REAL,
      card_sales_total REAL,
      order_count_total INTEGER,
      total_sales REAL,
      discount_total REAL,
      handed_over_to TEXT NOT NULL DEFAULT '',
      handover_status TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pos_shifts_operator_open ON pos_shifts(operator_id, closed_at);
  `);
  try {
    sqlite.prepare(`ALTER TABLE orders ADD COLUMN shift_id INTEGER`).run();
  } catch {
    /* */
  }
  try {
    sqlite.prepare(`ALTER TABLE orders ADD COLUMN operator_id INTEGER`).run();
  } catch {
    /* */
  }
}

function getOpenPosShift(operatorId) {
  const oid = Number(operatorId);
  if (!oid) return null;
  return sqliteRef
    .prepare(
      `SELECT * FROM pos_shifts WHERE operator_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1`
    )
    .get(oid);
}

function computePosShiftTotals(shiftId) {
  const sid = Number(shiftId);
  if (!sid) {
    return {
      order_count: 0,
      total_sales: 0,
      cash_total: 0,
      card_total: 0,
      discount_total: 0,
    };
  }
  const rows = sqliteRef
    .prepare(
      `SELECT total, payment_method, items_json, discount_total FROM orders
       WHERE COALESCE(status,'completed') = 'completed' AND shift_id = ?`
    )
    .all(sid);
  let cash = 0;
  let card = 0;
  let discount = 0;
  let sales = 0;
  for (const row of rows) {
    sales += round2(row.total);
    discount += round2(row.discount_total);
    cash += cashFromOrderRow(row);
    card += cardFromOrderRow(row);
  }
  return {
    order_count: rows.length,
    total_sales: round2(sales),
    cash_total: round2(cash),
    card_total: round2(card),
    discount_total: round2(discount),
  };
}

function computePosShiftTotalsInRange(shiftId, from, to) {
  const sid = Number(shiftId);
  const f = String(from || "").slice(0, 10);
  const t = String(to || "").slice(0, 10);
  if (!sid || !f || !t) {
    return {
      order_count: 0,
      total_sales: 0,
      cash_total: 0,
      card_total: 0,
      discount_total: 0,
    };
  }
  const rows = sqliteRef
    .prepare(
      `SELECT total, payment_method, items_json, discount_total FROM orders
       WHERE COALESCE(status,'completed') = 'completed' AND shift_id = ?
         AND date(created_at) >= date(?) AND date(created_at) <= date(?)`
    )
    .all(sid, f, t);
  let cash = 0;
  let card = 0;
  let discount = 0;
  let sales = 0;
  for (const row of rows) {
    sales += round2(row.total);
    discount += round2(row.discount_total);
    cash += cashFromOrderRow(row);
    card += cardFromOrderRow(row);
  }
  return {
    order_count: rows.length,
    total_sales: round2(sales),
    cash_total: round2(cash),
    card_total: round2(card),
    discount_total: round2(discount),
  };
}

function buildPosShiftSummary(shift, operatorId, operatorName) {
  const totals = shift
    ? computePosShiftTotals(shift.id)
    : {
        order_count: 0,
        total_sales: 0,
        cash_total: 0,
        card_total: 0,
        discount_total: 0,
      };
  const opening = shift && shift.opening_cash != null ? round2(shift.opening_cash) : null;
  const drawerCash = opening != null ? round2(opening + totals.cash_total) : null;
  return {
    shift_id: shift?.id || null,
    operator_id: Number(operatorId) || null,
    operator_name: operatorName || shift?.operator_name || "",
    shift_open: !!shift,
    opening_cash: opening,
    needs_opening_cash: !!(shift && shift.opening_cash == null),
    cash_total: totals.cash_total,
    card_total: totals.card_total,
    total_sales: totals.total_sales,
    order_count: totals.order_count,
    discount_total: totals.discount_total,
    drawer_cash: drawerCash,
    expected_closing_cash: drawerCash,
  };
}

function getPosShiftSummary(operatorId, operatorName) {
  const oid = Number(operatorId);
  if (!oid) throw new Error("Operatori i panjohur.");
  const shift = getOpenPosShift(oid);
  return buildPosShiftSummary(shift, oid, operatorName);
}

function openPosShift(operatorId, operatorName, openingCash) {
  const oid = Number(operatorId);
  if (!oid) throw new Error("Operatori i panjohur.");
  const name = String(operatorName || "").trim() || "Operator";
  const amount = normalizeCashAmount(openingCash);
  const existing = getOpenPosShift(oid);
  if (existing) {
    if (existing.opening_cash != null) {
      throw new Error("Nderrimi është hapur tashmë.");
    }
    sqliteRef.prepare(`UPDATE pos_shifts SET opening_cash = ? WHERE id = ?`).run(amount, existing.id);
    const shift = sqliteRef.prepare(`SELECT * FROM pos_shifts WHERE id = ?`).get(existing.id);
    return buildPosShiftSummary(shift, oid, name);
  }
  const now = new Date().toISOString();
  const r = sqliteRef
    .prepare(
      `INSERT INTO pos_shifts (operator_id, operator_name, opened_at, opening_cash)
       VALUES (?, ?, ?, ?)`
    )
    .run(oid, name, now, amount);
  const shift = sqliteRef.prepare(`SELECT * FROM pos_shifts WHERE id = ?`).get(r.lastInsertRowid);
  return buildPosShiftSummary(shift, oid, name);
}

function ensurePosShiftRow(operatorId, operatorName) {
  const oid = Number(operatorId);
  if (!oid) throw new Error("Operatori i panjohur.");
  let shift = getOpenPosShift(oid);
  if (shift) return shift;
  const now = new Date().toISOString();
  const name = String(operatorName || "").trim() || "Operator";
  const r = sqliteRef
    .prepare(
      `INSERT INTO pos_shifts (operator_id, operator_name, opened_at, opening_cash)
       VALUES (?, ?, ?, NULL)`
    )
    .run(oid, name, now);
  return sqliteRef.prepare(`SELECT * FROM pos_shifts WHERE id = ?`).get(r.lastInsertRowid);
}

function assertShiftReadyForSale(operatorId, operatorName) {
  const shift = ensurePosShiftRow(operatorId, operatorName);
  if (shift.opening_cash == null) {
    const err = new Error("Hap nderrimin — vendos paratë në arkë para shitjes.");
    err.code = "SHIFT_OPENING_REQUIRED";
    throw err;
  }
  return shift;
}

function defaultHandoverRecipientName() {
  const row = sqliteRef
    .prepare(`SELECT name FROM operators WHERE active = 1 ORDER BY id ASC LIMIT 1`)
    .get();
  return String(row?.name || "").trim() || "Pronari";
}

function shiftTotalsForListRow(row, from, to) {
  if (row.closed_at != null && row.cash_sales_total != null && row.total_sales != null) {
    return {
      order_count: Number(row.order_count_total) || 0,
      total_sales: round2(row.total_sales),
      cash_total: round2(row.cash_sales_total),
      card_total: round2(row.card_sales_total),
      discount_total: round2(row.discount_total),
    };
  }
  if (row.closed_at == null) {
    return computePosShiftTotals(row.id);
  }
  return computePosShiftTotalsInRange(row.id, from, to);
}

function mapPosShiftListRow(row, from, to) {
  const open = row.opened_at ? String(row.opened_at).slice(0, 16).replace("T", " ") : "—";
  const closed = row.closed_at ? String(row.closed_at).slice(0, 16).replace("T", " ") : "—";
  const totals = shiftTotalsForListRow(row, from, to);
  const opening = row.opening_cash != null ? round2(row.opening_cash) : null;
  const expectedStored =
    row.expected_closing_cash != null ? round2(row.expected_closing_cash) : null;
  const expectedLive = opening != null ? round2(opening + totals.cash_total) : null;
  return {
    id: row.id,
    operator_id: row.operator_id,
    operator_name: row.operator_name || "",
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    open_label: open,
    close_label: closed,
    is_open: row.closed_at == null,
    opening_cash: opening,
    closing_cash_actual: row.closing_cash_actual != null ? round2(row.closing_cash_actual) : null,
    expected_closing_cash: expectedStored != null ? expectedStored : expectedLive,
    cash_difference: row.cash_difference != null ? round2(row.cash_difference) : null,
    ...totals,
  };
}

function listPosShiftsInRange(from, to) {
  const f = String(from || "").slice(0, 10);
  const t = String(to || "").slice(0, 10);
  if (!f || !t) return [];
  const rows = sqliteRef
    .prepare(
      `SELECT * FROM pos_shifts
       WHERE (date(opened_at) >= date(?) AND date(opened_at) <= date(?))
          OR (closed_at IS NOT NULL AND date(closed_at) >= date(?) AND date(closed_at) <= date(?))
          OR id IN (
            SELECT DISTINCT shift_id FROM orders
            WHERE shift_id IS NOT NULL
              AND COALESCE(status,'completed') = 'completed'
              AND date(created_at) >= date(?) AND date(created_at) <= date(?)
          )
       ORDER BY datetime(COALESCE(closed_at, opened_at)) DESC, id DESC`
    )
    .all(f, t, f, t, f, t);
  return rows.map((row) => mapPosShiftListRow(row, f, t));
}

function closePosShift(operatorId, closingCashActual) {
  const oid = Number(operatorId);
  if (!oid) throw new Error("Operatori i panjohur.");
  const shift = getOpenPosShift(oid);
  if (!shift) throw new Error("Nuk ka nderrim aktiv.");
  if (shift.opening_cash == null) {
    throw new Error("Plotësoni fillimisht paratë e nisjes.");
  }
  const totals = computePosShiftTotals(shift.id);
  const opening = round2(shift.opening_cash);
  const actual = normalizeCashAmount(closingCashActual);
  const expected = round2(opening + totals.cash_total);
  const difference = round2(actual - expected);
  const closedAt = new Date().toISOString();
  const handedTo = defaultHandoverRecipientName();
  sqliteRef
    .prepare(
      `UPDATE pos_shifts SET
        closed_at = ?,
        closing_cash_actual = ?,
        expected_closing_cash = ?,
        cash_difference = ?,
        cash_sales_total = ?,
        card_sales_total = ?,
        order_count_total = ?,
        total_sales = ?,
        discount_total = ?,
        handed_over_to = ?,
        handover_status = ?
       WHERE id = ?`
    )
    .run(
      closedAt,
      actual,
      expected,
      difference,
      totals.cash_total,
      totals.card_total,
      totals.order_count,
      totals.total_sales,
      totals.discount_total,
      handedTo,
      "Pranuar",
      shift.id
    );
  return {
    shift_id: shift.id,
    operator_id: oid,
    operator_name: shift.operator_name,
    opened_at: shift.opened_at,
    closed_at: closedAt,
    opening_cash: opening,
    closing_cash_actual: actual,
    expected_closing_cash: expected,
    cash_difference: difference,
    cash_sales_total: totals.cash_total,
    card_sales_total: totals.card_total,
    cash_total: totals.cash_total,
    card_total: totals.card_total,
    total_sales: totals.total_sales,
    order_count: totals.order_count,
    discount_total: totals.discount_total,
    handed_over_to: handedTo,
    handover_status: "Pranuar",
  };
}

let sqliteRef = null;

function bindPosShiftDb(sqlite) {
  sqliteRef = sqlite;
}

module.exports = {
  bindPosShiftDb,
  initPosShiftSchema,
  getOpenPosShift,
  getPosShiftSummary,
  openPosShift,
  closePosShift,
  assertShiftReadyForSale,
  computePosShiftTotals,
  listPosShiftsInRange,
  cashFromOrderRow,
  cardFromOrderRow,
};
