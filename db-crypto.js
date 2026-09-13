/**
 * db-crypto.js — AES-256-GCM për biznes.db dhe çelësat privat fiskalë në pushim.
 *
 * - Çelës master 32-byte (random) i mbrojtur me Windows DPAPI (CurrentUser).
 * - Fallback jo-Windows: scrypt + fingerprint makine + salt instalimi.
 * - Format skedari: BIZENC1\\0 + IV(12) + authTag(16) + ciphertext
 *
 * Ky skedar NUK obfuskohet (përdoret nga database.js dhe fiscal-crypto.js).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const MAGIC = Buffer.from("BIZENC1\0", "ascii");
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const ALGO = "aes-256-gcm";
const SCrypt_N = 16384;
const SCrypt_r = 8;
const SCrypt_p = 1;

const WRAPPED_DPAPI = ".db-master.dpapi";
const WRAPPED_SCRYPT = ".db-master.scrypt";
const INSTALL_SALT = ".db-install-salt";

const PRIVATE_NAMES = ["private-key.pem", "private.pem"];

const portable = require("./portable-path");

let _masterKeysByDir = new Map();
let _fiscalKeyWriteAllowed = false;

function setFiscalKeyWriteAllowed(allowed) {
  _fiscalKeyWriteAllowed = !!allowed;
}

function isFiscalKeyWriteAllowedNow() {
  return _fiscalKeyWriteAllowed;
}

function isFiscalKeysDirectory(pemPath) {
  return /[\\/]fiscal-keys[\\/]/i.test(String(pemPath || ""));
}

/** Çelësat fiskalë përdorin të njëjtin master key si biznes.db (folderi prind). */
function resolveMasterKeyDir(pemPath) {
  if (isFiscalKeysDirectory(pemPath)) {
    return getDbDir();
  }
  return path.dirname(pemPath);
}

function removeStaleFiscalKeysMaster(keysDir) {
  if (!keysDir || !fs.existsSync(keysDir)) return;
  const dbDir = getDbDir();
  if (path.resolve(keysDir) === path.resolve(dbDir)) return;
  for (const name of [WRAPPED_DPAPI, WRAPPED_SCRYPT, INSTALL_SALT]) {
    const p = path.join(keysDir, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* */
    }
  }
}

function skipPrivateKeyEncryption() {
  return portable.isPortableMode();
}

function getDbDir() {
  const dbPath =
    process.env.BIZNES_DB_PATH ||
    process.env.DB_PATH ||
    path.join(portable.getDataDir(), "biznes.db");
  return path.dirname(dbPath);
}

function wrappedDpapiPath(dir) {
  return path.join(dir, WRAPPED_DPAPI);
}

function wrappedScryptPath(dir) {
  return path.join(dir, WRAPPED_SCRYPT);
}

function installSaltPath(dir) {
  return path.join(dir, INSTALL_SALT);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function isDpapiAvailable() {
  return process.platform === "win32";
}

function dpapiProtect(plainBuffer) {
  const tmpIn = path.join(os.tmpdir(), `bizenc-in-${process.pid}-${Date.now()}.bin`);
  const tmpOut = path.join(os.tmpdir(), `bizenc-out-${process.pid}-${Date.now()}.bin`);
  const psIn = tmpIn.replace(/'/g, "''");
  const psOut = tmpOut.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$in='${psIn}'`,
    `$out='${psOut}'`,
    "$bytes=[IO.File]::ReadAllBytes($in)",
    "$prot=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[IO.File]::WriteAllBytes($out,$prot)",
  ].join("; ");
  try {
    fs.writeFileSync(tmpIn, plainBuffer);
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "pipe", windowsHide: true }
    );
    return fs.readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpOut]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* */
      }
    }
  }
}

function dpapiUnprotect(protectedBuffer) {
  const tmpIn = path.join(os.tmpdir(), `bizenc-u-in-${process.pid}-${Date.now()}.bin`);
  const tmpOut = path.join(os.tmpdir(), `bizenc-u-out-${process.pid}-${Date.now()}.bin`);
  const psIn = tmpIn.replace(/'/g, "''");
  const psOut = tmpOut.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$in='${psIn}'`,
    `$out='${psOut}'`,
    "$bytes=[IO.File]::ReadAllBytes($in)",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[IO.File]::WriteAllBytes($out,$plain)",
  ].join("; ");
  try {
    fs.writeFileSync(tmpIn, protectedBuffer);
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "pipe", windowsHide: true }
    );
    return fs.readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpOut]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* */
      }
    }
  }
}

