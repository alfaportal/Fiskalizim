/**
 * Revolution Fiskalizim — license API server (Railway)
 * Publik: https://revolution-pos.com/fiskalizim/api/license/*
 */
require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const licenseRouter = require("./routes/license");
const adminRouter = require("./routes/admin");

const app = express();
const PORT = Number(process.env.PORT) || 8080;

let pkgVersion = "0.0.0";
try {
  pkgVersion = require(path.join(__dirname, "..", "package.json")).version || pkgVersion;
} catch {
  /* optional */
}

app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

function healthPayload() {
  return {
    ok: true,
    service: "fiskalizim-license",
    app_type: "fiskalizim",
    license_api: true,
    version: pkgVersion,
    git_commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
    git_branch: process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || null,
    supabase_url: process.env.SUPABASE_URL || "https://oqquiuisreztzcyehpiq.supabase.co",
    web_url: "https://revolution-pos.com/fiskalizim",
    time: new Date().toISOString(),
  };
}

app.get("/health", (_req, res) => {
  res.json(healthPayload());
});

app.get("/fiskalizim/health", (_req, res) => {
  res.json(healthPayload());
});

app.use("/fiskalizim/api/license", licenseRouter);
app.use("/fiskalizim/api/admin", adminRouter);

try {
  const { dedupeLicensesByHardware } = require("./adminService");
  dedupeLicensesByHardware()
    .then((r) => {
      if (r.removed) {
        console.log(`[fiskalizim] u fshinë ${r.removed} licenca duplikate (1 për hardware_id)`);
      }
    })
    .catch((e) => console.warn("[fiskalizim] dedupe licenses:", e.message || e));
} catch (e) {
  console.warn("[fiskalizim] dedupe licenses:", e.message || e);
}

app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err?.message || err);
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ gabim: "JSON i pavlefshëm në trupin e kërkesës." });
  }
  if (!res.headersSent) {
    res.status(500).json({ gabim: err?.message || "Gabim i brendshëm serveri." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[fiskalizim-license] listening on :${PORT}`);
  console.log("[fiskalizim-license] POST /fiskalizim/api/license/validate|heartbeat|activate|by-hardware");
  console.log("[fiskalizim-license] admin: /fiskalizim/api/admin/* (SUPER_ADMIN_SECRET)");
});
