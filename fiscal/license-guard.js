/**
 * Hardware Lock — shtresë lokale PARA license.js (cloud).
 * LICENSE_KEY (legacy): SHA256(HARDWARE_ID + SECRET_SALT)
 * LICENSE_KEY (trial):  SHA256(HARDWARE_ID + SECRET_SALT + "|trial")
 * LICENSE_KEY (annual): SHA256(HARDWARE_ID + SECRET_SALT + "|annual|" + YYYYMMDD)
 * Vlen vetëm për këtë PC (install-salt + motherboard + disk).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const LICENSE_STORAGE_REL = path.join("RevolutionInvest", "KafeneLicense");
const HW_LIC_BASENAME = ".hw-lic";
const INSTALL_SALT_BASENAME = ".install-salt";
const TRIAL_USED_BASENAME = ".hw-trial-used";
const GRACE_BASENAME = ".hw-grace.json";
const AUDIT_BASENAME = ".hw-audit.log";
const CONTACT_PHONE = "+383 48707880";
const CONTACT_WHATSAPP = "38348707880";

function buildWhatsAppActivationUrl(hardwareId, email) {
  const hw = String(hardwareId || "").trim() || "—";
  const em = String(email || "").trim();
  const lines = [
    "Pershendetje Revolution Invest,",
    `ID pajisje per aktivizim: ${hw}`,
    em ? `Email: ${em}` : null,
    "Ju lutem me dergoni kodin e licences. Mund te dergoj edhe foto te ketij ekrani.",
  ].filter(Boolean);
  return `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`;
}
/** Grace HW kur çelësi lokal prishet — i shkurtuar (mbrojtje më e fortë). */
const GRACE_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 7;
const ANNUAL_DAYS = 365;
const MSG_LICENSE_EXPIRED = `Licenca ka skaduar, kontaktoni ${CONTACT_PHONE}`;

function _xorDecode(bytes) {
  return Buffer.from(bytes.map((x, i) => x ^ ((i * 11 + 37) & 0xff))).toString("utf8");
}

/** SECRET_SALT — i obfuskuar (i njëjti vlerë si tools/generate-license.js). */
function getSecretSalt() {
  return _xorDecode([
    110, 113, 125, 3, 31, 25, 74, 58, 42, 196, 220, 221, 226, 153, 141, 250, 231, 214, 198, 184, 64, 95,
    82, 112, 0, 1, 37, 122, 58, 86, 14, 77, 231,
  ]);
}

function appDataRoot(app) {
  if (app) {
    try {
      return app.getPath("appData");
    } catch {
      /* fall through */
    }
  }
  return process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
}

function licenseStorageRoot(app) {
  const root = path.join(appDataRoot(app), LICENSE_STORAGE_REL);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function hwLicensePath(app) {
  return path.join(licenseStorageRoot(app), HW_LIC_BASENAME);
}

function installSaltPath(app) {
  return path.join(licenseStorageRoot(app), INSTALL_SALT_BASENAME);
}

function trialUsedPath(app) {
  return path.join(licenseStorageRoot(app), TRIAL_USED_BASENAME);
}

function gracePath(app) {
  return path.join(licenseStorageRoot(app), GRACE_BASENAME);
}

/** YYYYMMDD (UTC) */
function toYmd(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function ymdToEndOfDayIso(ymd) {
  const s = String(ymd || "").replace(/\D/g, "");
  if (s.length !== 8) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  if (!y || !m || !day) return null;
  return new Date(Date.UTC(y, m - 1, day, 23, 59, 59, 999)).toISOString();
}

function addDaysIso(fromIso, days) {
  const d = new Date(fromIso || Date.now());
  if (!Number.isFinite(d.getTime())) d.setTime(Date.now());
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString();
}

function annualExpiresYmdFromToday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ANNUAL_DAYS);
  return toYmd(d);
}

function keysEqual(a, b) {
  const x = normalizeLicenseKey(a);
  const y = normalizeLicenseKey(b);
  if (!x || !y || x.length !== 16 || y.length !== 16) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"));
  } catch {
    return x === y;
  }
}

function hasTrialBeenUsed(app, hardwareId) {
  const p = trialUsedPath(app);
  if (!fs.existsSync(p)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const stored = normalizeHardwareId(j && j.hardware_id);
    const want = normalizeHardwareId(hardwareId || getHardwareId(app));
    return !!stored && stored === want;
  } catch {
    return false;
  }
}

