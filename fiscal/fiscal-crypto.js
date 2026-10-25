/**
 * fiscal/fiscal-crypto.js — HAPI 8: çelësa ECDSA P-256 + nënshkrim SHA-256/ECDSA (ATK).
 * Placeholder derisa ATK jep private-key.pem / signed-certificate.pem.
 * Kur isFiscalEnabled()=false → null.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dbCrypto = require("../db-crypto");
const { isFiscalEnabled } = require("./fiscal-config");

/** Emra lokalë (ekzistues) */
const PRIVATE_FILE = "private.pem";
const CERT_FILE = "certificate.pem";
/** Emra ATK onboarder (prioritet në lexim) */
const PRIVATE_FILE_ATK = "private-key.pem";
const CERT_FILE_ATK = "signed-certificate.pem";
const FISCAL_KEYS_PROTECTED_MARKER = ".fiscal-atk-keys-v1.json";

/** Kurba e njëjtë me ATK / pos-php (P-256 / prime256v1 / secp256r1) */
const EC_CURVE = "prime256v1";

function getKeysDir() {
  const dbPath = process.env.BIZNES_DB_PATH || process.env.DB_PATH;
  if (dbPath) {
    return path.join(path.dirname(dbPath), "fiscal-keys");
  }
  const portable = require("../portable-path");
  return path.join(portable.getDataDir(), "fiscal-keys");
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

/** Gjen bazën e çelësit privat (plain ose .enc). */
function firstExistingPrivatePath(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    const enc = dbCrypto.encryptedPathFor(p);
    if (fs.existsSync(enc) || fs.existsSync(p)) return p;
  }
  return "";
}

function lockPrivateKeysAtRest() {
  try {
    cleanupFiscalKeysJunk();
    dbCrypto.lockPrivateKeyFiles(getKeysDir());
  } catch (e) {
    console.warn("[fiscal-crypto] lock keys:", e.message);
  }
}

/** Skedarë të vjetër në fiscal-keys që bëjnë konfuz — backup/pre-pos3 lokal. */
function isFiscalKeysJunkFile(name) {
  return /\.(backup|pre-pos3)-/i.test(String(name || ""));
}

/**
 * Heq kopje të vjetra (.backup-*, .pre-pos3-*) nga fiscal-keys/.
 * Backup-i ditor (Desktop) mbulon rikthimin — jo kopje të shumta këtu.
 */
function cleanupFiscalKeysJunk() {
  const dir = getKeysDir();
  if (!dir || !fs.existsSync(dir)) return { removed: [] };
  const removed = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!isFiscalKeysJunkFile(name)) continue;
      const full = path.join(dir, name);
      try {
        fs.unlinkSync(full);
        removed.push(name);
      } catch (e) {
        console.warn("[fiscal-crypto] cleanup junk:", name, e.message);
      }
    }
    const atkBase = path.join(dir, PRIVATE_FILE_ATK);
    const legacyEnc = path.join(dir, PRIVATE_FILE + ".enc");
    if (fs.existsSync(dbCrypto.encryptedPathFor(atkBase)) && fs.existsSync(legacyEnc)) {
      try {
        dbCrypto.readPrivatePem(atkBase);
        try {
          dbCrypto.readPrivatePem(path.join(dir, PRIVATE_FILE));
        } catch {
          fs.unlinkSync(legacyEnc);
          removed.push("private.pem.enc (dublikatë e palexueshme)");
        }
      } catch {
        /* çelësi ATK ende i palexueshëm */
      }
    }
    const dbDir = dbCrypto.getDbDir();
    const staleMaster = path.join(dir, ".db-master.dpapi");
    if (
      fs.existsSync(staleMaster) &&
      path.resolve(dir) !== path.resolve(dbDir) &&
      fs.existsSync(path.join(dbDir, ".db-master.dpapi"))
    ) {
      let keysOk = false;
      for (const name of ["private-key.pem", "private.pem"]) {
        const base = path.join(dir, name);
        if (!fs.existsSync(dbCrypto.encryptedPathFor(base))) continue;
        try {
          dbCrypto.readPrivatePem(base);
          keysOk = true;
          break;
        } catch {
          /* */
        }
      }
      if (keysOk) {
        dbCrypto.removeStaleFiscalKeysMaster(dir);
        removed.push(".db-master.dpapi (fiscal-keys — master i vjetër)");
      }
    }
  } catch (e) {
    console.warn("[fiscal-crypto] cleanupFiscalKeysJunk:", e.message);
  }
  if (removed.length) {
    console.log("[fiscal-crypto] pastruar fiscal-keys:", removed.join(", "));
  }
  return { removed };
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

