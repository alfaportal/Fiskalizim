const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://oqquiuisreztzcyehpiq.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/** Supabase Realtime kërkon WebSocket — Node 20 nuk e ka native; përdor `ws`. */
function supabaseClientOptions() {
  const opts = {
    auth: { persistSession: false, autoRefreshToken: false },
  };
  if (typeof globalThis.WebSocket === "undefined") {
    try {
      opts.global = { WebSocket: require("ws") };
    } catch {
      /* ws mungon — Realtime vetëm; REST punon pa të */
    }
  }
  return opts;
}

let _client = null;

function getSupabase() {
  if (_client) return _client;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Mungon SUPABASE_SERVICE_ROLE_KEY — vendose në Railway / .env (Fiskalizim Supabase).",
    );
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, supabaseClientOptions());
  return _client;
}

module.exports = { getSupabase, SUPABASE_URL };