function markTrialUsed(app, hardwareId) {
  const hw = formatHardwareId(hardwareId || getHardwareId(app));
  try {
    fs.writeFileSync(
      trialUsedPath(app),
      JSON.stringify({ hardware_id: hw, used_at: new Date().toISOString() }),
      "utf8",
    );
  } catch (e) {
    console.warn("[license-guard] trial-used:", e.message || e);
  }
}

function isLicenseExpired(rec) {
  if (!rec || !rec.expires_at) return false;
  const t = Date.parse(rec.expires_at);
  return Number.isFinite(t) && Date.now() > t;
}

function auditLogPath(app) {
  return path.join(licenseStorageRoot(app), AUDIT_BASENAME);
}

/** Audit lokal (gjithmonë) + fiscal audit nëse është aktiv. */
function logHwLicenseAudit(app, event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event: String(event || "unknown"),
    ...details,
  };
  try {
    fs.appendFileSync(auditLogPath(app), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.warn("[license-guard] audit file:", e.message || e);
  }
  try {
    const { isFiscalEnabled } = require("./fiscal-config");
    if (isFiscalEnabled()) {
      const { logFiscalAction } = require("./fiscal-audit");
      logFiscalAction("error", { source: "hardware_license", ...entry }, "system", null);
    }
  } catch (e) {
    console.warn("[license-guard] fiscal audit:", e.message || e);
  }
}

function readGraceRecord(app) {
  const p = gracePath(app);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!j || !j.started_at) return null;
    return j;
  } catch {
    return null;
  }
}

function clearGrace(app) {
  try {
    const p = gracePath(app);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{ active: boolean, expired: boolean, hoursLeft: number, endsAt: string|null, reason: string|null }}
 */
function getGraceStatus(app) {
  const rec = readGraceRecord(app);
  if (!rec) {
    return { active: false, expired: false, hoursLeft: 0, endsAt: null, reason: null };
  }
  const started = Date.parse(rec.started_at);
  if (!Number.isFinite(started)) {
    return { active: false, expired: true, hoursLeft: 0, endsAt: null, reason: rec.reason || null };
  }
  const ends = started + GRACE_MS;
  const leftMs = ends - Date.now();
  const hoursLeft = Math.max(0, Math.ceil(leftMs / (60 * 60 * 1000)));
  if (leftMs <= 0) {
    return {
      active: false,
      expired: true,
      hoursLeft: 0,
      endsAt: new Date(ends).toISOString(),
      reason: rec.reason || null,
    };
  }
  return {
    active: true,
    expired: false,
    hoursLeft,
    endsAt: new Date(ends).toISOString(),
    reason: rec.reason || null,
  };
}

/**
 * Nis grace nëse nuk ka; nuk rivendos orën nëse tashmë ekziston.
 * @returns {{ status: object, startedNow: boolean }}
 */
function beginGraceIfNeeded(app, reason, hardwareIdFormatted) {
  const existing = readGraceRecord(app);
  if (existing && existing.started_at) {
    return { status: getGraceStatus(app), startedNow: false };
  }
  const rec = {
    started_at: new Date().toISOString(),
    reason: String(reason || "license_invalid"),
    hardware_id: hardwareIdFormatted || null,
  };
  fs.writeFileSync(gracePath(app), JSON.stringify(rec, null, 2), "utf8");
  logHwLicenseAudit(app, "grace_started", rec);
  return { status: getGraceStatus(app), startedNow: true };
}

/**
 * Banner vetëm për admin/login (jo kamarier).
 * Null kur licenca OK; gjatë grace → njoftim skadimi (≤48 orë).
 */
function getGraceBannerInfo(app) {
  const g = getGraceStatus(app);
  if (!g.active) return null;
  if (!(g.hoursLeft > 0 && g.hoursLeft <= 48)) return null;
  return {
    hoursLeft: g.hoursLeft,
    message: `Licenca skadon për ${g.hoursLeft} orë — kontaktoni mbështetjen (${CONTACT_PHONE})`,
    phone: CONTACT_PHONE,
  };
}

/**
 * UUID i instalimit të parë — në %APPDATA%.
 * Mbijeton UPDATE. Fshihet VETËM me çinstalim të vërtetë (jo update).
 * Nëse ekziston → MOS e mbishkruaj kurrë.
 */
function ensureInstallSalt(app) {
  const p = installSaltPath(app);
  try {
    if (fs.existsSync(p)) {
      const existing = String(fs.readFileSync(p, "utf8") || "").trim();
      if (existing) return existing;
    }
  } catch {
    /* try create below */
  }
  const salt =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 'wx' = create only if missing — asnjë mbishkrim gjatë update/race
    fs.writeFileSync(p, salt, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if (e && (e.code === "EEXIST" || e.code === "EPERM")) {
      try {
        const again = String(fs.readFileSync(p, "utf8") || "").trim();
        if (again) return again;
      } catch {
        /* fall through */
      }
    }
    // Fallback vetëm nëse skedari vërtet mungon
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, salt, "utf8");
    } else {
      const again = String(fs.readFileSync(p, "utf8") || "").trim();
      if (again) return again;
    }
  }
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* ignore on Windows */
  }
  return salt;
}

