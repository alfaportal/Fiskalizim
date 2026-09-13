/**
 * databaza minimale për biznes (test ATK/SEF).
 * API e përputhshme me fiscal/* (db.prepare / getSetting / setSetting).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const portable = require("./portable-path");
const dbCrypto = require("./db-crypto");

portable.applyPortableEnv();
const DB_DIR = portable.getDataDir();
const DB_PATH = portable.getDbPath();

let rawDb = null;
let sqlite = null;
let readyPromise = null;
/** true = biznes.db e enkriptuar nuk lexohet; ruajtja në disk bllokohet (vetëm memorie). */
let dbDecryptFailed = false;
global.DB_DECRYPT_FAILED = false;

function isDecryptLoadError(err) {
  const msg = String(err?.message || err);
  return /enkriptuar e palexueshme|palexueshme.*backup/i.test(msg);
}

function setDbDecryptFailed(value) {
  dbDecryptFailed = !!value;
  global.DB_DECRYPT_FAILED = dbDecryptFailed;
}

function isDbDecryptFailed() {
  return dbDecryptFailed;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function saveDb() {
  if (!rawDb) return;
  if (dbDecryptFailed) return;
  ensureDir(DB_DIR);
  dbCrypto.saveDatabaseBytes(DB_PATH, Buffer.from(rawDb.export()));
}

/** Lexon biznes.db nga disku (plain ose BIZENC1 → SQLite bytes). */
function readDbBytesFromDisk() {
  return dbCrypto.loadDatabaseBytes(DB_PATH);
}

/** Pas leximit plain — ruan enkriptuar (migrim automatik). */
function migrateDbEncryptionIfNeeded(loaded) {
  if (!loaded?.needsEncryptionMigration) return;
  try {
    saveDb();
    console.log("[biznes] biznes.db u migrua plain → enkriptuar (BIZENC1)");
  } catch (e) {
    console.warn("[biznes] migrim enkriptimi biznes.db:", e.message || e);
  }
}

function wrapDb(db) {
  // sql.js: export() gjatë transaksionit e mbyll transaksionin — mos ruaj disk midis BEGIN/COMMIT.
  let txnDepth = 0;

  function syncTxnDepth(sql) {
    const head = String(sql || "")
      .trim()
      .split(/\s+/)[0]
      .toUpperCase();
    if (head === "BEGIN") txnDepth += 1;
    else if (head === "COMMIT" || head === "ROLLBACK") {
      txnDepth = Math.max(0, txnDepth - 1);
    }
  }

  function persistIfIdle() {
    if (txnDepth <= 0) saveDb();
  }

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
        persistIfIdle();
        return { changes, lastInsertRowid };
      },
    };
  }

  function exec(sql) {
    db.run(sql);
    syncTxnDepth(sql);
    persistIfIdle();
  }

  function transaction(fn) {
    return () => {
      db.run("BEGIN");
      txnDepth += 1;
      try {
        const result = fn();
        db.run("COMMIT");
        txnDepth = Math.max(0, txnDepth - 1);
        saveDb();
        return result;
      } catch (e) {
        try {
          db.run("ROLLBACK");
        } catch {
          /* */
        }
        txnDepth = Math.max(0, txnDepth - 1);
        saveDb();
        throw e;
      }
    };
  }

  return { prepare, exec, transaction };
}

/**
 * Katalog 20×4 sipas Ligjit TVSH Kosovë (05/L-037) + shkronjat ATK:
 * A = 0% përjashtuar / eksport · C = 0% përjashtuar tjetër
 * D = 8% e reduktuar · E = 18% standarde
 *
 * Korrigjime vs lista e dhënë: ilaç/libra/pajisje mjekësore → D (jo A);
 * ujë i emballar, mish, sheqer, kafe, pije → E (jo D); IT → D.
 */
function parseCatalogEntry(entry) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return {
      name: String(entry[0]),
      price: Number(entry[1]) || 0,
      unit_code: String(entry[2] || "EA").trim().toUpperCase() || "EA",
      category_code: String(entry[3] || "TT").trim().toUpperCase() || "TT",
    };
  }
  return entry;
}

function productCatalogByVatLetter() {
  return {
    A: [],
    C: [],
    D: [],
    E: [
      ["Coca-Cola 0.5L", 1.5, "LTR", "PJA"],
      ["Fanta 0.5L", 1.5, "LTR", "PJA"],
      ["Sprite 0.5L", 1.5, "LTR", "PJA"],
      ["Pepsi 0.5L", 1.5, "LTR", "PJA"],
      ["Red Bull 250ml", 2.5, "LTR", "PJA"],
      ["Hell 250ml", 2.5, "LTR", "PJA"],
      ["Lëng frutash 1L", 1.2, "LTR", "PJA"],
      ["Nektar 0.5L", 1.2, "LTR", "PJA"],
      ["Ujë i gazuar 0.5L", 0.8, "LTR", "PJA"],
      ["Ujë i aromatizuar 0.5L", 0.8, "LTR", "PJA"],
      ["Birra 0.5L", 1.8, "LTR", "PAL"],
      ["Verë 0.75L", 8.0, "LTR", "PAL"],
      ["Raki 0.5L", 6.0, "LTR", "PAL"],
      ["Vodkë 0.7L", 12.0, "LTR", "PAL"],
      ["Uiski 0.7L", 12.0, "LTR", "PAL"],
      ["Xhin 0.7L", 12.0, "LTR", "PAL"],
      ["Cigare (pako)", 3.0, "PK", "DUH"],
      ["Kafe espresso (pako)", 1.5, "CP", "UR"],
      ["Kafe turke (pako)", 1.5, "CP", "UR"],
      ["Çaj i paketuar (filter)", 1.2, "CP", "UR"],
      ["Ushqim i gatshëm", 3.5, "CP", "UR"],
      ["Sandviç", 3.5, "CP", "UR"],
      ["Picë", 3.5, "CP", "UR"],
      ["Çips", 1.3, "EA", "AU"],
      ["Snack", 1.3, "EA", "AU"],
      ["Akullore", 1.5, "EA", "AU"],
    ],
  };
}

