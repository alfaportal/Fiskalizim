#!/usr/bin/env node
"use strict";

process.env.FISCAL_LOCAL_RUN = "1";
process.env.ATK_TEST_MODE = "1";

const path = require("path");
const BIZNES_ROOT = path.resolve(__dirname, "..");
process.chdir(BIZNES_ROOT);

require("../portable-path").applyPortableEnv();

const { applyFiscalLocalRunEnvironment, ensureLocalDemoFiscalSettings } =
  require("./fiscal-local-env");
applyFiscalLocalRunEnvironment();

async function main() {
  const database = require("../database");
  await database.initDatabase();
  const { initFiscalDB } = require("./fiscal-db");
  initFiscalDB(database);
  ensureLocalDemoFiscalSettings();

  const { resetDailyCounter, getNextDailyNumber } = require("./fiscal-numbering");
  const sqlite = database.db;

  try {
    sqlite
      .prepare(`ALTER TABLE fiscal_settings ADD COLUMN last_daily_number_date TEXT`)
      .run();
  } catch {
    /* exists */
  }

  const row = sqlite
    .prepare(
      `SELECT daily_receipt_counter, last_z_report_date, last_daily_number_date
       FROM fiscal_settings WHERE id = 1`
    )
    .get();
  const snapshot = {
    counter: Number(row?.daily_receipt_counter) || 0,
    lastZ: row?.last_z_report_date != null ? String(row.last_z_report_date) : null,
    lastDaily:
      row?.last_daily_number_date != null ? String(row.last_daily_number_date) : null,
  };

  try {
    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
          daily_receipt_counter = 0,
          last_z_report_date = NULL,
          last_daily_number_date = NULL
         WHERE id = 1`
      )
      .run();

    const issued = [];
    for (let i = 0; i < 5; i += 1) {
      issued.push(Number(getNextDailyNumber()));
    }

    resetDailyCounter();
    const afterZ = Number(getNextDailyNumber());

    const pass = issued.join(",") === "1,2,3,4,5" && afterZ === 1;
    console.log(JSON.stringify({ pass, issued, afterZ }, null, 2));
    process.exitCode = pass ? 0 : 1;
  } finally {
    sqlite
      .prepare(
        `UPDATE fiscal_settings SET
          daily_receipt_counter = ?,
          last_z_report_date = ?,
          last_daily_number_date = ?,
          updated_at = datetime('now','localtime')
         WHERE id = 1`
      )
      .run(snapshot.counter, snapshot.lastZ, snapshot.lastDaily);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