function runCmd(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function parseWmicSerials(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const values = [];
  for (const line of lines) {
    if (/^serialnumber$/i.test(line)) continue;
    if (/^serial\s*number$/i.test(line)) continue;
    values.push(line);
  }
  return values.join("|");
}

function readBoardSerial() {
  const wmic = parseWmicSerials(runCmd("wmic baseboard get serialnumber"));
  if (wmic) return wmic;
  return String(
    runCmd(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_BaseBoard).SerialNumber"',
    ),
  ).trim();
}

function readDiskSerial() {
  const wmic = parseWmicSerials(runCmd("wmic diskdrive get serialnumber"));
  if (wmic) return wmic;
  return String(
    runCmd(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_DiskDrive | Select-Object -First 1).SerialNumber"',
    ),
  ).trim();
}

/**
 * Hash unik për këtë instalim:
 * SHA256(motherboard + disk + install-salt).
 * Çdo çinstalim/reinstalim → salt i ri → HARDWARE_ID i ri → kod i ri nga Revolution Invest.
 */
function getHardwareId(app) {
  const board = readBoardSerial() || "NO-BOARD";
  const disk = readDiskSerial() || "NO-DISK";
  const installSalt = ensureInstallSalt(app);
  return crypto
    .createHash("sha256")
    .update(`${board}::${disk}::${installSalt}`)
    .digest("hex");
}