function vatCategoryForLetter(letter) {
  if (letter === "D") return "8";
  if (letter === "E") return "18";
  // A (eksport Neni 31) dhe C (lirim Neni 27/28) = 0%
  return "0";
}

function vatPercentForLetter(letter) {
  return Number(vatCategoryForLetter(letter)) || 0;
}

/** Siguro që çdo produkt ka vat_category = % sipas shkronjës (ligji 05/L-037). */
function ensureProductVatCategories() {
  const rows = sqlite.prepare("SELECT id, vat_letter, vat_category FROM products").all();
  const upd = sqlite.prepare(
    `UPDATE products SET vat_category = ? WHERE id = ? AND vat_category != ?`
  );
  let fixed = 0;
  for (const r of rows) {
    const L = String(r.vat_letter || "E").toUpperCase();
    const cat = vatCategoryForLetter(L);
    if (String(r.vat_category) !== cat) {
      upd.run(cat, r.id, cat);
      fixed += 1;
    }
  }
  if (fixed > 0) syncMenuItemsFromProducts();
  return fixed;
}

function bundledDefaultProductsPath() {
  const fileName = "default-products.json";
  const candidates = [
    path.join(__dirname, "data", fileName),
  ];
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "data", fileName),
      path.join(process.resourcesPath, "app", "data", fileName)
    );
  }
  const asarRoot = String(__dirname).replace(/app\.asar[\\/].*$/i, "app.asar.unpacked");
  if (asarRoot !== __dirname) {
    candidates.push(path.join(asarRoot, "data", fileName));
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* */
    }
  }
  return path.join(__dirname, "data", fileName);
}

function loadBundledCatalogProducts() {
  const filePath = bundledDefaultProductsPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(payload?.products) ? payload.products : [];
  } catch (e) {
    console.warn("[biznes] default-products.json:", e.message);
    return [];
  }
}

