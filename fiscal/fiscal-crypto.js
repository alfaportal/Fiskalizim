/**
 * fiscal/fiscal-crypto.js — HAPI 8: çelësa ECDSA P-256 + nënshkrim SHA-256/ECDSA (ATK).
 * Placeholder derisa ATK jep private-key.pem / signed-certificate.pem.
 * Kur isFiscalEnabled()=false → null.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { isFiscalEnabled } = require("./fiscal-config");

/** Emra lokalë (ekzistues) */
const PRIVATE_FILE = "private.pem";
const CERT_FILE = "certificate.pem";
/** Emra ATK onboarder (prioritet në lexim) */
const PRIVATE_FILE_ATK = "private-key.pem";
const CERT_FILE_ATK = "signed-certificate.pem";

/** Kurba e njëjtë me ATK / pos-php (P-256 / prime256v1 / secp256r1) */
const EC_CURVE = "prime256v1";

function getKeysDir() {
  if (process.env.DB_PATH) {
    return path.join(path.dirname(process.env.DB_PATH), "fiscal-keys");
  }
  const appData =
    process.env.APPDATA ||
    path.join(os.homedir(), "AppData", "Roaming");
  // biznes (test ATK) — i ndarë nga KAFENE
  return path.join(appData, "biznes-sef", "fiscal-keys");
}

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function ensureSettingsRow(sqlite) {
  const row = sqlite.prepare("SELECT id FROM fiscal_settings WHERE id = 1").get();
  if (!row) {
    sqlite
      .prepare(
        `INSERT INTO fiscal_settings (id, fiscal_enabled, language, developer_nui)
         VALUES (1, 0, 'sq', '811314567')`
      )
      .run();
  }
}

function saveKeyPaths(certPath, privatePath) {
  const sqlite = getSqlite();
  ensureSettingsRow(sqlite);
  sqlite
    .prepare(
      `UPDATE fiscal_settings SET
        certificate_path = ?,
        private_key_path = ?,
        updated_at = datetime('now','localtime')
      WHERE id = 1`
    )
    .run(certPath, privatePath);
}

function getStoredPaths() {
  try {
    const sqlite = getSqlite();
    ensureSettingsRow(sqlite);
    const row = sqlite
      .prepare(
        `SELECT certificate_path, private_key_path FROM fiscal_settings WHERE id = 1`
      )
      .get();
    return {
      certificate_path: row?.certificate_path ? String(row.certificate_path) : "",
      private_key_path: row?.private_key_path ? String(row.private_key_path) : "",
    };
  } catch {
    return { certificate_path: "", private_key_path: "" };
  }
}

