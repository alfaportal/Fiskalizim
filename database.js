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
let installIsNewFile = false;
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
    `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order, unit_code, category_code, pos_category)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
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
    const posCat = normalizePosCategoryLabel(
      p.pos_category || inferPosCategoryForProduct({ name, category_code: categoryCode })
    );
    ins.run(
      name,
      Number(p.price) || 0,
      L,
      cat,
      Number(p.sort_order) || sort,
      unitCode,
      categoryCode,
      posCat
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

const POS_CATEGORY_VALUES = [
  "Bukë & Brumëra",
  "Bulmet",
  "Vezë",
  "Ushqim Bazë",
  "Pije",
  "Perime",
  "Pemë",
  "Mish",
  "Ëmbëlsira",
  "Rroba Meshkuj",
  "Rroba Femra",
  "Këpucë",
  "Aksesorë",
  "Elektronikë",
  "Higjienë",
  "Kancelari",
  "Lodra Fëmijë",
  "Shtëpi",
  "Barna OTC",
  "Pajisje të Ndryshme",
];

function normalizePosCategoryLabel(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Të tjera";
  if (s === "Embelsira" || s === "Ëmbëlsira") return "Ëmbëlsira";
  if (POS_CATEGORY_VALUES.includes(s)) return s;
  return "Të tjera";
}

/** Kategoria POS (Arka) — nga emri / category_code ATK. */
function inferPosCategoryForProduct(p) {
  const n = String(p?.name || "")
    .toLowerCase()
    .replace(/[ëé]/g, "e")
    .replace(/[çč]/g, "c");
  const atk = String(p?.category_code || "").trim().toUpperCase();
  if (/kafe|caj|espresso|turke|filter/.test(n)) return "Pije të nxehta";
  if (/sandvic|pica|ushqim|gatsh/.test(n)) return "Ushqime";
  if (/akullore|snack|cips|embelsir/.test(n)) return "Embelsira";
  if (/cigare|duhan/.test(n) || atk === "DUH") return "Të tjera";
  if (atk === "PAL" || atk === "PJA") return "Pije të ftohta";
  if (atk === "UR" || atk === "AU") {
    if (/kafe|caj/.test(n)) return "Pije të nxehta";
    if (/akullore|snack|cips/.test(n)) return "Embelsira";
    return "Ushqime";
  }
  return "Të tjera";
}

function migrateFiskalizimCatalog200() {
  const marker = "fiskalizim_catalog_200_v20261109";
  if (getSetting(marker) === "1") return null;
  const r = resyncAllProductsFromBundledCatalog();
  setSetting("fiskalizim_arka_catalog_v1", "1");
  setSetting("fiskalizim_pos_category_v2", "1");
  setSetting(marker, "1");
  console.log(
    `[fiskalizim] katalogu: ${r.total} produkte (D=${r.counts.D} E=${r.counts.E})`
  );
  return r;
}

function migrateFiskalizimPosCategory() {
  const marker = "fiskalizim_pos_category_v2";
  if (getSetting(marker) === "1") return null;
  const rows = sqlite.prepare("SELECT id, name, category_code, pos_category FROM products").all();
  const upd = sqlite.prepare("UPDATE products SET pos_category = ? WHERE id = ?");
  let n = 0;
  for (const p of rows) {
    const next = inferPosCategoryForProduct(p);
    upd.run(next, p.id);
    n += 1;
  }
  setSetting(marker, "1");
  setSetting("fiskalizim_pos_category_v1", "1");
  console.log(`[fiskalizim] pos_category: ${n} produkte`);
  return n;
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
      category_code TEXT NOT NULL DEFAULT 'TT',
      pos_category TEXT NOT NULL DEFAULT 'Të tjera',
      base_weight REAL NOT NULL DEFAULT 1
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
    sqlite.prepare(`ALTER TABLE operators ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    const owners = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM operators WHERE active = 1 AND COALESCE(is_owner, 0) = 1`
      )
      .get();
    if (!Number(owners?.c)) {
      const first = sqlite
        .prepare(`SELECT id FROM operators WHERE active = 1 ORDER BY id ASC LIMIT 1`)
        .get();
      if (first) sqlite.prepare(`UPDATE operators SET is_owner = 1 WHERE id = ?`).run(first.id);
    }
  } catch {
    /* */
  }
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
    sqlite.prepare(`ALTER TABLE products ADD COLUMN barcode TEXT DEFAULT ''`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT ''`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`ALTER TABLE products ADD COLUMN pos_category TEXT DEFAULT 'Të tjera'`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`ALTER TABLE products ADD COLUMN base_weight REAL DEFAULT 1`).run();
  } catch {
    /* kolona ekziston */
  }
  try {
    sqlite.prepare(`UPDATE products SET base_weight = 1 WHERE base_weight IS NULL OR base_weight <= 0`).run();
  } catch {
    /* */
  }
  let soldByWeightAdded = false;
  try {
    sqlite.prepare(`ALTER TABLE products ADD COLUMN sold_by_weight INTEGER NOT NULL DEFAULT 0`).run();
    soldByWeightAdded = true;
  } catch {
    /* kolona ekziston */
  }
  if (soldByWeightAdded) {
    sqlite
      .prepare(
        `UPDATE products SET sold_by_weight = 1
         WHERE UPPER(COALESCE(unit_code, '')) IN ('KGN', 'KGB', 'GRM')`
      )
      .run();
  }
  if (getSetting("sold_by_weight_name_v1") !== "1") {
    const weightName = /(\d+(?:[.,]\d+)?)\s*(kg|gr|gram|g)\b/i;
    const rows = sqlite.prepare("SELECT id, name, unit_code FROM products").all();
    const mark = sqlite.prepare("UPDATE products SET sold_by_weight = 1 WHERE id = ?");
    for (const row of rows) {
      const unit = String(row.unit_code || "").trim().toUpperCase();
      if (weightName.test(String(row.name || "")) || unit === "KGN" || unit === "KGB" || unit === "GRM") {
        mark.run(row.id);
      }
    }
    setSetting("sold_by_weight_name_v1", "1");
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
    try {
      migrateFiskalizimPosCategory();
    } catch (e) {
      console.warn("[fiskalizim] migrateFiskalizimPosCategory:", e.message);
    }
    try {
      migrateFiskalizimCatalog200();
    } catch (e) {
      console.warn("[fiskalizim] migrateFiskalizimCatalog200:", e.message);
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
      applyBaseWeightFromNamesOnce();
    } catch (e) {
      console.warn("[fiskalizim] applyBaseWeightFromNamesOnce:", e.message);
    }
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
  clearKnownPaperBlockProbeRows();
  clearCirculationOnNewInstall();
}

function clearKnownPaperBlockProbeRows() {
  const marker = "paper_block_probe_20261025_cleared";
  if (getSetting(marker) === "1") return;
  const exists = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='paper_block_receipts'`)
    .get();
  if (!exists) {
    setSetting(marker, "1");
    return;
  }
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_paper_block_block_delete`);
  const removed = sqlite
    .prepare(
      `DELETE FROM paper_block_receipts
       WHERE fiscal_date = '25.10.2026'
         AND serial_no IN (
           'GAP-1792968225491',
           'GAP-CHK-1792968226311',
           'PB1792968292481-OK',
           'PB1792968292481-CHK1'
         )`
    )
    .run();
  sqlite.exec(`
    CREATE TRIGGER trg_paper_block_block_delete
    BEFORE DELETE ON paper_block_receipts
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'WRITE-ONCE: DELETE i ndaluar në paper_block_receipts');
    END;
  `);
  setSetting(marker, "1");
  if (removed && removed.changes) {
    console.log("[biznes] u hoqën kuponët provë të bllokut të letrës 25.10.2026:", removed.changes);
  }
}

