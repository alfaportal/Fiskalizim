/**
 * Dërgim PosCoupon te ATK (Faza e Testimit / PROD).
 * Spec: https://github.com/fiskalizimi/pos-csharp
 */
const https = require("https");
const http = require("http");
const { getFiscalSettings } = require("./fiscal-config");
const {
  encodePosCoupon,
  resolveAtkCouponBuildOpts,
  validateAtkReferenceForSend,
} = require("./atk-model-builder");
const {
  signReceipt,
  loadPrivateKey,
  getKeysDir,
  compareCertWithSettings,
} = require("./fiscal-crypto");
const dbCrypto = require("../db-crypto");
const { atkDnsLookup } = require("./atk-dns");
const fs = require("fs");
const path = require("path");
const {
  isAtkTestMode,
  isAtkTransmissionBlocked,
  isFiscalMemoryOnly,
} = require("./fiscal-test-mode-store");
const { isAtkHost } = require("./fiscal-local-env");

const TEST_BASE = "https://fiskalizimi-test.atk-ks.org";
const PROD_BASE = "https://fiskalizimi.atk-ks.org";
const ATK_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.ATK_HTTP_TIMEOUT_MS) || 25000
);

/**
 * ATK_TEST_MODE — mjedisi TEST ATK (URL test); HTTP bllokohet vetëm me FISCAL_LOCAL_RUN=1.
 */
function logAtkTestModePayload(receiptRow, payload) {
  const summary = {
    code: "atk_test_mode_skip",
    nuikf: receiptRow?.nuikf || null,
    receipt_id: receiptRow?.id ?? null,
    total_amount: receiptRow?.total_amount ?? null,
    url: payload.url || null,
    details_len: payload.details ? String(payload.details).length : 0,
    signature_len: payload.signature ? String(payload.signature).length : 0,
  };
  console.log(
    "[fiscal-atk-api] ATK TEST_MODE — transmetimi i anashkaluar (pa HTTP te ATK).",
    summary
  );
  console.log(
    "[fiscal-atk-api] ATK TEST_MODE — payload (console only):",
    JSON.stringify({ details: payload.details, signature: payload.signature })
  );
}

function resolveAtkBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return TEST_BASE;
  if (/prod|production/i.test(s) && !/^https?:/i.test(s)) return PROD_BASE;
  if (/test/i.test(s) && !/^https?:/i.test(s)) return TEST_BASE;
  return s.replace(/\/+$/, "");
}

function couponEndpoint(base) {
  const b = resolveAtkBaseUrl(base);
  if (/\/pos\/coupon\/?$/i.test(b)) return b;
  return `${b}/pos/coupon`;
}

function httpJsonPost(url, bodyObj, timeoutMs = ATK_HTTP_TIMEOUT_MS) {
  if (isAtkTransmissionBlocked() && isAtkHost(url)) {
    return Promise.resolve({
      ok: false,
      blocked: true,
      error: "ATK HTTP i bllokuar (FISCAL_LOCAL_RUN / ATK_TEST_MODE)",
      url: String(url),
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      finish({ ok: false, error: "URL e pavlefshme: " + url });
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const body = JSON.stringify(bodyObj);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        servername: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + (parsed.search || ""),
        method: "POST",
        lookup: atkDnsLookup,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          const status = Number(res.statusCode) || 0;
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          finish({
            ok: status >= 200 && status < 300,
            status: status || null,
            body: data.slice(0, 4000),
            json,
          });
        });
        res.on("error", (e) => finish({ ok: false, error: e.message, status: res.statusCode || null }));
      }
    );
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      finish({ ok: false, error: "timeout (ATK nuk u përgjigj brenda " + timeoutMs + "ms)" });
    });
    req.write(body);
    req.end();
  });
}