/** HARDWARE_ID i formatuar për ekran / WhatsApp: XXXX-XXXX-XXXX-XXXX */
function formatHardwareId(hardwareId) {
  const hex = String(hardwareId || "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase()
    .slice(0, 16)
    .padEnd(16, "0");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function normalizeHardwareId(input) {
  return String(input || "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase()
    .slice(0, 16);
}

/** Vetëm A-Z / 0-9, max 16 (pa viza). */
function normalizeLicenseKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

/** Format: XXXX-XXXX-XXXX-XXXX */
function formatLicenseKey(key) {
  const n = normalizeLicenseKey(key).padEnd(16, "0").slice(0, 16);
  return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}`;
}

/**
 * LICENSE_KEY = 16 karakteret e para të SHA256(...), uppercase, me viza.
 * @param {string} [licenseType] — 'trial' | 'annual' | omitted (legacy)
 * @param {string} [expiresYmd] — YYYYMMDD, i detyrueshëm për annual
 */
function expectedLicenseKey(formattedOrRawHardwareId, licenseType, expiresYmd) {
  const id = normalizeHardwareId(formattedOrRawHardwareId);
  const type = String(licenseType || "")
    .trim()
    .toLowerCase();
  let material = id + getSecretSalt();
  if (type === "trial") {
    material = id + getSecretSalt() + "|trial";
  } else if (type === "annual") {
    const ymd = String(expiresYmd || "").replace(/\D/g, "");
    if (ymd.length !== 8) {
      throw new Error("expiresYmd i detyrueshëm për licencë vjetore (YYYYMMDD).");
    }
    material = id + getSecretSalt() + "|annual|" + ymd;
  }
  const hash = crypto.createHash("sha256").update(material).digest("hex").toUpperCase();
  return formatLicenseKey(hash.slice(0, 16));
}

/**
 * Verifikon çelësin dhe kthen tipin (trial / annual / legacy→annual).
 * @returns {{ ok: boolean, licenseType?: string, expiresYmd?: string|null, legacy?: boolean }}
 */
function matchLicenseKey(key, app, hardwareId) {
  const got = normalizeLicenseKey(key);
  if (!got || got.length !== 16) return { ok: false };
  const hwRaw = hardwareId || getHardwareId(app);
  const id = normalizeHardwareId(formatHardwareId(hwRaw));

  if (keysEqual(got, expectedLicenseKey(id, "trial"))) {
    return { ok: true, licenseType: "trial", expiresYmd: null };
  }

  // Annual: skadimi është në hash (1 vit nga dita e gjenerimit). Kërko deri ~400 ditë përpara.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 2);
  for (let i = 0; i < 420; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const ymd = toYmd(d);
    try {
      if (keysEqual(got, expectedLicenseKey(id, "annual", ymd))) {
        return { ok: true, licenseType: "annual", expiresYmd: ymd };
      }
    } catch {
      /* ignore */
    }
  }

  // Legacy (para trial/annual) — pranohet si annual pa skadim të detyrueshëm
  if (keysEqual(got, expectedLicenseKey(id))) {
    return { ok: true, licenseType: "annual", expiresYmd: null, legacy: true };
  }
  return { ok: false };
}

function readStoredLicenseRecord(app) {
  const p = hwLicensePath(app);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      const key = String(j.key || j.license_key || "").trim().toUpperCase();
      if (!key) return null;
      const licenseType =
        j.licenseType === "trial" || j.license_type === "trial"
          ? "trial"
          : j.licenseType === "annual" || j.license_type === "annual"
            ? "annual"
            : j.licenseType || j.license_type || null;
      return {
        key,
        source: j.source === "cloud" ? "cloud" : "hardware",
        hardware_id: j.hardware_id || "",
        activated_at: j.activated_at || null,
        licenseType,
        expires_at: j.expires_at || j.expiresAt || null,
      };
    } catch {
      const key = String(raw).trim().toUpperCase();
      return key
        ? { key, source: "hardware", hardware_id: "", activated_at: null, licenseType: null, expires_at: null }
        : null;
    }
  } catch {
    return null;
  }
}

function readStoredLicenseKey(app) {
  const rec = readStoredLicenseRecord(app);
  return rec ? rec.key : null;
}

function writeStoredLicenseKey(app, key, opts = {}) {
  const p = hwLicensePath(app);
  if (!p) throw new Error("Nuk u gjet rruga e licencës.");
  const source = opts.source === "cloud" ? "cloud" : "hardware";
  const raw = String(key || "").trim().toUpperCase();
  const hardware_id = formatHardwareId(getHardwareId(app));
  const activated_at = new Date().toISOString();

  let licenseType = opts.licenseType || null;
  let expires_at = opts.expires_at || opts.expiresAt || null;
  let match = opts.match || null;

  if (source === "hardware") {
    match = match || matchLicenseKey(raw, app);
    if (!match.ok) {
      throw new Error("Çelësi nuk është i vlefshëm për këtë pajisje.");
    }
    licenseType = match.licenseType || "annual";
    if (licenseType === "trial") {
      expires_at = addDaysIso(activated_at, TRIAL_DAYS);
    } else if (match.expiresYmd) {
      expires_at = ymdToEndOfDayIso(match.expiresYmd);
    } else if (match.legacy) {
      expires_at = null;
    } else {
      expires_at = addDaysIso(activated_at, ANNUAL_DAYS);
    }
  }

  const record = {
    key: raw,
    source,
    hardware_id,
    activated_at,
  };
  if (source === "hardware") {
    record.licenseType = licenseType || "annual";
    record.expires_at = expires_at;
  }
  fs.writeFileSync(p, JSON.stringify(record), "utf8");
  clearGrace(app);
  if (source === "hardware" && record.licenseType === "trial") {
    markTrialUsed(app, hardware_id);
  }
  logHwLicenseAudit(app, "license_activated", {
    hardware_id: record.hardware_id,
    source,
    licenseType: record.licenseType || null,
    expires_at: record.expires_at || null,
  });
}

function verifyLicenseKey(key, app, hardwareId) {
  return matchLicenseKey(key, app, hardwareId).ok;
}

/** Çelësi hardware përputhet me rekordin e ruajtur (pa kontroll skadimi). */
function verifyStoredHardwareKey(rec, app, hardwareId) {
  if (!rec || !rec.key) return false;
  if (rec.source === "cloud") return true;
  const hwRaw = hardwareId || getHardwareId(app);
  const id = normalizeHardwareId(formatHardwareId(hwRaw));
  const got = normalizeLicenseKey(rec.key);

  if (rec.licenseType === "trial") {
    return keysEqual(got, expectedLicenseKey(id, "trial"));
  }
  if (rec.licenseType === "annual" && rec.expires_at) {
    const ymd = toYmd(rec.expires_at);
    if (ymd) {
      try {
        if (keysEqual(got, expectedLicenseKey(id, "annual", ymd))) return true;
      } catch {
        /* fall through */
      }
    }
  }
  return matchLicenseKey(rec.key, app, hwRaw).ok;
}

/** Hardware key SHA256 OSE çelës cloud i ruajtur më parë (source=cloud). */
function isHardwareUnlocked(app, hardwareId) {
  const rec = readStoredLicenseRecord(app);
  if (!rec || !rec.key) return false;
  if (rec.source === "cloud") return true;
  if (!verifyStoredHardwareKey(rec, app, hardwareId)) return false;
  if (isLicenseExpired(rec)) return false;
  return true;
}

function promptHardwareActivation(app, opts = {}) {
  return new Promise((resolve) => {
    const { BrowserWindow, ipcMain } = require("electron");
    const hwFormatted = formatHardwareId(getHardwareId(app));
    const reason = String(opts.reason || "");
    let subText = "Programi hapet vetëm pasi të aktivizohet për këtë kompjuter.";
    if (reason === "trial_expired") {
      subText = "Prova 7-ditore ka përfunduar. Futni License Key vjetor.";
    } else if (reason === "annual_expired") {
      subText = MSG_LICENSE_EXPIRED;
    } else if (reason === "trial_used") {
      subText = `Trial është përdorur në këtë kompjuter. Futni License Key vjetor. Kontaktoni ${CONTACT_PHONE}.`;
    }
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ipcMain.removeHandler("hw-lic-try");
        ipcMain.removeHandler("hw-lic-close");
        ipcMain.removeHandler("hw-lic-whatsapp");
      } catch {
        /* ignore */
      }
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {
        /* ignore */
      }
      resolve(!!ok);
    };

    const { shell } = require("electron");
    const win = new BrowserWindow({
      width: 560,
      height: 720,
      fullscreen: false,
      frame: true,
      resizable: true,
      minimizable: true,
      maximizable: false,
      closable: true,
      alwaysOnTop: true,
      title: "Aktivizo KAFENE",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    try {
      win.setMenuBarVisibility(false);
    } catch {
      /* ignore */
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;font-family:"Segoe UI",Tahoma,sans-serif;background:linear-gradient(160deg,#0f172a 0%,#1e293b 55%,#0f172a 100%);color:#e2e8f0}
      .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
      .card{position:relative;width:min(520px,100%);background:rgba(15,23,42,.92);border:1px solid #334155;border-radius:16px;padding:32px 28px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
      .btn-close{position:absolute;top:12px;right:12px;width:40px;height:40px;margin:0;padding:0;border:1px solid #475569;border-radius:10px;background:#0f172a;color:#e2e8f0;font-size:1.35rem;line-height:1;cursor:pointer}
      .btn-close:hover{background:#1e293b;border-color:#94a3b8}
      h1{margin:0 40px 8px 0;font-size:1.45rem;font-weight:700;letter-spacing:.02em}
      .sub{margin:0 0 16px;color:#94a3b8;font-size:.95rem;line-height:1.45}
      .label{font-size:.8rem;color:#94a3b8;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em}
      .id{font-family:Consolas,monospace;font-size:1.15rem;letter-spacing:.14em;background:#020617;border:1px solid #475569;border-radius:10px;padding:14px 12px;text-align:center;margin:0 0 10px;user-select:all}
      .row{display:flex;gap:8px;margin:0 0 14px}
      .row button{flex:1;padding:10px;font-size:.9rem;font-weight:600;border:none;border-radius:10px;cursor:pointer}
      .btn-wa{background:#128C7E;color:#fff}
      input{width:100%;box-sizing:border-box;padding:14px 12px;font-size:1.05rem;text-align:center;border:2px solid #475569;border-radius:10px;background:#020617;color:#f8fafc;margin:0 0 12px}
      input.key{letter-spacing:.08em}
      input:focus{outline:none;border-color:#38bdf8}
      button.primary{margin-top:8px;width:100%;padding:14px;font-size:1.05rem;font-weight:600;background:#2563eb;color:#fff;border:none;border-radius:10px;cursor:pointer}
      button.primary:disabled{background:#64748b;cursor:wait}
      button.ghost{margin-top:10px;width:100%;padding:12px;font-size:.95rem;font-weight:600;background:transparent;color:#cbd5e1;border:1px solid #475569;border-radius:10px;cursor:pointer}
      button.ghost:hover{border-color:#94a3b8;color:#fff}
      .err{color:#f87171;min-height:1.3em;margin-top:10px;font-size:.9rem;white-space:pre-wrap}
      .phone{margin-top:14px;padding-top:14px;border-top:1px solid #334155;color:#cbd5e1;font-size:.95rem;line-height:1.45}
      .phone b{color:#25D366}
    </style></head><body><div class="wrap"><div class="card">
      <button type="button" class="btn-close" id="x" title="Mbyll" aria-label="Mbyll">×</button>
      <h1>Aktivizo KAFENE</h1>
      <p class="sub">${subText.replace(/</g, "&lt;")}</p>
      <p class="label">ID i pajisjes — dërgoni foto në WhatsApp</p>
      <div class="id" id="hw">${hwFormatted}</div>
      <div class="row"><button type="button" class="btn-wa" id="wa">Dërgo në WhatsApp</button></div>
      <p class="label">Email (i detyrueshëm)</p>
      <input id="email" type="email" placeholder="p.sh. emri@email.com" autocomplete="email" spellcheck="false">
      <p class="label">Çelësi i licencës</p>
      <input id="k" class="key" type="text" placeholder="Shkruaj ose ngjit çelësin" autocomplete="off" spellcheck="false" inputmode="text" autocapitalize="characters">
      <div class="err" id="e"></div>
      <button type="button" class="primary" id="b">Aktivizo</button>
      <button type="button" class="ghost" id="c">Mbyll</button>
      <p class="phone">WhatsApp / tel: <b>${CONTACT_PHONE}</b><br>Dërgoni foto të ID-së (këto numra) për aktivizim.</p>
    </div></div>
    <script>
      const { ipcRenderer } = require('electron');
      const btn = document.getElementById('b');
      const err = document.getElementById('e');
      const input = document.getElementById('k');
      const emailEl = document.getElementById('email');
      function isEmail(v) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(v||'').trim()); }
      function quitApp() {
        ipcRenderer.invoke('hw-lic-close').catch(() => {});
      }
      document.getElementById('x').onclick = quitApp;
      document.getElementById('c').onclick = quitApp;
      document.getElementById('wa').onclick = () => {
        ipcRenderer.invoke('hw-lic-whatsapp', {
          hardware_id: String(document.getElementById('hw').textContent || '').trim(),
          email: String(emailEl.value || '').trim(),
        }).catch(() => {});
      };
      async function submit() {
        const email = String(emailEl.value || '').trim();
        const v = String(input.value || '').trim();
        if (!isEmail(email)) { err.textContent = 'Shkruani email të vlefshëm për regjistrim.'; emailEl.focus(); return; }
        if (!v) { err.textContent = 'Shkruani çelësin e licencës.'; return; }
        btn.disabled = true;
        btn.textContent = 'Duke verifikuar...';
        err.textContent = '';
        try {
          const r = await ipcRenderer.invoke('hw-lic-try', { key: v, email });
          if (r && r.ok) return;
          err.textContent = (r && r.message) || 'Çelësi nuk është i vlefshëm.';
        } catch (e) {
          err.textContent = e.message || String(e);
        }
        btn.disabled = false;
        btn.textContent = 'Aktivizo';
      }
      btn.onclick = submit;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !btn.disabled) submit();
        if (e.key === 'Escape') quitApp();
      });
      setTimeout(() => { try { emailEl.focus(); } catch (_e) {} }, 80);
    </script></body></html>`;

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    ipcMain.handle("hw-lic-whatsapp", async (_e, payload) => {
      try {
        await shell.openExternal(
          buildWhatsAppActivationUrl(payload?.hardware_id || hwFormatted, payload?.email),
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err.message || String(err) };
      }
    });

    ipcMain.handle("hw-lic-try", async (_e, payload) => {
      try {
        const raw =
          typeof payload === "string"
            ? String(payload || "").trim()
            : String(payload?.key || "").trim();
        const email =
          typeof payload === "object" ? String(payload?.email || "").trim().toLowerCase() : "";
        if (!raw) return { ok: false, message: "Shkruani çelësin e licencës." };
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return { ok: false, message: "Shkruani email të vlefshëm për regjistrim." };
        }

        const hwFormattedNow = formatHardwareId(getHardwareId(app));

        // 1) Çelës hardware (trial / annual / legacy)
        const match = matchLicenseKey(raw, app);
        if (match.ok) {
          if (match.licenseType === "trial" && hasTrialBeenUsed(app)) {
            return {
              ok: false,
              message: `Trial është përdorur në këtë kompjuter. Duhet License Key vjetor. Kontaktoni ${CONTACT_PHONE}.`,
            };
          }
          if (match.licenseType === "annual" && match.expiresYmd) {
            const endIso = ymdToEndOfDayIso(match.expiresYmd);
            if (endIso && Date.now() > Date.parse(endIso)) {
              return { ok: false, message: MSG_LICENSE_EXPIRED };
            }
          }
          writeStoredLicenseKey(app, raw, { source: "hardware", match, email });
          finish(true);
          return { ok: true };
        }

        // 2) Çelës cloud — validim online
        try {
          const license = require(path.join(__dirname, "..", "license"));
          await license.activateWithKey(app, raw, { contact_email: email });
          writeStoredLicenseKey(app, raw, { source: "cloud", email });
          finish(true);
          return { ok: true };
        } catch (cloudErr) {
          try {
            const sec = require(path.join(__dirname, "..", "security-alert"));
            sec.reportLicenseActivationFailed(app, {
              hardwareId: hwFormattedNow,
              rawKey: raw,
              reason: (cloudErr && cloudErr.message) || "activate_failed",
            }).catch(() => {});
          } catch {
            /* ignore notify errors */
          }
          return {
            ok: false,
            message:
              (cloudErr && cloudErr.message) ||
              "Çelësi nuk u pranua. Kontrolloni çelësin / internetin.",
          };
        }
      } catch (err) {
        return { ok: false, message: err.message || String(err) };
      }
    });

    // Mbyll → app.quit() (në main.js), pa anashkaluar licencën
    ipcMain.handle("hw-lic-close", async () => {
      finish(false);
      return { ok: true };
    });

    win.on("close", () => {
      // Lejo mbylljen (X / Alt+F4) — finish(false) në "closed"
    });

    win.on("closed", () => {
      if (!settled) finish(false);
    });
  });
}

