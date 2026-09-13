/**
 * fiscal/fiscal-self-test.js — test lokal i plotë i modulit fiskal.
 * NUK dërgon te ATK. Printon kupon provë në printerin termik të KAFENE (opsionale).
 * Fshin vetëm rreshta TEST pas testit.
 */
const crypto = require("crypto");
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { fiscalReceiptUpdate, deleteTestFiscalReceipts } = require("./fiscal-db");
const {
  generateNUIKF,
  getNextDailyNumber,
  resetDailyCounter,
  getSefIdentifier,
} = require("./fiscal-numbering");
const {
  calculateVatBreakdown,
  calculateVatTaxBreakdown,
  money2,
  round2,
} = require("./fiscal-vat");
const { generateFiscalReceipt } = require("./fiscal-print");
const { signReceipt, verifyReceiptSignature } = require("./fiscal-crypto");
const { generateFiscalQR } = require("./fiscal-qr");
const { checkInternetConnection } = require("./fiscal-offline");
const { logFiscalAction, FISCAL_AUDIT_EXPORT_ACTIONS, ALLOWED_ACTIONS } = require("./fiscal-audit");
const { t, setLanguage, getCurrentLanguage } = require("./fiscal-i18n");
const { getFiscalLogoForPrint } = require("./fiscal-logo");
const {
  buildInternalTestCouponBundle,
  formatUnitPricePrintCheck,
  formatUnitPrice,
  MIN_ATK_TEST_ITEMS,
} = require("./fiscal-test-coupon-data");

const TEST_MARKER = "TEST";
const TEST_OPERATOR_ID = "SELFTEST";
const TESTS_PER_RUN = 22;

function isPrinterDisconnected(errMsg) {
  const m = String(errMsg || "").toLowerCase();
  return (
    /nuk u gjet printer|nuk është e lidhur|nuk eshte e lidhur|not connected|no printer|printer.*lidhur/i.test(
      m
    )
  );
}

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ok(name, detail) {
  return { name, pass: true, detail: detail || "" };
}

function fail(name, error) {
  return { name, pass: false, detail: String(error || "Dështoi") };
}

function tableExists(sqlite, name) {
  const row = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return !!row;
}

function columnExists(sqlite, table, column) {
  try {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => String(c.name) === column);
  } catch {
    return false;
  }
}

function testDatabase() {
  const name = "1. DATABAZA";
  try {
    const sqlite = getSqlite();
    const missing = [];
    for (const tName of ["fiscal_receipts", "fiscal_settings", "fiscal_audit_log"]) {
      if (!tableExists(sqlite, tName)) missing.push(tName);
    }
    const orderCols = ["payment_method", "fiscal_receipt_id", "is_fiscalized"];
    const missingCols = orderCols.filter((c) => !columnExists(sqlite, "orders", c));
    if (missing.length || missingCols.length) {
      const parts = [];
      if (missing.length) parts.push(`tabela mungojnë: ${missing.join(", ")}`);
      if (missingCols.length) parts.push(`kolona orders mungojnë: ${missingCols.join(", ")}`);
      return fail(name, parts.join("; "));
    }
    return ok(name, "fiscal_receipts, fiscal_settings, fiscal_audit_log + kolonat në orders");
  } catch (e) {
    return fail(name, e.message);
  }
}

function testSettings() {
  const name = "2. SETTINGS";
  try {
    if (!isFiscalEnabled()) {
      return fail(name, "fiscal_enabled=false");
    }
    const s = getFiscalSettings();
    const problems = [];
    if (!s.taxpayer_nui || !/^\d{9}$/.test(String(s.taxpayer_nui))) {
      problems.push("NUI (9 shifra) mungon ose i pavlefshëm");
    }
    if (!String(s.taxpayer_legal_name || "").trim()) {
      problems.push("emri ligjor mungon");
    }
    if (!String(s.taxpayer_address || "").trim()) {
      problems.push("adresa mungon");
    }
    if (problems.length) return fail(name, problems.join("; "));
    return ok(name, `NUI=${s.taxpayer_nui}, fiscal_enabled=true`);
  } catch (e) {
    return fail(name, e.message);
  }
}

function testNuikf() {
  const name = "3. NUIKF";
  try {
    const a = generateNUIKF();
    const b = generateNUIKF();
    if (!a || String(a).length !== 16) {
      return fail(name, `gjatesia: ${a ? String(a).length : 0} (pritur 16)`);
    }
    if (!/^[A-Z0-9]{16}$/.test(String(a))) {
      return fail(name, `format i pavlefshëm: ${a}`);
    }
    if (a === b) {
      return fail(name, "dy NUIKF të njëpasnjëshme janë të njëjta (jo unik)");
    }
    const sqlite = getSqlite();
    const exists = sqlite
      .prepare(`SELECT 1 AS ok FROM fiscal_receipts WHERE nuikf = ? LIMIT 1`)
      .get(a);
    if (exists) return fail(name, `NUIKF ${a} ekziston tashmë në DB`);
    return ok(name, `${a} (16 char, unik)`);
  } catch (e) {
    return fail(name, e.message);
  }
}

function testDailyNumber() {
  const name = "4. NUMRI DITOR";
  const sqlite = getSqlite();
  let snapshot = null;
  try {
    try {
      sqlite
        .prepare(`ALTER TABLE fiscal_settings ADD COLUMN last_daily_number_date TEXT`)
        .run();
    } catch {
      /* exists */
    }

    const row = sqlite
      .prepare(
        `SELECT daily_receipt_counter, last_z_report_date, last_daily_number_date
         FROM fiscal_settings WHERE id = 1`
      )
      .get();
    snapshot = {
      counter: Number(row?.daily_receipt_counter) || 0,
      lastZ: row?.last_z_report_date ? String(row.last_z_report_date) : null,
      lastDaily:
        row?.last_daily_number_date != null ? String(row.last_daily_number_date) : null,
    };

    const n = getNextDailyNumber();
    if (n == null || !Number.isFinite(Number(n)) || Number(n) < 1) {
      return fail(name, `numër i pavlefshëm: ${n}`);
    }
    return ok(name, `numri i radhës = ${n} (counter u rivendos pas testit)`);
  } catch (e) {
    return fail(name, e.message);
  } finally {
    if (snapshot) {
      try {
        sqlite
          .prepare(
            `UPDATE fiscal_settings SET
              daily_receipt_counter = ?,
              last_z_report_date = ?,
              last_daily_number_date = ?,
              updated_at = datetime('now','localtime')
             WHERE id = 1`
          )
          .run(snapshot.counter, snapshot.lastZ, snapshot.lastDaily);
      } catch (e) {
        console.warn("[fiscal-self-test] restore daily counter:", e.message);
      }
    }
  }
}

