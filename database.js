/**
 * databaza minimale për biznes (test ATK/SEF).
 * API e përputhshme me fiscal/* (db.prepare / getSetting / setSetting).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const DB_DIR = path.join(os.homedir(), "AppData", "Roaming", "biznes-sef");
const DB_PATH = process.env.BIZNES_DB_PATH || path.join(DB_DIR, "biznes.db");

let rawDb = null;
let sqlite = null;
let readyPromise = null;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function saveDb() {
  if (!rawDb) return;
  ensureDir(path.dirname(DB_PATH));
  fs.writeFileSync(DB_PATH, Buffer.from(rawDb.export()));
}

function wrapDb(db) {
  function prepare(sql) {
    return {
      get(...params) {
        const stmt = db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          if (stmt.step()) return stmt.getAsObject();
          return undefined;
        } finally {
          stmt.free();
        }
      },
      all(...params) {
        const stmt = db.prepare(sql);
        const rows = [];
        try {
          if (params.length) stmt.bind(params);
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally {
          stmt.free();
        }
      },
      run(...params) {
        db.run(sql, params.length ? params : []);
        const changes = db.getRowsModified();
        const idRow = db.exec("SELECT last_insert_rowid() AS id");
        const lastInsertRowid =
          idRow?.[0]?.values?.[0]?.[0] != null ? Number(idRow[0].values[0][0]) : 0;
        saveDb();
        return { changes, lastInsertRowid };
      },
    };
  }

  function exec(sql) {
    db.run(sql);
    saveDb();
  }

  function transaction(fn) {
    return () => {
      db.run("BEGIN");
      try {
        const result = fn();
        db.run("COMMIT");
        saveDb();
        return result;
      } catch (e) {
        try {
          db.run("ROLLBACK");
        } catch {
          /* */
        }
        throw e;
      }
    };
  }

  return { prepare, exec, transaction };
}

