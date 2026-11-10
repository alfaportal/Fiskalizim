const { getSupabase } = require("./db");

const KINDS = ["weekly_report", "low_stock_alert", "ai_report"];
let ensured = false;

function normalizeSlug(value) {
  return String(value || "").trim().toLowerCase();
}

function prefsAllow(row, kind) {
  return !!(row && row[kind] === true);
}

function emptyPrefs(slug) {
  return {
    slug,
    weekly_report: false,
    low_stock_alert: false,
    ai_report: false,
  };
}

function asBool(value) {
  return value === true;
}

async function ensureOwnerNotificationPreferences() {
  if (ensured) return true;
  const db = getSupabase();
  try {
    const { error } = await db.from("owner_notification_preferences").select("id").limit(1);
    if (!error) {
      ensured = true;
      return true;
    }
  } catch {
    ensured = false;
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "";
  if (!databaseUrl) return false;

  try {
    const { Client } = require("pg");
    const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.owner_notification_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_slug TEXT NOT NULL UNIQUE,
        weekly_report BOOLEAN NOT NULL DEFAULT false,
        low_stock_alert BOOLEAN NOT NULL DEFAULT false,
        ai_report BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.owner_notification_preferences ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS owner_notification_preferences_own ON public.owner_notification_preferences;
      CREATE POLICY owner_notification_preferences_own
        ON public.owner_notification_preferences
        FOR ALL
        TO authenticated
        USING (false)
        WITH CHECK (false);
      REVOKE ALL ON public.owner_notification_preferences FROM anon;
    `);
    await client.end();
    ensured = true;
    return true;
  } catch (err) {
    console.warn("[owner-notification-preferences]", err.message || err);
    return false;
  }
}

async function assertOwnerSlug(slug) {
  const wanted = normalizeSlug(slug);
  if (!wanted) {
    const err = new Error("Mungon slug.");
    err.status = 400;
    throw err;
  }
  const db = getSupabase();
  const { data, error } = await db.from("clients").select("id").eq("id", wanted).maybeSingle();
  if (error) throw error;
  if (!data?.id) {
    const err = new Error("Ky slug nuk është i lokalit tuaj.");
    err.status = 403;
    throw err;
  }
  return wanted;
}

async function readRow(slug) {
  const db = getSupabase();
  const { data, error } = await db
    .from("owner_notification_preferences")
    .select("business_slug, weekly_report, low_stock_alert, ai_report")
    .eq("business_slug", slug)
    .maybeSingle();
  if (error) {
    if (/owner_notification_preferences/i.test(error.message || "")) return null;
    throw error;
  }
  return data;
}

async function getPreferencesForSlug(slug) {
  const key = normalizeSlug(slug);
  if (!key) return emptyPrefs("");
  const row = await readRow(key);
  if (!row) return emptyPrefs(key);
  return {
    slug: key,
    weekly_report: row.weekly_report === true,
    low_stock_alert: row.low_stock_alert === true,
    ai_report: row.ai_report === true,
  };
}

async function savePreferencesForOwner(body) {
  const slug = await assertOwnerSlug(body?.slug);
  await ensureOwnerNotificationPreferences();
  const now = new Date().toISOString();
  const row = {
    business_slug: slug,
    weekly_report: asBool(body?.weekly_report),
    low_stock_alert: asBool(body?.low_stock_alert),
    ai_report: asBool(body?.ai_report),
    updated_at: now,
  };
  const db = getSupabase();
  const { data, error } = await db
    .from("owner_notification_preferences")
    .upsert(row, { onConflict: "business_slug" })
    .select("business_slug, weekly_report, low_stock_alert, ai_report")
    .single();
  if (error) throw error;
  return {
    slug: data.business_slug,
    weekly_report: data.weekly_report === true,
    low_stock_alert: data.low_stock_alert === true,
    ai_report: data.ai_report === true,
  };
}

async function ownerWantsNotification(clientId, kind) {
  if (!KINDS.includes(kind)) return false;
  const slug = normalizeSlug(clientId);
  if (!slug) return false;
  let row = null;
  try {
    row = await readRow(slug);
  } catch {
    return false;
  }
  return prefsAllow(row, kind);
}

module.exports = {
  ensureOwnerNotificationPreferences,
  getPreferencesForSlug,
  savePreferencesForOwner,
  assertOwnerSlug,
  ownerWantsNotification,
  prefsAllow,
  normalizeSlug,
};