function clearCirculationOnNewInstall() {
  if (!installIsNewFile || dbDecryptFailed) return;
  const names = ["orders", "fiscal_receipts", "paper_block_receipts", "pending_txn", "fiscal_audit_log"];
  const dirty = [];
  for (const name of names) {
    const exists = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    if (!exists) continue;
    const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get();
    if (Number(row && row.c) > 0) dirty.push(name);
  }
  if (!dirty.length) return;
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_paper_block_block_delete`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_fiscal_receipts_block_delete`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_fiscal_audit_block_delete`);
  for (const name of dirty) sqlite.exec(`DELETE FROM ${name}`);
  const { initFiscalDB } = require("./fiscal/fiscal-db");
  initFiscalDB({
    exec: (sql) => sqlite.exec(sql),
    run: (sql) => sqlite.exec(sql),
    get: (sql, params) => sqlite.prepare(sql).get(...(params || [])),
  });
  saveDb();
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
    installIsNewFile = !dbDecryptFailed && (!loaded.bytes || !loaded.bytes.length);
    try {
      initSchema();
      require("./fiskalizime-pos-shift").initPosShiftSchema(sqlite);
      ensureOrderCouponColumns();
    } catch (e) {
      if (/not a database|malformed|corrupt/i.test(String(e.message || e))) {
        if (!dbDecryptFailed) {
          backupCorruptDb("initSchema: " + (e.message || e));
        }
        rawDb = new SQL.Database();
        sqlite = wrapDb(rawDb);
        installIsNewFile = !dbDecryptFailed;
        initSchema();
        require("./fiskalizime-pos-shift").initPosShiftSchema(sqlite);
        ensureOrderCouponColumns();
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
    require("./fiskalizime-pos-shift").initPosShiftSchema(sqlite);
  } catch (e) {
    console.warn("[biznes] pos-shift reload:", e.message);
  }

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
      `SELECT id, name, price, vat_letter, vat_category, sort_order, unit_code, category_code,
              COALESCE(barcode, '') AS barcode,
              COALESCE(pos_category, 'Të tjera') AS pos_category,
              COALESCE(base_weight, 1) AS base_weight,
              COALESCE(sold_by_weight, 0) AS sold_by_weight
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
  const row = sqlite.prepare("SELECT id, base_weight FROM products WHERE id = ?").get(pid);
  if (!row) throw new Error("Produkti nuk u gjet.");
  const n = String(fields.name || "").trim();
  if (!n) throw new Error("Emri i produktit është i detyrueshëm.");
  const p = round4(fields.price);
  if (!(p >= 0) || Number.isNaN(p)) throw new Error("Çmimi i pavlefshëm.");
  const L = String(fields.vat_letter || "E").toUpperCase();
  if (!["A", "C", "D", "E"].includes(L)) {
    throw new Error("Norma TVSH duhet A, C, D ose E.");
  }
  const cat = vatCategoryForLetter(L);
  const unitCode = String(fields.unit_code || "EA").trim().toUpperCase() || "EA";
  const categoryCode = normalizeFiskalAtk(fields.category_code);
  const posCategory =
    fields.pos_category != null
      ? normalizePosCategoryLabel(fields.pos_category)
      : undefined;
  const barcode =
    fields.barcode != null ? String(fields.barcode).trim().replace(/\s+/g, "") : undefined;
  const baseWeight = resolveBaseWeightFromName(n, fields.base_weight, row.base_weight);
  if (barcode !== undefined || posCategory !== undefined) {
    const row = sqlite
      .prepare("SELECT barcode, pos_category FROM products WHERE id = ?")
      .get(pid);
    const bc = barcode !== undefined ? barcode : String(row?.barcode || "");
    if (bc) {
      const other = sqlite
        .prepare("SELECT id FROM products WHERE TRIM(COALESCE(barcode,'')) = ? AND id != ? LIMIT 1")
        .get(bc, pid);
      if (other) {
        throw new Error("Ky kod është në përdorim. Gjenero një tjetër ose shkruaj kod tjetër.");
      }
    }
    const pc =
      posCategory !== undefined
        ? posCategory
        : normalizePosCategoryLabel(row?.pos_category);
    sqlite
      .prepare(
        `UPDATE products SET name = ?, price = ?, vat_letter = ?, vat_category = ?,
         unit_code = ?, category_code = ?, barcode = ?, pos_category = ?, base_weight = ? WHERE id = ?`
      )
      .run(n, p, L, cat, unitCode, categoryCode, bc, pc, baseWeight, pid);
  } else {
    sqlite
      .prepare(
        `UPDATE products SET name = ?, price = ?, vat_letter = ?, vat_category = ?,
         unit_code = ?, category_code = ?, base_weight = ? WHERE id = ?`
      )
      .run(n, p, L, cat, unitCode, categoryCode, baseWeight, pid);
  }
  if (fields.description !== undefined) {
    sqlite
      .prepare("UPDATE products SET description = ? WHERE id = ?")
      .run(String(fields.description || "").slice(0, 2000), pid);
  }
  if (fields.sold_by_weight !== undefined) {
    const flag = fields.sold_by_weight === true || fields.sold_by_weight === 1 || fields.sold_by_weight === "1" ? 1 : 0;
    sqlite.prepare("UPDATE products SET sold_by_weight = ? WHERE id = ?").run(flag, pid);
  }
  syncMenuItemsFromProducts();
  return sqlite
    .prepare(
      `SELECT id, name, price, vat_letter, vat_category, sort_order, unit_code, category_code,
              COALESCE(barcode, '') AS barcode,
              COALESCE(pos_category, 'Të tjera') AS pos_category,
              COALESCE(base_weight, 1) AS base_weight,
              COALESCE(sold_by_weight, 0) AS sold_by_weight,
              COALESCE(description, '') AS description FROM products WHERE id = ?`
    )
    .get(pid);
}

const FISKAL_ATK_CATEGORY_CODES = ["TT", "UR", "AU", "PJA", "PAL", "DUH", "VM", "KO", "PP", "PE", "PS", "BM", "SM", "ST", "HT", "STI", "KB", "MPM", "PMI", "SEA", "STR", "AP", "PTI", "MN", "SHN"];

function normalizeFiskalAtk(code) {
  const c = String(code || "").trim().toUpperCase();
  return FISKAL_ATK_CATEGORY_CODES.includes(c) ? c : "TT";
}

