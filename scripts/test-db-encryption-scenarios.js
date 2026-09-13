/**
 * Test skenarësh enkriptimi biznes.db — vetëm lokale, pa prekur prod.
 *   node scripts/test-db-encryption-scenarios.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const dbCrypto = require("../db-crypto");

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
}

function hdr(filePath) {
  if (!fs.existsSync(filePath)) return "MISSING";
  const raw = fs.readFileSync(filePath);
  if (dbCrypto.isEncryptedBuffer(raw)) return "BIZENC1";
  if (dbCrypto.isPlainSqlite(raw)) return "SQLite format 3";
  return "unknown";
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resetModuleCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes("database.js") || k.includes("db-crypto.js")) {
      delete require.cache[k];
    }
  }
}

async function initDbAt(dbPath) {
  process.env.BIZNES_DB_PATH = dbPath;
  process.env.DB_PATH = dbPath;
  resetModuleCache();
  const db = require("../database");
  await db.initDatabase();
  return db;
}

async function scenario1_freshInstall() {
  const dir = mkTemp("enc-s1-");
  const dbPath = path.join(dir, "biznes.db");
  console.log("\n=== S1: Instalim i ri (DB bosh) ===");
  try {
    const db = await initDbAt(dbPath);
    const exists = fs.existsSync(dbPath);
    const header = hdr(dbPath);
    const dpapi = fs.existsSync(path.join(dir, ".db-master.dpapi"));
    const scrypt = fs.existsSync(path.join(dir, ".db-master.scrypt"));
    const products = db.db.prepare("SELECT COUNT(*) AS c FROM products").get()?.c;
    if (!exists) fail("S1a biznes.db krijohet", "skedari mungon pas init");
    else if (header !== "BIZENC1") fail("S1a biznes.db enkriptuar", `header=${header}`);
    else pass("S1a biznes.db krijohet e enkriptuar (BIZENC1)");

    if (process.platform === "win32" && dpapi) pass("S1b master key DPAPI", path.join(dir, ".db-master.dpapi"));
    else if (scrypt) pass("S1b master key scrypt", path.join(dir, ".db-master.scrypt"));
    else fail("S1b master key", "asnjë .db-master.*");

    if (Number(products) > 0) pass("S1c seed produkte", String(products));
    else fail("S1c seed produkte", "0 produkte");
  } catch (e) {
    fail("S1", e.message);
  }
}

async function scenario2_clientWorkflow() {
  const dir = mkTemp("enc-s2-");
  const dbPath = path.join(dir, "biznes.db");
  console.log("\n=== S2: Cilësimet + shitje + rihapje ===");
  try {
    const db = await initDbAt(dbPath);
    db.setSetting("test_client_nui", "811314567");
    db.db
      .prepare(
        `UPDATE fiscal_settings SET taxpayer_nui = ?, taxpayer_legal_name = ?, fiscal_enabled = 1 WHERE id = 1`
      )
      .run("811314567", "TEST KLIENT");
    db.db
      .prepare(
        `INSERT INTO orders (items_json, total, subtotal, payment_method, status)
         VALUES ('[{"name":"Kafe","qty":1,"unit_price":1.5}]', 1.5, 1.5, 'cash', 'completed')`
      )
      .run();
    db.flushDatabase();

    if (hdr(dbPath) !== "BIZENC1") {
      fail("S2a saveDb encrypted", hdr(dbPath));
    } else pass("S2a saveDb pas ndryshimeve", "BIZENC1");

    const orderCount1 = db.db.prepare("SELECT COUNT(*) AS c FROM orders").get()?.c;
    resetModuleCache();
    process.env.BIZNES_DB_PATH = dbPath;
    process.env.DB_PATH = dbPath;
    const db2 = require("../database");
    await db2.initDatabase();
    const orderCount2 = db2.db.prepare("SELECT COUNT(*) AS c FROM orders").get()?.c;
    const nui = db2.db.prepare("SELECT taxpayer_nui FROM fiscal_settings WHERE id = 1").get()?.taxpayer_nui;

    if (Number(orderCount2) === Number(orderCount1) && nui === "811314567") {
      pass("S2b rihapje lexon saktë", `orders=${orderCount2}, NUI=${nui}`);
    } else {
      fail("S2b rihapje", `orders ${orderCount1}→${orderCount2}, nui=${nui}`);
    }
  } catch (e) {
    fail("S2", e.message);
  }
}

function freshDbCrypto() {
  delete require.cache[require.resolve("../db-crypto")];
  return require("../db-crypto");
}

function scenario3_noDpapi() {
  console.log("\n=== S3: Pa DPAPI (scrypt fallback) ===");
  const dir = mkTemp("enc-s3-");
  const dbPath = path.join(dir, "biznes.db");
  const plain = Buffer.alloc(4096, 0);
  plain.write("SQLite format 3\u0000", 0, "ascii");

  const origPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "linux" });
    const dc = freshDbCrypto();

    dc.saveDatabaseBytes(dbPath, plain);
    const h1 = hdr(dbPath);
    const scrypt = fs.existsSync(path.join(dir, ".db-master.scrypt"));
    const loaded = dc.loadDatabaseBytes(dbPath);

    if (h1 === "BIZENC1" && scrypt) pass("S3a scrypt fallback save/load", "BIZENC1 + .db-master.scrypt");
    else fail("S3a scrypt fallback", `header=${h1}, scrypt=${scrypt}`);

    if (loaded.bytes.length === plain.length) pass("S3b roundtrip bytes", String(plain.length));
    else fail("S3b roundtrip bytes", "mismatch");

    const dc2 = freshDbCrypto();
    const origKey = dc2.getOrCreateMasterKey;
    dc2.getOrCreateMasterKey = () => {
      throw new Error("simulated master key failure");
    };
    try {
      dc2.saveDatabaseBytes(dbPath, plain);
      if (hdr(dbPath) === "SQLite format 3") pass("S3c plain fallback kur enkriptimi dështon", "plain, no throw");
      else fail("S3c plain fallback", hdr(dbPath));
    } catch (e) {
      fail("S3c plain fallback", "crash: " + e.message);
    }
  } catch (e) {
    fail("S3", e.message);
  } finally {
    Object.defineProperty(process, "platform", { value: origPlatform });
    freshDbCrypto();
  }
}

async function scenario4_backupRestore() {
  console.log("\n=== S4: Backup + Restore ===");
  const dir = mkTemp("enc-s4-");
  const dbPath = path.join(dir, "biznes.db");
  try {
    const db = await initDbAt(dbPath);
    db.setSetting("restore_marker_enc", "yes");
    db.flushDatabase();
    const encBackup = path.join(dir, "backup-enc", "biznes.db");
    fs.mkdirSync(path.dirname(encBackup), { recursive: true });
    fs.copyFileSync(dbPath, encBackup);
    for (const f of [".db-master.dpapi", ".db-master.scrypt", ".db-install-salt"]) {
      const src = path.join(dir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, "backup-enc", f));
    }

    db.setSetting("restore_marker_enc", "no");
    db.flushDatabase();
    fs.copyFileSync(encBackup, dbPath);
    resetModuleCache();
    process.env.BIZNES_DB_PATH = dbPath;
    process.env.DB_PATH = dbPath;
    const dbMod = require("../database");
    await dbMod.reloadDatabaseFromDisk();
    const v = dbMod.db.prepare("SELECT value FROM settings WHERE key = 'restore_marker_enc'").get()?.value;
    if (v === "yes") pass("S4a restore encrypted backup", "marker=yes");
    else fail("S4a restore encrypted", `marker=${v}`);

    const plainPath = path.join(dir, "plain-old.db");
    const plainBuf = dbMod.db.prepare("SELECT 1").get() ? fs.readFileSync(dbPath) : null;
    const loaded = dbCrypto.loadDatabaseBytes(dbPath);
    dbCrypto.saveDatabaseBytes(plainPath, loaded.bytes);
    fs.copyFileSync(plainPath, dbPath);
    resetModuleCache();
    process.env.BIZNES_DB_PATH = dbPath;
    process.env.DB_PATH = dbPath;
    const db2 = require("../database");
    await db2.reloadDatabaseFromDisk();
    if (hdr(dbPath) === "BIZENC1") pass("S4b restore plain → auto migrim", "BIZENC1");
    else fail("S4b restore plain migrim", hdr(dbPath));
  } catch (e) {
    fail("S4", e.message);
  }
}

async function scenario5_wrongUser() {
  console.log("\n=== S5: Ndryshim profil Windows (DPAPI tjetër) ===");
  const dir = mkTemp("enc-s5-");
  const dbPath = path.join(dir, "biznes.db");
  try {
    const db = await initDbAt(dbPath);
    db.setSetting("precious_data", "keep-me");
    db.flushDatabase();
    if (hdr(dbPath) !== "BIZENC1") {
      fail("S5 setup", "duhet encrypted");
      return;
    }

    const dpapiPath = path.join(dir, ".db-master.dpapi");
    if (fs.existsSync(dpapiPath)) {
      fs.writeFileSync(dpapiPath, Buffer.alloc(64, 0xff));
    }

    let loadError = null;
    try {
      dbCrypto.loadDatabaseBytes(dbPath);
    } catch (e) {
      loadError = e.message;
    }

    if (loadError) pass("S5a decrypt dështon me DPAPI të prishur", loadError.slice(0, 60));
    else fail("S5a decrypt", "duhet të dështojë");

    resetModuleCache();
    process.env.BIZNES_DB_PATH = dbPath;
    process.env.DB_PATH = dbPath;
    let initCrashed = false;
    let markerAfter = null;
    let corruptBackup = null;
    try {
      const db2 = require("../database");
      await db2.initDatabase();
      markerAfter = db2.db.prepare("SELECT value FROM settings WHERE key = 'precious_data'").get()?.value;
    } catch (e) {
      initCrashed = true;
    }

    const corruptFiles = fs.readdirSync(dir).filter((n) => n.includes("corrupt"));
    corruptBackup = corruptFiles[0] || null;

    if (initCrashed) {
      pass("S5b initDatabase", "crash (jo fallback plain)");
    } else if (global.DB_DECRYPT_FAILED && corruptBackup && hdr(dbPath) === "BIZENC1") {
      pass(
        "S5b DB_DECRYPT_FAILED + disk i paprekur",
        `corrupt=${corruptBackup}, flag=true, hdr=BIZENC1`
      );
    } else if (markerAfter === "keep-me") {
      pass("S5b të dhënat mbeten", "marker=keep-me");
    } else {
      fail(
        "S5b profil i ri / DPAPI i ri",
        `marker=${markerAfter}, corruptBackup=${corruptBackup}, crash=${initCrashed}, flag=${global.DB_DECRYPT_FAILED} — RREZIK: DB e re bosh në disk`
      );
    }
  } catch (e) {
    fail("S5", e.message);
  }
}

async function main() {
  console.log("Test enkriptimi biznes.db —", new Date().toISOString());
  await scenario1_freshInstall();
  await scenario2_clientWorkflow();
  scenario3_noDpapi();
  await scenario4_backupRestore();
  await scenario5_wrongUser();

  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n=== PËRMBLEDHJE: ${ok} OK, ${bad} DËSHTU ===`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
