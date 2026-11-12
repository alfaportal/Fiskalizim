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
    m === "sms" ||
    m === "check" ||
    m === "bank_account" ||
    m === "voucher" ||
    m === "pos"
  );
}

function rowPaymentSplits(row) {
  if (row && row.payment_splits_json) {
    try {
      const raw = typeof row.payment_splits_json === "string" ? JSON.parse(row.payment_splits_json) : row.payment_splits_json;
      if (Array.isArray(raw) && raw.length) return raw;
    } catch {
      /* */
    }
  }
  let items = {};
  try {
    items = JSON.parse(row.items_json || "{}");
  } catch {
    items = {};
  }
  return Array.isArray(items.payment_splits) ? items.payment_splits : [];
}

function splitCashCard(row) {
  const total = round2(row.total);
  const splits = rowPaymentSplits(row);
  if (!splits.length) {
    if (isCardPayment(row.payment_method)) return { cash: 0, card: total };
    return { cash: total, card: 0 };
  }
  let cash = 0;
  let card = 0;
  for (const p of splits) {
    const amt = round2(p.amount);
    if (isCardPayment(p.method)) card += amt;
    else cash += amt;
  }
  cash = round2(cash);
  card = round2(card);
  const sum = round2(cash + card);
  if (Math.abs(sum - total) > 0.009 && Math.abs(sum) > 0.009) {
    const scale = total / sum;
    cash = round2(cash * scale);
    card = round2(total - cash);
  } else if (Math.abs(sum - total) > 0.009) {
    if (isCardPayment(row.payment_method)) return { cash: 0, card: total };
    return { cash: total, card: 0 };
  }
  return { cash, card };
}

function cashFromOrderRow(row) {
  return splitCashCard(row).cash;
}