function isPlaceholderCertificatePem(pem) {
  const t = String(pem || "");
  if (/PLACEHOLDER|Replace with ATK/i.test(t)) return true;
  // Certifikatë e vërtetë ATK = X.509
  if (/BEGIN\s+CERTIFICATE/i.test(t)) return false;
  return true;
}

function projectFiscalKeyCandidates(fileName) {
  return [
    path.join(__dirname, fileName),
    path.join(__dirname, "..", "fiscal-keys", fileName),
  ];
}

function isFiscalKeyWriteAllowed(opts = {}) {
  return !!(opts && (opts.force === true || opts.allowOverwrite === true));
}

function listFiscalKeyCertCandidates(dir, storedCertPath) {
  // Vetëm fiscal-keys/ (+ path nga settings) — jo certifikata të paketuara në app
  return [
    path.join(dir, CERT_FILE_ATK),
    storedCertPath,
    path.join(dir, CERT_FILE),
  ].filter(Boolean);
}

/**
 * Certifikatë reale ATK (X.509) — jo placeholder demo.
 */
function hasRealAtkCertificate(dir, storedCertPath) {
  for (const certPath of listFiscalKeyCertCandidates(dir, storedCertPath)) {
    try {
      if (!certPath || !fs.existsSync(certPath)) continue;
      const txt = fs.readFileSync(certPath, "utf8");
      if (!isPlaceholderCertificatePem(txt)) return true;
    } catch {
      /* provo kandidatin tjetër */
    }
  }
  return false;
}

/**
 * Çdo skedar çelësi/certifikate në fiscal-keys — pas instalimit nuk preket.
 */