function createProduct({
  name,
  price,
  vat_letter,
  unit_code,
  category_code,
  barcode,
  pos_category,
  base_weight,
  description,
  sold_by_weight,
}) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Emri i produktit është i detyrueshëm.");
  const p = round4(price);
  if (!(p >= 0) || Number.isNaN(p)) throw new Error("Çmimi i pavlefshëm.");
  const L = String(vat_letter || "E").toUpperCase();
  if (!["A", "C", "D", "E"].includes(L)) {
    throw new Error("Norma TVSH duhet A, C, D ose E.");
  }
  const cat = vatCategoryForLetter(L);
  const unitCode = String(unit_code || "EA").trim().toUpperCase() || "EA";
  const categoryCode = normalizeFiskalAtk(category_code);
  const maxSort = sqlite.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM products").get();
  const sort = (Number(maxSort?.m) || 0) + 1;
  const bc = String(barcode || "").trim().replace(/\s+/g, "");
  if (bc) {
    const dup = sqlite
      .prepare("SELECT id FROM products WHERE TRIM(COALESCE(barcode,'')) = ? LIMIT 1")
      .get(bc);
    if (dup) {
      throw new Error("Ky kod është në përdorim. Gjenero një tjetër ose shkruaj kod tjetër.");
    }
  }
  const posCat = normalizePosCategoryLabel(
    pos_category || inferPosCategoryForProduct({ name: n, category_code: categoryCode })
  );
  const baseWeight = resolveBaseWeightFromName(n, base_weight, 1);
  const weightFlag = sold_by_weight === true || sold_by_weight === 1 || sold_by_weight === "1" ? 1 : 0;
  const result = sqlite
    .prepare(
      `INSERT INTO products (name, price, vat_letter, vat_category, active, sort_order, unit_code, category_code, barcode, pos_category, base_weight, sold_by_weight)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(n, p, L, cat, sort, unitCode, categoryCode, bc, posCat, baseWeight, weightFlag);
  const id = Number(result.lastInsertRowid);
  sqlite
    .prepare("UPDATE products SET description = ? WHERE id = ?")
    .run(String(description || "").slice(0, 2000), id);
  syncMenuItemsFromProducts();
  return sqlite
    .prepare(
      `SELECT id, name, price, vat_letter, vat_category, sort_order, unit_code, category_code,
              COALESCE(barcode, '') AS barcode,
              COALESCE(pos_category, 'Të tjera') AS pos_category,
              COALESCE(base_weight, 1) AS base_weight,
              COALESCE(sold_by_weight, 0) AS sold_by_weight,
              COALESCE(description, '') AS description FROM products WHERE id = ?`
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

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function parseBaseWeightFromName(name) {
  const s = String(name || "");
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|l|kg|gr|g)\b/gi;
  let last = null;
  let m;
  while ((m = re.exec(s))) last = m;
  if (!last) return null;
  const num = Number(String(last[1]).replace(",", "."));
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = String(last[2]).toLowerCase();
  let v = num;
  if (unit === "ml" || unit === "g" || unit === "gr") v = num / 1000;
  return Math.round(v * 1000) / 1000;
}

function resolveBaseWeightFromName(name, incoming, existing) {
  const parsed = parseBaseWeightFromName(name);
  const hasIncoming = incoming != null && String(incoming).trim() !== "";
  const incomingN = hasIncoming ? normalizeBaseWeight(incoming) : null;
  const existingN =
    existing != null && String(existing).trim() !== "" ? normalizeBaseWeight(existing) : 1;
  if (hasIncoming && incomingN !== 1) return incomingN;
  if (existingN !== 1) return existingN;
  if (parsed != null) return parsed;
  return 1;
}

function applyBaseWeightFromNamesOnce() {
  if (String(getSetting("base_weight_from_name_v1") || "") === "1") return;
  const rows = sqlite.prepare("SELECT id, name, base_weight FROM products").all();
  const upd = sqlite.prepare("UPDATE products SET base_weight = ? WHERE id = ?");
  for (const row of rows) {
    if (normalizeBaseWeight(row.base_weight) !== 1) continue;
    const parsed = parseBaseWeightFromName(row.name);
    if (parsed == null || parsed === 1) continue;
    upd.run(parsed, row.id);
  }
  setSetting("base_weight_from_name_v1", "1");
}

function normalizeBaseWeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(n * 1000) / 1000;
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
    const unit = qty ? round4(lineNet / qty) : 0;
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

function resolveShiftOperatorId(operatorId, operatorName) {
  const pin = String(operatorId || "").trim();
  if (pin && pin !== "POS") {
    const op = getOperatorByPin(pin);
    if (op?.id) return Number(op.id);
  }
  const name = String(operatorName || "").trim();
  if (name) {
    const hit = getOperators({ includeInactive: false }).find(
      (o) => String(o.name || "").trim() === name
    );
    if (hit?.id) return Number(hit.id);
  }
  const first = getOperators({ includeInactive: false })[0];
  if (first?.id) return Number(first.id);
  throw new Error("Shto një punonjës te Punonjësit para se të hapësh nderrimin.");
}

function createSale({
  items,
  payment_method,
  operator_name,
  operator_id,
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
  const oid = resolveShiftOperatorId(operator_id, op);
  const shiftMod = require("./fiskalizime-pos-shift");
  const shift = shiftMod.assertShiftReadyForSale(oid, op);

  const payload = {
    items: normalized,
    cart_discount_amount: cartDisc,
    cart_surcharge_amount: cartSur,
    payment_splits: splits,
  };

  const result = sqlite
    .prepare(
      `INSERT INTO orders (items_json, total, subtotal, discount_total, payment_method, waiter_name, status, shift_id, operator_id)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
    )
    .run(JSON.stringify(payload), total, subtotal, cartDisc, payment, op, shift.id, oid);

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
    shift_id: shift.id,
    operator_db_id: oid,
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
    is_owner: !!(row.is_owner != null ? row.is_owner : 0),
  };
}

function validateOperatorName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Emri i punonjësit është i detyrueshëm");
  return n;
}

function validateOwnerPassword(pin) {
  const p = String(pin || "").trim();
  if (!p) throw new Error("Fjalëkalimi i hyrjes është i detyrueshëm");
  if (p.length > 128) throw new Error("Fjalëkalimi është shumë i gjatë (max 128)");
  return p;
}

function validateWorkerPin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4}$/.test(p)) throw new Error("PIN-i duhet të jetë 4 shifra");
  return p;
}

function validateOperatorPin(pin) {
  return validateWorkerPin(pin);
}

function countOwners() {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM operators WHERE active = 1 AND COALESCE(is_owner, 0) = 1`)
    .get();
  return Number(row?.c) || 0;
}

function addOperator(name, pin, opts = {}) {
  const n = validateOperatorName(name);
  const activeCount = countActiveOperators();
  let isOwner = !!opts.is_owner && countOwners() === 0;
  if (activeCount === 0) isOwner = true;
  const p = isOwner ? validateOwnerPassword(pin) : validateWorkerPin(pin);
  try {
    const r = sqlite
      .prepare(`INSERT INTO operators (name, pin_code, active, is_owner) VALUES (?, ?, 1, ?)`)
      .run(n, p, isOwner ? 1 : 0);
    return rowToOperator({
      id: Number(r.lastInsertRowid),
      name: n,
      pin_code: p,
      active: 1,
      is_owner: isOwner ? 1 : 0,
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
    ? `SELECT id, name, pin_code, active, is_owner FROM operators ORDER BY name COLLATE NOCASE`
    : `SELECT id, name, pin_code, active, is_owner FROM operators WHERE active = 1 ORDER BY name COLLATE NOCASE`;
  return sqlite.prepare(sql).all().map(rowToOperator);
}

function getOperatorByPin(pin) {
  const p = String(pin || "").trim();
  if (!p) return null;
  const row = sqlite
    .prepare(
      `SELECT id, name, pin_code, active, is_owner FROM operators WHERE pin_code = ? AND active = 1`
    )
    .get(p);
  return rowToOperator(row);
}

function updateOperator(id, patch = {}) {
  const oid = Number(id);
  if (!oid) throw new Error("ID punonjësi mungon");
  const existing = sqlite
    .prepare(`SELECT id, COALESCE(is_owner, 0) AS is_owner FROM operators WHERE id = ?`)
    .get(oid);
  if (!existing) throw new Error("Punonjësi nuk u gjet");

  const name = patch.name != null ? validateOperatorName(patch.name) : null;
  const pin =
    patch.pin_code != null
      ? Number(existing.is_owner) === 1
        ? validateOwnerPassword(patch.pin_code)
        : validateWorkerPin(patch.pin_code)
      : null;
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
    .prepare(`SELECT id, name, pin_code, active, is_owner FROM operators WHERE id = ?`)
    .get(oid);
  return rowToOperator(row);
}

function deactivateOperator(id) {
  const oid = Number(id);
  if (!oid) throw new Error("ID punonjësi mungon");
  const ownerRow = sqlite
    .prepare(`SELECT COALESCE(is_owner, 0) AS o FROM operators WHERE id = ?`)
    .get(oid);
  if (!ownerRow) throw new Error("Punonjësi nuk u gjet");
  if (Number(ownerRow.o) === 1) throw new Error("Pronari nuk çaktivizohet");
  const r = sqlite.prepare(`UPDATE operators SET active = 0 WHERE id = ?`).run(oid);
  if (!r.changes) throw new Error("Punonjësi nuk u gjet");
  const row = sqlite
    .prepare(`SELECT id, name, pin_code, active, is_owner FROM operators WHERE id = ?`)
    .get(oid);
  return rowToOperator(row);
}

function deleteOperator(id) {
  const oid = Number(id);
  if (!oid) throw new Error("ID punonjësi mungon");
  const ownerRow = sqlite
    .prepare(`SELECT COALESCE(is_owner, 0) AS o FROM operators WHERE id = ?`)
    .get(oid);
  if (!ownerRow) throw new Error("Punonjësi nuk u gjet");
  if (Number(ownerRow.o) === 1) throw new Error("Pronari nuk fshihet");
  const r = sqlite.prepare(`DELETE FROM operators WHERE id = ?`).run(oid);
  if (!r.changes) throw new Error("Punonjësi nuk u gjet");
  return { id: oid, deleted: true };
}

function countActiveOperators() {
  const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM operators WHERE active = 1`).get();
  return Number(row?.c) || 0;
}