function machineFingerprint() {
  let user = "";
  try {
    user = os.userInfo().username || "";
  } catch {
    user = process.env.USERNAME || process.env.USER || "";
  }
  return [os.hostname(), user, os.platform(), os.arch(), "biznes-sef-v1"].join("|");
}

function getOrCreateInstallSalt(dir) {
  ensureDir(dir);
  const p = installSaltPath(dir);
  if (fs.existsSync(p)) {
    return fs.readFileSync(p);
  }
  const salt = crypto.randomBytes(32);
  fs.writeFileSync(p, salt, { mode: 0o600 });
  return salt;
}

function scryptWrapKey(masterKey, dir) {
  const salt = getOrCreateInstallSalt(dir);
  const derived = crypto.scryptSync(machineFingerprint(), salt, KEY_LEN, {
    N: SCrypt_N,
    r: SCrypt_r,
    p: SCrypt_p,
  });
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, derived, iv);
  const enc = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function scryptUnwrapKey(wrapped, dir) {
  if (wrapped.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("db-crypto: wrapped key i shkurtër (scrypt)");
  }
  const salt = getOrCreateInstallSalt(dir);
  const derived = crypto.scryptSync(machineFingerprint(), salt, KEY_LEN, {
    N: SCrypt_N,
    r: SCrypt_r,
    p: SCrypt_p,
  });
  const iv = wrapped.subarray(0, IV_LEN);
  const tag = wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = wrapped.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, derived, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function wrapMasterKey(masterKey, dir) {
  ensureDir(dir);
  if (isDpapiAvailable()) {
    const wrapped = dpapiProtect(masterKey);
    fs.writeFileSync(wrappedDpapiPath(dir), wrapped, { mode: 0o600 });
    try {
      fs.unlinkSync(wrappedScryptPath(dir));
    } catch {
      /* */
    }
    return;
  }
  const wrapped = scryptWrapKey(masterKey, dir);
  fs.writeFileSync(wrappedScryptPath(dir), wrapped, { mode: 0o600 });
}

function unwrapMasterKey(dir) {
  const dpapiPath = wrappedDpapiPath(dir);
  const scryptPath = wrappedScryptPath(dir);
  if (fs.existsSync(dpapiPath)) {
    return dpapiUnprotect(fs.readFileSync(dpapiPath));
  }
  if (fs.existsSync(scryptPath)) {
    return scryptUnwrapKey(fs.readFileSync(scryptPath), dir);
  }
  return null;
}

function getOrCreateMasterKey(dir) {
  const norm = path.resolve(dir);
  if (_masterKeysByDir.has(norm)) return _masterKeysByDir.get(norm);
  const existing = unwrapMasterKey(dir);
  if (existing && existing.length === KEY_LEN) {
    _masterKeysByDir.set(norm, existing);
    return existing;
  }
  const created = crypto.randomBytes(KEY_LEN);
  wrapMasterKey(created, dir);
  _masterKeysByDir.set(norm, created);
  return created;
}

function isEncryptedBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= MAGIC.length &&
    buf.subarray(0, MAGIC.length).equals(MAGIC)
  );
}

function isPlainSqlite(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 16 &&
    buf.subarray(0, 16).toString("ascii") === "SQLite format 3\u0000"
  );
}

function encryptBuffer(plaintext, dir) {
  const key = getOrCreateMasterKey(dir);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, enc]);
}