function getAtkStatus() {
  const s = getFiscalSettings();
  const keysDir = getKeysDir();
  const privAtk = path.join(keysDir, "private-key.pem");
  const certAtk = path.join(keysDir, "signed-certificate.pem");
  const privLegacy = path.join(keysDir, "private.pem");
  const certLegacy = path.join(keysDir, "certificate.pem");
  const hasPrivate =
    dbCrypto.hasPrivateKeyMaterial(keysDir, s.private_key_path) ||
    fs.existsSync(privAtk) ||
    fs.existsSync(dbCrypto.encryptedPathFor(privAtk)) ||
    fs.existsSync(privLegacy) ||
    fs.existsSync(dbCrypto.encryptedPathFor(privLegacy));
  let privateKeyReadable = false;
  let privateKeyError = "";
  if (hasPrivate) {
    try {
      const { verifyPrivateKeyReadable } = require("./fiscal-crypto");
      const keyCheck = verifyPrivateKeyReadable();
      privateKeyReadable = !!keyCheck.ok;
      if (!keyCheck.ok) privateKeyError = keyCheck.error || "Çelësi privat nuk lexohet";
    } catch (e) {
      privateKeyError = e.message || String(e);
    }
  } else {
    privateKeyError = "Çelësi privat mungon";
  }
  // Prioritet: signed-certificate.pem (ATK) para certificate.pem / path të vjetër në settings
  let certPath = "";
  if (fs.existsSync(certAtk)) certPath = certAtk;
  else if (s.certificate_path && fs.existsSync(s.certificate_path)) certPath = s.certificate_path;
  else if (fs.existsSync(certLegacy)) certPath = certLegacy;
  let certIsPlaceholder = true;
  if (certPath) {
    try {
      const txt = fs.readFileSync(certPath, "utf8");
      certIsPlaceholder =
        /PLACEHOLDER|Replace with ATK/i.test(txt) || !/BEGIN\s+CERTIFICATE/i.test(txt);
    } catch {
      /* */
    }
  }
  const certMatch = certPath && !certIsPlaceholder
    ? compareCertWithSettings(s, certPath)
    : { match: false, reason: "no_cert", cert_ids: null, settings_ids: null };
  const base = resolveAtkBaseUrl(s.atk_api_url);
  const testMode = isAtkTestMode();
  const blocked = isAtkTransmissionBlocked();
  const core = {
    fiscal_enabled: !!s.fiscal_enabled,
    fiscal_local_run: require("./fiscal-local-env").isFiscalLocalRun(),
    test_mode: testMode,
    atk_transmission_blocked: blocked,
    fiscal_persistence: isFiscalMemoryOnly() ? "memory_only" : "sqlite",
    atk_base_url: base,
    atk_pos_coupon_url: couponEndpoint(base),
    environment: /fiskalizimi-test/i.test(base) ? "TEST" : /fiskalizimi\.atk/i.test(base) ? "PROD" : "CUSTOM",
    taxpayer_nui: s.taxpayer_nui || "",
    taxpayer_legal_name: s.taxpayer_legal_name || "",
    unit_name: s.unit_name || "",
    unit_number: s.unit_number || "",
    pos_id: s.pos_id || "",
    fiscalization_number: s.fiscalization_number || "",
    application_id: s.application_id || "",
    sef_identifier: s.sef_identifier || "",
    keys_dir: keysDir,
    has_private_key: !!hasPrivate,
    private_key_readable: privateKeyReadable,
    private_key_error: privateKeyError,
    certificate_path: certPath,
    certificate_is_placeholder: certIsPlaceholder,
    cert_registered_pos_id: certMatch.cert_ids?.pos_id || "",
    cert_registered_branch_id: certMatch.cert_ids?.branch_id || "",
    settings_match_cert: !!certMatch.match,
    cert_mismatch_reason: certMatch.reason,
    ready_for_atk:
      !!s.fiscal_enabled &&
      /^\d{9}$/.test(String(s.taxpayer_nui || "")) &&
      !!hasPrivate &&
      privateKeyReadable &&
      !certIsPlaceholder &&
      !!String(s.application_id || "").trim(),
    ready_to_send_coupons:
      !!s.fiscal_enabled &&
      /^\d{9}$/.test(String(s.taxpayer_nui || "")) &&
      !!hasPrivate &&
      privateKeyReadable &&
      !certIsPlaceholder &&
      !!String(s.application_id || "").trim() &&
      !!certMatch.match,
  };
  const { buildFiscalUiStatus } = require("./fiscal-ui-status");
  return {
    ...core,
    ui: buildFiscalUiStatus(core),
  };
}

/**
 * Dërgon një rresht fiscal_receipts te ATK POST /pos/coupon
 */