function cardFromOrderRow(row) {
  return splitCashCard(row).card;
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

function thermalCorrectionRows(shiftId, from, to) {
  if (!sqliteRef) return [];
  try {
    if (from && to) {
      return sqliteRef
        .prepare(
          `SELECT total, payment_method, items_json
           FROM orders
           WHERE shift_id = ?
             AND ref_order_id IS NOT NULL
             AND correction_type IN ('return','cancel','storno','exchange')
             AND date(created_at) >= date(?) AND date(created_at) <= date(?)`
        )
        .all(shiftId, from, to);
    }
    return sqliteRef
      .prepare(
        `SELECT total, payment_method, items_json
         FROM orders
         WHERE shift_id = ?
           AND ref_order_id IS NOT NULL
           AND correction_type IN ('return','cancel','storno','exchange')`
      )
      .all(shiftId);
  } catch {
    return [];
  }
}

function correctionRowsForShift(shiftId, from, to) {
  if (!sqliteRef) return [];
  try {
    if (from && to) {
      return sqliteRef
        .prepare(
          `SELECT fr.total_amount AS total, fr.payment_method, fr.items_json, fr.payment_splits_json
           FROM fiscal_receipts fr
           INNER JOIN orders o ON o.id = fr.sale_id
           WHERE o.shift_id = ?
             AND lower(COALESCE(fr.receipt_type, '')) IN ('cancel', 'storno', 'return')
             AND date(fr.created_at) >= date(?) AND date(fr.created_at) <= date(?)`
        )
        .all(shiftId, from, to);
    }
    return sqliteRef
      .prepare(
        `SELECT fr.total_amount AS total, fr.payment_method, fr.items_json, fr.payment_splits_json
         FROM fiscal_receipts fr
         INNER JOIN orders o ON o.id = fr.sale_id
         WHERE o.shift_id = ?
           AND lower(COALESCE(fr.receipt_type, '')) IN ('cancel', 'storno', 'return')`
      )
      .all(shiftId);
  } catch {
    return [];
  }
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
  for (const row of correctionRowsForShift(sid)) {
    sales += round2(row.total);
    cash += cashFromOrderRow(row);
    card += cardFromOrderRow(row);
  }
  for (const row of thermalCorrectionRows(sid)) {
    sales += round2(row.total);
    cash += cashFromOrderRow(row);
    card += cardFromOrderRow(row);
  }
  const shiftRow = sqliteRef.prepare("SELECT operator_id, opened_at FROM pos_shifts WHERE id = ?").get(sid);
  const day = localDateKey(shiftRow && shiftRow.opened_at);
  if (day && shiftRow && shiftRow.operator_id != null) {
    for (const row of fiscalCorrectionsOnDayOutsideShift(sid, shiftRow.operator_id, day)) {
      sales += round2(row.total);
      cash += cashFromOrderRow(row);
      card += cardFromOrderRow(row);
    }
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
  for (const row of correctionRowsForShift(sid, f, t)) {
    sales += round2(row.total);
    cash += cashFromOrderRow(row);
    card += cardFromOrderRow(row);
  }
  for (const row of thermalCorrectionRows(sid, f, t)) {
    sales += round2(row.total);
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

function localDateKey(value) {
  const raw = String(value || "").trim();
  const head = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head) && raw.indexOf("Z") < 0 && raw.indexOf("+") < 0) return head;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localTodayKey() {
  const row = sqliteRef.prepare("SELECT date('now','localtime') AS d").get();
  return String((row && row.d) || localDateKey(new Date()));
}

function fiscalCorrectionsOnDayOutsideShift(shiftId, operatorId, day) {
  try {
    return sqliteRef
      .prepare(
        `SELECT fr.total_amount AS total, fr.payment_method, fr.items_json, fr.payment_splits_json
         FROM fiscal_receipts fr
         INNER JOIN orders o ON o.id = fr.sale_id
         WHERE lower(COALESCE(fr.receipt_type, '')) IN ('cancel', 'storno', 'return')
           AND date(fr.created_at) = date(?)
           AND (o.shift_id IS NULL OR o.shift_id != ?)
           AND o.operator_id = ?`
      )
      .all(day, shiftId, operatorId);
  } catch {
    return [];
  }
}

function attachDayOrders(shiftId, operatorId, day, onlyOpen) {
  if (onlyOpen) {
    sqliteRef
      .prepare(
        `UPDATE orders SET shift_id = ?
         WHERE shift_id IS NULL AND date(created_at) = date(?)`
      )
      .run(shiftId, day);
    return;
  }
  sqliteRef
    .prepare(
      `UPDATE orders SET shift_id = ?
       WHERE shift_id IS NULL AND date(created_at) = date(?) AND operator_id = ?`
    )
    .run(shiftId, day, operatorId);
}

function sealPosShiftForDay(shiftId, closedAt) {
  const shift = sqliteRef.prepare("SELECT * FROM pos_shifts WHERE id = ?").get(shiftId);
  if (!shift || (shift.closed_at && String(shift.closed_at).trim())) return;
  const openedDay = localDateKey(shift.opened_at);
  const totals = openedDay
    ? computePosShiftTotalsInRange(shiftId, openedDay, openedDay)
    : computePosShiftTotals(shiftId);
  const opening = shift.opening_cash != null ? round2(shift.opening_cash) : 0;
  const cash = round2(totals.cash_total);
  const expected = round2(opening + cash);
  sqliteRef
    .prepare(
      `UPDATE pos_shifts SET
        closed_at = ?,
        opening_cash = ?,
        closing_cash_actual = ?,
        expected_closing_cash = ?,
        cash_difference = 0,
        cash_sales_total = ?,
        card_sales_total = ?,
        order_count_total = ?,
        total_sales = ?,
        discount_total = ?
      WHERE id = ?`
    )
    .run(
      closedAt,
      opening,
      expected,
      expected,
      cash,
      round2(totals.card_total),
      Number(totals.order_count) || 0,
      round2(totals.total_sales),
      round2(totals.discount_total),
      shiftId,
    );
}

function openFreshPosShift(shift, day) {
  const r = sqliteRef
    .prepare(
      `INSERT INTO pos_shifts (operator_id, operator_name, opened_at, opening_cash)
       VALUES (?, ?, ?, 0)`
    )
    .run(shift.operator_id, shift.operator_name, `${day}T00:00:01`);
  return Number(r.lastInsertRowid);
}

let shiftDayRollBusy = false;

function rollOpenPosShiftsToLocalDay() {
  if (!sqliteRef || shiftDayRollBusy) return;
  shiftDayRollBusy = true;
  try {
    const today = localTodayKey();
    const openShifts = sqliteRef
      .prepare(
        `SELECT * FROM pos_shifts
         WHERE closed_at IS NULL OR TRIM(COALESCE(closed_at, '')) = ''`
      )
      .all();
    const onlyOpen = openShifts.length === 1;
    for (const shift of openShifts) {
      const openedDay = localDateKey(shift.opened_at);
      if (!openedDay) continue;
      if (openedDay >= today) {
        if (openedDay === today) attachDayOrders(shift.id, shift.operator_id, today, onlyOpen);
        continue;
      }
      sqliteRef.transaction(() => {
        const fresh = sqliteRef.prepare("SELECT * FROM pos_shifts WHERE id = ?").get(shift.id);
        if (!fresh || (fresh.closed_at && String(fresh.closed_at).trim())) return;
        const opened = localDateKey(fresh.opened_at);
        if (!opened || opened >= today) return;
        const dayRows = sqliteRef
          .prepare(
            `SELECT DISTINCT date(created_at) AS d FROM orders
             WHERE shift_id = ? AND created_at IS NOT NULL AND TRIM(created_at) != ''`
          )
          .all(fresh.id);
        const pastDays = dayRows
          .map((row) => String(row.d || ""))
          .filter((d) => d && d < today && d !== opened);
        const todayId = openFreshPosShift(fresh, today);
        sqliteRef
          .prepare(
            `UPDATE orders SET shift_id = ?
             WHERE shift_id = ? AND date(created_at) = date(?)`
          )
          .run(todayId, fresh.id, today);
        attachDayOrders(todayId, fresh.operator_id, today, onlyOpen);
        for (const day of pastDays) {
          const midId = openFreshPosShift(fresh, day);
          sqliteRef
            .prepare(
              `UPDATE orders SET shift_id = ?
               WHERE shift_id = ? AND date(created_at) = date(?)`
            )
            .run(midId, fresh.id, day);
          sealPosShiftForDay(midId, `${day}T23:59:59`);
        }
        attachDayOrders(fresh.id, fresh.operator_id, opened, onlyOpen);
        sealPosShiftForDay(fresh.id, `${opened}T23:59:59`);
      })();
    }
  } finally {
    shiftDayRollBusy = false;
  }
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
  rollOpenPosShiftsToLocalDay();
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

function parsePosOrderItems(itemsJson) {
  let payload = {};
  try {
    payload = JSON.parse(itemsJson || "{}");
  } catch {
    payload = {};
  }
  const list = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(list)) return [];
  return list
    .map((it) => ({
      name: String(it.name || it.product_name || "").trim(),
      quantity: Number(it.quantity ?? it.qty) || 1,
      price: Number(it.price ?? it.unit_price) || 0,
    }))
    .filter((it) => it.name && it.quantity > 0);
}

function getPosShiftSalesDetail(shiftId) {
  const sid = Number(shiftId);
  if (!sid) {
    return { orders: [], item_summary: [], totals: computePosShiftTotals(0) };
  }
  const rows = sqliteRef
    .prepare(
      `SELECT id, total, payment_method, items_json, discount_total, created_at
       FROM orders WHERE status = 'completed' AND shift_id = ?
       ORDER BY datetime(created_at) ASC, id ASC`
    )
    .all(sid);
  const orders = rows.map((e) => {
    const items = parsePosOrderItems(e.items_json);
    return {
      total: round2(e.total),
      payment_method: e.payment_method || "cash",
      discount_total: round2(e.discount_total),
      items,
    };
  });
  const itemMap = new Map();
  for (const order of orders) {
    for (const it of order.items) {
      const key = it.name.toLowerCase();
      const line = round2(it.price * it.quantity);
      const prev = itemMap.get(key);
      if (prev) {
        prev.quantity += it.quantity;
        prev.line_total = round2(prev.line_total + line);
      } else {
        itemMap.set(key, {
          name: it.name,
          price: it.price,
          quantity: it.quantity,
          line_total: line,
        });
      }
    }
  }
  const item_summary = [...itemMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "sq")
  );
  return {
    orders,
    item_summary,
    totals: computePosShiftTotals(sid),
  };
}

function buildPosShiftZReportData(shiftId) {
  const sid = Number(shiftId);
  const row = sqliteRef.prepare(`SELECT * FROM pos_shifts WHERE id = ?`).get(sid);
  if (!row) throw new Error("Nderrimi nuk u gjet.");
  if (!row.closed_at) throw new Error("Ky nderrim nuk është mbyllur ende.");
  const totals = computePosShiftTotals(row.id);
  return {
    shift_id: row.id,
    waiter_name: row.operator_name || "",
    opened_by: row.operator_name || "",
    closed_by: row.operator_name || "",
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    opening_cash: Number(row.opening_cash) || 0,
    closing_cash_actual:
      row.closing_cash_actual != null ? Number(row.closing_cash_actual) : null,
    expected_closing_cash:
      row.expected_closing_cash != null ? Number(row.expected_closing_cash) : null,
    cash_difference: Number(row.cash_difference) || 0,
    closing_reason: row.closing_reason || "",
    order_count: totals.order_count,
    total_sales: totals.total_sales,
    cash_total: totals.cash_total,
    card_total: totals.card_total,
    discount_total: totals.discount_total,
    by_category: [],
    item_summary: getPosShiftSalesDetail(sid).item_summary || [],
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
  rollOpenPosShiftsToLocalDay,
  openPosShift,
  closePosShift,
  buildPosShiftZReportData,
  getPosShiftSalesDetail,
  assertShiftReadyForSale,
  computePosShiftTotals,
  listPosShiftsInRange,
  cashFromOrderRow,
  cardFromOrderRow,
};