/** Fut produktet nga default-products.json (134 artikuj — norma/unit/category të sakta). */
function insertProductsFromCatalogList(list) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return 0;
  const ins = sqlite.prepare(
    `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order, unit_code, category_code)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  );
  let sort = 0;
  for (const p of rows) {
    const name = String(p.name || "").trim();
    if (!name) continue;
    const L = String(p.vat_letter || "E").toUpperCase();
    if (!["A", "C", "D", "E"].includes(L)) continue;
    const cat = String(p.vat_category || vatCategoryForLetter(L));
    const unitCode = String(p.unit_code || "EA").trim().toUpperCase() || "EA";
    const categoryCode = String(p.category_code || "TT").trim().toUpperCase() || "TT";
    sort += 1;
    ins.run(
      name,
      Number(p.price) || 0,
      L,
      cat,
      Number(p.sort_order) || sort,
      unitCode,
      categoryCode
    );
  }
  return sort;
}

/** Zëvendëso krejt katalogun nga default-products.json — hiq duplikatë / norma të gabuara. */
function resyncAllProductsFromBundledCatalog() {
  const list = loadBundledCatalogProducts();
  if (!list.length) throw new Error("default-products.json bosh ose mungon");
  sqlite.exec("DELETE FROM products");
  sqlite.exec("DELETE FROM menu_items");
  try {
    sqlite
      .prepare("DELETE FROM sqlite_sequence WHERE name IN ('products', 'menu_items')")
      .run();
  } catch {
    /* */
  }
  const n = insertProductsFromCatalogList(list);
  syncMenuItemsFromProducts();
  const counts = { A: 0, C: 0, D: 0, E: 0 };
  for (const p of list) {
    const L = String(p.vat_letter || "").toUpperCase();
    if (counts[L] != null) counts[L] += 1;
  }
  return { total: n, counts };
}

/** Migrim FISKALIZIME — vetëm 26 produkte E (Coca-Cola → Akullore), pa A/C/D. */
function migrateFiskalizimArkaCatalog() {
  const marker = "fiskalizim_arka_catalog_v1";
  if (getSetting(marker) === "1") return null;
  const r = resyncAllProductsFromBundledCatalog();
  setSetting("vat_a_catalog_rev_20260904", "1");
  setSetting("vat_c_catalog_rev_20260904", "1");
  setSetting("vat_d_catalog_rev_20260904", "1");
  setSetting("vat_e_catalog_rev_20260904", "1");
  setSetting("full_catalog_resync_20260904_v2", "1");
  setSetting(marker, "1");
  console.log(
    `[fiskalizim] katalog Arka: ${r.total} produkte E (deri Akullore)`
  );
  return r;
}

/** Migrim njëherësh — rregullon E/A/D të përziera + 195→134 produkte. */
function migrateFullCatalogResync() {
  const marker = "full_catalog_resync_20260904_v2";
  if (getSetting(marker) === "1") return null;
  const r = resyncAllProductsFromBundledCatalog();
  setSetting(marker, "1");
  console.log(
    `[biznes] katalog i plotë u sinkronizua: ${r.total} produkte (A=${r.counts.A} C=${r.counts.C} D=${r.counts.D} E=${r.counts.E})`
  );
  return r;
}

/** Instalim i ri / DB bosh → mbush automatikisht produktet e bundluara me Setup. */
function seedDefaultProductsIfEmpty() {
  const count = sqlite.prepare("SELECT COUNT(*) AS c FROM products").get();
  if (Number(count?.c) > 0) return 0;

  const list = loadBundledCatalogProducts();
  if (list.length > 0) {
    const n = insertProductsFromCatalogList(list);
    syncMenuItemsFromProducts();
    console.log(`[biznes] u mbushën ${n} produkte (katalog default pas Setup)`);
    return n;
  }

  seedProducts();
  const after = sqlite.prepare("SELECT COUNT(*) AS c FROM products").get();
  const n = Number(after?.c) || 0;
  if (n > 0) console.log(`[biznes] u mbushën ${n} produkte (katalog bazë)`);
  return n;
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

function verifyBundledCatalogIntegrity() {
  const expectedList = loadBundledCatalogProducts();
  if (!expectedList.length) return { ok: true, skipped: true };

  const exp = { A: 0, C: 0, D: 0, E: 0, total: expectedList.length };
  for (const p of expectedList) {
    const L = String(p.vat_letter || "").toUpperCase();
    if (exp[L] != null) exp[L] += 1;
  }

  const rows = sqlite
    .prepare(
      "SELECT vat_letter, COUNT(*) AS c FROM products WHERE active = 1 GROUP BY vat_letter"
    )
    .all();
  const counts = { A: 0, C: 0, D: 0, E: 0, total: 0 };
  for (const r of rows) {
    const L = String(r.vat_letter || "").toUpperCase();
    const n = Number(r.c) || 0;
    counts.total += n;
    if (counts[L] != null) counts[L] += n;
  }

  const ok =
    counts.total === exp.total &&
    counts.A === exp.A &&
    counts.C === exp.C &&
    counts.D === exp.D &&
    counts.E === exp.E;

  if (!ok) {
    console.warn(
      `[biznes] KATALOG integrity: DB A=${counts.A} C=${counts.C} D=${counts.D} E=${counts.E} (${counts.total}) — pritet A=${exp.A} C=${exp.C} D=${exp.D} E=${exp.E} (${exp.total})`
    );
  }
  return { ok, counts, expected: exp };
}

/** Legacy — çaktivizuar; katalogu vjen vetëm nga default-products.json. */
function ensureProductsPerVatLetter() {
  return 0;
}

/** Heq artikuj të vjetër nga katalogu — idempotent çdo nisje. */
function removeDeprecatedCatalogProducts() {
  const names = ["Ujë mineral 0.5L", "Uje mineral 0.5L"];
  const del = sqlite.prepare(`DELETE FROM products WHERE name = ?`);
  let removed = 0;
  for (const name of names) {
    const r = del.run(name);
    removed += Number(r.changes) || 0;
  }
  if (removed > 0) syncMenuItemsFromProducts();
  return removed;
}

/** Zëvendëso katalogun A (2026-09) — hiq eksportet e vjetra, vendos listën e re. */
function migrateVatAProductsCatalog() {
  const marker = "vat_a_catalog_rev_20260904";
  if (getSetting(marker) === "1") return 0;
  const r = replaceGroupFromCatalog("A");
  setSetting(marker, "1");
  console.log(`[biznes] katalog A u zëvendësua: ${r.count} produkte`);
  return r.count;
}

/** Zëvendëso katalogun C (2026-09) — unit/category të sakta, pa duplikatë. */
function migrateVatCProductsCatalog() {
  const marker = "vat_c_catalog_rev_20260904";
  if (getSetting(marker) === "1") return 0;
  const r = replaceGroupFromCatalog("C");
  setSetting(marker, "1");
  console.log(`[biznes] katalog C u zëvendësua: ${r.count} produkte`);
  return r.count;
}

/** Zëvendëso katalogun D (2026-09) — 71 produkte 8%, hiq të vjetrat. */
function migrateVatDProductsCatalog() {
  const marker = "vat_d_catalog_rev_20260904";
  if (getSetting(marker) === "1") return 0;
  const r = replaceGroupFromCatalog("D");
  setSetting(marker, "1");
  console.log(`[biznes] katalog D u zëvendësua: ${r.count} produkte`);
  return r.count;
}

/** Zëvendëso katalogun E (2026-09) — 41 produkte 18%, unit/category të sakta. */
function migrateVatEProductsCatalog() {
  const marker = "vat_e_catalog_rev_20260904";
  if (getSetting(marker) === "1") return 0;
  const r = replaceGroupFromCatalog("E");
  setSetting(marker, "1");
  console.log(`[biznes] katalog E u zëvendësua: ${r.count} produkte`);
  return r.count;
}

/** Aktivizo dërgimin te ATK TEST (një herë) për verifikim në portal. */
function migrateAtkTestTransmissionEnable() {
  const marker = "atk_test_transmission_enable_20260904";
  if (getSetting(marker) === "1") return;
  const row = sqlite.prepare("SELECT atk_api_url FROM fiscal_settings WHERE id = 1").get();
  const url = String(row?.atk_api_url || "").trim();
  if (!/fiskalizimi-test/i.test(url)) return;
  setSetting("atk_send_allowed", "1");
  setSetting("atk_auto_send", "1");
  setSetting("atk_test_mode", "1");
  setSetting(marker, "1");
  console.log("[biznes] ATK TEST — dërgimi u aktivizua për verifikim në fiskalizimi-test.atk-ks.org");
}

function migrateLegacyNfVatPlaceholders() {
  const row = sqlite
    .prepare(
      `SELECT taxpayer_nf, taxpayer_vat_number FROM fiscal_settings WHERE id = 1`
    )
    .get();
  if (!row) {
    console.log("[biznes] fiscal_settings pas nisjes: (pa rresht)", { db: DB_PATH });
    return;
  }
  const beforeNf = String(row.taxpayer_nf ?? "");
  const beforeVat = String(row.taxpayer_vat_number ?? "");
  const needsFix = beforeNf === "600000000" || beforeVat === "330000000";
  if (needsFix) {
    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
           taxpayer_nf = CASE WHEN taxpayer_nf = '600000000' THEN '' ELSE taxpayer_nf END,
           taxpayer_vat_number = CASE WHEN taxpayer_vat_number = '330000000' THEN '' ELSE taxpayer_vat_number END,
           updated_at = datetime('now','localtime')
         WHERE id = 1`
      )
      .run();
    saveDb();
    console.log("[biznes] NF/TVSH: u pastruan placeholder-at legacy (600000000 / 330000000)");
  }
  const after = sqlite
    .prepare(`SELECT taxpayer_nf, taxpayer_vat_number FROM fiscal_settings WHERE id = 1`)
    .get();
  console.log("[biznes] fiscal_settings pas nisjes:", {
    db: DB_PATH,
    taxpayer_nf: String(after?.taxpayer_nf ?? ""),
    taxpayer_vat_number: String(after?.taxpayer_vat_number ?? ""),
    migrated: needsFix,
  });
}

