/**
 * Dërgim PosCoupon te ATK (Faza e Testimit / PROD).
 * Spec: https://github.com/fiskalizimi/pos-csharp
 */
const https = require("https");
const http = require("http");
const { getFiscalSettings } = require("./fiscal-config");
const { encodePosCoupon } = require("./atk-model-builder");
const { signReceipt, loadPrivateKey, getKeysDir } = require("./fiscal-crypto");
const fs = require("fs");
const path = require("path");

const TEST_BASE = "https://fiskalizimi-test.atk-ks.org";
const PROD_BASE = "https://fiskalizimi.atk-ks.org";

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

function httpJsonPost(url, bodyObj, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, error: "URL e pavlefshme: " + url });
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const body = JSON.stringify(bodyObj);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + (parsed.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: data.slice(0, 4000),
            json,
          });
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
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
    (s.private_key_path && fs.existsSync(s.private_key_path)) ||
    fs.existsSync(privAtk) ||
    fs.existsSync(privLegacy);
  let certPath = "";
  if (s.certificate_path && fs.existsSync(s.certificate_path)) certPath = s.certificate_path;
  else if (fs.existsSync(certAtk)) certPath = certAtk;
  else if (fs.existsSync(certLegacy)) certPath = certLegacy;
  let certIsPlaceholder = true;
  if (certPath) {
    try {
      const txt = fs.readFileSync(certPath, "utf8");
      certIsPlaceholder = /PLACEHOLDER|Replace with ATK/i.test(txt);
    } catch {
      /* */
    }
  }
  const base = resolveAtkBaseUrl(s.atk_api_url);
  return {
    fiscal_enabled: !!s.fiscal_enabled,
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
    certificate_path: certPath,
    certificate_is_placeholder: certIsPlaceholder,
    ready_for_atk:
      !!s.fiscal_enabled &&
      /^\d{9}$/.test(String(s.taxpayer_nui || "")) &&
      !!hasPrivate &&
      !certIsPlaceholder &&
      !!String(s.application_id || "").trim(),
  };
}

/**
 * Dërgon një rresht fiscal_receipts te ATK POST /pos/coupon
 */
async function sendPosCouponToAtk(receiptRow) {
  if (!receiptRow) return { sent: false, error: "mungon receipt" };

  const settings = getFiscalSettings();
  if (!settings.fiscal_enabled) {
    return { sent: false, error: "fiscal OFF" };
  }

  try {
    loadPrivateKey();
  } catch (e) {
    return { sent: false, error: "Çelësi privat: " + e.message };
  }

  const opts = {
    settings,
    couponId: receiptRow.total_number || receiptRow.id,
    branchId: settings.unit_number || settings.business_unit_number || 1,
    applicationId: settings.application_id || 0,
  };

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
  const res = await httpJsonPost(url, { details, signature });
  if (!res.ok) {
    return {
      sent: false,
      error: res.error || `HTTP ${res.status}`,
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
  getAtkStatus,
  sendPosCouponToAtk,
  httpJsonPost,
};