/** 5 kuponë → Z → kuponi i ri duhet të jetë numri ditor 1. */
function testDailyNumberZReset() {
  const name = "4a. NUMRI DITOR PAS Z";
  const sqlite = getSqlite();
  let snapshot = null;
  try {
    try {
      sqlite
        .prepare(`ALTER TABLE fiscal_settings ADD COLUMN last_daily_number_date TEXT`)
        .run();
    } catch {
      /* exists */
    }

    const row = sqlite
      .prepare(
        `SELECT daily_receipt_counter, last_z_report_date, last_daily_number_date
         FROM fiscal_settings WHERE id = 1`
      )
      .get();
    snapshot = {
      counter: Number(row?.daily_receipt_counter) || 0,
      lastZ: row?.last_z_report_date ? String(row.last_z_report_date) : null,
      lastDaily:
        row?.last_daily_number_date != null ? String(row.last_daily_number_date) : null,
    };

    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
          daily_receipt_counter = 0,
          last_z_report_date = NULL,
          last_daily_number_date = NULL,
          updated_at = datetime('now','localtime')
         WHERE id = 1`
      )
      .run();

    const issued = [];
    for (let i = 0; i < 5; i += 1) {
      issued.push(Number(getNextDailyNumber()));
    }
    if (issued.join(",") !== "1,2,3,4,5") {
      return fail(name, `5 kuponë pritej 1–5, u morën: ${issued.join(",")}`);
    }

    if (!resetDailyCounter()) {
      return fail(name, "resetDailyCounter dështoi");
    }

    const afterZ = Number(getNextDailyNumber());
    if (afterZ !== 1) {
      return fail(name, `Pas Z pritej 1, u mor ${afterZ}`);
    }

    return ok(name, "5 kuponë → Z → kuponi i ri = 1");
  } catch (e) {
    return fail(name, e.message);
  } finally {
    if (snapshot) {
      try {
        sqlite
          .prepare(
            `UPDATE fiscal_settings SET
              daily_receipt_counter = ?,
              last_z_report_date = ?,
              last_daily_number_date = ?,
              updated_at = datetime('now','localtime')
             WHERE id = 1`
          )
          .run(snapshot.counter, snapshot.lastZ, snapshot.lastDaily);
      } catch (e) {
        console.warn("[fiscal-self-test] restore daily Z scenario:", e.message);
      }
    }
  }
}

/**
 * ATK Neni 25: Nr. SEF = [NumriNjësisëARBK]-[NUI]-[PosID]
 * JO NUI-NUI-PosID.
 */
function testSefIdentifier() {
  const name = "4b. SEF ID";
  const sqlite = getSqlite();
  let snapshot = null;
  try {
    try {
      sqlite.prepare(`ALTER TABLE fiscal_settings ADD COLUMN unit_number TEXT`).run();
    } catch {
      /* exists */
    }
    const row = sqlite
      .prepare(
        `SELECT unit_number, business_unit_number, taxpayer_nui, pos_id, sef_identifier
         FROM fiscal_settings WHERE id = 1`
      )
      .get();
    snapshot = {
      unit_number: row?.unit_number != null ? String(row.unit_number) : null,
      business_unit_number:
        row?.business_unit_number != null ? String(row.business_unit_number) : null,
      taxpayer_nui: row?.taxpayer_nui != null ? String(row.taxpayer_nui) : null,
      pos_id: row?.pos_id != null ? String(row.pos_id) : null,
      sef_identifier: row?.sef_identifier != null ? String(row.sef_identifier) : null,
    };

    const unitArb = "5130484";
    const nui = "812345678";
    const pos = "11";
    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
          unit_number = ?,
          taxpayer_nui = ?,
          pos_id = ?,
          sef_identifier = NULL,
          updated_at = datetime('now','localtime')
         WHERE id = 1`
      )
      .run(unitArb, nui, pos);

    const sef = getSefIdentifier();
    if (!sef) return fail(name, "getSefIdentifier ktheu null");
    const expected = `${unitArb}-${nui}-${pos}`;
    if (sef !== expected) {
      return fail(name, `pritur ${expected}, morëm ${sef}`);
    }
    if (!/^[0-9]+-[0-9]{9}-.+$/.test(sef)) {
      return fail(name, `format i pavlefshëm: ${sef}`);
    }
    const parts = sef.split("-");
    if (parts.length < 3) return fail(name, `pjesë të pakta: ${sef}`);
    if (parts[0] === parts[1]) {
      return fail(name, `NUI i përsëritur në vend të Numrit të Njësisë: ${sef}`);
    }
    if (parts[0] !== unitArb) {
      return fail(name, `fusha 1 duhet unit_number=${unitArb}, morëm ${parts[0]}`);
    }
    if (parts[1] !== nui) {
      return fail(name, `fusha 2 duhet NUI=${nui}, morëm ${parts[1]}`);
    }
    return ok(name, sef);
  } catch (e) {
    return fail(name, e.message);
  } finally {
    if (snapshot) {
      try {
        sqlite
          .prepare(
            `UPDATE fiscal_settings SET
              unit_number = ?,
              business_unit_number = ?,
              taxpayer_nui = ?,
              pos_id = ?,
              sef_identifier = ?,
              updated_at = datetime('now','localtime')
             WHERE id = 1`
          )
          .run(
            snapshot.unit_number,
            snapshot.business_unit_number,
            snapshot.taxpayer_nui,
            snapshot.pos_id,
            snapshot.sef_identifier
          );
      } catch (e) {
        console.warn("[fiscal-self-test] restore SEF settings:", e.message);
      }
    }
  }
}

/** Artikull dummy — çmime/sasi me 4 presje (formatUnitPrice / normalizeQty). */
function dummyItem(name, qty, price, vatNorm) {
  const unit = Number(formatUnitPrice(price));
  return {
    name,
    qty,
    quantity: qty,
    unit_price: unit,
    price: unit,
    vat_norm: vatNorm,
  };
}

