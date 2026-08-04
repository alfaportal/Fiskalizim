/**
 * Server lokal — POS minimal për testim ATK/SEF.
 */
const path = require("path");
const express = require("express");
const db = require("./database");

const PORT = Number(process.env.BIZNES_PORT) || 3971;
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Tekst i përbashkët për Modin X, Raportin Z dhe raportin periodik. */
function buildFiscalDayReportText(details, settings, mode) {
  const m = String(mode || details.mode || "Z").toUpperCase();
  const isX = m === "X";
  const isPeriodic = m === "PERIODIC" || m === "P";
  const w = 42;
  const line = (ch = "=") => ch.repeat(w);
  const row = (label, val) => {
    const v = String(val ?? "");
    const gap = Math.max(1, w - label.length - v.length);
    return `${label}${" ".repeat(gap)}${v}`;
  };
  const vat = details.vat_breakdown || {};
  const title = isPeriodic
    ? "RAPORTI PERIODIK"
    : isX
      ? "RAPORTI X (MODI X)"
      : "RAPORTI FISKAL DITOR (Z)";
  const subtitle = isPeriodic
    ? "Mes dy datave — JO mbyllje"
    : isX
      ? "Gjendja aktuale — JO mbyllje"
      : "Mbyllje zyrtare e ditës";
  const lines = [
    line("="),
    title,
    subtitle,
    line("-"),
    row("Biznesi:", settings.taxpayer_legal_name || "-"),
    row("NUI:", settings.taxpayer_nui || "-"),
    row("Njësia:", settings.unit_name || "-"),
    row("SEF ID:", require("./fiscal/fiscal-numbering").getSefIdentifier() || "-"),
    row("Data:", details.date || "-"),
    line("-"),
    row("Nr. kuponësh:", details.coupon_count ?? 0),
    row("Totali (EUR):", money(details.total_amount).toFixed(2)),
    row("Tot. pa TVSH:", money(details.total_without_tax).toFixed(2)),
    row("TVSH A:", money(vat.A).toFixed(2)),
    row("TVSH B:", money(vat.B).toFixed(2)),
    row("TVSH C:", money(vat.C).toFixed(2)),
    row("TVSH D 8%:", money(vat.D).toFixed(2)),
    row("TVSH E 18%:", money(vat.E).toFixed(2)),
    row("Offline:", details.offline_count ?? 0),
  ];
  if (isX || isPeriodic) {
    lines.push(row("Reset ditor:", isPeriodic ? "JO (periodik)" : "JO (Modi X)"));
    lines.push(line("="));
    lines.push("Mund të printohet shumë herë");
  } else {
    lines.push(row("Reset ditor:", details.reset_applied ? "PO" : "JO (tashmë)"));
    lines.push(line("="));
    lines.push("PEF/SF ËSHTË PASTRUAR");
    // Nuk ka kapacitet RFD në SEF lokal — placeholder: numri i RFD/kuponëve të krijuar deri tani
    const rfdCreated =
      details.rfd_created_count != null
        ? Number(details.rfd_created_count) || 0
        : Number(details.coupon_count) || 0;
    lines.push(row("RFD të krijuara:", String(rfdCreated)));
    lines.push("Fundi i raportit Z");
  }
  lines.push("");
  return lines.join("\n");
}

function buildZReportText(details, settings) {
  return buildFiscalDayReportText(details, settings, "Z");
}

function buildXReportText(details, settings) {
  return buildFiscalDayReportText(details, settings, "X");
}

function reportLayoutHelpers() {
  const w = 42;
  const line = (ch = "=") => ch.repeat(w);
  const row = (label, val) => {
    const v = String(val ?? "");
    const gap = Math.max(1, w - label.length - v.length);
    return `${label}${" ".repeat(gap)}${v}`;
  };
  const center = (s) => {
    const t = String(s || "");
    if (t.length >= w) return t.slice(0, w);
    const pad = Math.floor((w - t.length) / 2);
    return `${" ".repeat(pad)}${t}`;
  };
  return { w, line, row, center };
}

