/**
 * License validation for Revolution Fiskalizim — Supabase oqquiuisreztzcyehpiq.
 * Schema: clients, licenses, terminalet_e_licences
 */
const { getSupabase } = require("./db");
const {
  compactHardwareId,
  formatHardwareId,
  normalizeHardwareId,
  hardwareIdsEqual,
} = require("./hardwareId");

const APP_TYPE = "fiskalizim";
const BRAND = "Revolution Fiskalizim";

function normalizeKey(key) {
  const raw = String(key || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(raw)) return raw;
  const alnum = raw.replace(/[^A-Z0-9]/g, "");
  if (alnum.length === 16) return alnum.match(/.{1,4}/g).join("-");
  return raw;
}

function compactKey(key) {
  return normalizeKey(key).replace(/-/g, "");
}

function normalizeDeviceId(deviceId) {
  return String(deviceId || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function clientIp(req) {
  const forwarded = req.get?.("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 64);
  return String(req.socket?.remoteAddress || req.ip || "").slice(0, 64);
}

async function findLicenseByKey(celesi) {
  const db = getSupabase();
  const normalized = normalizeKey(celesi);
  if (!normalized) return null;

  const select = "*, clients(id, emri, email, telefon, adresa)";

  const { data, error } = await db
    .from("licenses")
    .select(select)
    .eq("license_key", normalized)
    .eq("app_type", APP_TYPE)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const compact = compactKey(normalized);
  if (compact.length < 8) return null;

  const { data: rows, error: allErr } = await db
    .from("licenses")
    .select(select)
    .eq("app_type", APP_TYPE);
  if (allErr) throw allErr;
  return (rows || []).find((row) => compactKey(row.license_key) === compact) || null;
}

async function listTerminals(licenseId) {
  const db = getSupabase();
  const { data, error } = await db
    .from("terminalet_e_licences")
    .select("id, device_id, last_seen, created_at")
    .eq("license_id", licenseId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function touchOrInsertTerminal(licenseId, deviceId) {
  const db = getSupabase();
  const now = new Date().toISOString();
  const id = normalizeDeviceId(deviceId);
  const { data: existing } = await db
    .from("terminalet_e_licences")
    .select("id")
    .eq("license_id", licenseId)
    .eq("device_id", id)
    .maybeSingle();

  if (existing?.id) {
    await db.from("terminalet_e_licences").update({ last_seen: now }).eq("id", existing.id);
    return { created: false };
  }

  const { error } = await db.from("terminalet_e_licences").insert({
    license_id: licenseId,
    device_id: id,
    last_seen: now,
  });
  if (error) throw error;
  return { created: true };
}

async function resolveTerminalAccess(license, deviceId) {
  const id = normalizeDeviceId(deviceId);
  const maxTerminals = Math.max(1, Number(license.max_terminals) || 1);
  if (!id) {
    return {
      allowed: false,
      code: "DEVICE_REQUIRED",
      message: "Mungon ID e pajisjes. Riaktivizoni licencën.",
      force_logout: true,
    };
  }

  const terminals = await listTerminals(license.id);
  const known = terminals.find((t) => normalizeDeviceId(t.device_id) === id);
  if (known) {
    await touchOrInsertTerminal(license.id, id);
    return {
      allowed: true,
      active_count: terminals.length,
      max_terminals: maxTerminals,
    };
  }

  if (terminals.length >= maxTerminals) {
    return {
      allowed: false,
      code: "TERMINAL_LIMIT_EXCEEDED",
      message: `Keni arritur limitin e terminaleve. Kontaktoni ${BRAND}.`,
      force_logout: true,
      active_count: terminals.length,
      max_terminals: maxTerminals,
    };
  }

  await touchOrInsertTerminal(license.id, id);
  return {
    allowed: true,
    active_count: terminals.length + 1,
    max_terminals: maxTerminals,
  };
}

function isExpired(license) {
  if (!license.expires_at) return false;
  const t = new Date(license.expires_at).getTime();
  return Number.isFinite(t) && t < Date.now();
}

/**
 * Shared validate / heartbeat / activate logic.
 */
async function validateLicense({
  celesi,
  license_key,
  device_id,
  hardware_id,
  app_type,
  bindHardware = false,
  relaxTerminals = false,
}) {
  const key = celesi || license_key;
  const license = await findLicenseByKey(key);
  if (!license) {
    return {
      valid: false,
      code: "NOT_FOUND",
      message: "Licenca nuk u gjet. Kontrolloni çelësin.",
      force_logout: true,
      force_factory_reset: true,
    };
  }

  const fail = (code, message) => ({
    valid: false,
    code,
    message,
    force_logout: [
      "REVOKED",
      "NOT_FOUND",
      "SUSPENDED",
      "EXPIRED",
      "DEVICE_MISMATCH",
      "TERMINAL_LIMIT_EXCEEDED",
      "APP_TYPE_MISMATCH",
    ].includes(code),
    force_factory_reset: [
      "REVOKED",
      "NOT_FOUND",
      "SUSPENDED",
      "EXPIRED",
      "DEVICE_MISMATCH",
      "TERMINAL_LIMIT_EXCEEDED",
      "APP_TYPE_MISMATCH",
    ].includes(code),
  });

  if (license.status === "revoked") {
    return fail("REVOKED", `Licenca është çaktivizuar. Kontaktoni ${BRAND}.`);
  }
  if (license.status === "suspended") {
    return fail("SUSPENDED", "Licenca është pezulluar.");
  }
  if (license.status === "expired" || isExpired(license)) {
    if (license.status !== "expired" && isExpired(license)) {
      try {
        await getSupabase().from("licenses").update({ status: "expired" }).eq("id", license.id);
      } catch {
        /* best effort */
      }
    }
    return fail("EXPIRED", "Licenca ka skaduar.");
  }
  if (license.status !== "active") {
    return fail("INVALID", `Status i panjohur i licencës: ${license.status}`);
  }

  const incomingType = String(app_type || APP_TYPE).toLowerCase();
  const storedType = String(license.app_type || APP_TYPE).toLowerCase();
  if (incomingType !== storedType) {
    return fail("APP_TYPE_MISMATCH", "Licenca nuk është për këtë produkt.");
  }

  const hwIncoming = normalizeHardwareId(hardware_id);
  const hwStored = normalizeHardwareId(license.hardware_id);
  if (
    compactHardwareId(hwStored).length >= 16
    && compactHardwareId(hwIncoming).length >= 16
    && !hardwareIdsEqual(hwStored, hwIncoming)
  ) {
    return fail("DEVICE_MISMATCH", "Hardware ID nuk përputhet me licencën.");
  }

  let terminalAccess;
  const hwLocked =
    hardwareIdsEqual(hwStored, hwIncoming)
    || (bindHardware && compactHardwareId(hwIncoming).length >= 16);
  if (relaxTerminals && hwLocked) {
    const maxTerminals = Math.max(1, Number(license.max_terminals) || 1);
    if (device_id && maxTerminals <= 1) {
      try {
        await getSupabase().from("terminalet_e_licences").delete().eq("license_id", license.id);
      } catch {
        /* best effort */
      }
    }
    if (device_id) {
      await touchOrInsertTerminal(license.id, device_id);
    }
    const terminals = await listTerminals(license.id);
    terminalAccess = {
      allowed: true,
      active_count: terminals.length,
      max_terminals: maxTerminals,
    };
  } else {
    terminalAccess = await resolveTerminalAccess(license, device_id);
    if (!terminalAccess.allowed) {
      return fail(
        terminalAccess.code || "TERMINAL_LIMIT_EXCEEDED",
        terminalAccess.message || "Limiti i terminaleve u tejkalua.",
      );
    }
  }

  const db = getSupabase();
  const patch = {};
  if (bindHardware && hwIncoming && !hwStored) {
    patch.hardware_id = hwIncoming;
  } else if (hwIncoming && !hwStored) {
    patch.hardware_id = hwIncoming;
  }
  if (Object.keys(patch).length) {
    await db.from("licenses").update(patch).eq("id", license.id);
  }

  const expiresAt = license.expires_at || null;
  const clientName = license.clients?.emri || "";

  return {
    valid: true,
    code: "OK",
    message: "Licenca është aktive.",
    license_id: license.id,
    celesi: license.license_key,
    client_id: license.client_id,
    client_name: clientName,
    clients: license.clients || null,
    app_type: license.app_type || APP_TYPE,
    status: license.status,
    device_id: normalizeDeviceId(device_id),
    hardware_id: hwIncoming || hwStored || null,
    data_skadimit: expiresAt,
    expires_at: expiresAt,
    valid_until: expiresAt,
    terminals_active: terminalAccess.active_count || 0,
    terminals_max: terminalAccess.max_terminals || license.max_terminals || 1,
    force_logout: false,
  };
}

async function findLicenseByHardwareId(hardwareId) {
  const want = compactHardwareId(hardwareId);
  if (want.length < 16) return null;
  const db = getSupabase();
  const select = "*, clients(id, emri, email, telefon, adresa)";
  const { data: rows, error } = await db
    .from("licenses")
    .select(select)
    .eq("app_type", APP_TYPE)
    .not("hardware_id", "is", null);
  if (error) throw error;
  const matches = (rows || []).filter((row) => hardwareIdsEqual(row.hardware_id, want));
  if (!matches.length) return null;
  return matches.find((row) => row.status === "active") || matches[0];
}

async function claimLicenseByHardware({ hardware_id, device_id, app_type }) {
  const license = await findLicenseByHardwareId(hardware_id);
  if (!license) {
    return {
      valid: false,
      code: "NOT_FOUND",
      message: "Nuk ka licencë të regjistruar për këtë Hardware ID.",
      force_logout: true,
      force_factory_reset: true,
    };
  }
  if (license.status === "revoked" || license.status === "suspended" || license.status === "expired") {
    return {
      valid: false,
      code: license.status === "revoked" ? "REVOKED" : license.status.toUpperCase(),
      message: "Licenca për këtë Hardware ID nuk është aktive.",
      force_logout: license.status === "revoked",
      force_factory_reset: true,
    };
  }
  if (!normalizeDeviceId(device_id)) {
    return {
      valid: true,
      code: "OK",
      message: "Licenca u gjet nga Hardware ID.",
      license_id: license.id,
      celesi: license.license_key,
      license_key: license.license_key,
      client_id: license.client_id,
      client_name: license.clients?.emri || "",
      clients: license.clients || null,
      app_type: license.app_type || APP_TYPE,
      status: license.status,
      hardware_id: formatHardwareId(hardware_id) || formatHardwareId(license.hardware_id),
      force_logout: false,
    };
  }
  return validateLicense({
    celesi: license.license_key,
    license_key: license.license_key,
    device_id,
    hardware_id,
    app_type: app_type || APP_TYPE,
    bindHardware: true,
    relaxTerminals: true,
  });
}

async function findLicenseByDeviceId(deviceId) {
  const id = normalizeDeviceId(deviceId);
  if (!id) return null;
  const db = getSupabase();
  const { data: term } = await db
    .from("terminalet_e_licences")
    .select("license_id")
    .eq("device_id", id)
    .order("last_seen", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!term?.license_id) return null;
  const { data: lic } = await db
    .from("licenses")
    .select("*, clients(id, emri, email, telefon, adresa)")
    .eq("id", term.license_id)
    .eq("app_type", APP_TYPE)
    .maybeSingle();
  return lic || null;
}

module.exports = {
  APP_TYPE,
  normalizeKey,
  normalizeDeviceId,
  normalizeHardwareId,
  compactHardwareId,
  formatHardwareId,
  hardwareIdsEqual,
  clientIp,
  validateLicense,
  findLicenseByDeviceId,
  findLicenseByHardwareId,
  claimLicenseByHardware,
  findLicenseByKey,
};