function ensureOrderCouponColumns() {
  const cols = [
    ["coupon_type", "TEXT NOT NULL DEFAULT ''"],
    ["ref_order_id", "INTEGER"],
    ["correction_type", "TEXT NOT NULL DEFAULT ''"],
    ["void_reason", "TEXT NOT NULL DEFAULT ''"],
    ["thermal_daily_no", "INTEGER"],
  ];
  for (const [name, def] of cols) {
    try {
      sqlite.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${def}`).run();
    } catch {
      /* kolona ekziston */
    }
  }
  backfillThermalDailyNumbers();
}

function isThermalNumberRow(row) {
  if (!row) return false;
  if (Number(row.is_fiscalized) === 1) return false;
  if (Number(row.fiscal_receipt_id)) return false;
  if (String(row.coupon_type || "") === "thermal") return true;
  return ["return", "cancel", "storno", "exchange"].includes(String(row.correction_type || ""));
}

function backfillThermalDailyNumbers() {
  const rows = sqlite
    .prepare(
      `SELECT id, date(created_at) AS d
       FROM orders
       WHERE COALESCE(is_fiscalized, 0) = 0
         AND (fiscal_receipt_id IS NULL OR fiscal_receipt_id = 0)
         AND (thermal_daily_no IS NULL OR thermal_daily_no = 0)
         AND (
           coupon_type = 'thermal'
           OR correction_type IN ('return','cancel','storno','exchange')
         )
       ORDER BY date(created_at), id`
    )
    .all();
  const upd = sqlite.prepare(
    `UPDATE orders SET thermal_daily_no = ? WHERE id = ? AND (thermal_daily_no IS NULL OR thermal_daily_no = 0)`
  );
  const maxForDay = sqlite.prepare(
    `SELECT COALESCE(MAX(thermal_daily_no), 0) AS n
     FROM orders
     WHERE date(created_at) = date(?)
       AND thermal_daily_no IS NOT NULL
       AND thermal_daily_no > 0`
  );
  let day = "";
  let n = 0;
  for (const row of rows) {
    const d = String(row.d || "");
    if (d !== day) {
      day = d;
      n = Number(maxForDay.get(d)?.n) || 0;
    }
    n += 1;
    upd.run(n, row.id);
  }
}

function assignThermalDailyNo(orderId) {
  const id = Number(orderId);
  const row = sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!isThermalNumberRow(row)) return null;
  if (Number(row.thermal_daily_no) > 0) return Number(row.thermal_daily_no);
  const day = String(row.created_at || "").slice(0, 10);
  const maxRow = sqlite
    .prepare(
      `SELECT COALESCE(MAX(thermal_daily_no), 0) AS n
       FROM orders
       WHERE date(created_at) = date(?)
         AND id != ?
         AND thermal_daily_no IS NOT NULL
         AND thermal_daily_no > 0
         AND COALESCE(is_fiscalized, 0) = 0
         AND (fiscal_receipt_id IS NULL OR fiscal_receipt_id = 0)`
    )
    .get(day, id);
  const next = (Number(maxRow?.n) || 0) + 1;
  sqlite.prepare("UPDATE orders SET thermal_daily_no = ? WHERE id = ?").run(next, id);
  return next;
}

function markOrderCouponType(orderId, couponType) {
  const type = String(couponType || "");
  sqlite.prepare(`UPDATE orders SET coupon_type = ? WHERE id = ?`).run(type, Number(orderId));
  if (type === "thermal") return assignThermalDailyNo(orderId);
  return null;
}

function todayIsoLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysIsoLocal(iso, days) {
  const [y, m, d] = String(iso || todayIsoLocal())
    .slice(0, 10)
    .split("-")
    .map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + Number(days || 0));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function paymentLabel(pm) {
  const p = String(pm || "cash").toLowerCase();
  if (
    p === "card" ||
    p === "karte" ||
    p === "kartë" ||
    p === "credit_card" ||
    p === "debit_card" ||
    p === "pos"
  ) {
    return "Kartë";
  }
  if (p === "mixed" || p === "perzier") return "Përzier";
  if (p === "bank_account") return "Bankë";
  return "Cash";
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

function parseOrderPayload(row) {
  try {
    const raw = JSON.parse(row?.items_json || "{}");
    if (Array.isArray(raw)) return { items: raw, payment_splits: [] };
    return {
      items: Array.isArray(raw.items) ? raw.items : [],
      payment_splits: Array.isArray(raw.payment_splits) ? raw.payment_splits : [],
    };
  } catch {
    return { items: [], payment_splits: [] };
  }
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
  return parseOrderPayload(row).payment_splits;
}

function cashFromOrderRow(row) {
  const total = round2(row.total);
  const splits = rowPaymentSplits(row);
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
  const splits = rowPaymentSplits(row);
  if (splits.length) {
    return round2(
      splits
        .filter((p) => isCardPayment(p.method))
        .reduce((s, p) => s + round2(p.amount), 0)
    );
  }
  return isCardPayment(row.payment_method) ? total : 0;
}

function resolveDitariRange(opts = {}) {
  const period = String(opts.period || "sot").toLowerCase();
  const today = todayIsoLocal();
  let from = opts.from || opts.dateFrom;
  let to = opts.to || opts.dateTo;
  if (period === "custom") {
    from = String(from || today).slice(0, 10);
    to = String(to || from || today).slice(0, 10);
  } else if (period === "java") {
    from = addDaysIsoLocal(today, -6);
    to = today;
  } else if (period === "muaj") {
    from = `${today.slice(0, 7)}-01`;
    to = today;
  } else {
    from = today;
    to = today;
  }
  from = String(from || today).slice(0, 10);
  to = String(to || today).slice(0, 10);
  let label = "Sot";
  if (period === "java") label = "Kjo javë";
  else if (period === "muaj") label = "Ky muaj";
  else if (period === "custom") label = `${from} – ${to}`;
  return { from, to, label };
}

function parseStoredVatLetters(raw) {
  const letters = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  try {
    const vb = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
    for (const L of ["A", "B", "C", "D", "E"]) {
      letters[L] = Number(vb[L] ?? vb[L.toLowerCase()]) || 0;
    }
  } catch {
    /* */
  }
  return letters;
}

function isDitariCorrectionType(receiptType) {
  return ["cancel", "storno", "return"].includes(String(receiptType || "").toLowerCase());
}

function vatPartsFromItems(items, total) {
  const list = Array.isArray(items) ? items : [];
  let base = 0;
  const lines = [];
  for (const it of list) {
    const gross = Math.abs(Number(it.price) || 0) * Math.abs(Number(it.quantity ?? it.qty) || 0);
    const letter = String(it.vat_letter || it.vat_norm || "E").toUpperCase();
    let pct = Number(it.vat_rate ?? it.vat_percent);
    if (!Number.isFinite(pct)) {
      pct = letter === "D" ? 8 : letter === "A" || letter === "C" || letter === "B" ? 0 : 18;
    }
    base += gross;
    lines.push({ gross, pct });
  }
  const paid = Number(total) || 0;
  const scale = base > 0 ? Math.abs(paid) / base : 1;
  let tax8 = 0;
  let tax18 = 0;
  let tax = 0;
  for (const line of lines) {
    const g = round2(line.gross * scale);
    const r = Number(line.pct) || 0;
    const part = r > 0 && g > 0 ? round2((g * r) / (100 + r)) : 0;
    tax += part;
    if (line.pct === 8) tax8 += part;
    else if (line.pct === 18) tax18 += part;
  }
  tax = round2(tax);
  tax8 = round2(tax8);
  tax18 = round2(tax18);
  const sign = paid < 0 ? -1 : 1;
  return {
    pa: round2(paid - sign * tax),
    tvsh: round2(sign * tax),
    tvsh8: round2(sign * tax8),
    tvsh18: round2(sign * tax18),
  };
}

function parseThermalOrderRef(value) {
  const s = String(value || "")
    .trim()
    .replace(/^#/, "");
  const pos = s.match(/^POS-0*(\d+)$/i);
  const digits = pos ? pos[1] : s;
  if (!/^\d+$/.test(digits)) return null;
  const id = Number(digits);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function isThermalSaleOrder(order) {
  if (!order) return false;
  if (Number(order.ref_order_id) > 0) return false;
  if (String(order.correction_type || "")) return false;
  if (Number(order.is_fiscalized) === 1) return false;
  if (Number(order.fiscal_receipt_id) > 0) return false;
  return true;
}

function isThermalCouponRef(value) {
  const id = parseThermalOrderRef(value);
  if (!id) return false;
  const order = sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  return isThermalSaleOrder(order);
}

function orderItemKey(it) {
  const id = Number(it.product_id || it.menu_item_id) || 0;
  const name = String(it.name || "").trim();
  const price = Math.round((Number(it.price ?? it.unit_price) || 0) * 10000) / 10000;
  return id ? `id:${id}:${price}` : `n:${name}:${price}`;
}

function correctionOrdersFor(orderId) {
  return sqlite
    .prepare(
      `SELECT id, items_json, total, correction_type, status, void_reason, payment_method, waiter_name, created_at
       FROM orders
       WHERE ref_order_id = ?
         AND correction_type IN ('return','cancel','storno','exchange')
       ORDER BY id ASC`
    )
    .all(Number(orderId));
}

function remainingLinesForOrder(order) {
  const base = parseOrderPayload(order).items.map((it) => ({
    ...it,
    quantity: Math.abs(Number(it.quantity ?? it.qty) || 0),
  }));
  const lines = base.map((it) => ({
    ...it,
    original_quantity: Math.abs(Number(it.quantity) || 0),
    already_returned: 0,
    remaining_quantity: Math.abs(Number(it.quantity) || 0),
  }));
  const extra = [];
  for (const log of correctionOrdersFor(order.id)) {
    const kind = String(log.correction_type || "");
    const items = parseOrderPayload(log).items;
    if (kind === "exchange") {
      for (const it of items) {
        const qty = Number(it.quantity) || 0;
        if (qty < 0) {
          const key = orderItemKey(it);
          const line =
            lines.find((l) => orderItemKey(l) === key) || extra.find((l) => orderItemKey(l) === key);
          if (line) line.remaining_quantity = Math.max(0, line.remaining_quantity - Math.abs(qty));
        } else if (qty > 0) {
          extra.push({
            ...it,
            quantity: qty,
            original_quantity: 0,
            already_returned: 0,
            remaining_quantity: qty,
          });
        }
      }
    } else {
      for (const it of items) {
        const qty = Math.abs(Number(it.quantity) || 0);
        const key = orderItemKey(it);
        const line =
          lines.find((l) => orderItemKey(l) === key) || extra.find((l) => orderItemKey(l) === key);
        if (!line) continue;
        line.already_returned = round2((Number(line.already_returned) || 0) + qty);
        line.remaining_quantity = Math.max(0, round2((Number(line.remaining_quantity) || 0) - qty));
      }
    }
  }
  return lines.concat(extra);
}

function returnedCountLabel(touched, fully, correctionType) {
  if (fully) {
    if (correctionType === "storno") return "Storno";
    if (correctionType === "cancel") return "Anuluar";
    return "Kthyer krejt";
  }
  if (touched === 1) return "Kthyer 1 artikull";
  if (touched > 1) return `Kthyer ${touched} artikuj`;
  return "";
}

function correctionTypeLabel(kind) {
  const k = String(kind || "");
  if (k === "cancel") return "anulim";
  if (k === "storno") return "storno";
  if (k === "return") return "kthim malli";
  if (k === "exchange") return "ndërrim";
  return "";
}

function saleReturnStatus(order) {
  const logs = correctionOrdersFor(order.id);
  const moneyLogs = logs.filter((l) => String(l.correction_type) !== "exchange");
  const lastType = moneyLogs.length ? String(moneyLogs[moneyLogs.length - 1].correction_type || "") : "";
  const lines = remainingLinesForOrder(order);
  let touched = 0;
  let fully = lines.length > 0;
  for (const it of lines) {
    if ((Number(it.already_returned) || 0) > 0) touched += 1;
    if ((Number(it.remaining_quantity) || 0) > 1e-9) fully = false;
  }
  const label = returnedCountLabel(touched, fully && moneyLogs.length > 0, lastType);
  if (label) return label;
  if (logs.some((l) => String(l.correction_type) === "exchange")) return "Ndërruar";
  return "completed";
}

function shiftForThermalCorrection(order, operatorId) {
  const oid = Number(operatorId) || Number(order.operator_id) || 0;
  try {
    const shiftMod = require("./fiskalizime-pos-shift");
    shiftMod.rollOpenPosShiftsToLocalDay();
    const open = shiftMod.getOpenPosShift(oid);
    if (open?.id) return { shift_id: open.id, operator_id: oid };
  } catch {
    /* */
  }
  return { shift_id: order.shift_id || null, operator_id: order.operator_id || null };
}

function loadThermalSale(orderId) {
  const order = sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(Number(orderId));
  if (!order) throw new Error("Shitja nuk u gjet.");
  if (!isThermalSaleOrder(order)) throw new Error("Vetëm kuponi termik kthehet këtu.");
  return order;
}

function remainingMoney(lines) {
  return round2(
    lines.reduce((s, l) => s + (Number(l.price ?? l.unit_price) || 0) * (Number(l.remaining_quantity) || 0), 0)
  );
}

function findRemainingLine(lines, req) {
  const pid = Number(req.product_id || req.menu_item_id || req.id) || 0;
  const name = String(req.name || "").trim();
  const price = Number(req.price ?? req.unit_price);
  return lines.find((l) => {
    if ((Number(l.remaining_quantity) || 0) <= 1e-9) return false;
    if (pid && Number(l.product_id || l.menu_item_id) === pid) return true;
    if (name && String(l.name || "").trim() === name) {
      if (!Number.isFinite(price)) return true;
      return Math.abs((Number(l.price ?? l.unit_price) || 0) - price) < 0.0001;
    }
    return false;
  });
}

function insertThermalCorrection(order, { items, total, correctionType, reason, cashier, operatorId }) {
  const meta = shiftForThermalCorrection(order, operatorId);
  const payload = { items, payment_splits: parseOrderPayload(order).payment_splits };
  const result = sqlite
    .prepare(
      `INSERT INTO orders (
         items_json, total, subtotal, discount_total, payment_method, waiter_name, status,
         shift_id, operator_id, coupon_type, ref_order_id, correction_type, void_reason
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'thermal', ?, ?, ?)`
    )
    .run(
      JSON.stringify(payload),
      round2(total),
      round2(total),
      order.payment_method || "cash",
      cashier,
      correctionType,
      meta.shift_id,
      meta.operator_id,
      order.id,
      correctionType,
      String(reason || "").trim()
    );
  const id = Number(result.lastInsertRowid);
  assignThermalDailyNo(id);
  return id;
}

function thermalDailyNoOf(orderId) {
  const row = sqlite.prepare("SELECT thermal_daily_no FROM orders WHERE id = ?").get(Number(orderId));
  return Number(row?.thermal_daily_no) || 0;
}

function correctionSlip(order, lines, refundTotal, remainingTotal, correctionType, reason, cashier) {
  return {
    order_id: order.id,
    original_ref: `#${order.id}`,
    correction_type: correctionType,
    correction_label: correctionTypeLabel(correctionType),
    items: lines.map((it) => ({
      product_id: it.product_id || it.menu_item_id || null,
      name: it.name,
      quantity: Number(it.quantity) || 0,
      price: Number(it.price ?? it.unit_price) || 0,
      side: it.side || "",
    })),
    refund_total: round2(Math.abs(refundTotal)),
    remaining_total: round2(Math.max(0, remainingTotal)),
    payment_method: order.payment_method,
    reason: String(reason || "").trim(),
    cashier,
  };
}

function partialRefundThermalSale(orderId, refundItems, reason, cashierName, operatorId) {
  const order = loadThermalSale(orderId);
  const reqLines = Array.isArray(refundItems) ? refundItems : [];
  if (!reqLines.length) throw new Error("Zgjidhni të paktën një artikull për kthim.");
  const leftLines = remainingLinesForOrder(order);
  let refundTotal = 0;
  const logItems = [];
  for (const req of reqLines) {
    const rqty = Number(req.quantity ?? req.qty) || 0;
    if (rqty <= 0) continue;
    const line = findRemainingLine(leftLines, req);
    if (!line) throw new Error("Artikulli nuk është në këtë shitje.");
    if (rqty > (Number(line.remaining_quantity) || 0) + 1e-9) {
      throw new Error(`Sasia e kthimit te «${line.name}» tejkalon të mbeturën.`);
    }
    const unit = Number(line.price ?? line.unit_price) || 0;
    refundTotal += unit * rqty;
    line.remaining_quantity = round2((Number(line.remaining_quantity) || 0) - rqty);
    logItems.push({
      product_id: line.product_id || line.menu_item_id || null,
      menu_item_id: line.product_id || line.menu_item_id || null,
      name: line.name,
      quantity: rqty,
      price: unit,
      unit_price: unit,
      vat_letter: line.vat_letter || line.vat_norm || "E",
      vat_norm: line.vat_norm || line.vat_letter || "E",
    });
  }
  if (!logItems.length) throw new Error("Zgjidhni të paktën një artikull për kthim.");
  refundTotal = round2(refundTotal);
  const remainingTotal = remainingMoney(leftLines);
  const cashier = String(cashierName || order.waiter_name || "Operator").trim();
  const reasonStr = String(reason || "").trim();
  const id = insertThermalCorrection(order, {
    items: logItems,
    total: -Math.abs(refundTotal),
    correctionType: "return",
    reason: reasonStr,
    cashier,
    operatorId,
  });
  return {
    ok: true,
    mode: "thermal",
    order_id: order.id,
    correction_id: id,
    refund_total: refundTotal,
    thermal_daily_no: thermalDailyNoOf(id),
    ...correctionSlip(order, logItems, refundTotal, remainingTotal, "return", reasonStr, cashier),
  };
}

function refundThermalSale(orderId, cashierName, operatorId, reason, correctionType) {
  const order = loadThermalSale(orderId);
  const kind = correctionType === "storno" ? "storno" : "cancel";
  const left = remainingLinesForOrder(order).filter((it) => (Number(it.remaining_quantity) || 0) > 1e-9);
  if (!left.length) throw new Error("Kjo shitje është kthyer tashmë.");
  const logItems = left.map((it) => ({
    product_id: it.product_id || it.menu_item_id || null,
    menu_item_id: it.product_id || it.menu_item_id || null,
    name: it.name,
    quantity: it.remaining_quantity,
    price: Number(it.price ?? it.unit_price) || 0,
    unit_price: Number(it.price ?? it.unit_price) || 0,
    vat_letter: it.vat_letter || it.vat_norm || "E",
    vat_norm: it.vat_norm || it.vat_letter || "E",
  }));
  const refundTotal = round2(logItems.reduce((s, it) => s + it.price * it.quantity, 0));
  const cashier = String(cashierName || order.waiter_name || "Operator").trim();
  const reasonStr = String(reason || "").trim();
  const id = insertThermalCorrection(order, {
    items: logItems,
    total: -Math.abs(refundTotal),
    correctionType: kind,
    reason: reasonStr,
    cashier,
    operatorId,
  });
  return {
    ok: true,
    mode: "thermal",
    order_id: order.id,
    correction_id: id,
    refund_total: refundTotal,
    thermal_daily_no: thermalDailyNoOf(id),
    ...correctionSlip(order, logItems, refundTotal, 0, kind, reasonStr, cashier),
  };
}

function exchangeThermalSale(orderId, exchangeLines, reason, cashierName, operatorId) {
  const order = loadThermalSale(orderId);
  const reqLines = Array.isArray(exchangeLines) ? exchangeLines : [];
  if (!reqLines.length) throw new Error("Zgjidhni të paktën një artikull për ndërrim.");
  const leftLines = remainingLinesForOrder(order);
  let delta = 0;
  const logItems = [];
  for (const raw of reqLines) {
    const qty = Number(raw.quantity ?? raw.qty) || 0;
    const newId = Number(raw.new_product_id) || 0;
    if (qty <= 0 || !newId) continue;
    const line = findRemainingLine(leftLines, raw);
    if (!line) throw new Error(`Artikulli nuk është në këtë shitje: ${raw.name || ""}`.trim());
    if (qty > (Number(line.remaining_quantity) || 0) + 1e-9) {
      throw new Error(`Sasia tejkalon të mbeturën për: ${line.name}`);
    }
    const neu = sqlite.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(newId);
    if (!neu) throw new Error("Produkti i ri nuk ekziston.");
    const oldVat = String(line.vat_norm || line.vat_letter || "E").toUpperCase();
    const newVat = String(neu.vat_letter || "E").toUpperCase();
    if (oldVat !== newVat) throw new Error(`Norma TVSH duhet e njëjtë (${oldVat} ≠ ${newVat})`);
    const oldUnit = Number(line.price ?? line.unit_price) || 0;
    const newUnit = Number(neu.price) || 0;
    delta += (newUnit - oldUnit) * qty;
    line.remaining_quantity = round2((Number(line.remaining_quantity) || 0) - qty);
    logItems.push({
      product_id: line.product_id || line.menu_item_id || null,
      name: line.name,
      quantity: -qty,
      price: oldUnit,
      side: "out",
      vat_letter: oldVat,
      vat_norm: oldVat,
    });
    logItems.push({
      product_id: neu.id,
      name: neu.name,
      quantity: qty,
      price: newUnit,
      side: "in",
      vat_letter: newVat,
      vat_norm: newVat,
    });
  }
  if (!logItems.length) throw new Error("Zgjidhni të paktën një artikull për ndërrim.");
  delta = round2(delta);
  const cashier = String(cashierName || order.waiter_name || "Operator").trim();
  const reasonStr = String(reason || "").trim();
  const id = insertThermalCorrection(order, {
    items: logItems,
    total: delta,
    correctionType: "exchange",
    reason: reasonStr,
    cashier,
    operatorId,
  });
  const remainingTotal = remainingMoney(remainingLinesForOrder(sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(order.id)));
  return {
    ok: true,
    mode: "thermal",
    order_id: order.id,
    correction_id: id,
    delta_total: delta,
    thermal_daily_no: thermalDailyNoOf(id),
    refund_total: delta < 0 ? Math.abs(delta) : 0,
    remaining_total: remainingTotal,
    original_ref: `#${order.id}`,
    correction_type: "exchange",
    correction_label: "ndërrim",
    items: logItems,
    payment_method: order.payment_method,
    reason: reasonStr,
    cashier,
  };
}

function listThermalCoupons(limit = 100) {
  const lim = Math.min(2000, Math.max(1, Number(limit) || 100));
  const sales = sqlite
    .prepare(
      `SELECT * FROM orders
       WHERE (ref_order_id IS NULL OR ref_order_id = 0)
         AND COALESCE(is_fiscalized, 0) = 0
         AND (fiscal_receipt_id IS NULL OR fiscal_receipt_id = 0)
         AND COALESCE(correction_type, '') = ''
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(lim);
  const logs = sqlite
    .prepare(
      `SELECT * FROM orders
       WHERE ref_order_id IS NOT NULL
         AND correction_type IN ('return','cancel','storno','exchange')
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(lim);
  const saleRows = sales.filter(isThermalSaleOrder).map((row) => {
    const created = String(row.created_at || "");
    const fiscal_date = created.slice(0, 10);
    const fiscal_time = created.length >= 19 ? created.slice(11, 19) : "";
    const returnStatus = saleReturnStatus(row);
    return {
      id: `t-${row.id}`,
      order_id: row.id,
      nuikf: `#${row.id}`,
      receipt_type: "shitje",
      receipt_type_label: "shitje",
      daily_number: Number(row.thermal_daily_no) || 0,
      total_number: "",
      fiscal_date,
      fiscal_time,
      total_amount: Number(row.total) || 0,
      payment_method: row.payment_method,
      payment_label: paymentLabel(row.payment_method),
      operator_name: row.waiter_name,
      atk_label: returnStatus === "completed" ? "Termik" : returnStatus,
      atk_ok: false,
      status: returnStatus,
      return_status: returnStatus === "completed" ? "" : returnStatus,
      mode: "thermal",
    };
  });
  const correctionRows = logs.map((row) => {
    const created = String(row.created_at || "");
    const label = correctionTypeLabel(row.correction_type) || "kthim malli";
    return {
      id: `c-${row.id}`,
      order_id: row.ref_order_id,
      log_id: row.id,
      nuikf: `#${row.ref_order_id}`,
      receipt_type: label,
      receipt_type_label: label,
      daily_number: Number(row.thermal_daily_no) || 0,
      total_number: "",
      fiscal_date: created.slice(0, 10),
      fiscal_time: created.length >= 19 ? created.slice(11, 19) : "",
      total_amount: Number(row.total) || 0,
      payment_method: row.payment_method,
      payment_label: paymentLabel(row.payment_method),
      operator_name: row.waiter_name,
      atk_label: label,
      atk_ok: false,
      status: label,
      return_status: label,
      mode: "thermal",
    };
  });
  return saleRows.concat(correctionRows);
}

function thermalOrderDetails(orderId) {
  const order = loadThermalSale(orderId);
  const created = String(order.created_at || "");
  const items = remainingLinesForOrder(order).map((it) => ({
    name: it.name,
    product_id: it.product_id || it.menu_item_id || null,
    quantity: it.remaining_quantity,
    original_quantity: it.original_quantity,
    already_returned: it.already_returned,
    remaining_quantity: it.remaining_quantity,
    price: Number(it.price ?? it.unit_price) || 0,
    unit_price: Number(it.price ?? it.unit_price) || 0,
    vat_norm: it.vat_norm || it.vat_letter || "E",
    vat_letter: it.vat_letter || it.vat_norm || "E",
  }));
  return {
    id: order.id,
    nuikf: `#${order.id}`,
    receipt_type: "thermal",
    total_amount: Number(order.total) || 0,
    fiscal_date: created.slice(0, 10),
    fiscal_time: created.length >= 19 ? created.slice(11, 19) : "",
    items,
    mode: "thermal",
  };
}

function thermalCouponPreview(ref) {
  const raw = String(ref || "");
  const settings = getFiscalSettingsRow() || {};
  const restaurantName = settings.taxpayer_legal_name || "Revolution Fiskalizim";
  const { buildReceiptText, buildCorrectionReceiptText } = require("./receipt-text");
  if (raw.startsWith("c-")) {
    const lid = Number(raw.slice(2));
    const log = sqlite
      .prepare(
        `SELECT * FROM orders WHERE id = ? AND ref_order_id IS NOT NULL AND correction_type IN ('return','cancel','storno','exchange')`
      )
      .get(lid);
    if (!log) throw new Error("Kuponi nuk u gjet.");
    const kind = String(log.correction_type || "");
    const titles = {
      return: "KTHIM MALLI",
      cancel: "ANULIM",
      storno: "STORNO",
      exchange: "NDERIM ARTIKULLI",
    };
    const items = parseOrderPayload(log).items.map((it) => {
      const qty = Number(it.quantity ?? it.qty) || 0;
      return {
        name: String(it.name || "").trim(),
        quantity: qty,
        price: Number(it.price ?? it.unit_price) || 0,
        side: it.side || (qty < 0 ? "out" : kind === "exchange" ? "in" : ""),
      };
    }).filter((it) => it.name && it.quantity !== 0);
    const order = sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(log.ref_order_id);
    const text = buildCorrectionReceiptText({
      restaurantName,
      title: titles[kind] || "KTHIM MALLI",
      originalRef: `#${log.ref_order_id}`,
      receiptNumber: Number(log.thermal_daily_no) > 0 ? `T-${Number(log.thermal_daily_no)}` : "",
      items,
      refundTotal: Number(log.total) < 0 ? Math.abs(Number(log.total)) : 0,
      remainingTotal: order ? remainingMoney(remainingLinesForOrder(order)) : 0,
      delta: kind === "exchange" ? Number(log.total) || 0 : null,
      reason: log.void_reason,
      paymentMethod: log.payment_method,
      cashierName: log.waiter_name,
      closedAt: String(log.created_at || "").replace(" ", "T"),
    });
    return { text, nuikf: `#${log.ref_order_id}`, label: correctionTypeLabel(kind) || "kthim malli", mode: "thermal" };
  }
  const id = raw.startsWith("t-") ? Number(raw.slice(2)) : parseThermalOrderRef(raw);
  const order = id ? sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(id) : null;
  if (!order || !isThermalSaleOrder(order)) throw new Error("Kuponi nuk u gjet.");
  const items = parseOrderPayload(order).items;
  const text = buildReceiptText({
    restaurantName,
    items,
    total: Number(order.total) || 0,
    receiptNumber: String(Number(order.thermal_daily_no) || ""),
    cashierName: order.waiter_name,
    closedAt: String(order.created_at || "").replace(" ", "T"),
    paymentMethod: order.payment_method,
    slipKind: "final",
    markedTotal: false,
  });
  return { text, nuikf: `#${order.id}`, label: "shitje", mode: "thermal" };
}

function getDitari(opts = {}) {
  const periodRaw = String(opts.period || "").trim().toLowerCase();
  const period =
    periodRaw || (opts.from && opts.to ? "custom" : "sot");
  const range = resolveDitariRange({
    period,
    from: opts.from,
    to: opts.to,
  });
  const rows = sqlite
    .prepare(
      `SELECT id, total, payment_method, waiter_name, status, created_at, items_json
       FROM orders
       WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)
       ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all(range.from, range.to);
  let fiscalRows = [];
  try {
    fiscalRows = sqlite
      .prepare(
        `SELECT id, sale_id, receipt_type, total_amount, total_without_tax, vat_breakdown_json,
                payment_method, payment_splits_json, operator_name, created_at, items_json
         FROM fiscal_receipts
         WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)`
      )
      .all(range.from, range.to);
  } catch {
    fiscalRows = [];
  }
  const regularBySale = new Map();
  for (const r of fiscalRows) {
    if (isDitariCorrectionType(r.receipt_type)) continue;
    const sid = Number(r.sale_id);
    if (sid && !regularBySale.has(sid)) regularBySale.set(sid, r);
  }
  const parsed = rows.map((e) => {
    const created = String(e.created_at || "");
    const date = created.slice(0, 10);
    const time = created.length >= 19 ? created.slice(11, 19) : created.slice(11) || "00:00:00";
    const payload = parseOrderPayload(e);
    const items = payload.items;
    const receipt = regularBySale.get(Number(e.id));
    return {
      id: e.id,
      date,
      time,
      waiter_name: e.waiter_name || "Operator",
      payment_method: e.payment_method || "cash",
      payment_label: paymentLabel(e.payment_method),
      artikujt: items.map((i) => `${i.quantity || 1}× ${i.name}`).join(", "),
      items,
      total: Number(e.total) || 0,
      status: e.status || "completed",
      cash_amount: cashFromOrderRow(e),
      card_amount: cardFromOrderRow(e),
      _letters: receipt ? parseStoredVatLetters(receipt.vat_breakdown_json) : null,
    };
  });
  const corrections = fiscalRows.filter((r) => isDitariCorrectionType(r.receipt_type)).map((r) => {
      const created = String(r.created_at || "").replace("T", " ");
      const date = created.slice(0, 10);
      const time = created.length >= 19 ? created.slice(11, 19) : created.slice(11) || "00:00:00";
      const rawItems = parseOrderPayload({ items_json: r.items_json }).items;
      const items = rawItems.map((it) => {
        const letter = String(it.vat_letter || it.vat_norm || "E").toUpperCase();
        return {
          name: it.name,
          quantity: Number(it.quantity ?? it.qty) || 0,
          price: Number(it.price ?? it.unit_price) || 0,
          vat_letter: letter,
          vat_norm: letter,
        };
      });
      const total = round2(r.total_amount);
      const payRow = {
        total,
        payment_method: r.payment_method || "cash",
        items_json: r.items_json,
        payment_splits_json: r.payment_splits_json,
      };
      return {
        id: r.id,
        date,
        time,
        waiter_name: r.operator_name || "Operator",
        payment_method: payRow.payment_method,
        payment_label: paymentLabel(payRow.payment_method),
        artikujt: items.map((i) => `${i.quantity || 1}× ${i.name}`).join(", "),
        items,
        total,
        status: String(r.receipt_type || "").toLowerCase(),
        cash_amount: cashFromOrderRow(payRow),
        card_amount: cardFromOrderRow(payRow),
        _letters: parseStoredVatLetters(r.vat_breakdown_json),
      };
    });
  const merged = [...parsed, ...corrections].sort((a, b) => {
    const ka = `${a.date || ""} ${a.time || ""}`;
    const kb = `${b.date || ""} ${b.time || ""}`;
    if (ka !== kb) return kb.localeCompare(ka);
    return Number(b.id) - Number(a.id);
  });
  const completed = merged.filter((e) => String(e.status || "") !== "cancelled");
  const totalSales = completed.reduce((sum, e) => sum + e.total, 0);
  let totalCash = 0;
  let totalKarte = 0;
  for (const e of completed) {
    totalCash += e.cash_amount;
    totalKarte += e.card_amount;
  }
  const letterSum = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const fiscalEntries = completed.filter((e) => e._letters);
  for (const e of fiscalEntries) {
    for (const L of ["A", "B", "C", "D", "E"]) letterSum[L] += e._letters[L];
  }
  let totalTvsh = 0;
  for (const L of ["A", "B", "C", "D", "E"]) {
    letterSum[L] = round2(letterSum[L]);
    totalTvsh += letterSum[L];
  }
  totalTvsh = round2(totalTvsh);
  let shownTvsh = 0;
  for (const e of fiscalEntries) {
    const raw = ["A", "B", "C", "D", "E"].reduce((s, L) => s + e._letters[L], 0);
    e.tvsh = round2(raw);
    e.pa_tvsh = round2((Number(e.total) || 0) - e.tvsh);
    shownTvsh += e.tvsh;
  }
  shownTvsh = round2(shownTvsh);
  const tvshDrift = round2(totalTvsh - shownTvsh);
  if (tvshDrift && fiscalEntries.length) {
    let pick = fiscalEntries[0];
    let best = -1;
    for (const e of fiscalEntries) {
      const raw = ["A", "B", "C", "D", "E"].reduce((s, L) => s + e._letters[L], 0);
      const rem = Math.abs(raw - e.tvsh);
      if (rem >= best) {
        best = rem;
        pick = e;
      }
    }
    pick.tvsh = round2(pick.tvsh + tvshDrift);
    pick.pa_tvsh = round2((Number(pick.total) || 0) - pick.tvsh);
  }
  for (const e of merged) {
    if (e._letters) {
      e.tvsh_8 = round2(e._letters.D);
      e.tvsh_18 = round2(e._letters.E);
      if (e.tvsh == null || !Number.isFinite(Number(e.tvsh))) {
        const raw = ["A", "B", "C", "D", "E"].reduce((s, L) => s + e._letters[L], 0);
        e.tvsh = round2(raw);
        e.pa_tvsh = round2((Number(e.total) || 0) - e.tvsh);
      }
    } else {
      const parts = vatPartsFromItems(e.items, e.total);
      e.tvsh_8 = parts.tvsh8;
      e.tvsh_18 = parts.tvsh18;
      e.tvsh = parts.tvsh;
      e.pa_tvsh = parts.pa;
    }
    delete e._letters;
  }
  return {
    periodLabel: range.label,
    dateFrom: range.from,
    dateTo: range.to,
    totalSales: round2(totalSales),
    totalTvsh,
    totalCash: round2(totalCash),
    totalKarte: round2(totalKarte),
    orderCount: completed.length,
    entries: merged,
    shifts: (() => {
      try {
        return require("./fiskalizime-pos-shift").listPosShiftsInRange(range.from, range.to);
      } catch {
        return [];
      }
    })(),
  };
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
  markOrderCouponType,
  parseThermalOrderRef,
  isThermalCouponRef,
  listThermalCoupons,
  thermalOrderDetails,
  thermalCouponPreview,
  partialRefundThermalSale,
  refundThermalSale,
  exchangeThermalSale,
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
  countOwners,
  updateOperator,
  deactivateOperator,
  deleteOperator,
  countActiveOperators,
  getDitari,
  resolveShiftOperatorId,
  getPosShiftSummary: (...a) => require("./fiskalizime-pos-shift").getPosShiftSummary(...a),
  rollOpenPosShiftsToLocalDay: (...a) => require("./fiskalizime-pos-shift").rollOpenPosShiftsToLocalDay(...a),
  openPosShift: (...a) => require("./fiskalizime-pos-shift").openPosShift(...a),
  closePosShift: (...a) => require("./fiskalizime-pos-shift").closePosShift(...a),
  listPosShiftsInRange: (...a) => require("./fiskalizime-pos-shift").listPosShiftsInRange(...a),
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
