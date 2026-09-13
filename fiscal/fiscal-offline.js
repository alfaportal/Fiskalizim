/**
 * fiscal/fiscal-offline.js — HAPI 9: offline queue + monitor 60s + status/warning.
 * fiscal_receipts WRITE-ONCE: UPDATE lejohet VETËM për sent_to_atk / sent_at / atk_response_json.
 * Nuk prek cloud-sync SQLite↔Supabase.
 */
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
const { insertFiscalReceipt, getFiscalReceiptById } = require("./fiscal-db");
const { attachChainToFiscalData } = require("./fiscal-hash-chain");
const { atkDnsLookup, resolveAtkHost } = require("./atk-dns");
const {
  getFiscalTodayParts,
  getFiscalNowMs,
  formatFiscalDateTimeLocal,
  syncClockFromNetwork,
  markOfflineClockAnchor,
  clearOfflineClockAnchor,
  getTimeSyncStatus,
  startFiscalTimeSyncMonitor,
} = require("./fiscal-time-sync");
const { round4, lineTotalAmount, normalizeQty, normalizeUnitPrice } = require("./fiscal-vat");
const { isAtkHost } = require("./fiscal-local-env");
const { isAtkTransmissionBlocked } = require("./fiscal-test-mode-store");
const { isFiscalLocalRun } = require("./fiscal-local-env");

const ATK_HOST = "efiskalizimi.atk-ks.org";
const ATK_TEST_HOST = "fiskalizimi-test.atk-ks.org";
const ATK_HTTP_TIMEOUT_MS = 1500;
const ATK_PROBE_TIMEOUT_MS = 1500;
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

/**
 * Dërgim automatik te ATK (pas shitjes + monitor 60s).
 * Default OFF — vetëm butoni manual «Dërgo kuponët në pritje te ATK».
 */
function isAtkAutoSendEnabled() {
  if (isAtkTransmissionBlocked()) return false;
  const env = process.env.ATK_AUTO_SEND;
  if (env !== undefined && env !== null && String(env).trim() !== "") {
    const s = String(env).trim().toLowerCase();
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  }
  try {
    const database = require("../database");
    const v = database.getSetting("atk_auto_send", "0");
    return v === "1" || v === 1 || v === true || v === "true";
  } catch {
    return false;
  }
}

function todayParts() {
  return getFiscalTodayParts();
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
    const addrs = await resolveAtkHost(host);
    return Array.isArray(addrs) && addrs.length > 0;
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
        servername: hostname,
        lookup: atkDnsLookup,
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
 * A ka lidhje HTTP me serverin ATK (TEST/PROD) — përdoret për vendosjen e kuponit offline.
 */
async function checkAtkReachable() {
  if (!isFiscalEnabled()) return null;
  if (isAtkTransmissionBlocked()) return false;

  let configuredHost = "";
  try {
    const url = getAtkApiUrl();
    if (url) configuredHost = new URL(url).hostname;
  } catch {
    configuredHost = "";
  }

  const hosts = [...new Set([configuredHost, ATK_TEST_HOST, ATK_HOST].filter(Boolean))];
  const results = await Promise.all(
    hosts.map((host) =>
      httpProbe(host, { path: "/", timeoutMs: ATK_PROBE_TIMEOUT_MS })
    )
  );
  return results.some(Boolean);
}

/**
 * Kontrollon lidhjen me internet (HTTP probe paralel — jo vetëm DNS).
 */
async function checkInternetConnection() {
  if (!isFiscalEnabled()) return null;

  const blocked = isAtkTransmissionBlocked();
  const probes = [];

  if (!blocked) {
    probes.push(
      httpProbe(ATK_TEST_HOST, { path: "/", timeoutMs: ATK_HTTP_TIMEOUT_MS }),
      httpProbe(ATK_HOST, { path: "/", timeoutMs: ATK_HTTP_TIMEOUT_MS })
    );
  }
  probes.push(
    httpProbe("www.google.com", {
      path: "/generate_204",
      timeoutMs: ATK_HTTP_TIMEOUT_MS,
    }),
    httpProbe("1.1.1.1", {
      path: "/",
      httpsMode: false,
      timeoutMs: ATK_HTTP_TIMEOUT_MS,
    })
  );

  const results = await Promise.all(probes);
  const online = results.some(Boolean);

  const was = _lastOnline;
  _lastOnline = online;

  if (online && !blocked) {
    try {
      await syncClockFromNetwork();
      if (was === false) clearOfflineClockAnchor();
    } catch (e) {
      console.warn("[fiscal-offline] time sync:", e.message);
    }
  }

  if (was === true && online === false) {
    markOfflineClockAnchor();
    insertAudit("offline_start", {
      at: new Date(getFiscalNowMs()).toISOString(),
      fiscal_trusted_clock: true,
    });
  } else if (was === false && online === true) {
    insertAudit("offline_end", {
      at: new Date(getFiscalNowMs()).toISOString(),
      fiscal_trusted_clock: true,
    });
  }
  return online;
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const letter = String(item.vat_norm || item.vat_letter || "E")
      .trim()
      .toUpperCase();
    const L = /^[A-E]$/.test(letter) ? letter : "E";
    const rate =
      item.vat_percent != null
        ? Number(item.vat_percent)
        : item.vat_rate != null
          ? Number(item.vat_rate)
          : L === "D"
            ? 8
            : L === "E"
              ? 18
              : 0;
    const qty = normalizeQty(item.quantity ?? item.qty ?? 1);
    const unitPrice = normalizeUnitPrice(item);
    const { resolveItemUnitCategory } = require("./fiscal-item-meta");
    const meta = resolveItemUnitCategory(item, { authoritativeDb: true });
    return {
      name: String(item.name || item.emri || "-").trim(),
      quantity: qty,
      qty,
      price: unitPrice,
      unit_price: unitPrice,
      vat_norm: L,
      vat_letter: L,
      vat_category: String(rate),
      vat_rate: rate,
      vat_percent: rate,
      product_id: item.product_id ?? item.menu_item_id ?? null,
      menu_item_id: item.menu_item_id ?? item.product_id ?? null,
      unit_code: meta.unit_code,
      category_code: meta.category_code,
    };
  });
}