/** Katalog produkesh sipas normës TVSH — 20 për A/C/D/E. */
function productCatalogByVatLetter() {
  return {
    A: [
      ["Test A1 - Bukë e liruar", 0.5],
      ["Test A2 - Quellë e liruar", 0.8],
      ["Test A3 - Libër", 5.0],
      ["Test A4 - Barnë", 3.5],
      ["Test A5 - Arsim", 10.0],
      ["Test A6 - Shërbim social", 2.0],
      ["Test A7 - Donacion", 1.0],
      ["Test A8 - Export prove A", 15.0],
      // +12 reale (0% — e përjashtuar)
      ["Bukë e bardhë 500g", 0.6],
      ["Farmaci — antibiotik", 4.5],
      ["Tekst shkollor", 6.0],
      ["Kurs gjuhe (arsim)", 25.0],
      ["Kujdes ditor për fëmijë", 8.0],
      ["Shërbim kujdesi social", 12.0],
      ["Donacion ushqimor", 2.0],
      ["Export mallrash (0%)", 40.0],
      ["Fatura e përjashtuar — shërbim", 15.0],
      ["Libër shkollor fillor", 3.5],
      ["Barnë pa recetë (0%)", 2.8],
      ["Tarifë arsimore", 18.0],
    ],
    C: [
      ["Test C1 - Normë tjetër C", 4.0],
      ["Test C2 - Shërbim C", 6.5],
      ["Test C3 - Artikull C", 2.2],
      ["Test C4 - Paketë C", 8.0],
      ["Test C5 - Material C", 3.0],
      ["Test C6 - Konsum C", 1.5],
      ["Test C7 - Tarifë C", 12.0],
      ["Test C8 - Prove C", 7.5],
      // +12 reale (normë C — 0%)
      ["Transport ndërkombëtar", 35.0],
      ["Shërbim doganor", 20.0],
      ["Mallë në tranzit", 50.0],
      ["Shërbim diplomatik", 30.0],
      ["Furnizim i përjashtuar C", 9.0],
      ["Tarifë administrimi C", 5.5],
      ["Konsum i veçantë C", 3.2],
      ["Paketim eksporti C", 7.0],
      ["Material ndihmës C", 4.8],
      ["Shërbim logjistikë C", 22.0],
      ["Artikull i veçantë C", 11.0],
      ["Prove normë C", 6.0],
    ],
    D: [
      ["Test D1 - Ushqim 8%", 2.5],
      ["Test D2 - Pije 8%", 1.5],
      ["Test D3 - Kafe 8%", 1.2],
      ["Test D4 - Sandwich 8%", 3.5],
      ["Test D5 - Supë 8%", 2.8],
      ["Test D6 - Saladë 8%", 4.0],
      ["Test D7 - Fruta 8%", 1.8],
      ["Test D8 - Perime 8%", 1.6],
      // +12 reale (8%)
      ["Qumësht 1L", 1.2],
      ["Vezë (10 copë)", 2.4],
      ["Miell 1kg", 1.1],
      ["Vaj luledielli 1L", 2.8],
      ["Sheqer 1kg", 1.3],
      ["Kripë 1kg", 0.6],
      ["Oriz 1kg", 1.8],
      ["Makarona 500g", 1.0],
      ["Domate 1kg", 1.5],
      ["Mish viçi 1kg", 9.5],
      ["Patate 1kg", 0.9],
      ["Jogurt 500g", 1.4],
    ],
    E: [
      ["Test E1 - Pije 18%", 2.0],
      ["Test E2 - Alkol 18%", 3.5],
      ["Test E3 - Snack 18%", 1.5],
      ["Test E4 - Aksesor 18%", 9.9],
      ["Test E5 - Elektronikë 18%", 49.9],
      ["Test E6 - Shërbim 18%", 15.0],
      ["Test E7 - Mallë 18%", 25.0],
      ["Test E8 - Prove 18%", 11.8],
      // +12 reale (18%)
      ["Kafe espresso", 1.5],
      ["Çaj i zi", 1.0],
      ["Coca-Cola 0.5L", 1.5],
      ["Ujë mineral 0.5L", 0.7],
      ["Birra 0.5L", 1.8],
      ["Ëmbëlsirë tortë", 2.5],
      ["Sallam 200g", 2.2],
      ["Djathë 250g", 3.0],
      ["Mollë 1kg", 1.6],
      ["Chips 150g", 1.3],
      ["Çokollatë 100g", 1.4],
      ["Energjik Red Bull", 2.5],
    ],
  };
}

function vatCategoryForLetter(letter) {
  if (letter === "D") return "8";
  if (letter === "E") return "18";
  return "0";
}