async function sendPosCouponToAtk(receiptRow) {
  if (!receiptRow) return { sent: false, error: "mungon receipt" };

  if (isAtkTransmissionBlocked()) {
    const settings = getFiscalSettings();
    const url = couponEndpoint(settings.atk_api_url);
    const blockedOpts = resolveAtkCouponBuildOpts(receiptRow, {
      settings,
      branchId: settings.unit_number || settings.business_unit_number || 1,
      applicationId: settings.application_id || 0,
    });
    const refCheck = validateAtkReferenceForSend(receiptRow, blockedOpts);
    if (!refCheck.ok) {
      return { sent: false, test_mode: true, blocked: true, error: refCheck.error };
    }
    let protoBuf;
    try {
      protoBuf = encodePosCoupon(receiptRow, blockedOpts);
    } catch (e) {
      return {
        sent: false,
        test_mode: true,
        blocked: true,
        error: "PosCoupon encode: " + e.message,
      };
    }
    const details = Buffer.from(protoBuf).toString("base64");
    let signature = "";
    try {
      signature = signReceipt(details) || "";
    } catch {
      /* provë lokale pa çelës */
    }
    logAtkTestModePayload(receiptRow, { details, signature, url });
    return {
      sent: false,
      test_mode: true,
      blocked: true,
      skipped: true,
      error: "ATK HTTP i bllokuar — transmetimi vetëm lokal (console/memorie)",
      payload_logged: true,
      url,
    };
  }

  const settings = getFiscalSettings();
  if (!settings.fiscal_enabled) {
    return { sent: false, error: "fiscal OFF" };
  }

  const atkStatus = getAtkStatus();
  if (atkStatus.certificate_is_placeholder || !atkStatus.ready_for_atk) {
    return {
      sent: false,
      ready_to_send: false,
      error:
        "Certifikata ATK mungon — bëni onboarding («Lidhu me ATK») para se të dërgoni kupone te ATK",
      atk: atkStatus,
    };
  }
  if (!atkStatus.settings_match_cert) {
    const c = atkStatus.cert_registered_branch_id || "?";
    const p = atkStatus.cert_registered_pos_id || "?";
    const sb =
      settings.business_unit_number || settings.unit_number || "?";
    const sp = settings.pos_id || "?";
    return {
      sent: false,
      ready_to_send: false,
      error:
        `Numrat në cilësime (Branch ${sb}, POS ${sp}) nuk përputhen me certifikatën (Branch ${c}, POS ${p}). Shtyp «Lidhu me ATK» për numrin që ke futur.`,
      atk: atkStatus,
    };
  }

  try {
    loadPrivateKey();
  } catch (e) {
    return { sent: false, error: "Çelësi privat: " + e.message };
  }

  const opts = resolveAtkCouponBuildOpts(receiptRow, {
    settings,
    businessId: settings.taxpayer_nui || receiptRow.taxpayer_nui,
    branchId: settings.unit_number || settings.business_unit_number || 1,
    applicationId: settings.application_id || 0,
  });

  const refCheck = validateAtkReferenceForSend(receiptRow, opts);
  if (!refCheck.ok) {
    return { sent: false, error: refCheck.error };
  }

  try {
    const { enrichItemsUnitCategory, findItemMetaMismatches } = require("./fiscal-item-meta");
    let rawItems = [];
    try {
      rawItems = JSON.parse(receiptRow.items_json || "[]");
    } catch {
      rawItems = [];
    }
    const enriched = enrichItemsUnitCategory(rawItems);
    const mismatches = findItemMetaMismatches(enriched);
    if (mismatches.length) {
      console.warn(
        "[fiscal-atk-api] ATK meta — u korrigjuan nga katalogu:",
        mismatches.map((m) => `${m.name}: ${m.got.unit}/${m.got.category} → ${m.expected.unit}/${m.expected.category}`)
      );
    }
    receiptRow = { ...receiptRow, items_json: JSON.stringify(enriched) };
  } catch (e) {
    console.warn("[fiscal-atk-api] enrich items:", e.message);
  }

  let protoBuf;
  try {
    protoBuf = encodePosCoupon(receiptRow, opts);
  } catch (e) {
    return { sent: false, error: "PosCoupon encode: " + e.message };
  }

  const details = Buffer.from(protoBuf).toString("base64");
  let signature;
  try {
    signature = signReceipt(details);
  } catch (e) {
    return { sent: false, error: "Nënshkrimi: " + e.message };
  }
  if (!signature) {
    return { sent: false, error: "Nënshkrimi dështoi" };
  }

  const url = couponEndpoint(settings.atk_api_url);
  const body = { details, signature };

  const res = await httpJsonPost(url, body, ATK_HTTP_TIMEOUT_MS);
  if (!res.ok) {
    const errDetail =
      res.error ||
      (res.body ? String(res.body).slice(0, 200) : "") ||
      (res.status ? `HTTP ${res.status}` : "ATK nuk u përgjigj (lidhje e prerë)");
    return {
      sent: false,
      error: errDetail,
      status: res.status,
      body: res.body,
      url,
    };
  }

  return {
    sent: true,
    status: res.status,
    body: res.body,
    json: res.json,
    url,
    transaction_id: res.json?.transaction_id ?? res.json?.transactionId ?? null,
  };
}

module.exports = {
  TEST_BASE,
  PROD_BASE,
  resolveAtkBaseUrl,
  couponEndpoint,
  isAtkTestMode,
  getAtkStatus,
  sendPosCouponToAtk,
  httpJsonPost,
};