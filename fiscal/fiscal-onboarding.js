/**
 * fiscal/fiscal-onboarding.js — ATK POS onboarding automatik (CA verify + CSR + signcsr).
 * Spec: https://github.com/fiskalizimi/pos-csharp
 */
const crypto = require("crypto");
const https = require("https");
const { saveAtkKeysFromOnboarding } = require("./fiscal-crypto");

const ATK_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.ATK_HTTP_TIMEOUT_MS) || 25000
);

const OID = {
  countryName: "2.5.4.6",
  organizationName: "2.5.4.10",
  organizationalUnitName: "2.5.4.11",
  localityName: "2.5.4.7",
  commonName: "2.5.4.3",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
};

function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    throw new Error("URL e ATK-së (atk_api_url) mungon.");
  }
  return s.replace(/\/+$/, "");
}

function requireSetting(settings, key, label) {
  const val = settings?.[key];
  if (val === undefined || val === null || String(val).trim() === "") {
    throw new Error(`Fusha "${label}" (${key}) mungon për onboarding ATK.`);
  }
  return val;
}

function parseUIntField(raw, label) {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Vlera e pavlefshme për ${label}: "${raw}".`);
  }
  return n;
}

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function encodeDer(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function encodeOid(oidStr) {
  const parts = oidStr.split(".").map((p) => parseInt(p, 10));
  if (parts.length < 2) throw new Error("OID i pavlefshëm: " + oidStr);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      bytes.push(val);
    } else {
      const enc = [];
      enc.push(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        enc.unshift((val & 0x7f) | 0x80);
        val >>= 7;
      }
      bytes.push(...enc);
    }
  }
  return encodeDer(0x06, Buffer.from(bytes));
}

function encodeInteger(value) {
  if (value === 0) return Buffer.from([0x02, 0x01, 0x00]);
  let n = value;
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return encodeDer(0x02, Buffer.from(bytes));
}

function encodeUtf8String(str) {
  return encodeDer(0x0c, Buffer.from(String(str), "utf8"));
}

function encodePrintableString(str) {
  return encodeDer(0x13, Buffer.from(String(str), "ascii"));
}

function encodeBitString(data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return encodeDer(0x03, Buffer.concat([Buffer.from([0x00]), body]));
}

function encodeSequence(items) {
  return encodeDer(0x30, Buffer.concat(items));
}

function encodeSet(items) {
  return encodeDer(0x31, Buffer.concat(items));
}

function encodeContextSpecific(tagNo, content) {
  return encodeDer(0xa0 | tagNo, content);
}

function buildRelativeDistinguishedName(oid, value, encoding) {
  const valueDer =
    encoding === "printable" ? encodePrintableString(value) : encodeUtf8String(value);
  return encodeSet([encodeSequence([encodeOid(oid), valueDer])]);
}

function buildSubjectName(fields) {
  return encodeSequence([
    buildRelativeDistinguishedName(OID.countryName, fields.country, "printable"),
    buildRelativeDistinguishedName(OID.organizationName, fields.organization, "utf8"),
    buildRelativeDistinguishedName(
      OID.organizationalUnitName,
      fields.organizationalUnit,
      "utf8"
    ),
    buildRelativeDistinguishedName(OID.localityName, fields.locality, "utf8"),
    buildRelativeDistinguishedName(OID.commonName, fields.commonName, "utf8"),
  ]);
}

/**
 * Krijon CSR PKCS#10 PEM (ECDSA P-256 / SHA-256) me crypto native — pa node-forge.
 */
function createEcdsaCsrPem(privateKeyPem, fields) {
  const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  const spkiDer = publicKeyObj.export({ type: "spki", format: "der" });

  const subject = buildSubjectName(fields);
  const attributes = encodeContextSpecific(0, encodeSequence([]));

  const certificationRequestInfo = encodeSequence([
    encodeInteger(0),
    subject,
    spkiDer,
    attributes,
  ]);

  const signatureAlgorithm = encodeSequence([encodeOid(OID.ecdsaWithSha256)]);
  const signature = crypto.sign("sha256", certificationRequestInfo, {
    key: privateKeyPem,
    dsaEncoding: "der",
  });

  const csrDer = encodeSequence([
    certificationRequestInfo,
    signatureAlgorithm,
    encodeBitString(signature),
  ]);

  const b64 = csrDer.toString("base64");
  const lines = b64.match(/.{1,64}/g) || [];
  return (
    "-----BEGIN CERTIFICATE REQUEST-----\n" +
    lines.join("\n") +
    "\n-----END CERTIFICATE REQUEST-----\n"
  );
}

function httpJsonPost(url, bodyObj, timeoutMs = ATK_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, payload) => {
      if (settled) return;
      settled = true;
      fn(payload);
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("URL e pavlefshme ATK: " + url));
      return;
    }

    if (parsed.protocol !== "https:") {
      reject(new Error("ATK onboarding kërkon HTTPS: " + url));
      return;
    }

    const body = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: parsed.hostname,
        servername: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + (parsed.search || ""),
        method: "POST",
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
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const status = Number(res.statusCode) || 0;
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          finish(resolve, {
            ok: status >= 200 && status < 300,
            status,
            body: data.slice(0, 4000),
            json,
          });
        });
        res.on("error", (err) => finish(reject, err));
      }
    );

    req.on("error", (err) => finish(reject, err));
    req.on("timeout", () => {
      req.destroy();
      finish(
        reject,
        new Error(
          "ATK nuk u përgjigj brenda " + timeoutMs + "ms (timeout onboarding)."
        )
      );
    });
    req.write(body);
    req.end();
  });
}

function formatAtkErrorDetail(json) {
  if (!json) return "pa detaje";
  if (json.message && typeof json.message === "string") return json.message;
  const err = json.error;
  if (err && typeof err === "object") {
    return String(err.message || err.title || JSON.stringify(err));
  }
  if (err != null && err !== "") return String(err);
  if (json.title) return String(json.title);
  return JSON.stringify(json);
}

function assertAtkOk(result, stepLabel) {
  if (!result || !result.ok) {
    const status = result?.status != null ? ` HTTP ${result.status}` : "";
    let detail = "pa detaje";
    if (result?.json) {
      detail = formatAtkErrorDetail(result.json);
    } else if (result?.body) {
      detail = result.body;
    }
    // Mesazhe specifike për gabime të njohura ATK
    if (result?.status === 404) {
      detail =
        "Ky POS (Branch/POS) ka certifikatë tashmë në ATK — nuk lejohet ri-regjistrim me «Lidhu me ATK». " +
        "Zgjidh një POS ID të ri që nuk shfaqet ende në portalin ATK (p.sh. 11, 12…) ose kërko reset te ATK për POS-in e vjetër.";
    }
    if (result?.status === 403 && String(detail).includes("Verification")) {
      detail = "Kodi i verifikimit nuk pranohet nga ATK — provo përsëri (kodi gjenerohet i ri çdo herë).";
    }
    throw new Error(
      `${stepLabel} dështoi${status}: ${String(detail).slice(0, 500)}`
    );
  }
}

function normalizePem(raw, label) {
  let pem = String(raw || "").trim();
  if (!pem) {
    throw new Error(`ATK nuk ktheu ${label} të vlefshme.`);
  }
  if (!pem.includes("BEGIN")) {
    const b64 = pem.replace(/\s+/g, "");
    const lines = b64.match(/.{1,64}/g) || [];
    pem =
      `-----BEGIN CERTIFICATE-----\n` +
      lines.join("\n") +
      `\n-----END CERTIFICATE-----\n`;
  }
  if (!/BEGIN\s+CERTIFICATE/i.test(pem)) {
    throw new Error(`Përgjigja e ATK për ${label} nuk është PEM i vlefshëm.`);
  }
  return pem.endsWith("\n") ? pem : pem + "\n";
}

/**
 * Onboarding i plotë POS te ATK: çelës → verify → CSR → signcsr → ruaj PEM.
 *
 * @param {object} settings
 * @param {string} settings.taxpayer_nui
 * @param {string} settings.fiscalization_number
 * @param {string|number} settings.pos_id
 * @param {string|number} settings.business_unit_number
 * @param {string|number} settings.application_id
 * @param {string} settings.atk_api_url
 * @returns {Promise<{success: true, business_name: string, verification_code: *, certificate_path: string, private_key_path: string}>}
 */
async function onboardPosAtAtk(settings) {
  const taxpayerNui = String(requireSetting(settings, "taxpayer_nui", "NUI")).trim();
  const fiscalizationNo = String(
    requireSetting(settings, "fiscalization_number", "FiscalizationNumber")
  ).trim();
  const posId = parseUIntField(requireSetting(settings, "pos_id", "PosID"), "PosID");
  const branchId = parseUIntField(
    requireSetting(settings, "business_unit_number", "BranchID"),
    "BranchID"
  );
  const applicationId = parseUIntField(
    requireSetting(settings, "application_id", "ApplicationID"),
    "ApplicationID"
  );
  const baseUrl = normalizeBaseUrl(requireSetting(settings, "atk_api_url", "URL ATK"));

  if (!/^\d{9}$/.test(taxpayerNui)) {
    throw new Error("NUI duhet të jetë saktësisht 9 shifra.");
  }

  // HAPI 1 — Gjenero çelës privat ECDSA P-256
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // HAPI 2 — Verifikim te ATK /ca/verify/{nui}
  const verifyUrl = `${baseUrl}/ca/verify/${encodeURIComponent(taxpayerNui)}`;
  const verifyBody = {
    fiscalization_no: fiscalizationNo,
    pos_id: posId,
    branch_id: branchId,
    application_id: applicationId,
  };

  let verifyResult;
  try {
    verifyResult = await httpJsonPost(verifyUrl, verifyBody);
  } catch (err) {
    throw new Error(
      "Verifikimi ATK (/ca/verify) dështoi: " + (err.message || String(err))
    );
  }
  assertAtkOk(verifyResult, "Verifikimi ATK (/ca/verify)");

  const businessName = String(
    verifyResult.json?.business_name || verifyResult.json?.businessName || ""
  ).trim();
  const verificationCode =
    verifyResult.json?.verification_code ??
    verifyResult.json?.verificationCode ??
    verifyResult.json?.verification_no ??
    null;

  if (!businessName) {
    throw new Error(
      "ATK nuk ktheu emrin e biznesit (business_name) pas verifikimit."
    );
  }
  if (
    verificationCode === null ||
    verificationCode === undefined ||
    String(verificationCode).trim() === ""
  ) {
    throw new Error(
      "ATK nuk ktheu kod verifikimi (verification_code) pas verifikimit."
    );
  }

  // HAPI 3 — Krijo CSR (native crypto, pa node-forge)
  const csrPem = createEcdsaCsrPem(privateKey, {
    country: "RKS",
    organization: taxpayerNui,
    organizationalUnit: String(posId),
    locality: String(branchId),
    commonName: businessName,
  });

  // HAPI 4 — Nënshkrim certifikate te ATK /ca/signcsr
  const signUrl = `${baseUrl}/ca/signcsr`;
  const signBody = {
    business_name: businessName,
    business_id: parseInt(taxpayerNui, 10),
    branch_id: branchId,
    verification_code: String(verificationCode),
    pos_id: posId,
    application_id: applicationId,
    csr: csrPem,
  };

  let signResult;
  try {
    signResult = await httpJsonPost(signUrl, signBody);
  } catch (err) {
    throw new Error(
      "Nënshkrimi i certifikatës ATK (/ca/signcsr) dështoi: " +
        (err.message || String(err))
    );
  }
  assertAtkOk(signResult, "Nënshkrimi i certifikatës ATK (/ca/signcsr)");

  const signedCertificate = normalizePem(
    signResult.json?.signed_certificate ||
      signResult.json?.signedCertificate ||
      "",
    "signed_certificate"
  );

  const saved = saveAtkKeysFromOnboarding(privateKey, signedCertificate, {
    allowOverwrite: true,
  });

  return {
    success: true,
    business_name: businessName,
    verification_code: verificationCode,
    certificate_path: saved.certificate_path,
    private_key_path: saved.private_key_path,
  };
}

module.exports = { onboardPosAtAtk };
