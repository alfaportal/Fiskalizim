/**
 * Vendos path-et e çelësave ATK + dërgon kuponët e papaguar te TEST.
 * node scripts/install-atk-keys-and-send.js
 */
const path = require("path");
const os = require("os");
const fs = require("fs");

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const keysDir = path.join(appData, "biznes-sef", "fiscal-keys");
const projectFiscal = path.join(__dirname, "..", "fiscal");

function ensureKeysCopied() {
  fs.mkdirSync(keysDir, { recursive: true });
  const srcPriv = path.join(projectFiscal, "private-key.pem");
  const srcCert = path.join(projectFiscal, "signed-certificate.pem");
  if (!fs.existsSync(srcPriv) || !fs.existsSync(srcCert)) {
    throw new Error("Mungojnë private-key.pem / signed-certificate.pem në fiscal/");
  }
  const certTxt = fs.readFileSync(srcCert, "utf8");
  if (!/BEGIN\s+CERTIFICATE/i.test(certTxt) || /PLACEHOLDER/i.test(certTxt)) {
    throw new Error("signed-certificate.pem nuk është certifikatë reale ATK");
  }
  fs.copyFileSync(srcPriv, path.join(keysDir, "private-key.pem"));
  fs.copyFileSync(srcCert, path.join(keysDir, "signed-certificate.pem"));
  fs.copyFileSync(srcPriv, path.join(keysDir, "private.pem"));
  fs.copyFileSync(srcCert, path.join(keysDir, "certificate.pem"));
}

async function main() {
  ensureKeysCopied();
  process.chdir(path.join(__dirname, ".."));

  const database = require("../database");
  await database.initDatabase();
  const db = database.db;

  const certPath = path.join(keysDir, "signed-certificate.pem");
  const privPath = path.join(keysDir, "private-key.pem");
  db.prepare(
    `UPDATE fiscal_settings SET
      certificate_path = ?,
      private_key_path = ?,
      updated_at = datetime('now','localtime')
     WHERE id = 1`,
  ).run(certPath, privPath);

  const settings = db
    .prepare(
      `SELECT certificate_path, private_key_path, application_id, atk_api_url, fiscal_enabled
       FROM fiscal_settings WHERE id = 1`,
    )
    .get();
  console.log("[keys]", {
    cert: settings.certificate_path,
    priv: settings.private_key_path,
    appId: settings.application_id,
    atk: settings.atk_api_url,
  });

  const receipts = db
    .prepare(
      `SELECT id, nuikf, sent_to_atk, total_amount FROM fiscal_receipts ORDER BY id`,
    )
    .all();
  console.log("[receipts]", receipts);

  const { getAtkStatus } = require("../fiscal/fiscal-atk-api");
  const status = getAtkStatus();
  console.log("[atk-status]", {
    ready: status.ready_for_atk,
    placeholder: status.certificate_is_placeholder,
    env: status.environment,
    cert: status.certificate_path,
  });
  if (!status.ready_for_atk) {
    console.error("NOT READY FOR ATK — ndalo dërgimin");
    process.exit(2);
  }

  const { processOfflineQueue } = require("../fiscal/fiscal-offline");
  const result = await processOfflineQueue({ manual: true });
  console.log("[send]", JSON.stringify(result, null, 2));
  process.exit(result && result.errors && result.errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