function sumItems(items) {
  return round4(
    items.reduce(
      (s, it) => s + lineTotalAmount(it.quantity || it.qty, it.unit_price || it.price),
      0
    )
  );
}

/**
 * Ruan kupon offline (INSERT write-once) me is_offline=1, sent_to_atk=0.
 * Kthen objektin + print_text (OFFLINE në letër vetëm kur print_offline_banner=true).
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

  const subtotal = round4(
    d.subtotal != null ? Number(d.subtotal) : sumItems(items)
  );
  const discount = round4(Number(d.discount_amount || 0) || 0);
  const totalAmount = round4(
    d.total_amount != null ? Number(d.total_amount) : subtotal - discount
  );
  const totalWithoutTax = round4(
    d.total_without_tax != null ? Number(d.total_without_tax) : totalAmount
  );
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
  const paymentSplits = Array.isArray(d.payment_splits) ? d.payment_splits : [];
  const paymentSplitsJson =
    d.payment_splits_json != null
      ? String(d.payment_splits_json)
      : paymentSplits.length > 0
        ? JSON.stringify(paymentSplits)
        : null;
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
    payment_splits_json: paymentSplitsJson,
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
    payment_splits: paymentSplits,
    subtotal,
    discount_amount: discount,
    total_amount: totalAmount,
    total_without_tax: totalWithoutTax,
    amount_paid: totalAmount,
    is_offline: true,
    print_offline_banner: !!d.print_offline_banner,
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
    print_offline_banner: !!d.print_offline_banner,
    fiscal_date: d.fiscal_date || fiscal_date,
    fiscal_time: d.fiscal_time || fiscal_time,
    vat_breakdown: vatBreak,
    language,
  };

  attachChainToFiscalData(fiscalData, getFiscalReceiptById(insertedId));

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
  const sentAt = formatFiscalDateTimeLocal(getFiscalNowMs());
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
 * @param {{ manual?: boolean }} [opts] — manual:true = butoni «Dërgo…»; auto vetëm nëse atk_auto_send=1
 */
