/**
 * Super Admin API — Revolution Fiskalizim (licenca).
 * Header: x-admin-secret | body.secret | query.secret
 */
const express = require("express");
const {
  listLicenses,
  registerClientWithLicense,
  setLicenseStatus,
  deleteLicense,
  deleteClient,
} = require("../adminService");

const router = express.Router();

const DEFAULT_ADMIN_SECRET = "naser-fiskalizim-2026";

function acceptedAdminSecrets() {
  return new Set(
    [process.env.SUPER_ADMIN_SECRET, process.env.ADMIN_SECRET, DEFAULT_ADMIN_SECRET]
      .map((s) => String(s || "").trim())
      .filter(Boolean),
  );
}

function requireAdmin(req, res, next) {
  const provided = String(
    req.get("x-admin-secret") || req.body?.secret || req.query?.secret || "",
  ).trim();
  const secrets = acceptedAdminSecrets();
  if (provided && secrets.has(provided)) {
    return next();
  }
  return res.status(401).json({
    ok: false,
    gabim: "Unauthorized — secret i Super Admin.",
    code: "ADMIN_AUTH",
  });
}

router.use(requireAdmin);

router.get("/licenses", async (_req, res) => {
  try {
    const licenses = await listLicenses();
    res.json({ ok: true, licenses });
  } catch (e) {
    console.error("[admin/licenses]", e.message || e);
    res.status(500).json({ ok: false, gabim: e.message });
  }
});

router.post("/clients/register-license", async (req, res) => {
  try {
    const data = await registerClientWithLicense(req.body || {});
    res.json({
      ok: true,
      ...data,
      already_exists: !!data.already_exists,
      message: data.already_exists ? "Tashmë ekziston" : data.message,
    });
  } catch (e) {
    console.error("[admin/clients/register-license]", e.message || e);
    res.status(400).json({ ok: false, gabim: e.message });
  }
});

router.post("/licenses/:id/status", async (req, res) => {
  try {
    const license = await setLicenseStatus(req.params.id, req.body?.status);
    res.json({ ok: true, license });
  } catch (e) {
    res.status(400).json({ ok: false, gabim: e.message });
  }
});

router.post("/licenses/:id/revoke", async (req, res) => {
  try {
    const license = await setLicenseStatus(req.params.id, "revoked");
    res.json({ ok: true, license, revoked: true });
  } catch (e) {
    res.status(400).json({ ok: false, gabim: e.message });
  }
});

router.delete("/licenses/:id", async (req, res) => {
  try {
    const data = await deleteLicense(req.params.id);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, gabim: e.message });
  }
});

router.delete("/clients/:id", async (req, res) => {
  try {
    const data = await deleteClient(req.params.id);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, gabim: e.message });
  }
});

module.exports = router;
