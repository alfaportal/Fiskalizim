"use strict";

/** Arkë / terminal — emra në Supabase (Fiskale + POS nëse ekziston). */
const LICENSE_TERMINAL_TABLES = ["terminalet_e_licences", "license_terminals"];

function isMissingRelation(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || error?.details || "");
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /does not exist|schema cache|Could not find the table/i.test(msg)
  );
}

async function purgeLicenseTerminalRows(db, licenseIds) {
  const ids = (licenseIds || []).filter(Boolean);
  if (!ids.length) return;

  for (const table of LICENSE_TERMINAL_TABLES) {
    const { error: bulkErr } = await db.from(table).delete().in("license_id", ids);
    if (bulkErr && !isMissingRelation(bulkErr)) throw bulkErr;

    for (const licId of ids) {
      const { error: oneErr } = await db.from(table).delete().eq("license_id", licId);
      if (oneErr && !isMissingRelation(oneErr)) throw oneErr;
    }

    for (const licId of ids) {
      const { count, error: cntErr } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("license_id", licId);
      if (cntErr && !isMissingRelation(cntErr)) throw cntErr;
      if ((count || 0) > 0) {
        throw new Error(
          `Nuk u fshinë ${count} terminal(e) (${table}) — provoni përsëri ose kontaktoni support.`,
        );
      }
    }
  }
}

async function deleteLicenseRow(db, licenseId) {
  const lid = String(licenseId || "").trim();
  if (!lid) throw new Error("ID e licencës mungon.");
  await purgeLicenseTerminalRows(db, [lid]);
  const { error } = await db.from("licenses").delete().eq("id", lid);
  if (error) throw error;
  return { ok: true, id: lid };
}

module.exports = { purgeLicenseTerminalRows, deleteLicenseRow, isMissingRelation };