/**
 * Kur licenca prishet: 48h grace (programi punon) pastaj bllokim + aktivizim.
 * @returns {Promise<{ ok: boolean, grace: object|null }>}
 */
async function allowWithGraceOrBlock(app, reason, formatted) {
  const { dialog } = require("electron");
  const { status, startedNow } = beginGraceIfNeeded(app, reason, formatted);

  if (status.active) {
    logHwLicenseAudit(app, "grace_continue", {
      reason,
      hoursLeft: status.hoursLeft,
      hardware_id: formatted,
    });
    // Popup vetëm herën e parë që niset grace — jo çdo hapje (nuk e shqetëson kamarierin)
    if (startedNow) {
      try {
        dialog.showMessageBoxSync({
          type: "warning",
          title: "Licenca ka problem",
          message: "Licenca ka problem. Kontaktoni " + CONTACT_PHONE + ".",
          detail:
            "Programi vazhdon me punu për 48 orë.\n\n" +
            `Mbeten rreth ${status.hoursLeft} orë.\n` +
            `ID i pajisjes: ${formatted}\n\n` +
            "Dërgoni foto të ID-së në WhatsApp (" +
            CONTACT_PHONE +
            ") për kod të ri. Njoftimi shfaqet te Admin / Hyrja.",
          buttons: ["OK"],
        });
      } catch {
        /* ignore */
      }
    }
    return { ok: true, grace: status };
  }

  // Grace skaduar — kërko kod të ri
  logHwLicenseAudit(app, "grace_expired_block", {
    reason,
    hardware_id: formatted,
  });
  try {
    dialog.showMessageBoxSync({
      type: "error",
      title: "Licenca",
      message: "Periudha 48 orë përfundoi.",
      detail:
        "Programi është bllokuar derisa të futni kodin e ri.\n\n" +
        `ID i pajisjes: ${formatted}\n` +
        `Kontaktoni: ${CONTACT_PHONE}`,
      buttons: ["Aktivizo tani"],
    });
  } catch {
    /* ignore */
  }
  const activated = await promptHardwareActivation(app);
  return { ok: !!activated, grace: null };
}