/** Zbraz fushat e klientit kur DB ka NUI demo të vjetër (811314567) — një herë. */
function migrateClearLegacyDemoClientFields() {
  const marker = "legacy_demo_client_fields_cleared_20260905";
  if (getSetting(marker) === "1") return;

  const row = sqlite
    .prepare(
      `SELECT taxpayer_nui FROM fiscal_settings WHERE id = 1`
    )
    .get();
  if (!row) {
    setSetting(marker, "1");
    return;
  }

  const nui = String(row.taxpayer_nui ?? "").trim();
  if (nui !== "811314567") {
    setSetting(marker, "1");
    return;
  }

  sqlite
    .prepare(
      `UPDATE fiscal_settings SET
         taxpayer_legal_name = '',
         taxpayer_nui = '',
         taxpayer_nf = '',
         taxpayer_vat_number = '',
         taxpayer_address = '',
         unit_name = '',
         unit_phone = '',
         application_id = '',
         fiscalization_number = '',
         updated_at = datetime('now','localtime')
       WHERE id = 1`
    )
    .run();
  saveDb();
  setSetting(marker, "1");
  console.log(
    "[biznes] legacy demo NUI 811314567 — fushat e klientit u zbrazën (developer_nui / atk_api_url / pos_id pa prekur)"
  );
}

function initSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin_code TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      vat_letter TEXT NOT NULL DEFAULT 'E',
      vat_category TEXT NOT NULL DEFAULT '18',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      unit_code TEXT NOT NULL DEFAULT 'EA',
      category_code TEXT NOT NULL DEFAULT 'TT'
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      vat_category TEXT NOT NULL DEFAULT '18',
      unit_code TEXT NOT NULL DEFAULT 'EA',
      category_code TEXT NOT NULL DEFAULT 'TT'
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

  try {
    sqlite.prepare(`ALTER TABLE products ADD COLUMN unit_code TEXT DEFAULT 'EA'`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`ALTER TABLE products ADD COLUMN category_code TEXT DEFAULT 'TT'`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`ALTER TABLE menu_items ADD COLUMN unit_code TEXT DEFAULT 'EA'`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`ALTER TABLE menu_items ADD COLUMN category_code TEXT DEFAULT 'TT'`).run();
  } catch {
    /* kolona ekziston */
  }

  const { initFiscalDB } = require("./fiscal/fiscal-db");
  initFiscalDB({
    exec: (sql) => sqlite.exec(sql),
    run: (sql) => sqlite.exec(sql),
    get: (sql, params) => sqlite.prepare(sql).get(...(params || [])),
  });

  // Instalim i ri: katalogu i bundluar me Setup → produkte menjëherë në Kasa
  if (!dbDecryptFailed) {
    seedDefaultProductsIfEmpty();
    try {
      migrateFiskalizimArkaCatalog();
    } catch (e) {
      console.warn("[fiskalizim] migrateFiskalizimArkaCatalog:", e.message);
    }
    ensureProductsPerVatLetter();
    try {
      const n = removeDeprecatedCatalogProducts();
      if (n > 0) console.log(`[biznes] u hoqën ${n} produkte të vjetra nga katalogu`);
    } catch (e) {
      console.warn("[biznes] removeDeprecatedCatalogProducts:", e.message);
    }
    syncMenuItemsFromProducts();
    try {
      verifyBundledCatalogIntegrity();
    } catch (e) {
      console.warn("[biznes] catalog integrity:", e.message);
    }
  } else {
    console.warn("[biznes] katalogu u anashkalua (DB_DECRYPT_FAILED — prit restore)");
  }

  // ATK: default NDALUR — asgjë te serveri ATK deri urdhër pronari
  if (getSetting("atk_send_allowed") == null) {
    setSetting("atk_send_allowed", "0");
  }
  if (getSetting("atk_auto_send") == null) {
    setSetting("atk_auto_send", "0");
  }
  if (/^1|true|yes|on$/i.test(String(process.env.BIZNES_ATK_SEND_ALLOWED || "").trim())) {
    setSetting("atk_send_allowed", "1");
  }
  migrateAtkTestTransmissionEnable();
  if (getSetting("atk_test_mode") == null) {
    setSetting("atk_test_mode", "0");
  }

  // SEF ON by default — klienti plotëson të dhënat në Cilësimet / onboarding
  const ATK_PREFILL = {
    taxpayer_legal_name: "",
    taxpayer_nui: "",
    taxpayer_nf: "",
    taxpayer_vat_number: "",
    taxpayer_address: "",
    unit_number: "1",
    unit_name: "",
    unit_phone: "",
    pos_id: "01",
    business_unit_number: "1",
    application_id: "",
    fiscalization_number: "",
    atk_api_url: "https://fiskalizimi-test.atk-ks.org",
    developer_nui: "811314567",
    language: "sq",
  };

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
  try {
    sqlite.prepare(`ALTER TABLE fiscal_settings ADD COLUMN fiscalization_number TEXT`).run();
  } catch {
    /* */
  }

  const P = ATK_PREFILL;
  if (!fsRow) {
    sqlite
      .prepare(
        `INSERT INTO fiscal_settings (
           id, fiscal_enabled, taxpayer_legal_name, taxpayer_nui, taxpayer_nf,
           taxpayer_vat_number, taxpayer_address, unit_number, unit_name, unit_phone,
           pos_id, business_unit_number, language, developer_nui, atk_api_url,
           application_id, fiscalization_number
         ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        P.taxpayer_legal_name,
        P.taxpayer_nui,
        P.taxpayer_nf,
        P.taxpayer_vat_number,
        P.taxpayer_address,
        P.unit_number,
        P.unit_name,
        P.unit_phone,
        P.pos_id,
        P.business_unit_number,
        P.language,
        P.developer_nui,
        P.atk_api_url,
        P.application_id,
        P.fiscalization_number
      );
  } else {
    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
           fiscal_enabled = 1,
           taxpayer_legal_name = COALESCE(NULLIF(taxpayer_legal_name,''), ?),
           taxpayer_nui = COALESCE(NULLIF(taxpayer_nui,''), ?),
           taxpayer_nf = COALESCE(NULLIF(taxpayer_nf,''), ?),
           taxpayer_vat_number = COALESCE(NULLIF(taxpayer_vat_number,''), ?),
           taxpayer_address = COALESCE(NULLIF(taxpayer_address,''), ?),
           unit_number = COALESCE(NULLIF(unit_number,''), ?),
           unit_name = COALESCE(NULLIF(unit_name,''), ?),
           unit_phone = COALESCE(NULLIF(unit_phone,''), ?),
           pos_id = COALESCE(NULLIF(pos_id,''), ?),
           business_unit_number = COALESCE(NULLIF(business_unit_number,''), ?),
           atk_api_url = COALESCE(NULLIF(atk_api_url,''), ?),
           application_id = COALESCE(NULLIF(application_id,''), ?),
           fiscalization_number = COALESCE(NULLIF(fiscalization_number,''), ?),
           developer_nui = COALESCE(NULLIF(developer_nui,''), ?),
           updated_at = datetime('now','localtime')
         WHERE id = 1`
      )
      .run(
        P.taxpayer_legal_name,
        P.taxpayer_nui,
        P.taxpayer_nf,
        P.taxpayer_vat_number,
        P.taxpayer_address,
        P.unit_number,
        P.unit_name,
        P.unit_phone,
        P.pos_id,
        P.business_unit_number,
        P.atk_api_url,
        P.application_id,
        P.fiscalization_number,
        P.developer_nui
      );
  }

  // Prefill i detyrueshëm për demo ATK (një herë për instalim) + certifikata TEST
  try {
    const fsKeys = require("fs");
    const pathKeys = require("path");
    const {
      generateKeyPair,
      getKeysDir,
      hasRealAtkCertificate,
      hasAnyFiscalKeyArtifacts,
      hasFiscalKeysProtectionMarker,
      ensureFiscalKeysProtectionMarker,
    } = require("./fiscal/fiscal-crypto");
    const marker = pathKeys.join(DB_DIR, ".atk-prefill-v1");
    const dir = getKeysDir();
    ensureDir(dir);

    const destPriv = pathKeys.join(dir, "private-key.pem");
    const keysSealed =
      hasFiscalKeysProtectionMarker(dir) ||
      hasAnyFiscalKeyArtifacts(dir) ||
      hasRealAtkCertificate(dir, null) ||
      dbCrypto.hasPrivateKeyMaterial(dir, destPriv);

    if (keysSealed) {
      ensureFiscalKeysProtectionMarker();
    }

    const firstInstall = !fsKeys.existsSync(marker);

    if (firstInstall) {
      sqlite
        .prepare(
          `UPDATE fiscal_settings SET
             fiscal_enabled = 1,
             taxpayer_legal_name = ?,
             taxpayer_nui = ?,
             taxpayer_nf = ?,
             taxpayer_vat_number = ?,
             taxpayer_address = ?,
             unit_number = ?,
             unit_name = ?,
             unit_phone = ?,
             pos_id = ?,
             business_unit_number = ?,
             atk_api_url = ?,
             application_id = ?,
             fiscalization_number = ?,
             developer_nui = ?,
             language = 'sq',
             updated_at = datetime('now','localtime')
           WHERE id = 1`
        )
        .run(
          P.taxpayer_legal_name,
          P.taxpayer_nui,
          P.taxpayer_nf,
          P.taxpayer_vat_number,
          P.taxpayer_address,
          P.unit_number,
          P.unit_name,
          P.unit_phone,
          P.pos_id,
          P.business_unit_number,
          P.atk_api_url,
          P.application_id,
          P.fiscalization_number,
          P.developer_nui
        );
      fsKeys.writeFileSync(marker, new Date().toISOString(), "utf8");
      migrateAtkTestTransmissionEnable();
    }

    if (!keysSealed) {
      const hasPriv = dbCrypto.hasPrivateKeyMaterial(dir, destPriv);
      const hasRealCert = hasRealAtkCertificate(dir, null);
      if (!hasPriv && !hasRealCert) {
        generateKeyPair();
      }
    }
  } catch (e) {
    console.warn("[biznes] keys/prefill:", e.message);
  }

  // NF/TVSH legacy (600000000 / 330000000) → zbraz — idempotent çdo nisje
  try {
    migrateLegacyNfVatPlaceholders();
  } catch (e) {
    console.warn("[biznes] nf/vat migrate:", e.message);
  }

  if (!getSetting("printer_name")) {
    setSetting("printer_name", "");
    setSetting("printer_paper", "80mm");
  }

  ensureProductVatCategories();
}

