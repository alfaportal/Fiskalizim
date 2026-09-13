#!/usr/bin/env node
/**
 * fiscal/fiscal-run-local.js — nis testim lokal të modulit fiskal.
 *
 * ATK HTTP: i bllokuar plotësisht (FISCAL_LOCAL_RUN + ATK_TEST_MODE).
 * Përdorimi (nga folderi biznes/):
 *   node fiscal/fiscal-run-local.js
 *   node fiscal/fiscal-run-local.js self-test
 *   node fiscal/fiscal-run-local.js status
 *   node fiscal/fiscal-run-local.js proto
 */
"use strict";

const path = require("path");

// Env PARA çdo require fiskal — kritike
process.env.FISCAL_LOCAL_RUN = process.env.FISCAL_LOCAL_RUN || "0";
process.env.ATK_TEST_MODE = "1";
process.env.FISCAL_TEST_MODE = "1";

const {
  applyFiscalLocalRunEnvironment,
  ensureLocalDemoFiscalSettings,
  getLocalRunStatus,
} = require("./fiscal-local-env");

applyFiscalLocalRunEnvironment();

const BIZNES_ROOT = path.resolve(__dirname, "..");
process.chdir(BIZNES_ROOT);

function printBanner() {
  console.log("");
  console.log("=== Revolution Fiskalizim — Modul Fiskal (LOKAL) ===");
  console.log("ATK HTTP: BLLLUAR | Persistence: memorie + console");
  console.log("Working dir:", BIZNES_ROOT);
  console.log("");
}

function printHelp() {
  console.log(`Komanda:
  self-test   — 15 teste fiskale (default)
  status      — gjendja e profilit lokal + ATK block
  proto       — vetëm testi Protobuf zbritje (6c)
  help        — ky ekran

Shembull:
  node fiscal/fiscal-run-local.js
  node fiscal/fiscal-run-local.js self-test
`);
}

async function initDb() {
  const database = require(path.join(BIZNES_ROOT, "database"));
  await database.initDatabase();
  return database;
}

async function cmdStatus() {
  const status = getLocalRunStatus();
  const { getAtkStatus } = require("./fiscal-atk-api");
  let atk = null;
  try {
    atk = getAtkStatus();
  } catch (e) {
    atk = { error: e.message };
  }
  console.log(JSON.stringify({ local: status, atk }, null, 2));
}

async function cmdProto() {
  await initDb();
  ensureLocalDemoFiscalSettings();
  const { buildPosCoupon, encodePosCoupon } = require("./atk-model-builder");
  const { buildInternalTestCouponBundle } = require("./fiscal-test-coupon-data");
  const bundle = buildInternalTestCouponBundle({}, {});
  const items = bundle.items.map((it, i) =>
    i === 0 ? { ...it, line_discount_amount: 0.1234 } : it
  );
  const row = {
    items_json: JSON.stringify(items),
    total_amount: bundle.totals.total,
    total_without_tax: bundle.totals.totalWithoutTax,
    discount_amount: 0,
    payment_method: "cash",
    receipt_type: "regular",
    fiscal_date: "18.07.2026",
    fiscal_time: "12:00",
    nuikf: "LOCALPROTO000001",
    sef_id: "5130484-812345678-11",
    taxpayer_nui: "812345678",
    taxpayer_address: "Prishtine",
    operator_id: "LOCAL",
    daily_number: 1,
    total_number: 1,
    vat_breakdown_json: JSON.stringify(bundle.totals.tax),
  };
  const pos = buildPosCoupon(row, {
    settings: {
      taxpayer_nui: "812345678",
      pos_id: "11",
      business_unit_number: "5130484",
      unit_number: "5130484",
    },
  });
  const buf = encodePosCoupon(row, {
    settings: {
      taxpayer_nui: "812345678",
      pos_id: "11",
      business_unit_number: "5130484",
    },
  });
  console.log("PosCoupon items:", pos.items.length);
  console.log("Item[0] discount:", pos.items[0]?.discount);
  console.log("Protobuf:", buf.length, "bytes");
  console.log("OK — pa HTTP te ATK");
}

async function cmdSelfTest() {
  await initDb();
  ensureLocalDemoFiscalSettings();
  const { runFiscalSelfTest } = require("./fiscal-self-test");
  const report = await runFiscalSelfTest({ print: false });
  console.log("");
  console.log("--- Rezultati ---");
  for (const r of report.results || []) {
    const mark = r.pass ? "OK" : "FAIL";
    console.log(`${mark}  ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("");
  console.log(
    `Përmbledhje: ${report.summary?.passed}/${report.summary?.total} kaloi` +
      (report.ok ? " — GJITHA OK" : " — KA DËSHTIME")
  );
  if (!report.ok) process.exitCode = 1;
}

async function main() {
  printBanner();
  const cmd = (process.argv[2] || "self-test").trim().toLowerCase();
  try {
    switch (cmd) {
      case "help":
      case "-h":
      case "--help":
        printHelp();
        break;
      case "status":
        await initDb().catch(() => {});
        await cmdStatus();
        break;
      case "proto":
        await cmdProto();
        break;
      case "self-test":
      case "test":
        await cmdSelfTest();
        break;
      default:
        console.error("Komandë e panjohur:", cmd);
        printHelp();
        process.exitCode = 1;
    }
  } catch (e) {
    console.error("[fiscal-run-local] Gabim:", e.message || e);
    process.exitCode = 1;
  }
}

main();