/** Neni 13 / 7 — Raport fiskal periodik i përmbledhur (i shkurtër). */
function buildShortPeriodicReportText(details, settings) {
  const { line, row, center } = reportLayoutHelpers();
  const turnover = details.vat_turnover || {};
  const tax = details.vat_breakdown || {};
  const lines = [
    line("="),
    center(settings.taxpayer_legal_name || "Biznesi"),
    row("NUI:", settings.taxpayer_nui || "-"),
    row("NF / TVSH:", settings.taxpayer_vat_number || settings.taxpayer_vat || "-"),
    row("Njësia:", settings.unit_name || "-"),
    row("SEF ID:", require("./fiscal/fiscal-numbering").getSefIdentifier() || "-"),
    line("-"),
    center(details.report_name || "RAPORT FISKAL PERIODIK I PËRMBLEDHUR"),
    line("-"),
    row("Data fillimit:", details.from_date || "-"),
    row("Data fundit:", details.to_date || "-"),
    row("Fiskalizimi:", details.fiscalization_datetime || "-"),
    line("-"),
    row("Nr. RFD / kuponë:", details.rfd_count ?? details.coupon_count ?? 0),
    row("Qarkullim me TVSH:", money(details.total_amount).toFixed(2)),
    row("Tatim TVSH total:", money(details.total_tax).toFixed(2)),
    line("-"),
    "Qarkullimi sipas normës:",
    row("  A (0%):", money(turnover.A).toFixed(2)),
    row("  C (0%):", money(turnover.C).toFixed(2)),
    row("  D (8%):", money(turnover.D).toFixed(2)),
    row("  E (18%):", money(turnover.E).toFixed(2)),
    "Tatimi sipas normës:",
    row("  A:", money(tax.A).toFixed(2)),
    row("  C:", money(tax.C).toFixed(2)),
    row("  D:", money(tax.D).toFixed(2)),
    row("  E:", money(tax.E).toFixed(2)),
    line("="),
    center("Fundi i raportit"),
    "",
  ];
  return lines.join("\n");
}

/** Neni 11 / 9 — Raporti mujor i memories fiskale të transferuar në ATK. */
function buildMonthlyMemoryReportText(details, settings) {
  const { line, row, center } = reportLayoutHelpers();
  const payMap = {
    cash: "KESH",
    card: "KARTELË",
    debit: "DEBIT",
    credit: "KREDIT",
    voucher: "VOUCHER",
    mixed: "E PËRZIER",
    other: "TJETER",
  };
  const payments = details.payments || {};
  const payLines = Object.keys(payments).length
    ? Object.entries(payments).map(([k, v]) =>
        row(`  ${payMap[k] || k.toUpperCase()}:`, money(v).toFixed(2))
      )
    : [row("  (pa pagesa):", "0.00")];

  const lines = [
    line("="),
    center(settings.taxpayer_legal_name || "Biznesi"),
    row("NUI:", settings.taxpayer_nui || "-"),
    row("Njësia:", settings.unit_name || "-"),
    row("SEF ID:", require("./fiscal/fiscal-numbering").getSefIdentifier() || "-"),
    line("-"),
    center(details.report_name || "RAPORTI MUJOR I MEMORIES FISKALE"),
    center("I TRANSFERUAR NË SISTEMIN E ATK"),
    line("-"),
    row("Data fillimit:", details.from_date || "-"),
    row("Data fundit:", details.to_date || "-"),
    row("Data fiskalizimit:", details.fiscalization_date || "-"),
    row("Ora fiskalizimit:", details.fiscalization_time || "-"),
    line("-"),
    row("Nr. RFD në periudhë:", details.rfd_count ?? details.coupon_count ?? 0),
    row("Qarkullim me TVSH:", money(details.total_amount).toFixed(2)),
    row("Tatim TVSH total:", money(details.total_tax).toFixed(2)),
    row("Tot. pa TVSH:", money(details.total_without_tax).toFixed(2)),
    row("Resetime RAM (Z):", details.ram_resets ?? 0),
    line("-"),
    "Mënyra e pagesës:",
    ...payLines,
    line("-"),
    center(details.transmission_text || "Transmetimi jo OK"),
    line("="),
    center("Fundi i raportit"),
    "",
  ];
  return lines.join("\n");
}