function syncMenuItemsFromProducts() {
  sqlite.exec("DELETE FROM menu_items");
  const products = sqlite.prepare("SELECT * FROM products WHERE active = 1").all();
  const ins = sqlite.prepare(
    `INSERT INTO menu_items (id, name, category, price, active, vat_category, unit_code, category_code)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  );
  for (const p of products) {
    ins.run(
      p.id,
      p.name,
      `Norma ${p.vat_letter}`,
      p.price,
      p.vat_category,
      String(p.unit_code || "EA").trim() || "EA",
      String(p.category_code || "TT").trim() || "TT"
    );
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
    console.time("[biznes] initDatabase-sqljs");
    ensureDir(DB_DIR);
    process.env.DB_PATH = DB_PATH;
    process.env.BIZNES_DB_PATH = DB_PATH;
    if (portable.isPortableMode()) {
      console.log("[biznes] portable mode — të dhënat:", DB_DIR);
    }
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs({
      locateFile: (file) => {
        const packed = path.join(__dirname, "node_modules", "sql.js", "dist", file);
        if (fs.existsSync(packed)) return packed;
        // electron-builder asarUnpack
        const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
        return unpacked;
      },
    });

    function backupCorruptDb(reason) {
      try {
        if (!fs.existsSync(DB_PATH)) return null;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dest = `${DB_PATH}.corrupt-${stamp}`;
        fs.copyFileSync(DB_PATH, dest);
        console.warn("[biznes] biznes.db e dëmtuar — backup:", dest, "—", reason);
        return dest;
      } catch (e) {
        console.warn("[biznes] backup DB dështoi:", e.message);
        return null;
      }
    }

    function openDatabaseFromBytes(bytes) {
      if (!bytes || !bytes.length) return new SQL.Database();
      try {
        const db = new SQL.Database(bytes);
        db.exec("SELECT 1");
        return db;
      } catch (e) {
        if (/not a database|malformed|corrupt/i.test(String(e.message || e))) {
          return null;
        }
        throw e;
      }
    }

    let loaded = { bytes: null, wasPlain: true, needsEncryptionMigration: false };
    try {
      ensureDir(DB_DIR);
      loaded = readDbBytesFromDisk();
    } catch (e) {
      backupCorruptDb("readDatabaseBytes: " + (e.message || e));
      if (isDecryptLoadError(e)) {
        setDbDecryptFailed(true);
        console.error(
          "[biznes] DB_DECRYPT_FAILED — databaza e enkriptuar nuk lexohet; rikthe nga backup (disk nuk mbishkruhet)"
        );
      }
      loaded = { bytes: null, wasPlain: true, needsEncryptionMigration: false };
    }

    rawDb = openDatabaseFromBytes(loaded.bytes);
    if (!rawDb) {
      if (!dbDecryptFailed) {
        backupCorruptDb("SQLite header invalid");
      }
      rawDb = new SQL.Database();
      loaded = { bytes: null, wasPlain: true, needsEncryptionMigration: false };
    }

    sqlite = wrapDb(rawDb);
    try {
      initSchema();
    } catch (e) {
      if (/not a database|malformed|corrupt/i.test(String(e.message || e))) {
        if (!dbDecryptFailed) {
          backupCorruptDb("initSchema: " + (e.message || e));
        }
        rawDb = new SQL.Database();
        sqlite = wrapDb(rawDb);
        initSchema();
        if (!dbDecryptFailed) {
          saveDb();
          console.warn("[biznes] u krijua biznes.db e re (skema e pastër)");
        } else {
          console.warn("[biznes] initSchema në memorie (DB_DECRYPT_FAILED — pa shkrim disk)");
        }
      } else {
        throw e;
      }
    }
    try {
      migrateClearLegacyDemoClientFields();
    } catch (e) {
      console.warn("[biznes] legacy demo client migrate:", e.message);
    }
    try {
      const keysDir = path.join(DB_DIR, "fiscal-keys");
      dbCrypto.migratePlainPrivateKeys(keysDir);
      dbCrypto.lockPrivateKeyFiles(keysDir);
    } catch (e) {
      console.warn("[biznes] enkriptim çelësash fiskalë:", e.message);
    }
    if (!dbDecryptFailed) {
      migrateDbEncryptionIfNeeded(loaded);
    }
    module.exports.db = sqlite;
    console.timeEnd("[biznes] initDatabase-sqljs");
    return sqlite;
  })();
  return readyPromise;
}

/** Riload pas restore — lexon biznes.db nga disku pa rinisur procesin. */
async function reloadDatabaseFromDisk() {
  if (readyPromise) {
    await readyPromise;
  }
  if (!dbDecryptFailed) {
    saveDb();
  }
  try {
    if (rawDb && typeof rawDb.close === "function") {
      rawDb.close();
    }
  } catch (e) {
    console.warn("[biznes] reloadDatabase close:", e.message);
  }

  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs({
    locateFile: (file) => {
      const packed = path.join(__dirname, "node_modules", "sql.js", "dist", file);
      if (fs.existsSync(packed)) return packed;
      const unpacked = packed.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
      );
      return unpacked;
    },
  });

  let loaded = { bytes: null, wasPlain: true, needsEncryptionMigration: false };
  try {
    loaded = readDbBytesFromDisk();
  } catch (e) {
    if (isDecryptLoadError(e)) {
      setDbDecryptFailed(true);
    }
    throw new Error("biznes.db e restauruar është e dëmtuar ose e pavlefshme: " + (e.message || e));
  }

  let nextRaw = null;
  try {
    if (loaded.bytes && loaded.bytes.length) {
      nextRaw = new SQL.Database(loaded.bytes);
      nextRaw.exec("SELECT 1");
    }
  } catch (e) {
    if (/not a database|malformed|corrupt/i.test(String(e.message || e))) {
      throw new Error("biznes.db e restauruar është e dëmtuar ose e pavlefshme");
    }
    throw e;
  }
  if (!nextRaw) {
    nextRaw = new SQL.Database();
  }

  rawDb = nextRaw;
  sqlite = wrapDb(rawDb);
  module.exports.db = sqlite;

  try {
    const keysDir = path.join(DB_DIR, "fiscal-keys");
    dbCrypto.migratePlainPrivateKeys(keysDir);
    dbCrypto.lockPrivateKeyFiles(keysDir);
  } catch (e) {
    console.warn("[biznes] reloadDatabase keys:", e.message);
  }

  migrateDbEncryptionIfNeeded(loaded);
  setDbDecryptFailed(false);

  console.log("[biznes] databaza u ringarkua nga disku pas restore");
  return sqlite;
}

function listProducts() {
  const rows = sqlite
    .prepare(
      `SELECT id, name, price, vat_letter, vat_category, sort_order, unit_code, category_code
       FROM products WHERE active = 1
       ORDER BY vat_letter ASC, sort_order ASC, id ASC`
    )
    .all();
  return rows.map((p) => {
    const L = String(p.vat_letter || "E").toUpperCase();
    const pct = vatPercentForLetter(L);
    return {
      ...p,
      vat_letter: L,
      vat_category: String(vatCategoryForLetter(L)),
      vat_percent: pct,
      vat_rate: pct,
      vat_label: `${L} · ${pct}%`,
    };
  });
}

function getProductById(id) {
  const pid = Number(id);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return sqlite.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(pid);
}

function updateProduct(id, fields) {
  const pid = Number(id);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error("ID produkti i pavlefshëm.");
  const row = sqlite.prepare("SELECT id FROM products WHERE id = ?").get(pid);
  if (!row) throw new Error("Produkti nuk u gjet.");
  const n = String(fields.name || "").trim();
  if (!n) throw new Error("Emri i produktit është i detyrueshëm.");
  const p = round2(fields.price);
  if (!(p >= 0) || Number.isNaN(p)) throw new Error("Çmimi i pavlefshëm.");
  const L = String(fields.vat_letter || "E").toUpperCase();
  if (!["A", "C", "D", "E"].includes(L)) {
    throw new Error("Norma TVSH duhet A, C, D ose E.");
  }
  const cat = vatCategoryForLetter(L);
  const unitCode = String(fields.unit_code || "EA").trim().toUpperCase() || "EA";
  const categoryCode = String(fields.category_code || "TT").trim().toUpperCase() || "TT";
  sqlite
    .prepare(
      `UPDATE products SET name = ?, price = ?, vat_letter = ?, vat_category = ?,
       unit_code = ?, category_code = ? WHERE id = ?`
    )
    .run(n, p, L, cat, unitCode, categoryCode, pid);
  syncMenuItemsFromProducts();
  return sqlite
    .prepare(
      "SELECT id, name, price, vat_letter, vat_category, sort_order, unit_code, category_code FROM products WHERE id = ?"
    )
    .get(pid);
}

function createProduct({ name, price, vat_letter, unit_code, category_code }) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Emri i produktit është i detyrueshëm.");
  const p = round2(price);
  if (!(p >= 0) || Number.isNaN(p)) throw new Error("Çmimi i pavlefshëm.");
  const L = String(vat_letter || "E").toUpperCase();
  if (!["A", "C", "D", "E"].includes(L)) {
    throw new Error("Norma TVSH duhet A, C, D ose E.");
  }
  const cat = vatCategoryForLetter(L);
  const unitCode = String(unit_code || "EA").trim().toUpperCase() || "EA";
  const categoryCode = String(category_code || "TT").trim().toUpperCase() || "TT";
  const maxSort = sqlite.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM products").get();
  const sort = (Number(maxSort?.m) || 0) + 1;
  const result = sqlite
    .prepare(
      `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order, unit_code, category_code)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(n, p, L, cat, sort, unitCode, categoryCode);
  const id = Number(result.lastInsertRowid);
  syncMenuItemsFromProducts();
  return sqlite
    .prepare(
      "SELECT id, name, price, vat_letter, vat_category, sort_order, unit_code, category_code FROM products WHERE id = ?"
    )
    .get(id);
}

