/**
 * Verifikim para/pas build: produkte pas Setup + ATK i ndalur.
 * Përdorim: node scripts/verify-build-readiness.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const failures = [];

function ok(msg) {
  console.log("OK  ", msg);
}

function fail(msg) {
  failures.push(msg);
  console.log("FAIL", msg);
}

// 1) Katalogu i bundluar
const catalogPath = path.join(root, "data", "default-products.json");
if (!fs.existsSync(catalogPath)) {
  fail("Mungon data/default-products.json (nuk hyn në Setup)");
} else {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const n = Array.isArray(catalog.products) ? catalog.products.length : 0;
  if (n < 1) fail("default-products.json bosh");
  else ok(`Katalog i bundluar: ${n} produkte`);
}

// 2) package.json përfshin data/**
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const files = pkg.build && pkg.build.files ? pkg.build.files : [];
if (!files.some((f) => String(f).includes("data/"))) {
  fail("package.json build.files nuk përfshin data/**");
} else {
  ok("Build përfshin data/** (produktet në Setup)");
}

// 3) DB e re → produkte
async function testFreshDb() {
  const tmpDir = path.join(os.tmpdir(), "biznes-verify-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.BIZNES_DB_PATH = path.join(tmpDir, "biznes.db");
  delete process.env.BIZNES_ATK_SEND_ALLOWED;
  process.env.FISCAL_LOCAL_RUN = "0";
  process.env.ATK_AUTO_SEND = "1";

  delete require.cache[require.resolve(path.join(root, "database.js"))];
  const db = require(path.join(root, "database.js"));
  await db.initDatabase();

  const products = db.listProducts();
  if (products.length < 1) {
    fail(`DB e re: 0 produkte (duhet auto-seed)`);
  } else {
    ok(`DB e re: ${products.length} produkte auto-seed`);
  }

  const allowed = db.getSetting("atk_send_allowed", "?");
  const autoSend = db.getSetting("atk_auto_send", "?");
  if (allowed !== "0") fail(`atk_send_allowed=${allowed} (duhet 0)`);
  else ok("DB e re: atk_send_allowed=0");
  if (autoSend !== "0") fail(`atk_auto_send=${autoSend} (duhet 0)`);
  else ok("DB e re: atk_auto_send=0");
}

// 4) ATK bllokuar edhe me env agresiv
function testAtkBlock() {
  delete require.cache[require.resolve(path.join(root, "fiscal", "fiscal-test-mode-store.js"))];
  process.env.FISCAL_LOCAL_RUN = "0";
  process.env.ATK_AUTO_SEND = "1";
  delete process.env.BIZNES_ATK_SEND_ALLOWED;
  const m = require(path.join(root, "fiscal", "fiscal-test-mode-store"));
  if (!m.isAtkTransmissionBlocked()) {
    fail("ATK nuk bllokohet (isAtkTransmissionBlocked=false)");
  } else {
    ok("ATK bllokuar (isAtkTransmissionBlocked=true)");
  }
  if (m.isAtkSendAllowedByOwner()) {
    fail("isAtkSendAllowedByOwner=true pa leje pronari");
  } else {
    ok("isAtkSendAllowedByOwner=false (pa urdhër pronari)");
  }
}

// 5) server.js forcon lock në boot
const serverSrc = fs.readFileSync(path.join(root, "server.js"), "utf8");
if (!serverSrc.includes("BIZNES_ATK_SEND_ALLOWED")) {
  fail("server.js nuk forcon BIZNES_ATK_SEND_ALLOWED lock");
} else {
  ok("server.js forcon ATK lock në nisje");
}

(async () => {
  testAtkBlock();
  await testFreshDb();
  console.log("");
  if (failures.length) {
    console.log("REZULTAT: DËSHTOI —", failures.length, "problem(e)");
    process.exit(1);
  }
  console.log("REZULTAT: GATI — produkte pas Setup + ATK i ndalur deri urdhër pronari");
})();