async function processOfflineQueue(opts = {}) {
  if (!isFiscalEnabled()) return null;

  if (isAtkTransmissionBlocked()) {
    return {
      processed: 0,
      online: false,
      blocked: true,
      message:
        "ATK HTTP i bllokuar (modalitet lokal/test) — asnjë kupon nuk dërgohet te ATK",
    };
  }

  const manual = !!(opts && opts.manual);
  if (!manual && !isAtkAutoSendEnabled()) {
    return {
      processed: 0,
      online: null,
      skipped_auto: true,
      message: "Dërgimi automatik është OFF — përdor «Dërgo kuponët në pritje te ATK»",
    };
  }

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
  let testModeSkipped = 0;
  const errors = [];

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
      } else if (result.test_mode) {
        testModeSkipped += 1;
      } else if (result.ready_to_send) {
        // ready_only = ka kupon, por mungon çelësi privat (nuk u dërgua)
        readyOnly += 1;
      } else {
        const errMsg = result.error || result.body || "dështoi";
        errors.push({
          id: row.id,
          nuikf: row.nuikf,
          error: errMsg,
          status: result.status || null,
          body: result.body ? String(result.body).slice(0, 300) : null,
        });
        insertAudit("receipt_send_failed", {
          nuikf: row.nuikf,
          error: errMsg,
          body: result.body ? String(result.body).slice(0, 300) : undefined,
        });
      }
    } catch (e) {
      errors.push({ id: row.id, nuikf: row.nuikf, error: e.message });
      insertAudit("receipt_send_failed", {
        nuikf: row.nuikf,
        error: e.message,
      });
    }
  }

  return {
    processed,
    ready_only: readyOnly,
    test_mode_skipped: testModeSkipped,
    online: true,
    pending: rows.length,
    // ready_only ≠ “nuk janë ready”: është numri i kuponëve që presin çelës privat
    errors: errors.slice(0, 10),
  };
}

/**
 * Dërgon kuponët e papërfunduar vetëm brenda periudhës (p.sh. para raportit mujor ATK).
 * @param {string} fromDate YYYY-MM-DD
 * @param {string} toDate YYYY-MM-DD
 */
async function processPendingForPeriod(fromDate, toDate, opts = {}) {
  if (!isFiscalEnabled()) {
    return { processed: 0, online: false, skipped: true };
  }

  const from = String(fromDate || "").slice(0, 10);
  const to = String(toDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { processed: 0, error: "Periudha e pavlefshme" };
  }

  if (isAtkTransmissionBlocked()) {
    if (isFiscalLocalRun()) {
      return finalizeLocalMemoryForPeriod(from, to);
    }
    return {
      processed: 0,
      blocked: true,
      online: false,
      message: "ATK HTTP i bllokuar — transmetimi real i pamundur",
    };
  }

  const manual = opts.manual !== false;
  if (!manual && !isAtkAutoSendEnabled()) {
    return {
      processed: 0,
      skipped_auto: true,
      message: "Dërgimi automatik është OFF",
    };
  }

  let totalProcessed = 0;
  const errors = [];
  const maxRounds = 20;

  for (let round = 0; round < maxRounds; round++) {
    const online = await checkInternetConnection();
    if (!online) {
      return {
        processed: totalProcessed,
        online: false,
        complete: false,
        errors: errors.slice(0, 10),
      };
    }

    const sqlite = getSqlite();
    const rows = sqlite
      .prepare(
        `SELECT * FROM fiscal_receipts
         WHERE sent_to_atk = 0
           AND date(created_at) >= date(?)
           AND date(created_at) <= date(?)
         ORDER BY id ASC
         LIMIT 50`
      )
      .all(from, to);

    if (!rows.length) {
      return {
        processed: totalProcessed,
        online: true,
        complete: true,
        errors: errors.slice(0, 10),
      };
    }

    let roundProcessed = 0;
    for (const row of rows) {
      try {
        const result = await sendReceiptToAtk(row);
        if (result.sent) {
          markReceiptSent(row.id, result);
          insertAudit("receipt_sent", {
            nuikf: row.nuikf,
            receipt_id: row.id,
            offline: !!row.is_offline,
            monthly_memory_flush: true,
          });
          totalProcessed += 1;
          roundProcessed += 1;
        } else if (result.test_mode) {
          /* test mode — skip */
        } else if (result.ready_to_send) {
          errors.push({
            id: row.id,
            nuikf: row.nuikf,
            error: result.error || "Në pritje — mungon çelësi privat",
          });
        } else {
          const errMsg = result.error || result.body || "dështoi";
          errors.push({
            id: row.id,
            nuikf: row.nuikf,
            error: errMsg,
            status: result.status || null,
          });
          insertAudit("receipt_send_failed", {
            nuikf: row.nuikf,
            error: errMsg,
            monthly_memory_flush: true,
          });
        }
      } catch (e) {
        errors.push({ id: row.id, nuikf: row.nuikf, error: e.message });
        insertAudit("receipt_send_failed", {
          nuikf: row.nuikf,
          error: e.message,
          monthly_memory_flush: true,
        });
      }
    }

    if (!roundProcessed && errors.length) break;
  }

  return {
    processed: totalProcessed,
    online: true,
    complete: false,
    errors: errors.slice(0, 10),
  };
}