/** Fshi krejt produktet dhe mbush katalogun e saktë. */
function replaceAllProductsFromCatalog() {
  sqlite.exec("DELETE FROM products");
  sqlite.exec("DELETE FROM menu_items");
  try {
    sqlite
      .prepare("DELETE FROM sqlite_sequence WHERE name IN ('products', 'menu_items')")
      .run();
  } catch {
    /* */
  }
  const groups = productCatalogByVatLetter();
  const ins = sqlite.prepare(
    `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  let sort = 0;
  const counts = { A: 0, C: 0, D: 0, E: 0 };
  for (const [letter, list] of Object.entries(groups)) {
    const cat = vatCategoryForLetter(letter);
    for (const [name, price] of list) {
      sort += 1;
      ins.run(name, price, letter, cat, sort);
      counts[letter] = (counts[letter] || 0) + 1;
    }
  }
  syncMenuItemsFromProducts();
  return { ok: true, total: sort, counts };
}

/** Zëvendëso një grup shkronjë (A/C/D/E) — të tjerat mbeten. */
function replaceGroupFromCatalog(letter) {
  const L = String(letter || "").toUpperCase();
  if (!["A", "C", "D", "E"].includes(L)) throw new Error("Shkronja e pavlefshme.");
  sqlite.prepare(`DELETE FROM products WHERE vat_letter = ?`).run(L);
  const list = productCatalogByVatLetter()[L] || [];
  const cat = vatCategoryForLetter(L);
  const maxSort = sqlite.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM products").get();
  let sort = Number(maxSort?.m) || 0;
  const ins = sqlite.prepare(
    `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order, unit_code, category_code)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  );
  for (const raw of list) {
    const row = parseCatalogEntry(raw);
    if (!row) continue;
    sort += 1;
    ins.run(row.name, row.price, L, cat, sort, row.unit_code, row.category_code);
  }
  syncMenuItemsFromProducts();
  return { ok: true, letter: L, count: list.length };
}

function replaceGroupAFromCatalog() {
  return replaceGroupFromCatalog("A");
}