function seedProducts() {
  const count = sqlite.prepare("SELECT COUNT(*) AS c FROM products").get();
  if (Number(count?.c) > 0) return;

  const groups = productCatalogByVatLetter();
  const ins = sqlite.prepare(
    `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  let sort = 0;
  for (const [letter, list] of Object.entries(groups)) {
    const cat = vatCategoryForLetter(letter);
    for (const [name, price] of list) {
      sort += 1;
      ins.run(name, price, letter, cat, sort);
    }
  }
}

/**
 * DB ekzistuese me 8/normë → shto artikujt që mungojnë deri në 20/normë.
 * Nuk prek rreshtat ekzistues.
 */
function ensureProductsPerVatLetter() {
  const groups = productCatalogByVatLetter();
  const maxSortRow = sqlite.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM products").get();
  let sort = Number(maxSortRow?.m) || 0;
  const exists = sqlite.prepare(
    `SELECT id FROM products WHERE name = ? AND vat_letter = ? LIMIT 1`
  );
  const ins = sqlite.prepare(
    `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  let added = 0;
  for (const [letter, list] of Object.entries(groups)) {
    const cat = vatCategoryForLetter(letter);
    for (const [name, price] of list) {
      if (exists.get(name, letter)) continue;
      sort += 1;
      ins.run(name, price, letter, cat, sort);
      added += 1;
    }
  }
  if (added > 0) {
    console.log(`[biznes] u shtuan ${added} produkte (20 për normë A/C/D/E)`);
    syncMenuItemsFromProducts();
  }
}

function initSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      vat_letter TEXT NOT NULL DEFAULT 'E',
      vat_category TEXT NOT NULL DEFAULT '18',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      vat_category TEXT NOT NULL DEFAULT '18'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      items_json TEXT NOT NULL DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      discount_total REAL NOT NULL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      waiter_name TEXT DEFAULT 'Operator',
      status TEXT DEFAULT 'completed',
      fiscal_receipt_id INTEGER,
      is_fiscalized INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  const { initFiscalDB } = require("./fiscal/fiscal-db");
  initFiscalDB({
    exec: (sql) => sqlite.exec(sql),
    run: (sql) => sqlite.exec(sql),
    get: (sql, params) => sqlite.prepare(sql).get(...(params || [])),
  });

  seedProducts();
  ensureProductsPerVatLetter();
  syncMenuItemsFromProducts();

  // SEF ON by default for ATK testing
  const fsRow = sqlite.prepare("SELECT id FROM fiscal_settings WHERE id = 1").get();
  try {
    sqlite.prepare(`ALTER TABLE fiscal_settings ADD COLUMN application_id TEXT`).run();
  } catch {
    /* */
  }
  try {
    sqlite.prepare(`ALTER TABLE fiscal_settings ADD COLUMN atk_api_url TEXT`).run();
  } catch {
    /* */
  }

  if (!fsRow) {
    sqlite
      .prepare(
        `INSERT INTO fiscal_settings (
           id, fiscal_enabled, taxpayer_legal_name, taxpayer_nui, taxpayer_nf,
           taxpayer_vat_number, taxpayer_address, unit_number, unit_name, unit_phone,
           pos_id, business_unit_number, language, developer_nui, atk_api_url
         ) VALUES (
           1, 1, 'BIZNES TEST SEF', '810000000', '600000000',
           '330000000', 'Prishtinë, Kosovë', '1', 'Njësia Test', '044 000 000',
           '01', '1', 'sq', '811314567', 'https://fiskalizimi-test.atk-ks.org'
         )`
      )
      .run();
  } else {
    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
           fiscal_enabled = 1,
           taxpayer_legal_name = COALESCE(NULLIF(taxpayer_legal_name,''), 'BIZNES TEST SEF'),
           taxpayer_nui = COALESCE(NULLIF(taxpayer_nui,''), '810000000'),
           taxpayer_nf = COALESCE(NULLIF(taxpayer_nf,''), '600000000'),
           taxpayer_vat_number = COALESCE(NULLIF(taxpayer_vat_number,''), '330000000'),
           taxpayer_address = COALESCE(NULLIF(taxpayer_address,''), 'Prishtinë, Kosovë'),
           unit_number = COALESCE(NULLIF(unit_number,''), '1'),
           unit_name = COALESCE(NULLIF(unit_name,''), 'Njësia Test'),
           unit_phone = COALESCE(NULLIF(unit_phone,''), '044 000 000'),
           pos_id = COALESCE(NULLIF(pos_id,''), '01'),
           business_unit_number = COALESCE(NULLIF(business_unit_number,''), '1'),
           atk_api_url = COALESCE(NULLIF(atk_api_url,''), 'https://fiskalizimi-test.atk-ks.org'),
           language = 'sq',
           updated_at = datetime('now','localtime')
         WHERE id = 1`
      )
      .run();
  }

  // Gjenero çelësa ECDSA lokalë nëse mungojnë (placeholder derisa ATK jep signed-certificate.pem)
  try {
    const { generateKeyPair, getKeysDir } = require("./fiscal/fiscal-crypto");
    const fsKeys = require("fs");
    const pathKeys = require("path");
    const dir = getKeysDir();
    const hasPriv =
      fsKeys.existsSync(pathKeys.join(dir, "private-key.pem")) ||
      fsKeys.existsSync(pathKeys.join(dir, "private.pem"));
    if (!hasPriv) generateKeyPair();
  } catch (e) {
    console.warn("[biznes] keys:", e.message);
  }

  if (!getSetting("printer_name")) {
    setSetting("printer_name", "");
    setSetting("printer_paper", "80mm");
  }
}

function syncMenuItemsFromProducts() {
  sqlite.exec("DELETE FROM menu_items");
  const products = sqlite.prepare("SELECT * FROM products WHERE active = 1").all();
  const ins = sqlite.prepare(
    `INSERT INTO menu_items (id, name, category, price, active, vat_category)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  for (const p of products) {
    ins.run(p.id, p.name, `Norma ${p.vat_letter}`, p.price, p.vat_category);
  }
}

function getSetting(key, fallback = null) {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(String(key), String(value));
}

async function initDatabase() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    ensureDir(DB_DIR);
    process.env.DB_PATH = DB_PATH;
    process.env.BIZNES_DB_PATH = DB_PATH;
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(__dirname, "node_modules", "sql.js", "dist", file),
    });
    if (fs.existsSync(DB_PATH)) {
      rawDb = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      rawDb = new SQL.Database();
    }
    sqlite = wrapDb(rawDb);
    initSchema();
    module.exports.db = sqlite;
    return sqlite;
  })();
  return readyPromise;
}