/**
 * Kontrollo / aktivizo hardware lock. Thirret PARA license.ensureActivated.
 * @returns {Promise<{ ok: boolean, grace: object|null }>}
 */
async function ensureHardwareLicense(app) {
  let hwId;
  let formatted;
  try {
    hwId = getHardwareId(app);
    formatted = formatHardwareId(hwId);
  } catch (e) {
    logHwLicenseAudit(app, "hardware_id_error", { error: e.message || String(e) });
    return allowWithGraceOrBlock(app, "hardware_id_error", "????-????-????-????");
  }

  let stored;
  try {
    stored = readStoredLicenseKey(app);
  } catch (e) {
    logHwLicenseAudit(app, "license_read_error", {
      error: e.message || String(e),
      hardware_id: formatted,
    });
    return allowWithGraceOrBlock(app, "license_read_error", formatted);
  }

  if (stored) {
    const rec = readStoredLicenseRecord(app);
    try {
      const keyOk = rec && verifyStoredHardwareKey(rec, app, hwId);
      if (keyOk && rec.source !== "cloud" && isLicenseExpired(rec)) {
        if (rec.licenseType === "trial") markTrialUsed(app, formatted);
        const reason = rec.licenseType === "trial" ? "trial_expired" : "annual_expired";
        logHwLicenseAudit(app, "license_expired", {
          hardware_id: formatted,
          licenseType: rec.licenseType || null,
          expires_at: rec.expires_at || null,
        });
        const activated = await promptHardwareActivation(app, { reason });
        return { ok: !!activated, grace: null };
      }
      if (keyOk && isHardwareUnlocked(app, hwId)) {
        clearGrace(app);
        return { ok: true, grace: null };
      }
    } catch (e) {
      logHwLicenseAudit(app, "license_verify_error", {
        error: e.message || String(e),
        hardware_id: formatted,
      });
      return allowWithGraceOrBlock(app, "license_verify_error", formatted);
    }
    logHwLicenseAudit(app, "license_mismatch", { hardware_id: formatted });
    return allowWithGraceOrBlock(app, "license_mismatch", formatted);
  }

  // Pa licencë të ruajtur — nëse ka grace aktive (p.sh. pas update), lejo
  const grace = getGraceStatus(app);
  if (grace.active) {
    logHwLicenseAudit(app, "grace_no_stored_key", {
      hoursLeft: grace.hoursLeft,
      hardware_id: formatted,
    });
    return { ok: true, grace };
  }
  if (grace.expired) {
    return allowWithGraceOrBlock(app, "grace_expired_no_key", formatted);
  }

  // Instalim i parë — kërko aktivizim (pa grace automatike për kopjim)
  const activated = await promptHardwareActivation(app);
  return { ok: !!activated, grace: null };
}

module.exports = {
  getHardwareId,
  ensureInstallSalt,
  formatHardwareId,
  formatLicenseKey,
  normalizeHardwareId,
  normalizeLicenseKey,
  expectedLicenseKey,
  matchLicenseKey,
  verifyLicenseKey,
  isHardwareUnlocked,
  isLicenseExpired,
  writeStoredLicenseKey,
  readStoredLicenseRecord,
  ensureHardwareLicense,
  getGraceStatus,
  getGraceBannerInfo,
  logHwLicenseAudit,
  annualExpiresYmdFromToday,
  CONTACT_PHONE,
  MSG_LICENSE_EXPIRED,
  TRIAL_DAYS,
  ANNUAL_DAYS,
  GRACE_MS,
};
