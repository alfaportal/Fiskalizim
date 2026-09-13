const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node test-s5-subprocess.js <dir>");
  process.exit(2);
}
const dc = require("../db-crypto");
const dbPath = path.join(dir, "biznes.db");
try {
  const r = dc.loadDatabaseBytes(dbPath);
  console.log("LOAD_OK", r.bytes.length);
} catch (e) {
  console.log("LOAD_FAIL", String(e.message).slice(0, 120));
}
