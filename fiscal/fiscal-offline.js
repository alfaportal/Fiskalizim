/**
 * fiscal/fiscal-offline.js — HAPI 9: offline queue + monitor 60s + status/warning.
 * fiscal_receipts WRITE-ONCE: UPDATE lejohet VETËM për sent_to_atk / sent_at / atk_response_json.
 * Nuk prek cloud-sync SQLite↔Supabase.
 */
const dns = require("dns").promises;
const https = require("https");
const http = require("http");
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const {
  generateNUIKF,
  getSefIdentifier,
  getNextDailyNumber,
  getNextTotalNumber,
} = require("./fiscal-numbering");
const { generateFiscalReceipt } = require("./fiscal-print");
const { logFiscalAction } = require("./fiscal-audit");
const { insertFiscalReceipt } = require("./fiscal-db");

const ATK_HOST = "efiskalizimi.atk-ks.org";
const MONITOR_MS = 60 * 1000;
const HOURS_24 = 24;
const HOURS_48 = 48;

let _monitorTimer = null;
let _lastOnline = null;
let _readyToSendLogged = new Set(); // receipt ids audited this process

function getSqlite() {
  const database = require("../database");
  if (!database || !database.db) {
    throw new Error("Databaza nuk është e gatshme");
  }
  return database.db;
}

function todayParts() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return {
    fiscal_date: `${dd}.${mm}.${yyyy}`,
    fiscal_time: `${hh}:${mi}`,
    iso: d.toISOString(),
  };
}

function insertAudit(action, details, operatorName = "system") {
  try {
    // Map legacy / helper actions to HAPI 10 allowed set
    let act = action;
    if (act === "ready_to_send") {
      act = "error";
      details = { ...(details || {}), code: "ready_to_send" };
    }
    logFiscalAction(act, details || {}, operatorName, "SYSTEM");
  } catch (e) {
    console.warn("[fiscal-offline] audit:", e.message);
  }
}

