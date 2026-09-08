const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://oqquiuisreztzcyehpiq.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/** Node 20: Realtime kërkon WebSocket — vendose global + transport (supabase-js 2.112+). */
function loadWsTransport() {
  try {
    return require("ws");
  } catch {
    return null;
  }
}

function ensureNodeWebSocket() {
  if (typeof globalThis.WebSocket !== "undefined") return loadWsTransport();
  const ws = loadWsTransport();
  if (ws) {
    globalThis.WebSocket = ws;
  }
  return ws;
}

function supabaseClientOptions() {
  const wsTransport = ensureNodeWebSocket();
  const opts = {
    auth: { persistSession: false, autoRefreshToken: false },
  };
  if (wsTransport) {
    opts.realtime = { transport: wsTransport };
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
