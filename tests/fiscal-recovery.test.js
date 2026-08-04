/**
 * Test praktik — Neni 11 / 7: rikuperim pas ndërprerjes pa dublikim.
 * Simulon: kupon krijuar → print i ndërprerë → resume me MUNGESË RRYME.
 */
const path = require("path");

async function main() {
  const db = require(path.join(__dirname, "..", "database"));
  await db.initDatabase();

  const recovery = require(path.join(__dirname, "..", "fiscal", "fiscal-recovery"));
  const { processFiscalReceipt } = require(path.join(__dirname, "..", "fiscal", "fiscal-main"));

  const products = db.listProducts();
  const e = products.find((p) => p.vat_letter === "E") || products[0];
  if (!e) throw new Error("Nuk ka produkte test");

  // 1) Checkout me skip_print=false do të printonte — ne krijojmë me skip pastaj "ndërpresim"
  const sale = db.createSale({
    items: [{ product_id: e.id, price: e.price, quantity: 1, vat_letter: e.vat_letter }],
    payment_method: "cash",
    operator_name: "RecoveryTest",
  });

  const fiscal = await processFiscalReceipt(sale.id, "cash", {
    items: sale.items,
    operator_name: "RecoveryTest",
    operator_id: "TEST",
    total_amount: sale.total,
    subtotal: sale.subtotal,
    skip_print: true, // markDone with skip — need open pending instead
  });

  // skip_print marks done — so simulate interrupt by manually leaving coupon_ready
  const sqlite = db.db;
  recovery.ensurePendingTxnTable(sqlite);

  // Simulo ndërprerje: pending hapur në coupon_ready me print_text
  const printText =
    fiscal.print_text ||
    "TEST KUPON\nTOTALI: " + Number(sale.total).toFixed(2) + "\nNUIKF: " + fiscal.nuikf;

  // Mbyll pending e markuar done nga skip_print dhe krijo pending të hapur (si pas crash)
  sqlite
    .prepare(`UPDATE pending_txn SET status='abandoned', stage='abandoned' WHERE order_id=? AND status='done'`)
    .run(sale.id);

  const ins = sqlite
    .prepare(
      `INSERT INTO pending_txn
         (order_id, fiscal_receipt_id, nuikf, stage, status, print_text, last_printed_line, operator_name, operator_id, details_json)
       VALUES (?, ?, ?, 'coupon_ready', 'open', ?, ?, 'RecoveryTest', 'TEST', '{}')`
    )
    .run(
      sale.id,
      fiscal.fiscal_receipt_id,
      fiscal.nuikf,
      printText,
      recovery.extractLastPrintedLine(printText)
    );
  const pendingId = Number(ins.lastInsertRowid);

  const beforeCount = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM fiscal_receipts WHERE sale_id = ?`)
    .get(sale.id).c;

  // 2) Resume pa print fizik — verifikon tekstin MUNGESË RRYME + pa kupon të ri
  const pending = sqlite.prepare(`SELECT * FROM pending_txn WHERE id = ?`).get(pendingId);
  const resumed = await recovery.resumePendingPrint(pending, { skip_print: true });

  const afterCount = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM fiscal_receipts WHERE sale_id = ?`)
    .get(sale.id).c;

  const retry = await processFiscalReceipt(sale.id, "cash", {
    skip_print: true,
  });

  const afterRetryCount = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM fiscal_receipts WHERE sale_id = ?`)
    .get(sale.id).c;

  const hasBanner = /MUNGESË RRYME|NEDOSTATAK STRUJE/i.test(resumed.recovery_text || "");
  const lastLine = recovery.extractLastPrintedLine(printText);
  const repeatsLast = lastLine && String(resumed.recovery_text || "").includes(lastLine);

  const pendingAfter = sqlite.prepare(`SELECT status, stage FROM pending_txn WHERE id = ?`).get(pendingId);

  console.log("--- fiscal-recovery.test ---");
  console.log("order_id", sale.id, "nuikf", fiscal.nuikf);
  console.log("receipts before/after/retry", beforeCount, afterCount, afterRetryCount);
  console.log("recovery banner", hasBanner);
  console.log("repeats last line", repeatsLast, JSON.stringify(lastLine));
  console.log("pending after", pendingAfter);
  console.log("already_fiscalized retry", !!retry.already_fiscalized);
  console.log("recovered flag", !!resumed.recovered);

  const ok =
    beforeCount === 1 &&
    afterCount === 1 &&
    afterRetryCount === 1 &&
    hasBanner &&
    repeatsLast &&
    pendingAfter.status === "done" &&
    !!retry.already_fiscalized;

  if (!ok) {
    console.error("FAIL");
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