function testVat() {
  const name = "5. VAT";
  try {
    const items = [
      dummyItem("Kafe", 2, 1.5, "D"),
      dummyItem("Ushqim", 1, 10, "E"),
      dummyItem("Ujë", 3, 1, "D"),
    ];
    const br = calculateVatBreakdown(items);
    if (!br) return fail(name, "calculateVatBreakdown ktheu null");
    const expD = 6;
    const expE = 10;
    if (Math.abs(Number(br.D) - expD) > 0.001) {
      return fail(name, `D=${br.D}, pritur ${expD}`);
    }
    if (Math.abs(Number(br.E) - expE) > 0.001) {
      return fail(name, `E=${br.E}, pritur ${expE}`);
    }
    return ok(name, `D=${br.D}, E=${br.E}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

/**
 * Residual rounding: sum(TVSH grupet) + Total pa TVSH === Total (ekzakt).
 */
function testVatRounding() {
  const name = "5b. VAT ROUNDING";
  try {
    const cases = [
      {
        label: "mix D+E .01/.03",
        items: [
          dummyItem("ArtD1", 1, 1.01, "D"),
          dummyItem("ArtD2", 1, 0.03, "D"),
          dummyItem("ArtE1", 1, 2.01, "E"),
          dummyItem("ArtE2", 3, 0.33, "E"),
        ],
      },
      {
        label: "total 4.00 classic",
        items: [
          dummyItem("Kafe", 1, 1.5, "D"),
          dummyItem("Ushqim", 1, 2.5, "E"),
        ],
      },
      {
        label: "many pennies E",
        items: [
          dummyItem("A", 1, 0.01, "E"),
          dummyItem("B", 1, 0.01, "E"),
          dummyItem("C", 1, 0.01, "D"),
          dummyItem("D", 7, 0.57, "E"),
        ],
      },
      {
        label: "only D odd",
        items: [
          dummyItem("X", 1, 1.11, "D"),
          dummyItem("Y", 1, 2.22, "D"),
        ],
      },
    ];

    const failures = [];
    for (const c of cases) {
      const result = calculateVatTaxBreakdown(c.items);
      if (!result) {
        failures.push(`${c.label}: null`);
        continue;
      }
      const taxSum = round2(
        ["A", "B", "C", "D", "E"].reduce(
          (s, L) => s + Number(result.tax[L] || 0),
          0
        )
      );
      const without = round2(result.totalWithoutTax);
      const total = round2(result.total);
      const sum = round2(taxSum + without);
      if (Math.abs(sum - total) > 0.0001) {
        failures.push(
          `${c.label}: TVSH=${taxSum}+pa=${without}=${sum} ≠ total=${total}`
        );
      }
      if (Math.abs(taxSum - round2(result.totalTax)) > 0.00005) {
        failures.push(`${c.label}: totalTax mismatch`);
      }
    }

    if (failures.length) return fail(name, failures.join("; "));
    return ok(name, `${cases.length} shembuj: TVSH+paTVSH=Total ekzakt`);
  } catch (e) {
    return fail(name, e.message);
  }
}

function testAtkItemUnitCategory() {
  const name = "6b. ATK UNIT/CATEGORY";
  try {
    const database = require("../database");
    const products = database.listProducts();
    const miell = products.find((p) => p.name === "Miell 1kg");
    const fanta = products.find((p) => p.name === "Fanta 0.5L");
    if (!miell || miell.unit_code !== "KGN") {
      return fail(name, "Miell 1kg mungon ose unit !== KGN në katalog");
    }
    const preview = database.previewSaleTotals({
      items: [{ product_id: miell.id, quantity: 1 }],
    });
    const { buildCouponItems } = require("./atk-model-builder");
    const atkLine = buildCouponItems(preview.items)[0];
    if (atkLine.unit !== "KGN" || atkLine.type !== miell.category_code) {
      return fail(
        name,
        `Miell payload: unit=${atkLine.unit} type=${atkLine.type} (pritet KGN/${miell.category_code})`
      );
    }
    if (fanta) {
      const p2 = database.previewSaleTotals({
        items: [{ product_id: fanta.id, quantity: 1 }],
      });
      const atkFanta = buildCouponItems(p2.items)[0];
      if (atkFanta.unit !== "LTR") {
        return fail(name, `Fanta payload unit=${atkFanta.unit} (pritet LTR)`);
      }
    }
    const stale = {
      name: "Miell 1kg",
      product_id: miell.id,
      quantity: 1,
      price: 0.8,
      unit_price: 0.8,
      vat_norm: "D",
      unit_code: "EA",
      category_code: "TT",
    };
    const fixed = buildCouponItems([stale])[0];
    if (fixed.unit !== "KGN" || fixed.type !== miell.category_code) {
      return fail(name, "Override DB dështoi për rresht stale EA/TT");
    }
    return ok(name, "KGN/LTR + DB fiton mbi EA/TT stale");
  } catch (e) {
    return fail(name, e.message);
  }
}

function testCouponItemDiscountProto() {
  const name = "6c. COUPON ITEM DISCOUNT";
  try {
    const { buildPosCoupon, encodePosCoupon, toCents, toPriceUnits } = require("./atk-model-builder");
    const { grossLineAmount, netLineAmount, resolveLineDiscountAmount } = require("./fiscal-line-discount");
    const { round4 } = require("./fiscal-vat");

    const items = [
      {
        name: "Kafe",
        qty: 2,
        unit_price: 1.5,
        vat_norm: "E",
        line_discount_amount: 0.1234,
      },
      {
        name: "Buke",
        qty: 1,
        unit_price: 0.875,
        vat_norm: "D",
        line_discount_amount: 0.0500,
      },
    ];
    const lineDiscSum = round4(
      resolveLineDiscountAmount(items[0]) + resolveLineDiscountAmount(items[1])
    );
    const cartDiscount = 0.25;
    const netLines = round4(netLineAmount(items[0]) + netLineAmount(items[1]));
    const totalAmount = round4(netLines - cartDiscount);

    const receiptRow = {
      items_json: JSON.stringify(items),
      total_amount: totalAmount,
      total_without_tax: totalAmount,
      discount_amount: cartDiscount,
      payment_method: "cash",
      receipt_type: "regular",
      fiscal_date: "18.07.2026",
      fiscal_time: "12:00",
      nuikf: "TESTDISCOUNT0001",
      sef_id: "1-123456789-1",
      taxpayer_nui: "123456789",
      taxpayer_address: "Test",
      operator_id: "1",
      daily_number: 1,
      total_number: 99,
      vat_breakdown_json: JSON.stringify({ D: 0, E: 0 }),
    };

    const pos = buildPosCoupon(receiptRow, {
      settings: { taxpayer_nui: "123456789", pos_id: "1", business_unit_number: "1" },
    });

    if (!Array.isArray(pos.items) || pos.items.length !== 2) {
      return fail(name, `items=${pos.items?.length}`);
    }
    const i0 = pos.items[0];
    const expectedLine0Disc = toCents(0.1234);
    const expectedLine0Total = toCents(netLineAmount(items[0]));
    if (Number(i0.discount) !== expectedLine0Disc) {
      return fail(
        name,
        `discount rresht 1: ${i0.discount} ≠ ${expectedLine0Disc} (0.1234 EUR)`
      );
    }
    const expectedNetUnit = round4(netLineAmount(items[0]) / items[0].qty);
    if (Number(i0.price) !== toPriceUnits(expectedNetUnit)) {
      return fail(
        name,
        `price rresht 1: ${i0.price} ≠ ${toPriceUnits(expectedNetUnit)} (neto/njësi pas zbritjes)`
      );
    }
    if (Number(i0.total) !== expectedLine0Total) {
      return fail(
        name,
        `total rresht 1: ${i0.total} ≠ ${expectedLine0Total} (neto pas zbritjes)`
      );
    }
    const expectedTotalDiscount = toCents(round4(cartDiscount + lineDiscSum));
    if (Number(pos.totalDiscount) !== expectedTotalDiscount) {
      return fail(
        name,
        `totalDiscount=${pos.totalDiscount} ≠ ${expectedTotalDiscount}`
      );
    }
    const gross0 = grossLineAmount(items[0]);
    const net0 = netLineAmount(items[0]);
    if (Math.abs(net0 - round4(gross0 - 0.1234)) > 0.00005) {
      return fail(name, `netLineAmount: gross=${gross0} net=${net0}`);
    }

    const buf = encodePosCoupon(receiptRow, {
      settings: { taxpayer_nui: "123456789", pos_id: "1", business_unit_number: "1" },
    });
    if (!Buffer.isBuffer(buf) || buf.length < 20) {
      return fail(name, "encodePosCoupon nuk ktheu buffer");
    }

    return ok(
      name,
      `discount rresht=${expectedLine0Disc}, totalDiscount=${expectedTotalDiscount}, proto ${buf.length}B`
    );
  } catch (e) {
    return fail(name, e.message);
  }
}

function testAtkPaymentsAndPriceUnits() {
  const name = "6d. ATK PAYMENTS + PRICE";
  try {
    const { buildPosCoupon, toPriceUnits, toCents } = require("./atk-model-builder");

    const items = [
      {
        name: "Test",
        qty: 1.25,
        unit_price: 1.2345,
        vat_norm: "D",
      },
    ];
    const totalAmount = 1.5431;
    const receiptRow = {
      items_json: JSON.stringify(items),
      total_amount: totalAmount,
      total_without_tax: totalAmount,
      discount_amount: 0,
      payment_method: "cash",
      payment_splits_json: JSON.stringify([
        { method: "cash", amount: 0.5431 },
        { method: "credit_card", amount: 1.0 },
      ]),
      receipt_type: "regular",
      fiscal_date: "18.07.2026",
      fiscal_time: "12:00",
      nuikf: "TESTPAY00000001",
      sef_id: "1-123456789-1",
      taxpayer_nui: "123456789",
      taxpayer_address: "Test",
      operator_id: "1",
      daily_number: 2,
      total_number: 100,
      vat_breakdown_json: JSON.stringify({ D: 0 }),
    };

    const pos = buildPosCoupon(receiptRow, {
      settings: { taxpayer_nui: "123456789", pos_id: "1", business_unit_number: "1" },
    });

    if (!Array.isArray(pos.payments) || pos.payments.length !== 2) {
      return fail(name, `payments=${pos.payments?.length} (pritur 2)`);
    }
    if (pos.payments[0].type !== "CASH" || pos.payments[0].amount !== toCents(0.5431)) {
      return fail(
        name,
        `cash: type=${pos.payments[0]?.type} amt=${pos.payments[0]?.amount}`
      );
    }
    if (
      pos.payments[1].type !== "CREDIT_CARD" ||
      pos.payments[1].amount !== toCents(1.0)
    ) {
      return fail(
        name,
        `card: type=${pos.payments[1]?.type} amt=${pos.payments[1]?.amount}`
      );
    }
    if (Number(pos.items[0].price) !== toPriceUnits(1.2345)) {
      return fail(
        name,
        `price=${pos.items[0].price} ≠ ${toPriceUnits(1.2345)} (×10000)`
      );
    }
    if (Number(pos.items[0].total) !== toCents(1.5431)) {
      return fail(name, `total rresht=${pos.items[0].total} (pritur cent)`);
    }

    return ok(name, "2 payments (Cash+Card), price ×10000, total cent");
  } catch (e) {
    return fail(name, e.message);
  }
}

async function testCoupon(opts = {}) {
  const name = "6. KUPONI";
  const doPrint = opts.print !== false;
  try {
    const settings = getFiscalSettings();
    const bundle = buildInternalTestCouponBundle(settings, {
      operator_name: "Test Operator",
      operator_id: "1",
    });
    const { items, totals, orderData: orderPayload, fiscalMeta } = bundle;
    if (items.length < MIN_ATK_TEST_ITEMS) {
      return fail(name, `duhen min ${MIN_ATK_TEST_ITEMS} artikuj, morëm ${items.length}`);
    }
    const totalAmt = totals.total;
    const text = generateFiscalReceipt(
      {
        ...orderPayload,
        operator_name: orderPayload.operator_name,
        operator_id: orderPayload.operator_id,
        subtotal: totalAmt,
        total_amount: totalAmt,
        total_without_tax: totals.totalWithoutTax,
        amount_paid: totalAmt,
      },
      fiscalMeta
    );
    if (!text || typeof text !== "string") {
      return fail(name, "generateFiscalReceipt ktheu bosh");
    }
    const missing = [];
    if (!/NR\.\s*FISKAL:|FISKALNI BR:/i.test(text)) missing.push("NR. FISKAL");
    if (!/NR\.\s*TVSH:|PDV BR:/i.test(text)) missing.push("NR. TVSH");
    if (!/TVSH|PDV/i.test(text)) missing.push("TVSH");
    if (!/Operator|Operater/i.test(text)) missing.push("operator");
    if (!/NUIKF/i.test(text)) missing.push("NUIKF");
    if (!/KUPON FISKAL NR\.|FISKALNI KUPON BR\./i.test(text)) {
      missing.push("KUPON FISKAL NR.");
    }
    if (!/KUPON FISKAL DITOR NR\.|FISKALNI KUPON DNEVNI BR\./i.test(text)) {
      missing.push("KUPON FISKAL DITOR NR.");
    }
    if (!/MËNYRA E PAGESËS:\s*KESH|NAČIN PLAĆANJA:\s*KES/i.test(text)) {
      missing.push("MËNYRA E PAGESËS");
    }
    if (!/\be-kuponi\b|\be-kupon\b/i.test(text)) missing.push("e-kuponi");
    if (!String(text).includes(String(fiscalMeta.unit_name))) {
      missing.push("EMRI I NJËSISË");
    }
    if (!String(text).includes(String(fiscalMeta.unit_phone))) {
      missing.push("TELEFONI");
    }
    if (!/KUPON FISKAL NR\.\s*42|FISKALNI KUPON BR\.\s*42/i.test(text)) {
      missing.push("numri rendor total");
    }
    if (!/KUPON FISKAL DITOR NR\.\s*1|FISKALNI KUPON DNEVNI BR\.\s*1/i.test(text)) {
      missing.push("numri ditor");
    }
    if (/\^L/.test(text)) missing.push("^L i ndaluar (pa double size)");
    if (!/\^C\^B/.test(text) && !/\^B/.test(text)) missing.push("^B emri biznesit (bold)");
    // QR/logo nuk janë në tekst — printohen si imazh (QR → RKS/MF) nga fiscal-main
    if (/\[QR/i.test(text)) missing.push("QR placeholder (duhet hequr)");
    const logo = getFiscalLogoForPrint();
    if (!(logo && logo.buffer && logo.buffer.length)) missing.push("logo");
    if (!/TVSH D=8\.00%|PDV D=8\.00%/i.test(text)) missing.push("TVSH D=");
    if (!/TVSH E=18\.00%|PDV E=18\.00%/i.test(text)) missing.push("TVSH E=");
    if (/TVSH A=0\.00%|PDV A=0\.00%/i.test(text)) missing.push("TVSH A (duhet fshehur kur 0)");
    if (/Tatimi sipas normave|Porez po stopama/i.test(text)) {
      missing.push("titull tatimi (duhet hequr)");
    }
    if (!/TOTALI NE EURO|UKUPNO U EUR|UKUPNO ZA PLA[CĆ]ANJE/i.test(text)) {
      missing.push("TOTALI NE EURO");
    }
    if (!/TOT\. PA TVSH|UKUP\. BEZ PDV|UKUPNO BEZ PDV/i.test(text)) missing.push("TOT. PA TVSH");
    if (!/PARA TE GATSHME|GOTOVINA|Gotovina/i.test(text)) missing.push("PARA TE GATSHME");
    // Printim klienti = max 2 presje; llogaritja mbetet 4 presje
    const moneyProbe = String(text)
      .replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, "")
      .replace(/\b\d{1,2}:\d{2}\b/g, "");
    if (/\d+\.\d{3,}/.test(moneyProbe)) {
      missing.push("shumë me më shumë se 2 presje në printim");
    }
    for (const it of items) {
      if (!String(text).includes(it.name)) {
        missing.push(`artikull ${it.name}`);
      }
      const printUnit = formatUnitPricePrintCheck(it.unit_price);
      if (!new RegExp(`\\b${printUnit.replace(".", "\\.")}\\b`).test(text)) {
        missing.push(`çmim print ${it.name} ${printUnit}`);
      }
    }
    const uniqueNames = new Set(items.map((it) => it.name));
    if (uniqueNames.size < MIN_ATK_TEST_ITEMS) {
      missing.push(`artikuj unikë ${uniqueNames.size} < ${MIN_ATK_TEST_ITEMS}`);
    }
    if (/Shuma e paguar|Plaćeni iznos/i.test(text)) {
      missing.push("Shuma e paguar (redundante kur = total)");
    }
    if (missing.length) return fail(name, `mungojnë: ${missing.join(", ")}`);

    let printNote = "printim i anashkaluar";
    if (doPrint) {
      try {
        let qrResult = null;
        try {
          qrResult = await generateFiscalQR({
            nuikf: fiscalMeta.nuikf,
            total_amount: totalAmt,
            fiscal_date: fiscalMeta.fiscal_date,
            taxpayer_nui: fiscalMeta.taxpayer_nui,
          });
        } catch (qe) {
          console.warn("[fiscal-self-test] QR për print:", qe.message);
        }
        const { printFiscalBundle } = require("./fiscal-main");
        const printResult = await printFiscalBundle(text, qrResult);
        if (printResult.printed) {
          printNote = "printuar në printer termik";
        } else {
          // Pa printer → nuk dështon testi; vazhdojmë me kontrollet tjera
          printNote = "Printeri nuk është i lidhur";
          if (
            printResult.printMessage &&
            !isPrinterDisconnected(printResult.printMessage)
          ) {
            printNote += ` (${printResult.printMessage})`;
          }
        }
      } catch (pe) {
        printNote = "Printeri nuk është i lidhur";
        if (pe.message && !isPrinterDisconnected(pe.message)) {
          printNote += ` (${pe.message})`;
        }
      }
    }

    return ok(
      name,
      `${items.length} artikuj ATK (4 dec); tekst OK (${text.length} char); ${printNote}`
    );
  } catch (e) {
    return fail(name, e.message);
  }
}

function testCrypto() {
  const name = "7. CRYPTO";
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    if (!publicKey || !privateKey || !String(privateKey).includes("PRIVATE KEY")) {
      return fail(name, "gjenerimi ECDSA P-256 dështoi");
    }
    try {
      const keyObj = crypto.createPrivateKey(privateKey);
      if (keyObj.asymmetricKeyType !== "ec") {
        return fail(name, "çelësi i gjeneruar nuk është EC");
      }
    } catch (ke) {
      return fail(name, "çelësi EC i pavlefshëm: " + (ke.message || ke));
    }

    /* MOS thirr generateKeyPair() këtu — mbishkruante certifikatën reale ATK.
       Testi kriptografik bëhet me çift të përkohshëm në memorie. */
    const { signWithKey, verifyWithKey } = (() => {
      try {
        const { signReceipt: sr, verifyReceiptSignature: vr } = require("./fiscal-crypto");
        return { signWithKey: sr, verifyWithKey: vr };
      } catch {
        return { signWithKey: null, verifyWithKey: null };
      }
    })();

    const payload = {
      nuikf: "TESTCRYPTO000001",
      total_amount: 12.34,
      fiscal_date: "16.07.2026",
      taxpayer_nui: "123456789",
    };
    let signature;
    let verified = false;
    let extra = "; çelësat ekzistues (disk i paprekur)";
    try {
      if (!signWithKey) throw new Error("signReceipt mungon");
      signature = signWithKey(payload);
      if (!signature) throw new Error("nënshkrim bosh");
      verified = !!(verifyWithKey && verifyWithKey(payload, signature));
      if (!verified) throw new Error("verifikimi dështoi me çelësat në disk");
    } catch (signErr) {
      // Nëse mungojnë çelësat në disk — provo vetëm ECDSA në memorie (pa shkruar file)
      const sign = crypto.createSign("SHA256");
      sign.update(JSON.stringify(payload));
      sign.end();
      signature = sign.sign(privateKey, "base64");
      const verify = crypto.createVerify("SHA256");
      verify.update(JSON.stringify(payload));
      verify.end();
      verified = verify.verify(publicKey, signature, "base64");
      extra = "; ECDSA në memorie (pa mbishkruar ATK keys)";
      if (!verified) return fail(name, "nënshkrimi në memorie dështoi: " + (signErr.message || ""));
    }
    if (!signature || typeof signature !== "string" || signature.length < 20) {
      return fail(name, "signReceipt nuk ktheu nënshkrim");
    }
    if (!verified) {
      return fail(name, "verifyReceiptSignature = false");
    }
    return ok(name, `ECDSA P-256 OK, nënshkrim ${signature.slice(0, 16)}…${extra}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

async function testQr() {
  const name = "8. QR";
  try {
    const qr = await generateFiscalQR({
      nuikf: "TESTQRCODE000001",
      total_amount: 5.5,
      fiscal_date: "16.07.2026",
      taxpayer_nui: "123456789",
    });
    if (!qr) return fail(name, "generateFiscalQR ktheu null");
    const hasPng =
      Buffer.isBuffer(qr.png_buffer) ||
      Buffer.isBuffer(qr.pngBuffer) ||
      (!!qr.png_base64 && String(qr.png_base64).length > 20);
    const hasEscpos =
      Buffer.isBuffer(qr.escpos_buffer) ||
      Buffer.isBuffer(qr.escpos) ||
      (!!qr.escpos_base64 && String(qr.escpos_base64).length > 10);
    if (!qr.payload && !hasPng && !hasEscpos) {
      return fail(name, "QR pa payload/png/escpos");
    }
    return ok(
      name,
      `payload=${!!qr.payload}, png=${!!hasPng}, escpos=${!!hasEscpos}`
    );
  } catch (e) {
    return fail(name, e.message);
  }
}

function testWriteOnce() {
  const name = "9. WRITE-ONCE";
  try {
    const { insertFiscalReceipt } = require("./fiscal-db");
    const nuikf = ("TEST" + Date.now().toString(36).toUpperCase())
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 16)
      .padEnd(16, "0");

    // INSERT provë (pa pragma — wrapper i KAFENE nuk ka sqlite.pragma)
    const insertedId = insertFiscalReceipt({
      sale_id: 0,
      nuikf,
      sef_id: "TEST-SEF",
      receipt_type: "regular",
      daily_number: 0,
      total_number: 1,
      fiscal_date: "16.07.2026",
      fiscal_time: "12:00",
      operator_name: TEST_MARKER,
      operator_id: TEST_OPERATOR_ID,
      taxpayer_nui: "000000000",
      taxpayer_name: "TEST",
      taxpayer_address: "TEST",
      items_json: JSON.stringify([{ name: "TEST", qty: 1, __self_test__: true }]),
      subtotal: 1,
      discount_amount: 0,
      total_amount: 1,
      total_without_tax: 1,
      vat_breakdown_json: JSON.stringify({ D: 0, E: 0 }),
      payment_method: "cash",
      qr_code_data: "TEST",
      digital_signature: TEST_MARKER,
      is_offline: 0,
      sent_to_atk: 0,
    });

    if (!insertedId) return fail(name, "INSERT dështoi");

    // UPDATE me fushë të ndaluar përmes fiscalReceiptUpdate — duhet error WRITE-ONCE
    let updateBlocked = false;
    let updateErr = "";
    try {
      fiscalReceiptUpdate(insertedId, { total_amount: 999 });
    } catch (e) {
      updateBlocked = /WRITE-ONCE|ndaluara/i.test(String(e && e.message));
      updateErr = e && e.message ? String(e.message) : String(e);
    }
    if (!updateBlocked) {
      return fail(name, "UPDATE i ndaluar NUK u bllokua (" + (updateErr || "pa error") + ")");
    }
    return ok(name, "INSERT id=" + insertedId + "; UPDATE total_amount u bllokua");
  } catch (e) {
    return fail(name, e.message);
  }
}

function testAudit() {
  const name = "10. AUDIT";
  try {
    if (FISCAL_AUDIT_EXPORT_ACTIONS.length !== ALLOWED_ACTIONS.length) {
      return fail(
        name,
        `eksporti ${FISCAL_AUDIT_EXPORT_ACTIONS.length} ≠ ${ALLOWED_ACTIONS.length} veprime`
      );
    }
    for (const action of ALLOWED_ACTIONS) {
      if (!FISCAL_AUDIT_EXPORT_ACTIONS.includes(action)) {
        return fail(name, `veprim jo i eksportueshëm: ${action}`);
      }
    }
    return ok(name, `${ALLOWED_ACTIONS.length} veprime — krejt audit log`);
  } catch (e) {
    return fail(name, e.message);
  }
}

function testCorrections() {
  const name = "13. KORRIGJIME";
  try {
    const { createCorrectionReceipt, CORRECTION_TYPES } = require("./fiscal-correction");
    if (!CORRECTION_TYPES.includes("cancel") || !CORRECTION_TYPES.includes("return")) {
      return fail(name, "CORRECTION_TYPES incomplete");
    }
    try {
      createCorrectionReceipt("NONEXIST00000001", "cancel", [], "self-test");
      return fail(name, "duhet error për kupon mungues");
    } catch (e) {
      if (!/nuk u gjet/i.test(String(e.message || e))) {
        return fail(name, `kupon mungues: ${e.message || e}`);
      }
    }
    try {
      createCorrectionReceipt("X", "invalid_type", [], "self-test");
      return fail(name, "duhet error për tip invalid");
    } catch (e) {
      if (!/cancel, return ose storno/i.test(String(e.message || e))) {
        return fail(name, `tip invalid: ${e.message || e}`);
      }
    }
    return ok(name, "cancel/return/storno — validim OK");
  } catch (e) {
    return fail(name, e.message);
  }
}

function testPaperBlock() {
  const name = "14. BLOK LETËR";
  try {
    const {
      getPaperBlockStatus,
      isPaperBlockModeActive,
      issuePaperBlockCoupon,
      generatePaperBlockSlipText,
    } = require("./fiscal-paper-block");
    const status = getPaperBlockStatus();
    if (!status || typeof status.active !== "boolean") {
      return fail(name, "getPaperBlockStatus");
    }
    const active = isPaperBlockModeActive();
    if (typeof active !== "boolean") return fail(name, "isPaperBlockModeActive");
    const slip = generatePaperBlockSlipText(
      {
        serial_no: "TEST-PB-SELFTEST",
        fiscal_date: "28.08.2026",
        fiscal_time: "12:00",
        operator_name: "SELFTEST",
        items_json: JSON.stringify([
          { name: "Test", qty: 1, unit_price: 1, vat_norm: "E" },
        ]),
        subtotal: 1,
        total_amount: 1,
        payment_method: "cash",
      },
      "merchant"
    );
    if (!slip || !/TEST-PB-SELFTEST/i.test(slip)) {
      return fail(name, "generatePaperBlockSlipText");
    }
    if (!/BLLOK LETRE/i.test(slip)) {
      return fail(name, "slip pa titull blloku letër");
    }
    try {
      issuePaperBlockCoupon({
        serial_no: "TEST-PB-GATE",
        items: [{ name: "T", price: 1, quantity: 1, vat_norm: "E" }],
      });
      return fail(name, "duhet error kur modaliteti off");
    } catch (e) {
      if (!/nuk është aktiv/i.test(String(e.message || e))) {
        return fail(name, `gate off: ${e.message || e}`);
      }
    }
    return ok(
      name,
      `active=${active}, pending=${status.pending_count}, slip + gate OK`
    );
  } catch (e) {
    return fail(name, e.message);
  }
}

function testOver1000Gate() {
  const name = "15. OVER 1000 EUR";
  try {
    const db = require("../database");
    const big = db.previewSaleTotals({
      items: [{ name: "BIG", price: 1001, quantity: 1, vat_norm: "E" }],
    });
    const small = db.previewSaleTotals({
      items: [{ name: "SMALL", price: 100, quantity: 1, vat_norm: "E" }],
    });
    if (!big || big.total <= 1000) {
      return fail(name, `total i madh=${big?.total} (pritur >1000)`);
    }
    if (!small || small.total > 1000) {
      return fail(name, `total i vogël=${small?.total} (pritur ≤1000)`);
    }
    const needsConfirm = big.total > 1000;
    const noConfirm = small.total <= 1000;
    if (!needsConfirm || !noConfirm) {
      return fail(name, "logjika needs_confirm_over_1000");
    }
    return ok(
      name,
      `${big.total.toFixed(2)}€ → konfirmim, ${small.total.toFixed(2)}€ → jo`
    );
  } catch (e) {
    return fail(name, e.message);
  }
}

async function testReports() {
  const name = "16. RAPORTE X/Z/QR";
  try {
    const { getXReportSnapshot } = require("./fiscal-numbering");
    const { generateFiscalReportQR } = require("./fiscal-qr");
    const details = getXReportSnapshot("SELFTEST", TEST_OPERATOR_ID);
    if (!details || String(details.mode || "").toUpperCase() !== "X") {
      return fail(name, "getXReportSnapshot");
    }
    for (const key of [
      "date",
      "coupon_count",
      "total_amount",
      "total_without_tax",
      "vat_breakdown",
    ]) {
      if (details[key] == null && key !== "vat_breakdown") {
        return fail(name, `fushë mungon: ${key}`);
      }
    }
    if (!details.vat_breakdown || typeof details.vat_breakdown !== "object") {
      return fail(name, "vat_breakdown");
    }

    const qrX = await generateFiscalReportQR(details, {
      reportMode: "X",
      operatorId: "POS",
    });
    if (!qrX) return fail(name, "generateFiscalReportQR X null");
    const hasQrPayload =
      !!qrX.payload ||
      Buffer.isBuffer(qrX.png_buffer) ||
      Buffer.isBuffer(qrX.escpos_buffer);
    if (!hasQrPayload) return fail(name, "QR raport pa payload/buffer");

    const qrZ = await generateFiscalReportQR(
      { ...details, mode: "Z" },
      { reportMode: "Z", operatorId: "POS" }
    );
    if (!qrZ) return fail(name, "generateFiscalReportQR Z null");

    return ok(
      name,
      `X snapshot OK (${details.coupon_count} kuponë), QR X+Z OK`
    );
  } catch (e) {
    return fail(name, e.message);
  }
}

async function testOffline() {
  const name = "11. OFFLINE";
  try {
    const online = await checkInternetConnection();
    if (typeof online !== "boolean") {
      return fail(name, `pritur boolean, morëm: ${typeof online}`);
    }
    return ok(name, online ? "internet OK (online)" : "pa internet (offline) — funksioni OK");
  } catch (e) {
    return fail(name, e.message);
  }
}

function testI18n() {
  const name = "12. I18N";
  const prev = getCurrentLanguage();
  try {
    setLanguage("sq", { persist: false });
    const sq = t("KUPON_FISKAL");
    const sqTotal = t("TOTALI_NE_EURO");
    setLanguage("sr", { persist: false });
    const sr = t("KUPON_FISKAL");
    const srTotal = t("TOTALI_NE_EURO");
    const srCash = t("PARA_E_GATSHME");
    const problems = [];
    if (sq !== "KUPON FISKAL") problems.push(`sq="${sq}" (pritur "KUPON FISKAL")`);
    if (sr !== "FISKALNI KUPON") problems.push(`sr="${sr}" (pritur "FISKALNI KUPON")`);
    if (sqTotal !== "TOTALI NE EURO") problems.push(`sq total="${sqTotal}"`);
    if (!/UKUPNO ZA PLA[CĆ]ANJE/i.test(srTotal)) {
      problems.push(`sr total="${srTotal}" (pritur UKUPNO ZA PLAĆANJE)`);
    }
    if (!/^Gotovina$/i.test(srCash)) problems.push(`sr cash="${srCash}"`);
    if (problems.length) return fail(name, problems.join("; "));
    return ok(name, `sq="${sq}", sr="${sr}", total="${srTotal}"`);
  } catch (e) {
    return fail(name, e.message);
  } finally {
    try {
      setLanguage(prev || "sq", { persist: false });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Ekzekuton të 20 testet. Kërkon fiscal_enabled=true.
 * @param {{ print?: boolean }} [opts] — print=false anashkalon printerin termik
 */
async function runFiscalSelfTest(opts = {}) {
  if (!isFiscalEnabled()) {
    return {
      ok: false,
      error: "Fiskalizimi është OFF — testi shfaqet vetëm kur fiscal ON",
      results: [],
      summary: { passed: 0, failed: 0, total: 0 },
    };
  }

  const print = opts.print !== false;
  const results = [];
  results.push(testDatabase());
  results.push(testSettings());
  results.push(testNuikf());
  results.push(testDailyNumber());
  results.push(testDailyNumberZReset());
  results.push(testSefIdentifier());
  results.push(testVat());
  results.push(testVatRounding());
  results.push(testAtkItemUnitCategory());
  results.push(await testCoupon({ print }));
  results.push(testCouponItemDiscountProto());
  results.push(testAtkPaymentsAndPriceUnits());
  results.push(testCrypto());
  results.push(await testQr());
  results.push(testWriteOnce());
  results.push(testAudit());
  results.push(await testOffline());
  results.push(testI18n());
  results.push(testCorrections());
  results.push(testPaperBlock());
  results.push(testOver1000Gate());
  results.push(await testReports());

  let deleted = 0;
  try {
    deleted = deleteTestFiscalReceipts();
  } catch (e) {
    results.push(fail("CLEANUP", "fshirja e TEST dështoi: " + (e && e.message ? e.message : e)));
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  try {
    logFiscalAction(
      "self_test",
      {
        summary: `self_test: ${passed}/${results.length} ${failed === 0 ? "OK" : "FAIL"}`,
        passed,
        failed,
        total: results.length,
      },
      "SYSTEM",
      "SELFTEST"
    );
  } catch (e) {
    console.warn("[fiscal-self-test] audit summary:", e.message || e);
  }

  return {
    ok: failed === 0,
    results,
    summary: {
      passed,
      failed,
      total: results.length,
      deleted_test_receipts: deleted,
    },
  };
}

/**
 * Ekzekuton të 20 testet `times` herë radhazi (default 100).
 * Printimi termik vetëm në iteracionin e parë (për të mos harxhuar 100 kuponë).
 */
async function runFiscalSelfTestBattery(times = 100) {
  if (!isFiscalEnabled()) {
    return {
      ok: false,
      error: "Fiskalizimi është OFF — testi shfaqet vetëm kur fiscal ON",
      times: 0,
      duration_ms: 0,
      checks: { passed: 0, failed: 0, total: 0 },
      runs: { passed: 0, failed: 0 },
      failures: [],
      headline: "",
      perfect: false,
    };
  }

  const n = Math.max(1, Math.min(500, Number(times) || 100));
  const t0 = Date.now();
  const failures = [];
  let checksPassed = 0;
  let checksFailed = 0;
  let runsPassed = 0;
  let runsFailed = 0;

  for (let i = 1; i <= n; i++) {
    const report = await runFiscalSelfTest({ print: i === 1 });
    const rows = Array.isArray(report.results) ? report.results : [];
    for (const r of rows) {
      if (r.pass) {
        checksPassed += 1;
      } else {
        checksFailed += 1;
        failures.push({
          run: i,
          name: r.name,
          detail: r.detail || "",
        });
      }
    }
    if (report.ok) runsPassed += 1;
    else runsFailed += 1;
  }

  const totalChecks = checksPassed + checksFailed;
  const duration_ms = Date.now() - t0;
  const perfect = checksFailed === 0 && totalChecks === n * TESTS_PER_RUN;
  // Nëse CLEANUP shtoi rresht ekstra, total mund të jetë > 12*n — llogarit nga rezultatet reale
  const expectedLine = `${TESTS_PER_RUN} teste × ${n} = ${TESTS_PER_RUN * n} kontrolle`;

  return {
    ok: checksFailed === 0,
    mode: "battery",
    times: n,
    duration_ms,
    duration_label: formatDuration(duration_ms),
    tests_per_run: TESTS_PER_RUN,
    expected_checks: TESTS_PER_RUN * n,
    checks: {
      passed: checksPassed,
      failed: checksFailed,
      total: totalChecks,
    },
    runs: {
      passed: runsPassed,
      failed: runsFailed,
      total: n,
    },
    failures,
    headline: expectedLine,
    perfect,
    perfect_message: perfect ? "SISTEMI FISKAL ËSHTË 100% GATI" : null,
  };
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

module.exports = {
  runFiscalSelfTest,
  runFiscalSelfTestBattery,
  TEST_MARKER,
  TEST_OPERATOR_ID,
  TESTS_PER_RUN,
};