function deleteProduct(id) {
  const pid = Number(id);
  if (!pid) throw new Error("ID produkti i pavlefshëm.");
  const row = sqlite.prepare("SELECT id FROM products WHERE id = ?").get(pid);
  if (!row) throw new Error("Produkti nuk u gjet.");
  sqlite.prepare("DELETE FROM products WHERE id = ?").run(pid);
  syncMenuItemsFromProducts();
  return { ok: true, id: pid };
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
    // % nga shkronja e produktit (jo nga klienti) — A/C=0, D=8, E=18
    const letter = product?.vat_letter
      ? String(product.vat_letter).toUpperCase()
      : L;
    const finalLetter = /^[A-E]$/.test(letter) ? letter : L;
    const finalPct = vatPercentForLetter(finalLetter);
    const discType = String(it.line_discount?.type || it.discount_type || "")
      .trim()
      .toLowerCase();
    const discVal = Number(it.line_discount?.value ?? it.discount_value);
    const lineDiscountMeta =
      lineDisc > 0 && discType && discType !== "none" && Number.isFinite(discVal) && discVal > 0
        ? { type: discType, value: discVal }
        : null;
    const surType = String(it.line_surcharge?.type || it.surcharge_type || "")
      .trim()
      .toLowerCase();
    const surVal = Number(it.line_surcharge?.value ?? it.surcharge_value);
    const lineSurchargeMeta =
      lineSur > 0 && surType && surType !== "none" && Number.isFinite(surVal) && surVal > 0
        ? { type: surType, value: surVal }
        : null;
    const row = {
      name,
      quantity: qty,
      qty,
      price: unit,
      unit_price: unit,
      base_price: basePrice,
      line_discount_amount: lineDisc,
      line_surcharge_amount: lineSur,
      vat_norm: finalLetter,
      vat_letter: finalLetter,
      vat_category: String(finalPct),
      vat_rate: finalPct,
      vat_percent: finalPct,
      menu_item_id: product?.id ?? it.product_id ?? null,
      product_id: product?.id ?? it.product_id ?? null,
      unit_code: String(it.unit_code || product?.unit_code || "EA").trim() || "EA",
      category_code: String(it.category_code || product?.category_code || "TT").trim() || "TT",
    };
    if (lineDiscountMeta) row.line_discount = lineDiscountMeta;
    if (lineSurchargeMeta) row.line_surcharge = lineSurchargeMeta;
    return row;
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

function rowToOperator(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    pin_code: row.pin_code,
    active: !!row.active,
  };
}

function validateOperatorName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Emri i punonjësit është i detyrueshëm");
  return n;
}

function validateOperatorPin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4,6}$/.test(p)) {
    throw new Error("Kodi i hyrjes duhet të jetë 4–6 shifra");
  }
  return p;
}

function addOperator(name, pin) {
  const n = validateOperatorName(name);
  const p = validateOperatorPin(pin);
  try {
    const r = sqlite
      .prepare(`INSERT INTO operators (name, pin_code, active) VALUES (?, ?, 1)`)
      .run(n, p);
    return rowToOperator({
      id: Number(r.lastInsertRowid),
      name: n,
      pin_code: p,
      active: 1,
    });
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) {
      throw new Error("Ky kod hyrjeje është përdorur tashmë");
    }
    throw e;
  }
}

function getOperators(opts = {}) {
  const includeInactive = !!opts.includeInactive;
  const sql = includeInactive
    ? `SELECT id, name, pin_code, active FROM operators ORDER BY name COLLATE NOCASE`
    : `SELECT id, name, pin_code, active FROM operators WHERE active = 1 ORDER BY name COLLATE NOCASE`;
  return sqlite.prepare(sql).all().map(rowToOperator);
}

function getOperatorByPin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4,6}$/.test(p)) return null;
  const row = sqlite
    .prepare(
      `SELECT id, name, pin_code, active FROM operators WHERE pin_code = ? AND active = 1`
    )
    .get(p);
  return rowToOperator(row);
}

function updateOperator(id, patch = {}) {
  const oid = Number(id);
  if (!oid) throw new Error("ID punonjësi mungon");
  const existing = sqlite.prepare(`SELECT id FROM operators WHERE id = ?`).get(oid);
  if (!existing) throw new Error("Punonjësi nuk u gjet");

  const name = patch.name != null ? validateOperatorName(patch.name) : null;
  const pin = patch.pin_code != null ? validateOperatorPin(patch.pin_code) : null;
  if (name == null && pin == null) throw new Error("Asgjë për përditësim");

  try {
    if (name != null && pin != null) {
      sqlite.prepare(`UPDATE operators SET name = ?, pin_code = ? WHERE id = ?`).run(name, pin, oid);
    } else if (name != null) {
      sqlite.prepare(`UPDATE operators SET name = ? WHERE id = ?`).run(name, oid);
    } else {
      sqlite.prepare(`UPDATE operators SET pin_code = ? WHERE id = ?`).run(pin, oid);
    }
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) {
      throw new Error("Ky kod hyrjeje është përdorur tashmë");
    }
    throw e;
  }
  const row = sqlite
    .prepare(`SELECT id, name, pin_code, active FROM operators WHERE id = ?`)
    .get(oid);
  return rowToOperator(row);
}

function deactivateOperator(id) {
  const oid = Number(id);
  if (!oid) throw new Error("ID punonjësi mungon");
  const r = sqlite.prepare(`UPDATE operators SET active = 0 WHERE id = ?`).run(oid);
  if (!r.changes) throw new Error("Punonjësi nuk u gjet");
  const row = sqlite
    .prepare(`SELECT id, name, pin_code, active FROM operators WHERE id = ?`)
    .get(oid);
  return rowToOperator(row);
}

function deleteOperator(id) {
  const oid = Number(id);
  if (!oid) throw new Error("ID punonjësi mungon");
  const r = sqlite.prepare(`DELETE FROM operators WHERE id = ?`).run(oid);
  if (!r.changes) throw new Error("Punonjësi nuk u gjet");
  return { id: oid, deleted: true };
}

function countActiveOperators() {
  const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM operators WHERE active = 1`).get();
  return Number(row?.c) || 0;
}

module.exports = {
  initDatabase,
  reloadDatabaseFromDisk,
  get db() {
    if (!sqlite) throw new Error("Databaza nuk është e gatshme — thirr initDatabase()");
    return sqlite;
  },
  getSetting,
  setSetting,
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  replaceAllProductsFromCatalog,
  replaceGroupAFromCatalog,
  replaceGroupFromCatalog,
  createSale,
  previewSaleTotals,
  getOrder,
  listRecentOrders,
  getFiscalSettingsRow,
  saveFiscalSettings,
  vatCategoryForLetter,
  vatPercentForLetter,
  ensureProductVatCategories,
  addOperator,
  getOperators,
  getOperatorByPin,
  updateOperator,
  deactivateOperator,
  deleteOperator,
  countActiveOperators,
  DB_PATH,
  DB_DIR,
  flushDatabase: saveDb,
  isDbDecryptFailed,
  setDbDecryptFailed,
  getDbDecryptStatus: () => ({
    db_decrypt_failed: dbDecryptFailed,
    disk_path: DB_PATH,
  }),
};