function listProducts() {
  return sqlite
    .prepare(
      `SELECT id, name, price, vat_letter, vat_category, sort_order
       FROM products WHERE active = 1
       ORDER BY vat_letter ASC, sort_order ASC, id ASC`
    )
    .all();
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Zbritje/rritje: type = none|value|percent */
function computeAdjAmount(base, type, value) {
  const t = String(type || "none").toLowerCase();
  const v = Number(value) || 0;
  if (!t || t === "none" || v <= 0) return 0;
  if (t === "percent" || t === "pct" || t === "%") return round2((base * v) / 100);
  return round2(v);
}

function normalizePaymentMethod(raw, paymentSplits) {
  if (Array.isArray(paymentSplits) && paymentSplits.length > 1) return "mixed";
  const v = String(raw || "cash").trim().toLowerCase();
  if (["card", "karte", "kartë", "debit_card", "credit_card", "pos"].includes(v)) {
    return v === "debit_card" || v === "credit_card" ? v : "card";
  }
  if (["voucher", "check", "cheque", "cek", "çek", "bank_account", "sms", "cash"].includes(v)) {
    return v === "cheque" || v === "cek" || v === "çek" ? "check" : v;
  }
  return "cash";
}

function buildSaleLines(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw new Error("Shporta është bosh");

  return list.map((it) => {
    const product = it.product_id
      ? sqlite.prepare("SELECT * FROM products WHERE id = ?").get(Number(it.product_id))
      : null;
    const vatLetter = String(
      it.vat_norm || it.vat_letter || product?.vat_letter || "E"
    )
      .trim()
      .toUpperCase();
    const qty = Number(it.quantity || it.qty || 1) || 1;
    const basePrice = Number(it.base_price ?? it.price ?? product?.price ?? 0) || 0;
    const name = String(it.name || product?.name || "Artikull").trim();
    const lineBase = round2(basePrice * qty);
    const lineDisc = computeAdjAmount(
      lineBase,
      it.line_discount?.type || it.discount_type,
      it.line_discount?.value ?? it.discount_value
    );
    const lineSur = computeAdjAmount(
      lineBase,
      it.line_surcharge?.type || it.surcharge_type,
      it.line_surcharge?.value ?? it.surcharge_value
    );
    const lineNet = round2(lineBase - lineDisc + lineSur);
    if (lineNet < 0) throw new Error(`Rreshti "${name}" ka total negativ pas zbritjes`);
    const unit = qty ? round2(lineNet / qty) : 0;
    const L = /^[A-E]$/.test(vatLetter) ? vatLetter : "E";
    return {
      name,
      quantity: qty,
      qty,
      price: unit,
      unit_price: unit,
      base_price: basePrice,
      line_discount_amount: lineDisc,
      line_surcharge_amount: lineSur,
      vat_norm: L,
      vat_letter: L,
      menu_item_id: product?.id ?? it.product_id ?? null,
      product_id: product?.id ?? it.product_id ?? null,
    };
  });
}

function previewSaleTotals({ items, cart_discount, cart_surcharge }) {
  const normalized = buildSaleLines(items);
  const subtotal = round2(
    normalized.reduce((s, it) => s + it.price * it.quantity, 0)
  );
  const cartDisc = computeAdjAmount(
    subtotal,
    cart_discount?.type,
    cart_discount?.value
  );
  const cartSur = computeAdjAmount(
    subtotal,
    cart_surcharge?.type,
    cart_surcharge?.value
  );
  const total = round2(subtotal - cartDisc + cartSur);
  return { items: normalized, subtotal, discount_total: cartDisc, surcharge_total: cartSur, total };
}

function createSale({
  items,
  payment_method,
  operator_name,
  cart_discount,
  cart_surcharge,
  payment_splits,
}) {
  const preview = previewSaleTotals({ items, cart_discount, cart_surcharge });
  const normalized = preview.items;
  const subtotal = preview.subtotal;
  const cartDisc = preview.discount_total;
  const cartSur = preview.surcharge_total;
  const total = preview.total;
  if (total <= 0) throw new Error("Totali duhet > 0");

  const splits = Array.isArray(payment_splits)
    ? payment_splits
        .map((p) => ({
          method: normalizePaymentMethod(p.method || p.id, null),
          amount: round2(p.amount),
        }))
        .filter((p) => p.amount > 0)
    : [];
  if (splits.length) {
    const sumPay = round2(splits.reduce((s, p) => s + p.amount, 0));
    if (Math.abs(sumPay - total) > 0.02) {
      throw new Error(
        `Pagesat e përziera (${sumPay.toFixed(2)}) ≠ totali (${total.toFixed(2)})`
      );
    }
  }

  const payment = normalizePaymentMethod(payment_method, splits);
  const op = String(operator_name || "Operator").trim() || "Operator";

  const payload = {
    items: normalized,
    cart_discount_amount: cartDisc,
    cart_surcharge_amount: cartSur,
    payment_splits: splits,
  };

  const result = sqlite
    .prepare(
      `INSERT INTO orders (items_json, total, subtotal, discount_total, payment_method, waiter_name, status)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`
    )
    .run(JSON.stringify(payload), total, subtotal, cartDisc, payment, op);

  const orderId = Number(result.lastInsertRowid);
  return {
    id: orderId,
    items: normalized,
    total,
    subtotal,
    discount_total: cartDisc,
    surcharge_total: cartSur,
    payment_method: payment,
    payment_splits: splits,
    operator_name: op,
  };
}

function getOrder(id) {
  return sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id));
}

function listRecentOrders(limit = 50) {
  return sqlite
    .prepare(
      `SELECT id, total, payment_method, waiter_name, is_fiscalized, fiscal_receipt_id, created_at, items_json
       FROM orders ORDER BY id DESC LIMIT ?`
    )
    .all(Number(limit) || 50);
}

function getFiscalSettingsRow() {
  return require("./fiscal/fiscal-config").getFiscalSettings();
}

function saveFiscalSettings(data) {
  return require("./fiscal/fiscal-config").saveFiscalSettings(data);
}

module.exports = {
  initDatabase,
  get db() {
    if (!sqlite) throw new Error("Databaza nuk është e gatshme — thirr initDatabase()");
    return sqlite;
  },
  getSetting,
  setSetting,
  listProducts,
  createSale,
  previewSaleTotals,
  getOrder,
  listRecentOrders,
  getFiscalSettingsRow,
  saveFiscalSettings,
  DB_PATH,
};
