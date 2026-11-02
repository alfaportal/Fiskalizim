/**
 * Super Admin — klientë + licenca (Fiskalizim Supabase, service_role).
 */
const bcrypt = require("bcryptjs");
const { getSupabase } = require("./db");
const { genLicenseKey } = require("./licenseKey");
const {
  APP_TYPE,
  normalizeKey,
  findLicenseByKey,
  findLicenseByHardwareId,
} = require("./licenseService");
const { compactHardwareId, formatHardwareId, hardwareIdsEqual } = require("./hardwareId");
const { deleteLicenseRow } = require("./licenseDeletePurge");

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
      await deleteLicenseRow(db, extra.id);
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

async function updateClient(id, patch = {}) {
  const db = getSupabase();
  const cid = String(id || "").trim();
  if (!cid) throw new Error("Mungon ID e klientit.");
  const row = {};
  if (patch.emri != null) row.emri = String(patch.emri || "").trim();
  if (patch.email != null) row.email = String(patch.email || "").trim().toLowerCase() || null;
  if (patch.telefon != null || patch.telefoni != null) {
    row.telefon = String(patch.telefon || patch.telefoni || "").trim() || null;
  }
  if (patch.adresa != null) row.adresa = String(patch.adresa || "").trim() || null;
  if (!Object.keys(row).length) throw new Error("Nuk ka fusha për përditësim klienti.");
  if (!row.emri) throw new Error("Emri i biznesit është i detyrueshëm.");
  const { data, error } = await db.from("clients").update(row).eq("id", cid).select("*").single();
  if (error) throw error;
  return data;
}

function mapAdminLicenseStatus(statusi) {
  const s = String(statusi || "").toLowerCase();
  if (["aktive", "active", "aktiv"].includes(s)) return "active";
  if (["revokuar", "revoked"].includes(s)) return "revoked";
  if (["pezulluar", "suspended"].includes(s)) return "suspended";
  if (["skaduar", "expired"].includes(s)) return "expired";
  return s || "active";
}

async function updateLicense(id, patch = {}) {
  const db = getSupabase();
  const row = {};
  if (patch.status != null || patch.statusi != null) row.status = mapAdminLicenseStatus(patch.statusi || patch.status);
  if (patch.license_key != null || patch.celesi != null) {
    const key = normalizeKey(patch.license_key || patch.celesi);
    if (!key) throw new Error("Çelësi i licencës është i pavlefshëm.");
    const dup = await findLicenseByKey(key);
    if (dup && dup.id !== id) throw new Error("Ky kod licencë përdoret tashmë.");
    row.license_key = key;
  }
  if (patch.hardware_id != null) {
    const hw = formatHardwareId(patch.hardware_id);
    row.hardware_id = compactHardwareId(hw).length >= 16 ? hw : null;
  }
  if (patch.expires_at != null || patch.data_skadimit != null) {
    const raw = patch.expires_at || patch.data_skadimit;
    row.expires_at = raw ? String(raw).slice(0, 10) : null;
  }
  if (!Object.keys(row).length) throw new Error("Nuk ka fusha për përditësim.");
  let { data, error } = await db
    .from("licenses")
    .update(row)
    .eq("id", id)
    .eq("app_type", APP_TYPE)
    .select("*, clients(id, emri, email, telefon, adresa)")
    .single();
  if (error && /hardware_id/i.test(error.message || "")) {
    delete row.hardware_id;
    ({ data, error } = await db
      .from("licenses")
      .update(row)
      .eq("id", id)
      .eq("app_type", APP_TYPE)
      .select("*, clients(id, emri, email, telefon, adresa)")
      .single());
  }
  if (error) throw error;
  return data;
}

async function rotateLicenseKey(id) {
  const db = getSupabase();
  const { data: existing, error: findErr } = await db
    .from("licenses")
    .select("id, license_key")
    .eq("id", id)
    .eq("app_type", APP_TYPE)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!existing) throw new Error("Licenca nuk u gjet.");
  const key = await genUniqueLicenseKey(db);
  return updateLicense(id, { license_key: key });
}

async function extendLicense(id, months = 12) {
  const db = getSupabase();
  const { data: lic, error } = await db
    .from("licenses")
    .select("id, expires_at, status")
    .eq("id", id)
    .eq("app_type", APP_TYPE)
    .maybeSingle();
  if (error || !lic) throw new Error("Licenca nuk u gjet.");
  const base =
    lic.expires_at && String(lic.expires_at).slice(0, 10) > new Date().toISOString().slice(0, 10)
      ? String(lic.expires_at).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const d = new Date(base);
  d.setMonth(d.getMonth() + Math.max(1, Math.min(36, Number(months) || 12)));
  const expires_at = d.toISOString().slice(0, 10);
  return updateLicense(id, { expires_at, statusi: "active" });
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
  await deleteLicenseRow(db, id);
  return { ok: true, id, license_key: existing.license_key, client_id: existing.client_id || null };
}

async function deleteClient(id) {
  const db = getSupabase();
  const cid = String(id || "").trim();
  if (!cid) throw new Error("Mungon ID e klientit.");

  const { data: existing, error: findErr } = await db
    .from("clients")
    .select("id, emri")
    .eq("id", cid)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!existing) throw new Error("Klienti nuk u gjet.");

  const { data: licenses, error: licListErr } = await db
    .from("licenses")
    .select("id")
    .eq("client_id", cid)
    .eq("app_type", APP_TYPE);
  if (licListErr) throw licListErr;

  for (const lic of licenses || []) {
    await deleteLicense(lic.id);
  }

  const { error } = await db.from("clients").delete().eq("id", cid);
  if (error) throw error;
  return { ok: true, id: cid, emri: existing.emri };
}