function decryptBuffer(ciphertext, dir) {
  if (!isEncryptedBuffer(ciphertext)) {
    throw new Error("db-crypto: skedar i palekriptuar ose format i panjohur");
  }
  const key = getOrCreateMasterKey(dir);
  const body = ciphertext.subarray(MAGIC.length);
  if (body.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("db-crypto: blob i shkurtër");
  }
  const iv = body.subarray(0, IV_LEN);
  const tag = body.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = body.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Lexon biznes.db nga disku → bytes SQLite (plain në memorie).
 * @returns {{ bytes: Buffer|null, wasPlain: boolean, needsEncryptionMigration: boolean }}
 */
function loadDatabaseBytes(dbPath) {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  if (!fs.existsSync(dbPath)) {
    return { bytes: null, wasPlain: true, needsEncryptionMigration: false };
  }
  const raw = fs.readFileSync(dbPath);

  if (isEncryptedBuffer(raw)) {
    try {
      const plain = decryptBuffer(raw, dir);
      if (!isPlainSqlite(plain)) {
        throw new Error("plaintext pas dekriptimit nuk është SQLite");
      }
      return {
        bytes: plain,
        wasPlain: false,
        needsEncryptionMigration: false,
      };
    } catch (e) {
      console.warn(
        "[db-crypto] dekriptimi i biznes.db dështoi — provo si plain:",
        e.message || e
      );
      if (isPlainSqlite(raw)) {
        return { bytes: raw, wasPlain: true, needsEncryptionMigration: true };
      }
      throw new Error(
        "db-crypto: biznes.db e enkriptuar e palexueshme — rikthe nga backup. " +
          (e.message || e)
      );
    }
  }

  if (isPlainSqlite(raw)) {
    return { bytes: raw, wasPlain: true, needsEncryptionMigration: true };
  }

  throw new Error("db-crypto: biznes.db — format i panjohur (jo BIZENC1, jo SQLite)");
}

/**
 * Ruan bytes SQLite — enkriptuar BIZENC1 kur DPAPI/master key funksionon.
 * Nëse enkriptimi dështon → plain + log (mos prish programin).
 */
function saveDatabaseBytes(dbPath, sqliteBytes) {
  if (global.DB_DECRYPT_FAILED && /biznes\.db$/i.test(String(dbPath || ""))) {
    console.warn("[db-crypto] saveDatabaseBytes u bllokua (DB_DECRYPT_FAILED)");
    return;
  }
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const plain = Buffer.isBuffer(sqliteBytes) ? sqliteBytes : Buffer.from(sqliteBytes);
  try {
    getOrCreateMasterKey(dir);
    const enc = encryptBuffer(plain, dir);
    fs.writeFileSync(dbPath, enc, { mode: 0o600 });
  } catch (e) {
    console.warn(
      "[db-crypto] enkriptimi i biznes.db dështoi — ruhet plain:",
      e.message || e
    );
    fs.writeFileSync(dbPath, plain, { mode: 0o600 });
  }
}

function encryptedPathFor(pemPath) {
  return `${pemPath}.enc`;
}

function readPrivatePem(pemPath) {
  const encPath = encryptedPathFor(pemPath);
  const fileDir = path.dirname(pemPath);
  const masterDir = resolveMasterKeyDir(pemPath);
  if (skipPrivateKeyEncryption() && fs.existsSync(pemPath)) {
    return fs.readFileSync(pemPath, "utf8");
  }
  if (fs.existsSync(encPath)) {
    const raw = fs.readFileSync(encPath);
    let plain;
    try {
      plain = decryptBuffer(raw, masterDir);
    } catch (primaryErr) {
      if (masterDir !== fileDir && isFiscalKeysDirectory(pemPath)) {
        try {
          plain = decryptBuffer(raw, fileDir);
          const pem = plain.toString("utf8");
          const prev = _fiscalKeyWriteAllowed;
          setFiscalKeyWriteAllowed(true);
          try {
            fs.writeFileSync(
              encPath,
              encryptBuffer(plain, masterDir),
              { mode: 0o600 }
            );
            removeStaleFiscalKeysMaster(fileDir);
          } finally {
            setFiscalKeyWriteAllowed(prev);
          }
          return pem;
        } catch {
          throw primaryErr;
        }
      }
      throw primaryErr;
    }
    return plain.toString("utf8");
  }
  if (fs.existsSync(pemPath)) {
    const pem = fs.readFileSync(pemPath, "utf8");
    if (!skipPrivateKeyEncryption()) {
      writePrivatePem(pemPath, pem);
    }
    return pem;
  }
  return null;
}

function writePrivatePem(pemPath, pemText) {
  const dir = resolveMasterKeyDir(pemPath);
  const encPath = encryptedPathFor(pemPath);
  if (isFiscalKeysDirectory(pemPath) && !isFiscalKeyWriteAllowedNow()) {
    const plainExists = fs.existsSync(pemPath);
    const encExists = fs.existsSync(encPath);
    // Lejo vetëm migrimin plain → enc (i njëjti çelës, pa zëvendësim)
    if (!(plainExists && !encExists)) {
      console.warn(
        "[db-crypto] Shkrimi i çelësit privat u bllokua — çelësat fiskalë janë të mbrojtur."
      );
      return;
    }
  }
  ensureDir(dir);
  const enc = encryptBuffer(Buffer.from(String(pemText), "utf8"), dir);
  fs.writeFileSync(encPath, enc, { mode: 0o600 });
  try {
    fs.unlinkSync(pemPath);
  } catch {
    /* */
  }
}

/**
 * Në portable/USB: çelësat .enc → plain .pem (lexueshëm pas kopjimit nga PC burim).
 */
function exportPlainPrivateKeysForPortable(keysDir) {
  if (!keysDir || !fs.existsSync(keysDir)) return { exported: 0 };
  let exported = 0;
  for (const name of PRIVATE_NAMES) {
    const pemPath = path.join(keysDir, name);
    const encPath = encryptedPathFor(pemPath);
    if (fs.existsSync(pemPath)) {
      exported += 1;
      continue;
    }
    if (!fs.existsSync(encPath)) continue;
    try {
      const plain = decryptBuffer(
        fs.readFileSync(encPath),
        resolveMasterKeyDir(pemPath)
      );
      fs.writeFileSync(pemPath, plain, { mode: 0o600 });
      try {
        fs.unlinkSync(encPath);
      } catch {
        /* */
      }
      exported += 1;
    } catch (e) {
      console.warn("[db-crypto] export plain key:", pemPath, e.message);
    }
  }
  return { exported };
}

function lockPrivateKeyFiles(keysDir) {
  if (!keysDir || !fs.existsSync(keysDir)) return { locked: 0 };
  if (skipPrivateKeyEncryption()) {
    exportPlainPrivateKeysForPortable(keysDir);
    return { locked: 0, portable: true };
  }
  let locked = 0;
  for (const name of PRIVATE_NAMES) {
    const pemPath = path.join(keysDir, name);
    const encPath = encryptedPathFor(pemPath);
    if (fs.existsSync(pemPath)) {
      const pem = fs.readFileSync(pemPath, "utf8");
      writePrivatePem(pemPath, pem);
      locked += 1;
    } else if (fs.existsSync(encPath)) {
      locked += 1;
    }
  }
  return { locked };
}

function migratePlainPrivateKeys(keysDir) {
  return lockPrivateKeyFiles(keysDir);
}

function hasPrivateKeyMaterial(keysDir, storedPath) {
  const candidates = [];
  if (storedPath) candidates.push(storedPath);
  for (const name of PRIVATE_NAMES) {
    candidates.push(path.join(keysDir, name));
  }
  for (const base of candidates) {
    if (!base) continue;
    if (fs.existsSync(encryptedPathFor(base)) || fs.existsSync(base)) return true;
  }
  return false;
}

module.exports = {
  getDbDir,
  resolveMasterKeyDir,
  removeStaleFiscalKeysMaster,
  getOrCreateMasterKey,
  encryptBuffer,
  decryptBuffer,
  isEncryptedBuffer,
  isPlainSqlite,
  loadDatabaseBytes,
  saveDatabaseBytes,
  readPrivatePem,
  writePrivatePem,
  setFiscalKeyWriteAllowed,
  isFiscalKeyWriteAllowedNow,
  lockPrivateKeyFiles,
  migratePlainPrivateKeys,
  exportPlainPrivateKeysForPortable,
  skipPrivateKeyEncryption,
  hasPrivateKeyMaterial,
  encryptedPathFor,
};
