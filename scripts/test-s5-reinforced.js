/**
 * Test i fortë S5 — dekriptim dështon, disk i paprekur, restore funksionon.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const dbCrypto = require("../db-crypto");

const results = [];
function pass(name, detail) {
  results.push({ ok: true, name, detail });
  console.log("✅", name, detail ? "— " + detail : "");
}
function fail(name, detail) {
  results.push({ ok: false, name, detail });
  console.log("❌", name, detail ? "— " + detail : "");
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hdr(p) {
  if (!fs.existsSync(p)) return "MISSING";
  const b = fs.readFileSync(p);
  if (b.length >= 7 && b.slice(0, 7).toString("ascii") === "BIZENC1") return "BIZENC1";
  if (b.length >= 15 && b.slice(0, 15).toString("ascii") === "SQLite format 3") return "SQLITE";
  return "OTHER";
}

function resetModuleCache() {
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](database|db-crypto|biznes-backup|portable-path)\.js$/i.test(k)) {
      delete require.cache[k];
    }
  }
  global.DB_DECRYPT_FAILED = false;
}

async function initDbAt(dbPath) {
  resetModuleCache();
  process.env.BIZNES_DB_PATH = dbPath;
  process.env.DB_PATH = dbPath;
  const db = require("../database");
  await db.initDatabase();
  return db;
}

async function main() {
  console.log("=== S5 reinforced test ===", new Date().toISOString());

  const dir = mkTemp("enc-s5r-");
  const dbPath = path.join(dir, "biznes.db");

  // 1) Krijo DB enkriptuar me të dhëna
  const db1 = await initDbAt(dbPath);
  db1.setSetting("precious_data", "keep-me-s5r");
  db1.flushDatabase();
  if (hdr(dbPath) !== "BIZENC1") {
    fail("setup", "duhet BIZENC1");
    process.exitCode = 1;
    return;
  }
  const sizeBefore = fs.statSync(dbPath).size;
  const hashBefore = fs.readFileSync(dbPath);

  // 2) Prish DPAPI
  const dpapiPath = path.join(dir, ".db-master.dpapi");
  if (fs.existsSync(dpapiPath)) fs.writeFileSync(dpapiPath, Buffer.alloc(64, 0xff));

  // 3) Ringarko — duhet DB_DECRYPT_FAILED
  resetModuleCache();
  process.env.BIZNES_DB_PATH = dbPath;
  process.env.DB_PATH = dbPath;
  const db2 = require("../database");
  await db2.initDatabase();

  if (!global.DB_DECRYPT_FAILED) fail("flag", "DB_DECRYPT_FAILED duhet true");
  else pass("flag", "DB_DECRYPT_FAILED=true");

  const corruptFiles = fs.readdirSync(dir).filter((n) => n.includes("corrupt"));
  if (corruptFiles.length) pass("corrupt backup", corruptFiles[0]);
  else fail("corrupt backup", "mungon .corrupt-*");

  if (hdr(dbPath) === "BIZENC1") pass("disk hdr", "BIZENC1 i paprekur");
  else fail("disk hdr", hdr(dbPath));

  const sizeAfter = fs.statSync(dbPath).size;
  if (sizeAfter === sizeBefore) pass("disk size", String(sizeBefore));
  else fail("disk size", `${sizeBefore} → ${sizeAfter}`);

  const hashAfter = fs.readFileSync(dbPath);
  if (hashAfter.equals(hashBefore)) pass("disk bytes", "identike");
  else fail("disk bytes", "ndryshuan");

  // 4) flushDatabase nuk shkruan
  db2.flushDatabase();
  const hashAfterFlush = fs.readFileSync(dbPath);
  if (hashAfterFlush.equals(hashBefore)) pass("flushDatabase", "pa ndryshim disk");
  else fail("flushDatabase", "disk u ndryshua");

  // 5) saveDatabaseBytes direkt bllokohet
  resetModuleCache();
  global.DB_DECRYPT_FAILED = true;
  const dc = require("../db-crypto");
  dc.saveDatabaseBytes(dbPath, Buffer.from("SQLite format 3\x00fake"));
  if (fs.readFileSync(dbPath).equals(hashBefore)) pass("saveDatabaseBytes guard", "bllokuar");
  else fail("saveDatabaseBytes guard", "shkroi disk");

  // 6) status API field
  global.DB_DECRYPT_FAILED = true;
  const { getAutoBackupStatus } = require("../biznes-backup");
  const st = getAutoBackupStatus();
  if (st.db_decrypt_failed) pass("backup/status", "db_decrypt_failed=true");
  else fail("backup/status", JSON.stringify(st));

  // 7) restore nga backup i corrupt (kopje e enkriptuar + dpapi origjinal nga safety sim)
  // Kopjo biznes.db + .db-master.dpapi nga corrupt backup folder
  const backupDir = mkTemp("enc-s5r-backup-");
  fs.copyFileSync(dbPath, path.join(backupDir, "biznes.db"));
  // Ripar DPAPI nga db1 init — rikrijo db të re për marrë çelësin e vërtetë
  resetModuleCache();
  global.DB_DECRYPT_FAILED = false;
  const dirGood = mkTemp("enc-s5r-good-");
  const goodPath = path.join(dirGood, "biznes.db");
  process.env.BIZNES_DB_PATH = goodPath;
  process.env.DB_PATH = goodPath;
  const dbGood = require("../database");
  await dbGood.initDatabase();
  dbGood.setSetting("precious_data", "keep-me-s5r");
  dbGood.flushDatabase();
  fs.copyFileSync(goodPath, path.join(backupDir, "biznes.db"));
  const goodDpapi = path.join(dirGood, ".db-master.dpapi");
  if (fs.existsSync(goodDpapi)) {
    fs.copyFileSync(goodDpapi, path.join(backupDir, ".db-master.dpapi"));
  }

  resetModuleCache();
  process.env.BIZNES_DB_PATH = dbPath;
  process.env.DB_PATH = dbPath;
  global.DB_DECRYPT_FAILED = true;
  const db3 = require("../database");
  await db3.initDatabase();

  const { restoreFromBackup } = require("../biznes-backup");
  await restoreFromBackup(backupDir);

  if (!global.DB_DECRYPT_FAILED) pass("restore clears flag", "ok");
  else fail("restore clears flag", "ende true");

  const marker = db3.db.prepare("SELECT value FROM settings WHERE key = 'precious_data'").get()?.value;
  if (marker === "keep-me-s5r") pass("restore data", "precious_data=keep-me-s5r");
  else fail("restore data", "marker=" + marker);

  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n=== PËRMBLEDHJE: ${ok} OK, ${bad} DËSHTU ===`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
