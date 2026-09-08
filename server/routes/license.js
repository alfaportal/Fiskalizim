const express = require("express");
const {
  validateLicense,
  findLicenseByDeviceId,
  claimLicenseByHardware,
  clientIp,
  APP_TYPE,
} = require("../licenseService");

const router = express.Router();

function pickBody(req) {
  const b = req.body || {};
  return {
    celesi: b.celesi || b.license_key || b.licenseKey,
    license_key: b.license_key || b.celesi || b.licenseKey,
    device_id: b.device_id || b.deviceId,
    hardware_id: b.hardware_id || b.hardwareId,
    app_type: b.app_type || b.appType || APP_TYPE,
    hostname: b.hostname,
    client_ip: clientIp(req),
  };
}

router.post("/validate", async (req, res) => {
  try {
    const body = pickBody(req);
    if (!body.celesi) {
      return res.status(400).json({ valid: false, gabim: "Mungon çelësi i licencës.", code: "MISSING_KEY" });
    }
    const result = await validateLicense(body);
    res.status(result.valid ? 200 : 403).json(result);
  } catch (e) {
    console.error("[license/validate]", e.message || e);
    res.status(500).json({ valid: false, gabim: e.message || "Gabim serveri.", code: "SERVER_ERROR" });
  }
});

router.post("/heartbeat", async (req, res) => {
  try {
    const body = pickBody(req);
    if (!body.celesi) {
      return res
        .status(400)
        .json({ ok: false, valid: false, gabim: "Mungon çelësi i licencës.", code: "MISSING_KEY" });
    }

    let result = await validateLicense(body);

    if (!result.valid && result.code === "NOT_FOUND" && body.hardware_id) {
      const byHw = await claimLicenseByHardware({
        hardware_id: body.hardware_id,
        device_id: body.device_id,
        app_type: body.app_type,
      });
      if (byHw?.valid && byHw.celesi) {
        result = byHw;
        result.celesi_updated = byHw.celesi;
      }
    }

    if (!result.valid && result.code === "NOT_FOUND" && body.device_id) {
      const byDevice = await findLicenseByDeviceId(body.device_id);
      if (byDevice?.license_key) {
        result = await validateLicense({
          ...body,
          celesi: byDevice.license_key,
          license_key: byDevice.license_key,
        });
        if (result.valid) {
          result.celesi_updated = byDevice.license_key;
          result.celesi = byDevice.license_key;
        }
      }
    }

    res.status(result.valid ? 200 : 403).json({
      ok: result.valid,
      ...result,
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[license/heartbeat]", e.message || e);
    res.status(500).json({ ok: false, valid: false, gabim: e.message || "Gabim serveri.", code: "SERVER_ERROR" });
  }
});

router.post("/activate", async (req, res) => {
  try {
    const body = pickBody(req);
    if (!body.celesi) {
      return res.status(400).json({ valid: false, gabim: "Mungon çelësi i licencës.", code: "MISSING_KEY" });
    }
    if (!body.device_id) {
      return res.status(400).json({ valid: false, gabim: "Mungon ID e pajisjes.", code: "MISSING_DEVICE" });
    }
    const result = await validateLicense({ ...body, bindHardware: true });
    res.status(result.valid ? 200 : 403).json({
      ...result,
      activated: !!result.valid,
    });
  } catch (e) {
    console.error("[license/activate]", e.message || e);
    res.status(500).json({ valid: false, gabim: e.message || "Gabim serveri.", code: "SERVER_ERROR" });
  }
});

router.post("/by-hardware", async (req, res) => {
  try {
    const body = pickBody(req);
    if (!body.hardware_id) {
      return res.status(400).json({
        valid: false,
        gabim: "Mungon Hardware ID.",
        code: "MISSING_HARDWARE",
      });
    }
    const result = await claimLicenseByHardware({
      hardware_id: body.hardware_id,
      device_id: body.device_id,
      app_type: body.app_type,
    });
    res.status(result.valid ? 200 : 404).json(result);
  } catch (e) {
    console.error("[license/by-hardware]", e.message || e);
    res.status(500).json({ valid: false, gabim: e.message || "Gabim serveri.", code: "SERVER_ERROR" });
  }
});

router.post("/security-alert", async (req, res) => {
  try {
    console.warn("[fiskalizim-security-alert]", {
      type: req.body?.type,
      hardware_id: req.body?.hardware_id,
      ts: req.body?.ts,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, gabim: e.message });
  }
});

module.exports = router;