function hasAnyFiscalKeyArtifacts(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/\.(pem|enc)$/i.test(name) && !isFiscalKeysJunkFile(name)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Certifikatë reale ose çelës privat — NUK lejohet shkrim automatik.
 */
function isFiscalKeysProtected(opts = {}) {
  if (isFiscalKeyWriteAllowed(opts)) return false;
  const dir = getKeysDir();
  if (hasFiscalKeysProtectionMarker(dir)) return true;
  const stored = getStoredPaths();
  if (hasRealAtkCertificate(dir, stored.certificate_path)) return true;
  if (dbCrypto.hasPrivateKeyMaterial(dir, stored.private_key_path)) return true;
  if (hasAnyFiscalKeyArtifacts(dir)) return true;
  return false;
}

function assertFiscalKeyWriteAllowed(opts, context) {
  if (!isFiscalKeysProtected(opts)) return;
  throw new Error(
    `${context} — çelësat/certifikata janë të mbrojtur dhe nuk ndryshohen automatikisht. ` +
      "Vetëm «Lidhu me ATK» (regjistrim i ri me leje) mund t'i zëvendësojë."
  );
}

function getFiscalKeysProtectionMarkerPath(dir) {
  return path.join(dir || getKeysDir(), FISCAL_KEYS_PROTECTED_MARKER);
}

function readFiscalKeysProtectionMarker(dir) {
  try {
    const p = getFiscalKeysProtectionMarkerPath(dir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function hasFiscalKeysProtectionMarker(dir) {
  return !!readFiscalKeysProtectionMarker(dir);
}

function writeFiscalKeysProtectionMarker(dir, certIds) {
  const payload = {
    protected: true,
    branch_id: certIds?.branch_id || "",
    pos_id: certIds?.pos_id || "",
    saved_at: new Date().toISOString(),
    note: "Mos ndrysho — vetëm Lidhu me ATK me leje zëvendëson çelësat",
  };
  fs.writeFileSync(
    getFiscalKeysProtectionMarkerPath(dir),
    JSON.stringify(payload, null, 2),
    { encoding: "utf8", mode: 0o600 }
  );
}

/**
 * Vulos certifikatën ekzistuese (instalime të vjetra pa marker).
 */
function ensureFiscalKeysProtectionMarker() {
  const dir = getKeysDir();
  if (hasFiscalKeysProtectionMarker(dir)) return readFiscalKeysProtectionMarker(dir);
  const stored = getStoredPaths();
  if (!hasRealAtkCertificate(dir, stored.certificate_path)) return null;
  const certPath = firstExistingPath([
    path.join(dir, CERT_FILE_ATK),
    stored.certificate_path,
    path.join(dir, CERT_FILE),
  ]);
  const ids = parseCertRegistrationIds(certPath);
  if (ids) writeFiscalKeysProtectionMarker(dir, ids);
  return readFiscalKeysProtectionMarker(dir);
}

function writeCertPemProtected(targetPath, pemText, opts = {}) {
  assertFiscalKeyWriteAllowed(opts, "Shkrimi i certifikatës");
  fs.writeFileSync(targetPath, pemText, { encoding: "utf8", mode: 0o600 });
}

/**
 * Ruaj çelësat pas onboarding ATK — i vetmi rrugë me allowOverwrite.
 */
function saveAtkKeysFromOnboarding(privateKeyPem, signedCertificatePem, opts = {}) {
  if (!isFiscalKeyWriteAllowed({ allowOverwrite: true, ...opts })) {
    throw new Error("saveAtkKeysFromOnboarding kërkon allowOverwrite:true");
  }
  const dir = getKeysDir();
  fs.mkdirSync(dir, { recursive: true });
  const privateAtkPath = path.join(dir, PRIVATE_FILE_ATK);
  const certAtkPath = path.join(dir, CERT_FILE_ATK);
  const privatePath = path.join(dir, PRIVATE_FILE);
  const certPath = path.join(dir, CERT_FILE);
  const writeOpts = { encoding: "utf8", mode: 0o600 };

  dbCrypto.setFiscalKeyWriteAllowed(true);
  try {
    dbCrypto.writePrivatePem(privateAtkPath, privateKeyPem);
    dbCrypto.writePrivatePem(privatePath, privateKeyPem);
    writeCertPemProtected(certAtkPath, signedCertificatePem, { allowOverwrite: true });
    writeCertPemProtected(certPath, signedCertificatePem, { allowOverwrite: true });
  } finally {
    dbCrypto.setFiscalKeyWriteAllowed(false);
  }
  saveKeyPaths(certAtkPath, privateAtkPath);
  const certIds = parseCertRegistrationIds(certAtkPath);
  writeFiscalKeysProtectionMarker(dir, certIds);
  lockPrivateKeysAtRest();
  return { certificate_path: certAtkPath, private_key_path: privateAtkPath };
}

/**
 * Gjeneron çift ECDSA P-256 (placeholder), ruan në fiscal-keys/, përditëson fiscal_settings.
 * Shkruan edhe emrat legacy (private.pem) edhe ATK (private-key.pem).
 * MOS mbishkruaj certifikatë/çelës real ATK (pa force:true / allowOverwrite:true).
 */
function generateKeyPair(opts = {}) {
  if (!isFiscalEnabled()) return null;

  const dir = getKeysDir();
  fs.mkdirSync(dir, { recursive: true });

  const privatePath = path.join(dir, PRIVATE_FILE);
  const certPath = path.join(dir, CERT_FILE);
  const privateAtkPath = path.join(dir, PRIVATE_FILE_ATK);
  const certAtkPath = path.join(dir, CERT_FILE_ATK);

  if (isFiscalKeysProtected(opts)) {
    const existingCert = firstExistingPath([certAtkPath, certPath]);
    const existingPriv = firstExistingPrivatePath([privateAtkPath, privatePath]);
    console.warn(
      "[fiscal-crypto] Çelësat fiskalë janë të mbrojtur — generateKeyPair u anulua (pa force)."
    );
    return {
      certificate_path: existingCert || certAtkPath,
      private_key_path: existingPriv || privateAtkPath,
      placeholder: false,
      skipped: true,
      protected: true,
      algorithm: "ECDSA-P256",
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: EC_CURVE,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const certPem =
    `# KAFENE FISCAL PLACEHOLDER CERTIFICATE (ECDSA P-256)\n` +
    `# Replace with ATK signed-certificate.pem when available\n` +
    publicKey;

  const writeOpts = { encoding: "utf8", mode: 0o600 };
  writeCertPemProtected(certPath, certPem, opts);
  writeCertPemProtected(certAtkPath, certPem, opts);
  dbCrypto.setFiscalKeyWriteAllowed(true);
  try {
    dbCrypto.writePrivatePem(privatePath, privateKey);
    dbCrypto.writePrivatePem(privateAtkPath, privateKey);
  } finally {
    dbCrypto.setFiscalKeyWriteAllowed(false);
  }

  try {
    saveKeyPaths(certAtkPath, privateAtkPath);
  } catch (e) {
    console.warn("[fiscal-crypto] saveKeyPaths:", e.message);
  }

  return {
    certificate_path: certAtkPath,
    private_key_path: privateAtkPath,
    placeholder: true,
    algorithm: "ECDSA-P256",
  };
}

/**
 * Lexon çelësin privat: settings → private-key.pem → private.pem.
 * NUK gjeneron çelës të ri nëse certifikata reale ekziston.
 */
function loadPrivateKey() {
  if (!isFiscalEnabled()) return null;

  const dir = getKeysDir();
  const stored = getStoredPaths();
  let privatePath = firstExistingPrivatePath([
    stored.private_key_path,
    path.join(dir, PRIVATE_FILE_ATK),
    path.join(dir, PRIVATE_FILE),
    ...projectFiscalKeyCandidates(PRIVATE_FILE_ATK),
    ...projectFiscalKeyCandidates(PRIVATE_FILE),
  ]);

  if (privatePath) {
    const pem = dbCrypto.readPrivatePem(privatePath);
    if (pem && isEcPrivateKeyPem(pem)) return pem;
    if (pem) {
      console.warn(
        "[fiscal-crypto] Çelësi privat nuk është ECDSA — nuk mbishkruhet certifikatë ATK; dështon ngarkimi"
      );
      throw new Error("Çelësi privat ekzistues nuk është ECDSA");
    }
  }

  if (hasRealAtkCertificate(dir, stored.certificate_path)) {
    throw new Error(
      "Certifikata ATK ekziston por çelësi privat mungon — NUK gjenerohet çelës i ri automatikisht. " +
        "Rivendos private-key.pem ose përdor «Lidhu me ATK»."
    );
  }

  if (isFiscalKeysProtected()) {
    throw new Error(
      "Çelësi privat mungon — çelësat fiskalë janë të mbrojtur; nuk gjenerohet çelës i ri pa leje."
    );
  }

  const gen = generateKeyPair();
  if (!gen || gen.skipped || gen.protected) return null;
  const pem = dbCrypto.readPrivatePem(gen.private_key_path);
  return pem;
}

/**
 * Lexon certifikatën / publik: settings → signed-certificate.pem → certificate.pem.
 */
function loadCertificate() {
  if (!isFiscalEnabled()) return null;

  const dir = getKeysDir();
  const stored = getStoredPaths();
  let certPath = firstExistingPath([
    path.join(dir, CERT_FILE_ATK),
    stored.certificate_path,
    path.join(dir, CERT_FILE),
    ...projectFiscalKeyCandidates(CERT_FILE_ATK),
    ...projectFiscalKeyCandidates(CERT_FILE),
  ]);

  if (!certPath) {
    if (
      dbCrypto.hasPrivateKeyMaterial(dir, stored.private_key_path) ||
      isFiscalKeysProtected()
    ) {
      throw new Error(
        "Certifikata mungon — çelësat fiskalë janë të mbrojtur; nuk gjenerohet certifikatë e re pa leje."
      );
    }
    const gen = generateKeyPair();
    if (!gen || gen.skipped || gen.protected) return null;
    certPath = gen.certificate_path;
  }
  return fs.readFileSync(certPath, "utf8");
}

/**
 * data → SHA-256 → ECDSA (P-256) → signature base64.
 */
function signReceipt(receiptData) {
  if (!isFiscalEnabled()) return null;

  try {
    const pem = loadPrivateKey();
    if (!pem) {
      throw new Error("Çelësi privat nuk u gjet");
    }
    if (!isEcPrivateKeyPem(pem)) {
      throw new Error("Çelësi privat duhet ECDSA P-256 (jo RSA)");
    }

    const canonical =
      typeof receiptData === "string"
        ? receiptData
        : canonicalizeReceiptData(receiptData);
    const data = Buffer.from(canonical, "utf8");
    const signature = crypto.sign("sha256", data, {
      key: pem,
      dsaEncoding: "der",
    });
    return signature.toString("base64");
  } finally {
    lockPrivateKeysAtRest();
  }
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

function normalizeRegId(raw) {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) ? String(n) : "";
}

/**
 * Lexon POS ID (OU) dhe Branch ID (L/locality) nga certifikata ATK.
 * CSR onboarding: OU=PosId, L=BranchId (spec pos-csharp).
 */
function parseCertRegistrationIds(certPath) {
  try {
    if (!certPath || !fs.existsSync(certPath)) return null;
    const pem = fs.readFileSync(certPath, "utf8");
    if (!/BEGIN\s+CERTIFICATE/i.test(pem)) return null;
    const { X509Certificate } = crypto;
    const cert = new X509Certificate(pem);
    const fields = {};
    for (const line of String(cert.subject || "").split(/\n/)) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (m) fields[m[1].trim()] = m[2].trim();
    }
    const posRaw = fields.OU ?? fields.ou ?? "";
    const branchRaw = fields.L ?? fields.l ?? fields.localityName ?? "";
    return {
      pos_id: normalizeRegId(posRaw),
      branch_id: normalizeRegId(branchRaw),
      raw_subject: cert.subject,
    };
  } catch {
    return null;
  }
}

function compareCertWithSettings(settings, certPath) {
  const certIds = parseCertRegistrationIds(certPath);
  if (!certIds) {
    return {
      match: false,
      reason: "no_cert",
      cert_ids: null,
      settings_ids: null,
    };
  }
  const settingsIds = {
    pos_id: normalizeRegId(settings?.pos_id),
    branch_id: normalizeRegId(
      settings?.business_unit_number ?? settings?.unit_number
    ),
  };
  if (!settingsIds.pos_id || !settingsIds.branch_id) {
    return {
      match: false,
      reason: "settings_incomplete",
      cert_ids: certIds,
      settings_ids: settingsIds,
    };
  }
  const match =
    settingsIds.pos_id === certIds.pos_id &&
    settingsIds.branch_id === certIds.branch_id;
  return {
    match,
    reason: match ? "ok" : "mismatch",
    cert_ids: certIds,
    settings_ids: settingsIds,
  };
}

/**
 * Verifikon që çelësi privat lexohet (dekriptim + ECDSA) — para shitjes/printit.
 */
function verifyPrivateKeyReadable() {
  if (!isFiscalEnabled()) {
    return { ok: true, skipped: true };
  }
  try {
    const pem = loadPrivateKey();
    if (!pem) {
      return { ok: false, error: "Çelësi privat mungon" };
    }
    if (!isEcPrivateKeyPem(pem)) {
      return { ok: false, error: "Çelësi privat duhet ECDSA P-256" };
    }
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/unsupported state|unable to authenticate|palexueshme|decrypt/i.test(msg)) {
      return {
        ok: false,
        error:
          "Çelësi privat i enkriptuar nuk lexohet — rikthe nga backup-i (fiscal-keys + .db-master.dpapi)",
        decrypt_failed: true,
      };
    }
    return { ok: false, error: msg };
  }
}

module.exports = {
  getKeysDir,
  saveKeyPaths,
  isPlaceholderCertificatePem,
  hasRealAtkCertificate,
  hasAnyFiscalKeyArtifacts,
  hasFiscalKeysProtectionMarker,
  ensureFiscalKeysProtectionMarker,
  isFiscalKeysProtected,
  saveAtkKeysFromOnboarding,
  parseCertRegistrationIds,
  compareCertWithSettings,
  normalizeRegId,
  generateKeyPair,
  loadPrivateKey,
  loadCertificate,
  signReceipt,
  verifyPrivateKeyReadable,
  verifyReceiptSignature,
  canonicalizeReceiptData,
  lockPrivateKeysAtRest,
  cleanupFiscalKeysJunk,
  EC_CURVE,
};