async function dnsOk(host) {
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

/** HTTP/HTTPS probe i shkurtër — true nëse ka përgjigje (edhe 4xx). */
function httpProbe(hostname, { path = "/", httpsMode = true, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const mod = httpsMode ? https : http;
    const req = mod.request(
      {
        hostname,
        path,
        method: "HEAD",
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * Kontrollon lidhjen me internet (DNS + HTTP).
 * Jeshile = çdo probe DNS/HTTP që funksionon (jo vetëm ATK).
 */
async function checkInternetConnection() {
  if (!isFiscalEnabled()) return null;

  const dnsHosts = [ATK_HOST, "dns.google", "1.1.1.1", "cloudflare.com"];
  let anyDns = false;
  for (const host of dnsHosts) {
    if (await dnsOk(host)) {
      anyDns = true;
      break;
    }
  }

  let online = anyDns;
  if (!online) {
    online =
      (await httpProbe(ATK_HOST, { path: "/" })) ||
      (await httpProbe("www.google.com", { path: "/generate_204" })) ||
      (await httpProbe("1.1.1.1", { path: "/", httpsMode: false }));
  }

  const was = _lastOnline;
  _lastOnline = online;
  if (was === true && online === false) {
    insertAudit("offline_start", { at: new Date().toISOString() });
  } else if (was === false && online === true) {
    insertAudit("offline_end", { at: new Date().toISOString() });
  }
  return online;
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    name: String(item.name || item.emri || "-").trim(),
    quantity: Number(item.quantity ?? item.qty ?? 1) || 0,
    qty: Number(item.quantity ?? item.qty ?? 1) || 0,
    price: Number(item.price ?? item.unit_price ?? item.cmimi ?? 0) || 0,
    unit_price: Number(item.unit_price ?? item.price ?? item.cmimi ?? 0) || 0,
    vat_norm: String(item.vat_norm || item.vat_letter || "E")
      .trim()
      .toUpperCase(),
  }));
}

function sumItems(items) {
  return items.reduce(
    (s, it) => s + (Number(it.quantity || it.qty) || 0) * (Number(it.unit_price || it.price) || 0),
    0
  );
}

/**
 * Ruan kupon offline (INSERT write-once) me is_offline=1, sent_to_atk=0.
 * Kthen objektin + print_text me "*** OFFLINE ***".
 */
function queueOfflineReceipt(receiptData) {
  if (!isFiscalEnabled()) return null;

  const d = receiptData && typeof receiptData === "object" ? receiptData : {};
  const items = normalizeItems(d.items);
  if (!items.length) {
    throw new Error("Kuponi offline kërkon artikuj");
  }

  const settings = getFiscalSettings();
  const { fiscal_date, fiscal_time } = todayParts();
  const nuikf = d.nuikf || generateNUIKF();
  if (!nuikf) throw new Error("Nuk u gjenerua NUIKF");
  const sefId = d.sef_id || getSefIdentifier() || "";
  const dailyNumber = d.daily_number != null ? d.daily_number : getNextDailyNumber();
  const totalNumber = d.total_number != null ? d.total_number : getNextTotalNumber();
  if (dailyNumber == null || totalNumber == null) {
    throw new Error("Nuk u gjenerua numri ditor/total");
  }

  const subtotal = Math.round(
    (d.subtotal != null ? Number(d.subtotal) : sumItems(items)) * 100
  ) / 100;
  const discount = Number(d.discount_amount || 0) || 0;
  const totalAmount =
    Math.round(
      (d.total_amount != null ? Number(d.total_amount) : subtotal - discount) * 100
    ) / 100;
  const totalWithoutTax =
    Math.round(
      (d.total_without_tax != null ? Number(d.total_without_tax) : totalAmount) * 100
    ) / 100;
  const vatBreak = d.vat_breakdown || { A: 0, B: 0, C: 0, D: 0, E: 0 };

  const operatorName = String(d.operator_name || "Operator").trim() || "Operator";
  const operatorId = String(d.operator_id || "POS").trim() || "POS";
  const taxpayerNui = d.taxpayer_nui || settings.taxpayer_nui || settings.developer_nui || "";
  const taxpayerVat = d.taxpayer_vat || settings.taxpayer_vat_number || "";
  const taxpayerName =
    d.taxpayer_name || settings.taxpayer_legal_name || "Biznesi";
  const taxpayerAddress = d.taxpayer_address || settings.taxpayer_address || "";
  const unitName = d.unit_name || settings.unit_name || "";
  const unitPhone = d.unit_phone || settings.unit_phone || "";
  const paymentMethod = d.payment_method || "cash";
  const receiptType = d.receipt_type || "regular";
  const saleId = Number(d.sale_id) || 0;

  const qrPayload = JSON.stringify({
    placeholder: true,
    hapi: 8,
    offline: true,
  });

  const insertedId = insertFiscalReceipt({
    sale_id: saleId,
    nuikf,
    sef_id: sefId,
    receipt_type: receiptType,
    original_nuikf: d.original_nuikf || null,
    daily_number: dailyNumber,
    total_number: totalNumber,
    fiscal_date: d.fiscal_date || fiscal_date,
    fiscal_time: d.fiscal_time || fiscal_time,
    operator_name: operatorName,
    operator_id: operatorId,
    taxpayer_nui: taxpayerNui,
    taxpayer_vat: taxpayerVat || null,
    taxpayer_name: taxpayerName,
    taxpayer_address: taxpayerAddress,
    items_json: JSON.stringify(items),
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    vat_breakdown_json: JSON.stringify(vatBreak),
    payment_method: paymentMethod,
    currency: "EUR",
    qr_code_data: qrPayload,
    digital_signature: null,
    is_offline: 1,
    sent_to_atk: 0,
  });
  const result = { lastInsertRowid: insertedId };

  const orderData = {
    items,
    operator_name: operatorName,
    operator_id: operatorId,
    payment_method: paymentMethod,
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    amount_paid: totalAmount,
    is_offline: true,
  };
  let language = "sq";
  try {
    language = getFiscalSettings().language === "sr" ? "sr" : "sq";
  } catch {
    language = "sq";
  }

  const fiscalData = {
    taxpayer_legal_name: taxpayerName,
    taxpayer_address: taxpayerAddress,
    taxpayer_nui: taxpayerNui,
    taxpayer_vat: taxpayerVat,
    unit_name: unitName,
    unit_phone: unitPhone,
    daily_number: dailyNumber,
    total_number: totalNumber,
    nuikf,
    sef_id: sefId,
    receipt_type: receiptType,
    original_nuikf: d.original_nuikf || null,
    is_offline: true,
    fiscal_date: d.fiscal_date || fiscal_date,
    fiscal_time: d.fiscal_time || fiscal_time,
    vat_breakdown: vatBreak,
    language,
  };

  const printText = generateFiscalReceipt(orderData, fiscalData);

  insertAudit("receipt_created", {
    nuikf,
    offline: true,
    total: totalAmount,
  }, operatorName);

  return {
    id: result.lastInsertRowid,
    nuikf,
    sef_id: sefId,
    daily_number: dailyNumber,
    total_number: totalNumber,
    is_offline: true,
    sent_to_atk: false,
    total_amount: totalAmount,
    print_text: printText,
  };
}

function getAtkApiUrl() {
  try {
    const s = getFiscalSettings();
    return (s.atk_api_url && String(s.atk_api_url).trim()) || "";
  } catch {
    return "";
  }
}

function markReceiptSent(id, atkResponse) {
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(`SELECT sent_to_atk FROM fiscal_receipts WHERE id = ?`)
    .get(id);
  if (!row || Number(row.sent_to_atk) === 1) return;

  const { fiscalReceiptUpdate } = require("./fiscal-db");
  const sentAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  fiscalReceiptUpdate(id, {
    sent_to_atk: 1,
    sent_at: sentAt,
    atk_response_json: atkResponse || { ok: true },
  });
}

/**
 * Dërgim te ATK — PosCoupon protobuf + ECDSA (fiscal-atk-api.js).
 */
async function sendReceiptToAtk(row) {
  try {
    const { sendPosCouponToAtk, getAtkStatus } = require("./fiscal-atk-api");
    const status = getAtkStatus();
    if (!status.has_private_key) {
      if (!_readyToSendLogged.has(row.id)) {
        insertAudit("ready_to_send", {
          nuikf: row.nuikf,
          receipt_id: row.id,
          reason: "Mungon çelësi privat ECDSA",
        });
        _readyToSendLogged.add(row.id);
      }
      return { sent: false, ready_to_send: true, error: "Mungon çelësi privat" };
    }
    const result = await sendPosCouponToAtk(row);
    return result;
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

/**
 * Dërgon kuponët me sent_to_atk=0 njëri pas tjetrit (nëse ka internet).
 */
async function processOfflineQueue() {
  if (!isFiscalEnabled()) return null;

  const online = await checkInternetConnection();
  if (!online) {
    return { processed: 0, online: false };
  }

  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      `SELECT * FROM fiscal_receipts
       WHERE sent_to_atk = 0
       ORDER BY id ASC
       LIMIT 50`
    )
    .all();

  let processed = 0;
  let readyOnly = 0;

  for (const row of rows) {
    try {
      const result = await sendReceiptToAtk(row);
      if (result.sent) {
        markReceiptSent(row.id, result);
        insertAudit("receipt_sent", {
          nuikf: row.nuikf,
          receipt_id: row.id,
          offline: !!row.is_offline,
        });
        processed += 1;
      } else if (result.ready_to_send) {
        readyOnly += 1;
      } else {
        insertAudit("receipt_send_failed", {
          nuikf: row.nuikf,
          error: result.error || result.body || "dështoi",
        });
      }
    } catch (e) {
      insertAudit("receipt_send_failed", {
        nuikf: row.nuikf,
        error: e.message,
      });
    }
  }

  return { processed, ready_only: readyOnly, online: true, pending: rows.length };
}

/**
 * Monitor çdo 60s — vetëm kur fiscal ON.
 */
function startOfflineMonitor() {
  if (!isFiscalEnabled()) {
    console.log("[fiscal-offline] monitor: fiscal OFF — nuk niset");
    return false;
  }
  if (_monitorTimer) return true;

  console.log("[fiscal-offline] monitor: nisur (60s)");
  // menjëherë një herë, pastaj interval
  processOfflineQueue().catch((e) =>
    console.warn("[fiscal-offline] queue:", e.message)
  );

  _monitorTimer = setInterval(() => {
    if (!isFiscalEnabled()) return;
    processOfflineQueue().catch((e) =>
      console.warn("[fiscal-offline] queue:", e.message)
    );
  }, MONITOR_MS);

  if (typeof _monitorTimer.unref === "function") {
    _monitorTimer.unref();
  }
  return true;
}

function stopOfflineMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
}

function parseCreatedAt(row) {
  const raw = row.created_at || "";
  // SQLite localtime: "YYYY-MM-DD HH:MM:SS"
  const iso = String(raw).includes("T")
    ? raw
    : String(raw).replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Statusi i radhës offline.
 */
function getOfflineStatus() {
  if (!isFiscalEnabled()) return null;

  const sqlite = getSqlite();
  const pending = sqlite
    .prepare(
      `SELECT id, nuikf, created_at, is_offline, total_amount
       FROM fiscal_receipts
       WHERE sent_to_atk = 0
       ORDER BY id ASC`
    )
    .all();

  const totalRow = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM fiscal_receipts`)
    .get();
  const receipt_count = Number(totalRow?.c) || 0;

  let oldestHours = 0;
  let oldestAt = null;
  if (pending.length) {
    const first = parseCreatedAt(pending[0]);
    if (first) {
      oldestAt = first.toISOString();
      oldestHours = (Date.now() - first.getTime()) / (1000 * 60 * 60);
    }
  }

  const within48h = oldestHours <= HOURS_48;

  return {
    enabled: true,
    online: _lastOnline,
    receipt_count,
    pending_count: pending.length,
    oldest_pending_at: oldestAt,
    oldest_hours: Math.round(oldestHours * 10) / 10,
    within_48h: pending.length === 0 ? true : within48h,
    monitor_running: !!_monitorTimer,
  };
}

/**
 * Mesazh paralajmërues / urgjent sipas orëve pa dërgim.
 */
function getOfflineWarning() {
  if (!isFiscalEnabled()) return null;

  const status = getOfflineStatus();
  if (!status || status.pending_count === 0) {
    return { level: "ok", message: null, ...status };
  }

  const hours = status.oldest_hours || 0;
  if (hours > HOURS_48) {
    return {
      level: "urgent",
      message:
        "Duhet me njoftu ATK-në — kanë kaluar 48 orë pa lidhje",
      ...status,
    };
  }
  if (hours > HOURS_24) {
    return {
      level: "warning",
      message: `Kujdes: ${Math.floor(hours)} orë pa dërguar kuponë te SIATK (limiti 48h)`,
      ...status,
    };
  }
  return {
    level: "info",
    message: `${status.pending_count} kupon(ë) në radhë për dërgim te SIATK`,
    ...status,
  };
}

module.exports = {
  checkInternetConnection,
  queueOfflineReceipt,
  sendReceiptToAtk,
  processOfflineQueue,
  startOfflineMonitor,
  stopOfflineMonitor,
  getOfflineStatus,
  getOfflineWarning,
};
