const express = require("express");
const {
  ensureOwnerNotificationPreferences,
  assertOwnerSlug,
  getPreferencesForSlug,
  savePreferencesForOwner,
} = require("../ownerNotificationPreferences");

const router = express.Router();

router.get("/notification-preferences", async (req, res) => {
  try {
    await ensureOwnerNotificationPreferences();
    const slug = await assertOwnerSlug(req.query.slug);
    const prefs = await getPreferencesForSlug(slug);
    res.json({ ok: true, ...prefs });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, gabim: e.message });
  }
});

router.put("/notification-preferences", async (req, res) => {
  try {
    const prefs = await savePreferencesForOwner(req.body || {});
    res.json({ ok: true, ...prefs });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, gabim: e.message });
  }
});

module.exports = router;
