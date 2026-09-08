/**
 * Super Admin — klientë + licenca (Fiskalizim Supabase, service_role).
 */
const { getSupabase } = require("./db");
const { genLicenseKey } = require("./licenseKey");
const {
  APP_TYPE,
  normalizeKey,
  findLicenseByKey,
  findLicenseByHardwareId,
} = require("./licenseService");
const { compactHardwareId, formatHardwareId, hardwareIdsEqual } = require("./hardwareId");

async function genUniqueLicenseKey(db) {
  for (let i = 0; i < 8; i += 1) {
    const key = genLicenseKey();
    const { data } = await db.from("licenses").select("id").eq("license_key", key).maybeSingle();
    if (!data) return key;
  }
  return genLicenseKey();
}

async function createClient({ emri, email, telefon, adresa }) {
  const db = getSupabase();
  const row = {
    emri: String(emri || "").trim(),
    email: String(email || "").trim().toLowerCase() || null,
    telefon: String(telefon || "").trim() || null,
    adresa: String(adresa || "").trim() || null,
  };
  if (!row.emri) throw new Error("Emri i biznesit është i detyrueshëm.");
  const { data, error } = await db.from("clients").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

async function listLicenses() {
  const db = getSupabase();
  const { data, error } = await db
    .from("licenses")
    .select("*, clients(id, emri, email, telefon, adresa)")
    .eq("app_type", APP_TYPE)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

function alreadyExistsPayload(license) {
  return {
    ...license,
    already_exists: true,
    message: "Tashmë ekziston",
  };
}

async function dedupeLicensesByHardware() {
  const db = getSupabase();
  const { data: rows, error } = await db
    .from("licenses")
    .select("id, hardware_id, status, created_at, license_key")
    .eq("app_type", APP_TYPE);
  if (error) throw error;
  const groups = new Map();
  for (const row of rows || []) {
    const hw = compactHardwareId(row.hardware_id);
    if (hw.length < 16) continue;
    if (!groups.has(hw)) groups.set(hw, []);
    groups.get(hw).push(row);
  }
  let removed = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => {
      const aAct = a.status === "active" ? 0 : 1;
      const bAct = b.status === "active" ? 0 : 1;
      if (aAct !== bAct) return aAct - bAct;
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
    for (const extra of list.slice(1)) {
      await db.from("terminalet_e_licences").delete().eq("license_id", extra.id);
      const { error: delErr } = await db.from("licenses").delete().eq("id", extra.id);
      if (delErr) throw delErr;
      removed += 1;
    }
  }
  return { ok: true, removed };
}

async function issueLicense({
  client_id,
  license_key,
  hardware_id,
  app_type = APP_TYPE,
  max_terminals = 1,
  expires_at = null,
  status = "active",
}) {
  const db = getSupabase();
  const hw = formatHardwareId(hardware_id);
  const hwOk = compactHardwareId(hw).length >= 16;

  if (hwOk) {
    try {
      await dedupeLicensesByHardware();
    } catch (e) {
      console.warn("[adminService] dedupe:", e.message || e);
    }
    const existingHw = await findLicenseByHardwareId(hw);
    if (existingHw) return alreadyExistsPayload(existingHw);
  }

  let key = normalizeKey(license_key);
  if (key) {
    const existingKey = await findLicenseByKey(key);
    if (existingKey) {
      if (hwOk && hardwareIdsEqual(existingKey.hardware_id, hw)) {
        return alreadyExistsPayload(existingKey);
      }
      key = await genUniqueLicenseKey(db);
    }
  } else {
    key = await genUniqueLicenseKey(db);
  }

  const row = {
    client_id: client_id || null,
    license_key: key,
    app_type: app_type || APP_TYPE,
    max_terminals: Math.max(1, Number(max_terminals) || 1),
    expires_at: expires_at || null,
    status: status || "active",
  };
  if (hwOk) row.hardware_id = hw;

  let { data, error } = await db
    .from("licenses")
    .insert(row)
    .select("*, clients(id, emri, email, telefon, adresa)")
    .single();
  if (error && /hardware_id/i.test(error.message || "")) {
    delete row.hardware_id;
    ({ data, error } = await db
      .from("licenses")
      .insert(row)
      .select("*, clients(id, emri, email, telefon, adresa)")
      .single());
  }
  if (error && /duplicate|unique/i.test(error.message || "")) {
    const again = hwOk ? await findLicenseByHardwareId(hw) : await findLicenseByKey(key);
    if (again) return alreadyExistsPayload(again);
  }
  if (error) throw error;
  return data;
}

async function registerClientWithLicense({
  emri,
  email,
  telefon,
  adresa,
  hardware_id,
  license_key,
}) {
  const hw = formatHardwareId(hardware_id);
  if (compactHardwareId(hw).length >= 16) {
    try {
      await dedupeLicensesByHardware();
    } catch (e) {
      console.warn("[adminService] dedupe:", e.message || e);
    }
    const existing = await findLicenseByHardwareId(hw);
    if (existing) {
      return {
        already_exists: true,
        message: "Tashmë ekziston",
        license: existing,
        license_key: existing.license_key,
        client: existing.clients || null,
      };
    }
  }
  const client = await createClient({ emri, email, telefon, adresa });
  const license = await issueLicense({
    client_id: client.id,
    hardware_id: hw,
    license_key,
    app_type: APP_TYPE,
  });
  return {
    ok: true,
    client,
    license,
    license_key: license.license_key,
    already_exists: !!license.already_exists,
    message: license.already_exists ? "Tashmë ekziston" : undefined,
  };
}

async function setLicenseStatus(id, status) {
  const db = getSupabase();
  const allowed = ["active", "revoked", "suspended", "expired"];
  if (!allowed.includes(status)) throw new Error("Status i pavlefshëm.");
  const { data, error } = await db
    .from("licenses")
    .update({ status })
    .eq("id", id)
    .eq("app_type", APP_TYPE)
    .select("*, clients(id, emri, email, telefon, adresa)")
    .single();
  if (error) throw error;
  return data;
}

async function deleteLicense(id) {
  const db = getSupabase();
  const { data: existing, error: findErr } = await db
    .from("licenses")
    .select("id, license_key, client_id")
    .eq("id", id)
    .eq("app_type", APP_TYPE)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!existing) throw new Error("Licenca nuk u gjet.");

  await db.from("licenses").update({ status: "revoked" }).eq("id", id);
  const { error: termErr } = await db.from("terminalet_e_licences").delete().eq("license_id", id);
  if (termErr) throw termErr;

  const { error } = await db.from("licenses").delete().eq("id", id);
  if (error) throw error;
  return { ok: true, id, license_key: existing.license_key, client_id: existing.client_id || null };
}

module.exports = {
  genLicenseKey,
  genUniqueLicenseKey,
  createClient,
  listLicenses,
  dedupeLicensesByHardware,
  issueLicense,
  registerClientWithLicense,
  setLicenseStatus,
  deleteLicense,
};