/** Modalitet lokal — shëno memorie të transferuar pa HTTP te ATK. */
function finalizeLocalMemoryForPeriod(from, to) {
  const sqlite = getSqlite();
  const sentAt = formatFiscalDateTimeLocal(getFiscalNowMs());
  const payload = JSON.stringify({
    local_only: true,
    memory_report: true,
    note: "Memoria fiskale — transfer lokal (FISCAL_LOCAL_RUN)",
  });
  const info = sqlite
    .prepare(
      `UPDATE fiscal_receipts SET
        sent_to_atk = 1,
        sent_at = ?,
        atk_response_json = ?
      WHERE sent_to_atk = 0
        AND date(created_at) >= date(?)
        AND date(created_at) <= date(?)`
    )
    .run(sentAt, payload, from, to);

  return {
    processed: Number(info.changes) || 0,
    local_memory: true,
    online: true,
    complete: true,
  };
}

/**
 * Monitor çdo 60s — vetëm kur fiscal ON.
 */
function startOfflineMonitor() {
  if (!isFiscalEnabled()) {
    console.log("[fiscal-offline] monitor: fiscal OFF — nuk niset");
    return false;
  }

  try {
    startFiscalTimeSyncMonitor();
  } catch (e) {
    console.warn("[fiscal-offline] time-sync:", e.message);
  }

  try {
    const { startOfflineComplianceMonitor } = require("./fiscal-offline-compliance");
    startOfflineComplianceMonitor();
  } catch (e) {
    console.warn("[fiscal-offline] compliance monitor:", e.message);
  }

  try {
    const { startPaperBlockMonitor } = require("./fiscal-paper-block");
    startPaperBlockMonitor();
  } catch (e) {
    console.warn("[fiscal-offline] paper-block monitor:", e.message);
  }

  if (!isAtkAutoSendEnabled()) {
    console.log(
      "[fiscal-offline] monitor: atk_auto_send OFF — nuk dërgon automatikisht (vetëm butoni manual)"
    );
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
    if (!isAtkAutoSendEnabled()) return;
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
  try {
    const { stopOfflineComplianceMonitor } = require("./fiscal-offline-compliance");
    stopOfflineComplianceMonitor();
  } catch {
    /* ignore */
  }
  try {
    const { stopPaperBlockMonitor } = require("./fiscal-paper-block");
    stopPaperBlockMonitor();
  } catch {
    /* ignore */
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

  const offlineIssued = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM fiscal_receipts
       WHERE sent_to_atk = 0 AND is_offline = 1`
    )
    .get();
  const offline_queue_count = Number(offlineIssued?.c) || 0;

  const offlineDailyRows = sqlite
    .prepare(
      `SELECT daily_number FROM fiscal_receipts
       WHERE sent_to_atk = 0 AND is_offline = 1
       ORDER BY id ASC
       LIMIT 20`
    )
    .all();
  const offline_daily_numbers = offlineDailyRows
    .map((r) => Number(r.daily_number))
    .filter((n) => Number.isFinite(n) && n > 0);

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

  const base = {
    enabled: true,
    local_only: isFiscalLocalRun() || isAtkTransmissionBlocked(),
    online: _lastOnline,
    receipt_count,
    pending_count: pending.length,
    offline_queue_count,
    offline_daily_numbers,
    oldest_pending_at: oldestAt,
    oldest_hours: Math.round(oldestHours * 10) / 10,
    within_48h: pending.length === 0 ? true : within48h,
    monitor_running: !!_monitorTimer,
    time_sync: getTimeSyncStatus(),
  };

  try {
    const { evaluateOfflineCompliance } = require("./fiscal-offline-compliance");
    const compliance = evaluateOfflineCompliance();
    if (compliance) {
      base.compliance = compliance;
    }
  } catch {
    /* compliance opsional */
  }

  return base;
}

/**
 * Mesazh paralajmërues / urgjent sipas orëve pa dërgim + afatet Neni 44.5 / 44.6.
 */
function getOfflineWarning() {
  if (!isFiscalEnabled()) return null;

  try {
    const { evaluateOfflineCompliance } = require("./fiscal-offline-compliance");
    const compliance = evaluateOfflineCompliance();
    const status = getOfflineStatus();
    if (!status) return null;

    if (!compliance || compliance.level === "ok") {
      if (!status.pending_count) {
        return { level: "ok", message: null, ...status, compliance };
      }
      return {
        level: "info",
        message: `${status.pending_count} kupon(ë) në radhë për dërgim te SIATK`,
        ...status,
        compliance,
      };
    }

    return {
      level: compliance.level,
      message: compliance.message,
      ...status,
      compliance,
    };
  } catch {
    /* fallback i vjetër */
  }

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

/**
 * Dërgon kuponin aktual (regular/storno/kthim/ndërrim) te ATK — gjithmonë kur nuk është bllokuar.
 * Checkbox atk_auto_send kontrollon vetëm radhën offline (processOfflineQueue).
 */
async function tryAutoSendFiscalReceiptById(receiptId) {
  const id = Number(receiptId);
  if (!id) {
    return {
      atk_sent: false,
      atk_auto: isAtkAutoSendEnabled(),
      atk_status: "missing",
      atk_message: "ATK: mungon ID e kuponit",
    };
  }
  const auto = isAtkAutoSendEnabled();
  if (isAtkTransmissionBlocked()) {
    return {
      atk_sent: false,
      atk_auto: auto,
      atk_status: "local_only",
      atk_message: "LOKAL — pa dërgim te ATK (nuk je i lidhur)",
    };
  }
  const sqlite = getSqlite();
  const row = sqlite.prepare(`SELECT * FROM fiscal_receipts WHERE id = ?`).get(id);
  if (!row) {
    return {
      atk_sent: false,
      atk_auto: true,
      atk_status: "missing",
      atk_message: "ATK: kuponi nuk u gjet",
    };
  }
  if (Number(row.sent_to_atk) === 1) {
    return {
      atk_sent: true,
      atk_auto: true,
      atk_status: "sent_ok",
      atk_message: "ATK: SUKSES — tashmë i dërguar",
    };
  }
  const result = await sendReceiptToAtk(row);
  if (result?.test_mode) {
    return {
      atk_sent: false,
      atk_auto: true,
      atk_test_mode: true,
      atk_status: "test_mode",
      atk_message: "ATK: TEST_MODE — kuponi u ruajt lokalisht, pa dërgim te API",
    };
  }
  if (result?.sent) {
    markReceiptSent(id, result);
    try {
      insertAudit("receipt_sent", {
        nuikf: row.nuikf,
        receipt_id: id,
        receipt_type: row.receipt_type,
        transaction_id: result.transaction_id,
      });
    } catch {
      /* */
    }
    return {
      atk_sent: true,
      atk_auto: true,
      atk_status: "sent_ok",
      atk_message: "ATK: SUKSES — kuponi u pranua",
      transaction_id: result.transaction_id || null,
    };
  }
  const err = String(result?.error || result?.status || "dështoi");
  try {
    insertAudit("receipt_send_failed", {
      nuikf: row.nuikf,
      receipt_id: id,
      receipt_type: row.receipt_type,
      error: err,
      queued_for_retry: true,
    });
  } catch {
    /* */
  }
  return {
    atk_sent: false,
    atk_auto: true,
    atk_status: "send_failed",
    atk_error: err,
    atk_message: `ATK: DËSHTOI — ${err} (në radhë për ritransmetim)`,
  };
}

module.exports = {
  checkInternetConnection,
  checkAtkReachable,
  queueOfflineReceipt,
  sendReceiptToAtk,
  tryAutoSendFiscalReceiptById,
  processOfflineQueue,
  processPendingForPeriod,
  startOfflineMonitor,
  stopOfflineMonitor,
  getOfflineStatus,
  getOfflineWarning,
  isAtkAutoSendEnabled,
  markReceiptSent,
  getTimeSyncStatus,
};