function isMissingUsersTable(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "");
  return (
    code === "42P01"
    || code === "PGRST205"
    || /could not find the table|relation .*users.* does not exist|schema cache/i.test(msg)
  );
}

function usersMissingError() {
  return new Error("Tabela users mungon. Ekzekutoni supabase/users.sql në Supabase Fiskalizim.");
}

function sanitizeOwner(row) {
  if (!row) return row;
  const { passwordi, ...safe } = row;
  return safe;
}

async function setOwnerPasswordForClient(clientId, password, { email, emri } = {}) {
  const pw = String(password || "").trim();
  if (pw.length < 6) throw new Error("Fjalëkalimi min. 6 karaktere.");
  const db = getSupabase();
  const cid = String(clientId || "").trim();
  if (!cid) throw new Error("Mungon ID e klientit.");

  const { data: client, error: cErr } = await db
    .from("clients")
    .select("id, emri, email")
    .eq("id", cid)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!client) throw new Error("Klienti nuk u gjet.");

  const mail = (email != null ? String(email).trim().toLowerCase() : "")
    || String(client.email || "").trim().toLowerCase();
  if (!mail) throw new Error("Vendos email të klientit para se të vendosësh fjalëkalimin.");
  const name = String(emri || client.emri || "Pronar").trim();
  const hash = await bcrypt.hash(pw, 12);
  const now = new Date().toISOString();

  const { error: emailErr } = await db.from("clients").update({ email: mail }).eq("id", cid);
  if (emailErr) throw emailErr;

  const { data: owners, error: uErr } = await db
    .from("users")
    .select("id, emri, email, roli, client_id")
    .eq("client_id", cid)
    .eq("roli", "client_admin");
  if (uErr) {
    if (isMissingUsersTable(uErr)) throw usersMissingError();
    throw uErr;
  }

  if (owners && owners.length) {
    const updated = [];
    for (const o of owners) {
      const patch = { passwordi: hash, password_set_at: now, email: mail, emri: name };
      let { data, error } = await db
        .from("users")
        .update(patch)
        .eq("id", o.id)
        .eq("roli", "client_admin")
        .select("id, emri, email, roli, client_id")
        .single();
      if (error && /password_set_at|aktiv/i.test(error.message || "")) {
        delete patch.password_set_at;
        ({ data, error } = await db
          .from("users")
          .update(patch)
          .eq("id", o.id)
          .eq("roli", "client_admin")
          .select("id, emri, email, roli, client_id")
          .single());
      }
      if (error) throw error;
      updated.push(sanitizeOwner(data));
    }
    return { owners: updated, created: false, product_line: "fiskale" };
  }

  const row = {
    client_id: cid,
    emri: name,
    email: mail,
    roli: "client_admin",
    aktiv: true,
    passwordi: hash,
    password_set_at: now,
  };
  let { data: created, error: insErr } = await db
    .from("users")
    .insert(row)
    .select("id, emri, email, roli, client_id")
    .single();
  if (insErr && /aktiv|password_set_at/i.test(insErr.message || "")) {
    delete row.aktiv;
    delete row.password_set_at;
    ({ data: created, error: insErr } = await db
      .from("users")
      .insert(row)
      .select("id, emri, email, roli, client_id")
      .single());
  }
  if (insErr) {
    if (isMissingUsersTable(insErr)) throw usersMissingError();
    throw insErr;
  }
  return { owners: [sanitizeOwner(created)], created: true, product_line: "fiskale" };
}

async function setOwnerEmailForClient(clientId, email, { emri } = {}) {
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) throw new Error("Email është i detyrueshëm.");
  const db = getSupabase();
  const cid = String(clientId || "").trim();
  if (!cid) throw new Error("Mungon ID e klientit.");

  const { data: client, error: cErr } = await db
    .from("clients")
    .select("id, emri, email")
    .eq("id", cid)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!client) throw new Error("Klienti nuk u gjet.");

  const { error: emailErr } = await db.from("clients").update({ email: mail }).eq("id", cid);
  if (emailErr) throw emailErr;

  const { data: owners, error: uErr } = await db
    .from("users")
    .select("id, emri, email, roli, client_id")
    .eq("client_id", cid)
    .eq("roli", "client_admin");
  if (uErr) {
    if (isMissingUsersTable(uErr)) throw usersMissingError();
    throw uErr;
  }
  if (!owners || !owners.length) {
    throw new Error("Nuk ka llogari pronari për këtë klient. Vendos email + fjalëkalim së pari.");
  }

  const name = emri != null ? String(emri).trim() : "";
  const updated = [];
  for (const o of owners) {
    const patch = { email: mail };
    if (name) patch.emri = name;
    const { data, error } = await db
      .from("users")
      .update(patch)
      .eq("id", o.id)
      .eq("roli", "client_admin")
      .select("id, emri, email, roli, client_id")
      .single();
    if (error) throw error;
    updated.push(sanitizeOwner(data));
  }
  return { owners: updated, client_email: mail, product_line: "fiskale" };
}

module.exports = {
  genLicenseKey,
  genUniqueLicenseKey,
  createClient,
  listLicenses,
  dedupeLicensesByHardware,
  issueLicense,
  registerClientWithLicense,
  updateClient,
  updateLicense,
  rotateLicenseKey,
  extendLicense,
  setLicenseStatus,
  deleteLicense,
  deleteClient,
  setOwnerPasswordForClient,
  setOwnerEmailForClient,
};