async function boot() {
  await db.initDatabase();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, app: "biznes", purpose: "ATK SEF test", desktop: true });
  });

  /** Login operatori — audit write-once (kush / kur / IP). */
  app.post("/api/auth/login", (req, res) => {
    try {
      const operatorName = String(req.body?.operator_name || req.body?.name || "").trim();
      const operatorId = String(req.body?.operator_id || req.body?.id || "POS").trim() || "POS";
      if (!operatorName) throw new Error("Emri i operatorit është i detyrueshëm");
      const ip =
        String(req.headers["x-forwarded-for"] || "")
          .split(",")[0]
          .trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        "";
      const { logFiscalAction } = require("./fiscal/fiscal-audit");
      const entry = logFiscalAction(
        "login",
        {
          event: "login",
          operator_name: operatorName,
          operator_id: operatorId,
          ip: ip || null,
          user_agent: String(req.headers["user-agent"] || "").slice(0, 180) || null,
          at: new Date().toISOString(),
        },
        operatorName,
        operatorId
      );
      res.json({
        ok: true,
        operator_name: operatorName,
        operator_id: operatorId,
        ip: ip || null,
        audit_id: entry?.id || null,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/printers", async (_req, res) => {
    try {
      const printer = require("./printer");
      let list = await printer.listPrinters();
      // Termikët (Tysso) sipër; PDF/OneNote poshtë
      list = [...(list || [])].sort((a, b) => {
        const score = (p) => {
          const n = String(p.name || "").toLowerCase();
          if (n.includes("tysso")) return 0;
          if (p.type === "thermal") return 1;
          if (p.type === "fiscal") return 2;
          return 9;
        };
        return score(a) - score(b);
      });
      let currentName = db.getSetting("printer_name", "") || "";
      if (!currentName || !list.some((p) => p.name === currentName)) {
        const auto = printer.pickAutoPrinter(list);
        if (auto) {
          currentName = auto;
          db.setSetting("printer_name", auto);
          db.setSetting("printer_paper", "80mm");
        }
      }
      const current = {
        name: currentName,
        paper: db.getSetting("printer_paper", "80mm") || "80mm",
      };
      res.json({ ok: true, printers: list, current });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/printers", async (req, res) => {
    try {
      const printer = require("./printer");
      const name = String(req.body?.name || "").trim();
      const paper = String(req.body?.paper || "80mm").trim() || "80mm";
      printer.savePrinterConfig(db, { name, paper });
      res.json({
        ok: true,
        current: {
          name: db.getSetting("printer_name", "") || "",
          paper: db.getSetting("printer_paper", "80mm") || "80mm",
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/printers/test", async (_req, res) => {
    try {
      const printer = require("./printer");
      const text =
        "==========================================\n" +
        "       BIZNES — TEST PRINTUESI\n" +
        "==========================================\n" +
        "ATK / SEF test desktop\n" +
        new Date().toLocaleString("sq-AL") +
        "\n==========================================\n\n\n";
      await printer.printPlainTextAt(text, db, "bar");
      res.json({ ok: true, message: "U dërgua te printeri" });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/products", (_req, res) => {
    try {
      const products = db.listProducts();
      const byLetter = { A: [], C: [], D: [], E: [] };
      for (const p of products) {
        const L = String(p.vat_letter || "E").toUpperCase();
        if (byLetter[L]) byLetter[L].push(p);
        else byLetter.E.push(p);
      }
      res.json({ ok: true, products, byLetter });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/fiscal/settings", (_req, res) => {
    try {
      const { getSefIdentifier } = require("./fiscal/fiscal-numbering");
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      const s = db.getFiscalSettingsRow();
      res.json({
        ok: true,
        settings: { ...s, sef_identifier_computed: getSefIdentifier() || "" },
        atk: getAtkStatus(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/fiscal/settings", (req, res) => {
    try {
      const saved = db.saveFiscalSettings({
        ...(req.body || {}),
        fiscal_enabled: true,
      });
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      res.json({ ok: true, settings: saved, atk: getAtkStatus() });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/fiscal/atk-status", (_req, res) => {
    try {
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      res.json({ ok: true, atk: getAtkStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/open-keys-folder", (_req, res) => {
    try {
      const { getKeysDir } = require("./fiscal/fiscal-crypto");
      const fs = require("fs");
      const { exec } = require("child_process");
      const dir = getKeysDir();
      fs.mkdirSync(dir, { recursive: true });
      exec(`explorer "${dir}"`);
      res.json({ ok: true, keys_dir: dir });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/send-pending", async (_req, res) => {
    try {
      const { processOfflineQueue } = require("./fiscal/fiscal-offline");
      const result = await processOfflineQueue();
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/orders", (_req, res) => {
    try {
      res.json({ ok: true, orders: db.listRecentOrders(80) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Checkout: regjistron shitjen + emeton kupon fiskal + print */
  app.post("/api/checkout", async (req, res) => {
    try {
      const preview = db.previewSaleTotals({
        items: req.body?.items || [],
        cart_discount: req.body?.cart_discount || null,
        cart_surcharge: req.body?.cart_surcharge || null,
      });

      // Neni 11 p.25 — konfirmim shtesë për > 1000€ (para INSERT)
      if (preview.total > 1000 && !req.body?.confirmed_over_1000) {
        return res.status(409).json({
          ok: false,
          needs_confirm_over_1000: true,
          total: preview.total,
          error: "Transaksioni > 1000€ kërkon konfirmim shtesë (Neni 11 / 25)",
        });
      }

      const sale = db.createSale({
        items: req.body?.items || [],
        payment_method: req.body?.payment_method || "cash",
        operator_name: req.body?.operator_name || "Operator",
        cart_discount: req.body?.cart_discount || null,
        cart_surcharge: req.body?.cart_surcharge || null,
        payment_splits: req.body?.payment_splits || null,
      });

      const { processFiscalReceipt } = require("./fiscal/fiscal-main");
      const fiscal = await processFiscalReceipt(sale.id, sale.payment_method, {
        items: sale.items,
        operator_name: sale.operator_name,
        operator_id: "POS",
        total_amount: sale.total,
        subtotal: sale.subtotal,
        discount_amount: sale.discount_total,
        surcharge_amount: sale.surcharge_total,
        payment_splits: sale.payment_splits,
        skip_print: !!req.body?.skip_print,
      });

      res.json({
        ok: true,
        order_id: sale.id,
        total: sale.total,
        subtotal: sale.subtotal,
        discount_total: sale.discount_total,
        surcharge_total: sale.surcharge_total,
        payment_method: sale.payment_method,
        payment_splits: sale.payment_splits,
        fiscal,
      });
    } catch (e) {
      console.error("[checkout]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Anulim / storno kuponi fiskal */
  app.post("/api/fiscal/storno", async (req, res) => {
    try {
      const nuikf = String(req.body?.nuikf || "").trim().toUpperCase();
      if (!nuikf) throw new Error("NUIKF mungon");
      const type = String(req.body?.type || "storno").toLowerCase();
      const correctionType =
        type === "cancel" ? "cancel" : type === "return" ? "return" : "storno";
      const { createCorrectionReceipt } = require("./fiscal/fiscal-correction");
      const { printFiscalBundle } = require("./fiscal/fiscal-main");
      const { generateFiscalQR } = require("./fiscal/fiscal-qr");

      const result = createCorrectionReceipt(
        nuikf,
        correctionType,
        correctionType === "return" ? req.body?.items || null : null,
        req.body?.reason || `${correctionType} ATK`,
        {
          operator_name: req.body?.operator_name || "Operator",
          operator_id: "POS",
        }
      );

      let qrResult = null;
      try {
        const settings = db.getFiscalSettingsRow();
        qrResult = await generateFiscalQR({
          nuikf: result.nuikf,
          total_amount: result.total_amount,
          fiscal_date: result.fiscal_date,
          taxpayer_nui: settings.taxpayer_nui,
        });
      } catch (qe) {
        console.warn("[storno] QR:", qe.message);
      }

      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print && result.print_text) {
        const pr = await printFiscalBundle(result.print_text, qrResult);
        printed = pr.printed;
        printMessage = pr.printMessage || "";
      }

      res.json({
        ok: true,
        correction: {
          id: result.id,
          nuikf: result.nuikf,
          original_nuikf: result.original_nuikf,
          receipt_type: result.receipt_type,
          total_amount: result.total_amount,
        },
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[storno]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Lista kuponësh fiskalë */
  app.get("/api/fiscal/receipts", (_req, res) => {
    try {
      const rows = db.db
        .prepare(
          `SELECT id, nuikf, sef_id, receipt_type, original_nuikf, daily_number, total_number,
                  fiscal_date, fiscal_time, total_amount, payment_method, created_at
           FROM fiscal_receipts
           ORDER BY id DESC LIMIT 100`
        )
        .all();
      res.json({ ok: true, receipts: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Print Preview — tekst i kuponit, pa printim letre. */
  app.get("/api/fiscal/receipts/:id/preview", (req, res) => {
    try {
      const { getFiscalReceiptPreview } = require("./fiscal/fiscal-receipts-list");
      const preview = getFiscalReceiptPreview(req.params.id);
      if (!preview) throw new Error("Fiskalizimi nuk është aktiv");
      res.json({
        ok: true,
        receipt_id: preview.id,
        nuikf: preview.nuikf,
        text: preview.print_text,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Reprint i kuponit origjinal (pas Preview) — pa INSERT të ri. */
  app.post("/api/fiscal/receipts/:id/print", async (req, res) => {
    try {
      const { prepareFiscalReceiptReprint } = require("./fiscal/fiscal-receipts-list");
      const { printFiscalBundle } = require("./fiscal/fiscal-main");
      const { generateFiscalQR } = require("./fiscal/fiscal-qr");
      const reprint = prepareFiscalReceiptReprint(req.params.id);
      let qrResult = null;
      try {
        qrResult = await generateFiscalQR({
          nuikf: reprint.nuikf,
          total_amount: reprint.total_amount,
          fiscal_date: reprint.fiscal_date,
          taxpayer_nui: reprint.taxpayer_nui,
        });
      } catch (qe) {
        console.warn("[print] QR:", qe.message);
      }
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        const pr = await printFiscalBundle(reprint.print_text, qrResult);
        printed = pr.printed;
        printMessage = pr.printMessage || "";
      }
      res.json({
        ok: true,
        receipt_id: reprint.id,
        nuikf: reprint.nuikf,
        text: reprint.print_text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[print]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /**
   * Kopje e kuponit — riprint me "KOPJE E KUPONIT".
   * NUK krijon kupon të ri fiskal (pa INSERT në fiscal_receipts).
   */
  app.post("/api/fiscal/receipts/:id/print-copy", async (req, res) => {
    try {
      const { prepareFiscalReceiptCopy } = require("./fiscal/fiscal-receipts-list");
      const { printFiscalBundle } = require("./fiscal/fiscal-main");
      const { generateFiscalQR } = require("./fiscal/fiscal-qr");

      const copy = prepareFiscalReceiptCopy(req.params.id);
      let qrResult = null;
      try {
        qrResult = await generateFiscalQR({
          nuikf: copy.nuikf,
          total_amount: copy.total_amount,
          fiscal_date: copy.fiscal_date,
          taxpayer_nui: copy.taxpayer_nui,
        });
      } catch (qe) {
        console.warn("[print-copy] QR:", qe.message);
      }

      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        const pr = await printFiscalBundle(copy.print_text, qrResult);
        printed = pr.printed;
        printMessage = pr.printMessage || "";
      }

      res.json({
        ok: true,
        is_copy: true,
        receipt_id: copy.id,
        nuikf: copy.nuikf,
        text: copy.print_text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[print-copy]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Raporti X (Modi X) — gjendja aktuale, pa reset / pa mbyllje zyrtare */
  app.post("/api/fiscal/x-report", async (req, res) => {
    try {
      const { getXReportSnapshot, getSefIdentifier } = require("./fiscal/fiscal-numbering");
      const settings = db.getFiscalSettingsRow();
      const details = getXReportSnapshot(
        req.body?.operator_name || "Operator",
        "POS"
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");

      const text = buildXReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const printer = require("./printer");
          await printer.printPlainTextAt(text, db, "bar");
          printed = true;
        } catch (pe) {
          printMessage = pe.message || "Printimi X dështoi";
        }
      }

      res.json({
        ok: true,
        details: { ...details, sef_id: getSefIdentifier() || "" },
        text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[x-report]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Raporti Fiskal Ditor (Z) */
  app.post("/api/fiscal/z-report", async (req, res) => {
    try {
      const { onDailySummaryPrinted, getSefIdentifier } = require("./fiscal/fiscal-numbering");
      const settings = db.getFiscalSettingsRow();
      const details = onDailySummaryPrinted(
        req.body?.operator_name || "Operator",
        "POS"
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");

      const text = buildZReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const printer = require("./printer");
          await printer.printPlainTextAt(text, db, "bar");
          printed = true;
        } catch (pe) {
          printMessage = pe.message || "Printimi Z dështoi";
        }
      }

      res.json({
        ok: true,
        details: { ...details, sef_id: getSefIdentifier() || "" },
        text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[z-report]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Raport periodik (mes dy datave) */
  app.post("/api/fiscal/periodic-report", async (req, res) => {
    try {
      const { getPeriodicFiscalReport, getSefIdentifier } = require("./fiscal/fiscal-numbering");
      const settings = db.getFiscalSettingsRow();
      const details = getPeriodicFiscalReport(
        req.body?.from || req.body?.from_date,
        req.body?.to || req.body?.to_date,
        req.body?.operator_name || "Operator",
        "POS"
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");
      const text = buildFiscalDayReportText(details, settings, "PERIODIC");
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const printer = require("./printer");
          await printer.printPlainTextAt(text, db, "bar");
          printed = true;
        } catch (pe) {
          printMessage = pe.message || "Printimi periodik dështoi";
        }
      }
      res.json({
        ok: true,
        details: { ...details, sef_id: getSefIdentifier() || "" },
        text,
        printed,
        printMessage,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Raport i shkurtër periodik (Neni 13 / 7) */
  app.post("/api/fiscal/short-periodic-report", async (req, res) => {
    try {
      const {
        getShortPeriodicFiscalReport,
        getSefIdentifier,
      } = require("./fiscal/fiscal-numbering");
      const settings = db.getFiscalSettingsRow();
      const details = getShortPeriodicFiscalReport(
        req.body?.from || req.body?.from_date,
        req.body?.to || req.body?.to_date,
        req.body?.operator_name || "Operator",
        "POS"
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");
      const text = buildShortPeriodicReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const printer = require("./printer");
          await printer.printPlainTextAt(text, db, "bar");
          printed = true;
        } catch (pe) {
          printMessage = pe.message || "Printimi i raportit të shkurtër dështoi";
        }
      }
      res.json({
        ok: true,
        details: { ...details, sef_id: getSefIdentifier() || "" },
        text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[short-periodic]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Raporti mujor i memories fiskale → ATK (Neni 11 / 9) */
  app.post("/api/fiscal/monthly-memory-report", async (req, res) => {
    try {
      const {
        getMonthlyFiscalMemoryReport,
        getSefIdentifier,
      } = require("./fiscal/fiscal-numbering");
      const settings = db.getFiscalSettingsRow();
      const details = getMonthlyFiscalMemoryReport(
        req.body?.from || req.body?.from_date,
        req.body?.to || req.body?.to_date,
        req.body?.operator_name || "Operator",
        "POS"
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");
      const text = buildMonthlyMemoryReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const printer = require("./printer");
          await printer.printPlainTextAt(text, db, "bar");
          printed = true;
        } catch (pe) {
          printMessage = pe.message || "Printimi i raportit mujor dështoi";
        }
      }
      res.json({
        ok: true,
        details: { ...details, sef_id: getSefIdentifier() || "" },
        text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[monthly-memory]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Eksport audit log CSV/PDF (Neni 26 / 7) */
  app.post("/api/fiscal/audit/export", (req, res) => {
    try {
      const { exportAuditCSV, exportAuditPDF } = require("./fiscal/fiscal-audit");
      const from = req.body?.from || req.body?.from_date;
      const to = req.body?.to || req.body?.to_date;
      const format = String(req.body?.format || "csv").toLowerCase();
      const filePath =
        format === "pdf" ? exportAuditPDF(from, to) : exportAuditCSV(from, to);
      if (!filePath) throw new Error("Fiskalizimi nuk është aktiv ose eksporti dështoi");
      res.json({ ok: true, format, filePath });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /**
   * Ndërrim artikulli: kthim (return) i të vjetrit + shitje e re.
   * Kusht: çmim i ri ≥ i vjetri, e njëjta normë TVSH.
   */
  app.post("/api/fiscal/exchange", async (req, res) => {
    try {
      const nuikf = String(req.body?.nuikf || "").trim().toUpperCase();
      const newProductId = Number(req.body?.new_product_id);
      if (!nuikf) throw new Error("NUIKF origjinal mungon");
      if (!newProductId) throw new Error("Produkti i ri mungon");

      const { getOriginalReceipt, createCorrectionReceipt } = require("./fiscal/fiscal-correction");
      const original = getOriginalReceipt(nuikf);
      if (!original) throw new Error("Kuponi origjinal nuk u gjet");

      const oldItems = original.items || [];
      let oldItem = null;
      if (req.body?.old_item && typeof req.body.old_item === "object") {
        oldItem = oldItems.find(
          (o) =>
            String(o.name) === String(req.body.old_item.name) &&
            Math.abs(Number(o.price) - Number(req.body.old_item.price)) < 0.0001
        );
      }
      if (!oldItem) oldItem = oldItems[Number(req.body?.old_index) || 0];
      if (!oldItem) throw new Error("Artikulli i vjetër nuk u gjet në kupon");

      const products = db.listProducts();
      const neu = products.find((p) => Number(p.id) === newProductId);
      if (!neu) throw new Error("Produkti i ri nuk ekziston");

      const oldVat = String(oldItem.vat_norm || oldItem.vat_letter || "E").toUpperCase();
      const newVat = String(neu.vat_letter || "E").toUpperCase();
      if (oldVat !== newVat) {
        throw new Error(`Norma TVSH duhet e njëjtë (${oldVat} ≠ ${newVat})`);
      }
      const oldPrice = Number(oldItem.unit_price ?? oldItem.price) || 0;
      const newPrice = Number(neu.price) || 0;
      if (newPrice + 1e-9 < oldPrice) {
        throw new Error(
          `Çmimi i ri (${newPrice}) duhet ≥ çmimi i vjetër (${oldPrice})`
        );
      }

      const qty = Number(req.body?.quantity || oldItem.quantity || 1) || 1;
      const reason = req.body?.reason || "Ndërrim artikulli ATK";

      const ret = createCorrectionReceipt(
        nuikf,
        "return",
        [
          {
            name: oldItem.name,
            quantity: qty,
            price: oldPrice,
            unit_price: oldPrice,
            vat_norm: oldVat,
          },
        ],
        reason,
        { operator_name: req.body?.operator_name || "Operator", operator_id: "POS" }
      );

      const sale = db.createSale({
        items: [
          {
            product_id: neu.id,
            name: neu.name,
            price: newPrice,
            quantity: qty,
            vat_letter: newVat,
          },
        ],
        payment_method: req.body?.payment_method || original.payment_method || "cash",
        operator_name: req.body?.operator_name || "Operator",
      });

      const { processFiscalReceipt, printFiscalBundle } = require("./fiscal/fiscal-main");
      const { generateFiscalQR } = require("./fiscal/fiscal-qr");
      const fiscalNew = await processFiscalReceipt(sale.id, sale.payment_method, {
        items: sale.items,
        operator_name: sale.operator_name,
        operator_id: "POS",
        total_amount: sale.total,
        subtotal: sale.subtotal,
        skip_print: !!req.body?.skip_print,
      });

      let printedReturn = false;
      if (!req.body?.skip_print && ret.print_text) {
        let qr = null;
        try {
          qr = await generateFiscalQR({
            nuikf: ret.nuikf,
            total_amount: ret.total_amount,
            fiscal_date: ret.fiscal_date,
            taxpayer_nui: db.getFiscalSettingsRow().taxpayer_nui,
          });
        } catch {
          /* */
        }
        const pr = await printFiscalBundle(ret.print_text, qr);
        printedReturn = !!pr.printed;
      }

      res.json({
        ok: true,
        return_coupon: {
          nuikf: ret.nuikf,
          original_nuikf: ret.original_nuikf,
          receipt_type: ret.receipt_type,
          total_amount: ret.total_amount,
          printed: printedReturn,
        },
        new_sale: {
          order_id: sale.id,
          total: sale.total,
          fiscal: fiscalNew,
        },
      });
    } catch (e) {
      console.error("[exchange]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Self-test fiskal (opsional) */
  app.post("/api/fiscal/self-test", async (_req, res) => {
    try {
      const { runFiscalSelfTest } = require("./fiscal/fiscal-self-test");
      const result = await runFiscalSelfTest({ skip_print: true });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Rikuperim manual pas ndërprerjes (Neni 11 / 7) */
  app.get("/api/fiscal/pending", (_req, res) => {
    try {
      const { listOpenPending } = require("./fiscal/fiscal-recovery");
      res.json({ ok: true, pending: listOpenPending() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/recovery/resume", async (req, res) => {
    try {
      const {
        resumeAllPendingOnBoot,
        resumePendingPrint,
        listOpenPending,
      } = require("./fiscal/fiscal-recovery");
      if (req.body?.pending_id) {
        const all = listOpenPending();
        const p = all.find((x) => Number(x.id) === Number(req.body.pending_id));
        if (!p) throw new Error("Pending nuk u gjet");
        const result = await resumePendingPrint(p, {
          skip_print: !!req.body?.skip_print,
        });
        return res.json({ ok: true, result });
      }
      const result = await resumeAllPendingOnBoot({
        skip_print: !!req.body?.skip_print,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  try {
    const { startOfflineMonitor } = require("./fiscal/fiscal-offline");
    startOfflineMonitor();
  } catch (e) {
    console.warn("[biznes] offline monitor:", e.message);
  }

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[biznes] ATK SEF test POS → http://127.0.0.1:${PORT}`);
    console.log(`[biznes] DB: ${db.DB_PATH}`);
    try {
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      const a = getAtkStatus();
      console.log(`[biznes] ATK ${a.environment}: ${a.atk_pos_coupon_url}`);
      console.log(`[biznes] Çelësat: ${a.keys_dir}`);
    } catch {
      /* */
    }
    // Neni 11 / 7 — rifillo printimet e papërfunduara pas boot
    setTimeout(() => {
      try {
        const { resumeAllPendingOnBoot } = require("./fiscal/fiscal-recovery");
        resumeAllPendingOnBoot({ skip_print: false })
          .then((r) => {
            if ((r.resumed && r.resumed.length) || (r.abandoned && r.abandoned.length)) {
              console.log(
                `[biznes] recovery: resumed=${r.resumed?.length || 0} abandoned=${r.abandoned?.length || 0}`
              );
            }
          })
          .catch((e) => console.warn("[biznes] recovery:", e.message));
      } catch (e) {
        console.warn("[biznes] recovery boot:", e.message);
      }
    }, 1500);
  });
}

boot().catch((e) => {
  console.error("Boot failed:", e);
  process.exit(1);
});
