const { getSupabase } = require("./db");
const { isEmailConfigured, sendOwnerOfflineEmail } = require("./mailer");

const OFFLINE_MS = 48 * 60 * 60 * 1000;
const ONLINE_MS = 15 * 60 * 1000;
const APP_TYPE = "fiskalizim";
const FISCAL_PRODUCT = true;
const businesses = new Map();

function blankState() {
  return { last_seen_online: 0, offline_email_sent: false };
}

function decideOfflineEmail(state, { seenAtMs, fiscalActive, now }) {
  if (!fiscalActive || !state) return "skip";
  const seenOk = Number.isFinite(seenAtMs) && seenAtMs > 0 && seenAtMs <= now + 60 * 1000;
  const onlineNow = seenOk && now - seenAtMs <= ONLINE_MS;
  if (onlineNow) {
    state.last_seen_online = seenAtMs;
    state.offline_email_sent = false;
    return "online";
  }
  if (seenOk && seenAtMs > state.last_seen_online) state.last_seen_online = seenAtMs;
  if (!state.last_seen_online || state.offline_email_sent) return "wait";
  if (now - state.last_seen_online < OFFLINE_MS) return "wait";
  return "send";
}

function isRevokedStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "revoked" || s === "revokuar";
}

async function fetchBusinesses() {
  const db = getSupabase();
  let licQuery = db.from("licenses").select("id, client_id, status, clients(id, emri, email)");
  if (APP_TYPE) licQuery = licQuery.eq("app_type", APP_TYPE);
  const [{ data: licenses, error: licErr }, { data: terminals, error: termErr }] = await Promise.all([
    licQuery,
    db.from("terminalet_e_licences").select("license_id, last_seen"),
  ]);
  if (licErr) throw licErr;
  if (termErr) console.warn("[offline-48h] terminals:", termErr.message || termErr);

  const seenByLicense = new Map();
  for (const t of terminals || []) {
    if (!t.license_id || !t.last_seen) continue;
    const ms = new Date(t.last_seen).getTime();
    if (!Number.isFinite(ms)) continue;
    const prev = seenByLicense.get(t.license_id) || 0;
    if (ms > prev) seenByLicense.set(t.license_id, ms);
  }

  const byClient = new Map();
  for (const lic of licenses || []) {
    if (!lic?.client_id || isRevokedStatus(lic.status)) continue;
    const seenAtMs = seenByLicense.get(lic.id) || 0;
    if (!seenAtMs) continue;
    const client = lic.clients || {};
    const slug = String(client.id || lic.client_id).trim().toLowerCase();
    if (!slug) continue;
    const prev = byClient.get(slug);
    if (prev && seenAtMs <= prev.seenAtMs) continue;
    byClient.set(slug, {
      slug,
      client_name: client.emri || slug,
      client_email: client.email || "",
      seenAtMs,
      fiscalActive: FISCAL_PRODUCT,
    });
  }
  return [...byClient.values()];
}

async function processOfflineNotifications(now = Date.now()) {
  if (!isEmailConfigured()) {
    return { skipped: true, reason: "email_not_configured" };
  }
  const rows = await fetchBusinesses();
  const stats = { checked: rows.length, sent: 0, online: 0, wait: 0, errors: 0 };
  for (const row of rows) {
    let state = businesses.get(row.slug);
    if (!state) {
      state = blankState();
      businesses.set(row.slug, state);
    }
    const action = decideOfflineEmail(state, {
      seenAtMs: row.seenAtMs,
      fiscalActive: row.fiscalActive,
      now,
    });
    if (action === "online") {
      stats.online += 1;
      continue;
    }
    if (action !== "send") {
      stats.wait += 1;
      continue;
    }
    state.offline_email_sent = true;
    const ownerEmail = String(row.client_email || "").trim().toLowerCase();
    if (!ownerEmail) {
      state.offline_email_sent = false;
      stats.wait += 1;
      continue;
    }
    try {
      await sendOwnerOfflineEmail({ to: ownerEmail, clientName: row.client_name });
      stats.sent += 1;
    } catch (err) {
      state.offline_email_sent = false;
      stats.errors += 1;
      console.error(`[offline-48h] ${row.slug}:`, err.message || err);
    }
  }
  return stats;
}

module.exports = {
  processOfflineNotifications,
  decideOfflineEmail,
  businesses,
  OFFLINE_MS,
  ONLINE_MS,
};
