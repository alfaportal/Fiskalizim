const { getSupabase } = require("./db");
const { isEmailConfigured, sendOwnerOfflineEmail } = require("./mailer");

const MILESTONES = [44];
const MS_HOUR = 60 * 60 * 1000;
const APP_TYPE = "fiskalizim";

function hoursSince(iso) {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms / MS_HOUR;
}

function normalizeOfflineSince(iso) {
  if (!iso) return new Date(0).toISOString();
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return new Date(0).toISOString();
  return d.toISOString();
}

function isRevokedStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "revoked" || s === "revokuar";
}

async function fetchClientOfflineSnapshots() {
  const db = getSupabase();
  let licQuery = db.from("licenses").select("id, client_id, status, clients(id, emri, email)");
  if (APP_TYPE) licQuery = licQuery.eq("app_type", APP_TYPE);
  const [{ data: licenses, error: licErr }, { data: terminals, error: termErr }] = await Promise.all([
    licQuery,
    db.from("terminalet_e_licences").select("license_id, last_seen"),
  ]);
  if (licErr) throw licErr;
  if (termErr) {
    console.warn("[cron] offlineNotifications terminals:", termErr.message || termErr);
  }

  const seenByLicense = new Map();
  for (const t of terminals || []) {
    if (!t.license_id || !t.last_seen) continue;
    const prev = seenByLicense.get(t.license_id);
    if (!prev || new Date(t.last_seen) > new Date(prev)) {
      seenByLicense.set(t.license_id, t.last_seen);
    }
  }

  const byClient = new Map();
  for (const lic of licenses || []) {
    if (!lic?.client_id || isRevokedStatus(lic.status)) continue;
    const lastSeen = seenByLicense.get(lic.id);
    if (!lastSeen) continue;
    const client = lic.clients || {};
    const clientId = lic.client_id;
    const hours = hoursSince(lastSeen);
    const prev = byClient.get(clientId);
    if (prev && hours >= prev.hours_offline) continue;
    byClient.set(clientId, {
      client_id: clientId,
      license_id: lic.id,
      client_name: client.emri || "—",
      client_email: client.email || "",
      last_seen_at: lastSeen,
      offline_since: normalizeOfflineSince(lastSeen),
      hours_offline: hours,
    });
  }

  return [...byClient.values()].filter((c) => c.hours_offline >= MILESTONES[0]);
}

async function fetchSentMilestones(clientId, offlineSince) {
  const db = getSupabase();
  const { data, error } = await db
    .from("offline_notifications")
    .select("milestone_hours")
    .eq("client_id", clientId)
    .eq("offline_since", offlineSince);
  if (error) {
    if (/offline_notifications|schema cache|does not exist/i.test(error.message || "")) {
      const err = new Error(
        "Tabela offline_notifications mungon. Ekzekutoni server/sql/offline_notifications.sql",
      );
      err.code = "MISSING_OFFLINE_NOTIFICATIONS_TABLE";
      throw err;
    }
    throw error;
  }
  return new Set((data || []).map((r) => Number(r.milestone_hours)));
}

async function notifiedAfterLastSeen(clientId, lastSeenAt) {
  const db = getSupabase();
  const { data, error } = await db
    .from("offline_notifications")
    .select("sent_at")
    .eq("client_id", clientId)
    .order("sent_at", { ascending: false })
    .limit(8);
  if (error) throw error;
  const seenMs = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seenMs)) return false;
  return (data || []).some((r) => {
    const sentMs = new Date(r.sent_at).getTime();
    return Number.isFinite(sentMs) && sentMs >= seenMs;
  });
}

async function recordMilestone(row, milestoneHours) {
  const db = getSupabase();
  const { error } = await db.from("offline_notifications").upsert(
    {
      client_id: row.client_id,
      license_id: row.license_id || null,
      offline_since: row.offline_since,
      milestone_hours: milestoneHours,
      sent_at: new Date().toISOString(),
    },
    { onConflict: "client_id,offline_since,milestone_hours" },
  );
  if (error) throw error;
}

async function processOfflineNotifications() {
  if (!isEmailConfigured()) {
    console.log("[cron] offlineNotifications: RESEND_API_KEY mungon — anashkalohet.");
    return { skipped: true, reason: "email_not_configured" };
  }

  const offline = await fetchClientOfflineSnapshots();
  const stats = { checked: offline.length, sent: 0, skipped: 0, no_email: 0, errors: 0 };

  for (const row of offline) {
    let sentSet;
    try {
      sentSet = await fetchSentMilestones(row.client_id, row.offline_since);
    } catch (err) {
      if (err.code === "MISSING_OFFLINE_NOTIFICATIONS_TABLE") {
        console.error("[cron] offlineNotifications:", err.message);
        return { skipped: true, reason: "missing_table" };
      }
      throw err;
    }

    const ownerEmail = String(row.client_email || "").trim().toLowerCase();
    if (!ownerEmail) {
      stats.no_email += 1;
      console.warn(
        `[cron] offlineNotifications: pa email pronari — ${row.client_name} (${row.client_id})`,
      );
      continue;
    }

    if (await notifiedAfterLastSeen(row.client_id, row.last_seen_at)) {
      stats.skipped += 1;
      continue;
    }

    for (const milestone of MILESTONES) {
      if (row.hours_offline < milestone) continue;
      if (sentSet.has(milestone)) {
        stats.skipped += 1;
        continue;
      }
      try {
        await sendOwnerOfflineEmail({
          to: ownerEmail,
          clientName: row.client_name,
        });
        await recordMilestone(row, milestone);
        sentSet.add(milestone);
        stats.sent += 1;
      } catch (err) {
        stats.errors += 1;
        console.error(
          `[cron] offlineNotifications client ${row.client_id} @${milestone}h:`,
          err.message || err,
        );
      }
    }
  }

  console.log(
    `[cron] offlineNotifications: checked=${stats.checked} sent=${stats.sent} skipped=${stats.skipped} no_email=${stats.no_email} errors=${stats.errors}`,
  );
  return stats;
}

module.exports = {
  processOfflineNotifications,
  MILESTONES,
};