function firstExistingPath(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

function isEcPrivateKeyPem(pem) {
  try {
    const key = crypto.createPrivateKey(pem);
    return key.asymmetricKeyType === "ec";
  } catch {
    return false;
  }
}

function extractPemBlock(pemOrCert) {
  const pemMatch = String(pemOrCert || "").match(
    /-----BEGIN [\s\S]+?-----END [^-]+-----/
  );
  return pemMatch ? pemMatch[0] : String(pemOrCert || "");
}

/**
 * Canonical payload për nënshkrim — rend i qëndrueshëm.
 */
function canonicalizeReceiptData(receiptData) {
  const d = receiptData && typeof receiptData === "object" ? receiptData : {};
  const payload = {
    nuikf: String(d.nuikf || ""),
    total: Number(d.total_amount ?? d.total ?? 0),
    date: String(d.fiscal_date || d.date || ""),
    time: String(d.fiscal_time || d.time || ""),
    nui: String(d.taxpayer_nui || d.nui || ""),
    sef_id: String(d.sef_id || ""),
    daily_number: Number(d.daily_number || 0),
    receipt_type: String(d.receipt_type || "regular"),
  };
  return JSON.stringify(payload);
}

/**
 * Gjeneron çift ECDSA P-256 (placeholder), ruan në fiscal-keys/, përditëson fiscal_settings.
 * Shkruan edhe emrat legacy (private.pem) edhe ATK (private-key.pem).
 */
function generateKeyPair() {
  if (!isFiscalEnabled()) return null;

  const dir = getKeysDir();
  fs.mkdirSync(dir, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: EC_CURVE,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const privatePath = path.join(dir, PRIVATE_FILE);
  const certPath = path.join(dir, CERT_FILE);
  const privateAtkPath = path.join(dir, PRIVATE_FILE_ATK);
  const certAtkPath = path.join(dir, CERT_FILE_ATK);

  const certPem =
    `# KAFENE FISCAL PLACEHOLDER CERTIFICATE (ECDSA P-256)\n` +
    `# Replace with ATK signed-certificate.pem when available\n` +
    publicKey;

  const writeOpts = { encoding: "utf8", mode: 0o600 };
  fs.writeFileSync(privatePath, privateKey, writeOpts);
  fs.writeFileSync(certPath, certPem, writeOpts);
  fs.writeFileSync(privateAtkPath, privateKey, writeOpts);
  fs.writeFileSync(certAtkPath, certPem, writeOpts);

  try {
    saveKeyPaths(certPath, privatePath);
  } catch (e) {
    console.warn("[fiscal-crypto] saveKeyPaths:", e.message);
  }

  return {
    certificate_path: certPath,
    private_key_path: privatePath,
    placeholder: true,
    algorithm: "ECDSA-P256",
  };
}

/**
 * Lexon çelësin privat: settings → private-key.pem → private.pem.
 * Nëse mungon ose është RSA i vjetër → gjenero ECDSA.
 */
function loadPrivateKey() {
  if (!isFiscalEnabled()) return null;

  const dir = getKeysDir();
  const stored = getStoredPaths();
  let privatePath = firstExistingPath([
    stored.private_key_path,
    path.join(dir, PRIVATE_FILE_ATK),
    path.join(dir, PRIVATE_FILE),
  ]);

  if (privatePath) {
    const pem = fs.readFileSync(privatePath, "utf8");
    if (isEcPrivateKeyPem(pem)) return pem;
    console.warn(
      "[fiscal-crypto] Çelësi privat nuk është ECDSA — gjenerohet çift i ri P-256"
    );
  }

  const gen = generateKeyPair();
  if (!gen) return null;
  return fs.readFileSync(gen.private_key_path, "utf8");
}

/**
 * Lexon certifikatën / publik: settings → signed-certificate.pem → certificate.pem.
 */
function loadCertificate() {
  if (!isFiscalEnabled()) return null;

  const dir = getKeysDir();
  const stored = getStoredPaths();
  let certPath = firstExistingPath([
    stored.certificate_path,
    path.join(dir, CERT_FILE_ATK),
    path.join(dir, CERT_FILE),
  ]);

  if (!certPath) {
    const gen = generateKeyPair();
    if (!gen) return null;
    certPath = gen.certificate_path;
  }
  return fs.readFileSync(certPath, "utf8");
}

/**
 * data → SHA-256 → ECDSA (P-256) → signature base64.
 */
function signReceipt(receiptData) {
  if (!isFiscalEnabled()) return null;

  const pem = loadPrivateKey();
  if (!pem) {
    throw new Error("Çelësi privat nuk u gjet");
  }
  if (!isEcPrivateKeyPem(pem)) {
    throw new Error("Çelësi privat duhet ECDSA P-256 (jo RSA)");
  }

  // String i papërpunuar (p.sh. base64 i CitizenCoupon për QR ATK) → nënshkruhet siç është
  const canonical =
    typeof receiptData === "string"
      ? receiptData
      : canonicalizeReceiptData(receiptData);
  const data = Buffer.from(canonical, "utf8");
  // Node: SHA-256 i të dhënave + nënshkrim ECDSA me çelësin privat
  const signature = crypto.sign("sha256", data, {
    key: pem,
    dsaEncoding: "der",
  });
  return signature.toString("base64");
}

/**
 * Verifikim lokal ECDSA (SHA-256) me certifikatën / çelësin publik.
 */
function verifyReceiptSignature(receiptData, signatureBase64) {
  if (!isFiscalEnabled()) return null;
  const cert = loadCertificate();
  if (!cert || !signatureBase64) return false;

  const publicPem = extractPemBlock(cert);
  const canonical =
    typeof receiptData === "string"
      ? receiptData
      : canonicalizeReceiptData(receiptData);
  const data = Buffer.from(canonical, "utf8");
  try {
    return crypto.verify(
      "sha256",
      data,
      { key: publicPem, dsaEncoding: "der" },
      Buffer.from(String(signatureBase64), "base64")
    );
  } catch {
    return false;
  }
}

module.exports = {
  getKeysDir,
  generateKeyPair,
  loadPrivateKey,
  loadCertificate,
  signReceipt,
  verifyReceiptSignature,
  canonicalizeReceiptData,
  EC_CURVE,
};
