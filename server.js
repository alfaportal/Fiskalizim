/**
 * Server LOKAL — vetëm në këtë kompjuter (folder biznes).
 * Nuk hapet në rrjet / internet: bind vetëm 127.0.0.1.
 */
const path = require("path");
require("./portable-path").applyPortableEnv();
process.env.FISCAL_LOCAL_RUN = "1";
process.env.ATK_AUTO_SEND = "0";
process.env.BIZNES_ATK_SEND_ALLOWED = "0";
const express = require("express");
const db = require("./database");
const { onboardPosAtAtk } = require("./fiscal/fiscal-onboarding");
const { t, syncLanguageFromSettings } = require("./fiscal/fiscal-i18n");

function syncReportLanguage(settings) {
  syncLanguageFromSettings(settings?.language);
}

const PORT = Number(process.env.BIZNES_PORT) || 3972;
/** Gjithmonë localhost — asnjë akses nga LAN / internet */
const HOST = "127.0.0.1";
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    }
  },
}));

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function resolveBodyOperatorId(req) {
  return String(req.body?.operator_id || "POS").trim() || "POS";
}

/** Tekst i përbashkët për Modin X, Raportin Z dhe raportin periodik. */
function buildFiscalDayReportText(details, settings, mode) {
  syncReportLanguage(settings);
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
    ? t("report_periodic")
    : isX
      ? t("report_x")
      : t("report_z");
  const subtitle = isPeriodic
    ? t("report_subtitle_periodic")
    : isX
      ? t("report_subtitle_x")
      : t("report_subtitle_z");
  const lines = [
    line("="),
    title,
    subtitle,
    line("-"),
    row(t("report_business"), settings.taxpayer_legal_name || "-"),
    row(t("nui_label"), settings.taxpayer_nui || "-"),
    row(t("report_unit"), settings.unit_name || "-"),
    row(t("report_sef_id"), require("./fiscal/fiscal-numbering").getSefIdentifier() || "-"),
    row(t("date_label"), details.date || "-"),
    line("-"),
    row(t("report_coupon_count"), details.coupon_count ?? 0),
    row(t("report_total_eur"), money(details.total_amount).toFixed(2)),
    row(t("report_total_without_vat"), money(details.total_without_tax).toFixed(2)),
    row(t("report_vat_a"), money(vat.A).toFixed(2)),
    row(t("report_vat_b"), money(vat.B).toFixed(2)),
    row(t("report_vat_c"), money(vat.C).toFixed(2)),
    row(t("report_vat_d"), money(vat.D).toFixed(2)),
    row(t("report_vat_e"), money(vat.E).toFixed(2)),
    row(t("report_offline"), details.offline_count ?? 0),
  ];
  if (isX || isPeriodic) {
    lines.push(
      row(
        t("report_daily_reset"),
        isPeriodic ? t("report_no_periodic") : t("report_no_mod_x")
      )
    );
    lines.push(line("="));
    lines.push(t("report_print_many"));
  } else {
    const closureStatus = details.reset_applied
      ? t("report_z_closure_done")
      : details.day_already_closed
        ? t("report_z_closure_earlier")
        : t("report_z_closure_done");
    lines.push(row(t("report_daily_closure"), closureStatus));
    lines.push(line("="));
    if (details.reset_applied) {
      lines.push(t("report_pef_cleared"));
    } else if (details.day_already_closed) {
      lines.push(t("report_pef_cleared_earlier"));
    }
    const rfdCreated =
      details.rfd_created_count != null
        ? Number(details.rfd_created_count) || 0
        : Number(details.coupon_count) || 0;
    lines.push(row(t("report_rfd_created"), String(rfdCreated)));
    lines.push(t("report_end_z"));
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
  syncReportLanguage(settings);
  const { line, row, center } = reportLayoutHelpers();
  const turnover = details.vat_turnover || {};
  const tax = details.vat_breakdown || {};
  const lines = [
    line("="),
    center(settings.taxpayer_legal_name || t("business_fallback")),
    row(t("nui_label"), settings.taxpayer_nui || "-"),
    row(t("report_nf_vat"), settings.taxpayer_vat_number || settings.taxpayer_vat || "-"),
    row(t("report_unit"), settings.unit_name || "-"),
    row(t("report_sef_id"), require("./fiscal/fiscal-numbering").getSefIdentifier() || "-"),
    line("-"),
    center(details.report_name || t("report_short_periodic_title")),
    line("-"),
    row(t("report_from_date"), details.from_date || "-"),
    row(t("report_to_date"), details.to_date || "-"),
    row(t("report_fiscalization"), details.fiscalization_datetime || "-"),
    line("-"),
    row(t("report_rfd_coupons"), details.rfd_count ?? details.coupon_count ?? 0),
    row(t("report_turnover_with_vat"), money(details.total_amount).toFixed(2)),
    row(t("report_total_vat_tax"), money(details.total_tax).toFixed(2)),
    line("-"),
    t("report_turnover_by_rate"),
    row(t("report_rate_a_0"), money(turnover.A).toFixed(2)),
    row(t("report_rate_c_0"), money(turnover.C).toFixed(2)),
    row(t("report_rate_d_8"), money(turnover.D).toFixed(2)),
    row(t("report_rate_e_18"), money(turnover.E).toFixed(2)),
    t("report_tax_by_rate"),
    row(t("report_tax_a"), money(tax.A).toFixed(2)),
    row(t("report_tax_c"), money(tax.C).toFixed(2)),
    row(t("report_tax_d"), money(tax.D).toFixed(2)),
    row(t("report_tax_e"), money(tax.E).toFixed(2)),
    line("="),
    center(t("report_end")),
    "",
  ];
  return lines.join("\n");
}

/** Neni 11 / 9 — Raporti mujor i memories fiskale të transferuar në ATK. */
function buildMonthlyMemoryReportText(details, settings) {
  syncReportLanguage(settings);
  const { line, row, center } = reportLayoutHelpers();
  const payLabel = (key) => {
    const map = {
      cash: t("payment_mode_cash"),
      card: t("payment_mode_pos"),
      debit: t("pay_debit"),
      credit: t("pay_credit"),
      voucher: t("payment_mode_voucher"),
      mixed: t("mixed_payment"),
      other: t("payment_mode_other"),
    };
    return map[key] || String(key || "").toUpperCase();
  };
  const payments = details.payments || {};
  const payLines = Object.keys(payments).length
    ? Object.entries(payments).map(([k, v]) =>
        row(`  ${payLabel(k)}:`, money(v).toFixed(2))
      )
    : [row(t("report_no_payments"), "0.00")];

  const lines = [
    line("="),
    center(settings.taxpayer_legal_name || t("business_fallback")),
    row(t("nui_label"), settings.taxpayer_nui || "-"),
    row(t("report_unit"), settings.unit_name || "-"),
    row(t("report_sef_id"), require("./fiscal/fiscal-numbering").getSefIdentifier() || "-"),
    line("-"),
    center(details.report_name || t("report_monthly_memory")),
    center(t("report_transferred_atk")),
    line("-"),
    row(t("report_from_date"), details.from_date || "-"),
    row(t("report_to_date"), details.to_date || "-"),
    row(t("report_fiscalization_date"), details.fiscalization_date || "-"),
    row(t("report_fiscalization_time"), details.fiscalization_time || "-"),
    line("-"),
    row(t("report_rfd_in_period"), details.rfd_count ?? details.coupon_count ?? 0),
    row(t("report_turnover_with_vat"), money(details.total_amount).toFixed(2)),
    row(t("report_total_vat_tax"), money(details.total_tax).toFixed(2)),
    row(t("report_total_without_vat"), money(details.total_without_tax).toFixed(2)),
    row(t("report_ram_resets"), details.ram_resets ?? 0),
    line("-"),
    t("report_payment_methods"),
    ...payLines,
    line("-"),
    center(
      details.transmission_ok ? t("report_transmission_ok") : t("report_transmission_fail")
    ),
    line("="),
    center(t("report_end")),
    "",
  ];
  return lines.join("\n");
}

let httpServer = null;

async function boot() {
  console.time("[biznes] boot-total");
  try {
    const {
      applyStartupFiscalProfile,
      applyLocalRunDatabaseLockdown,
      scheduleStartupSelfTest,
      logStartupFiscalStatus,
    } = require("./fiscal/fiscal-boot");
    applyStartupFiscalProfile();
  } catch (e) {
    process.env.FISCAL_LOCAL_RUN = "1";
    process.env.ATK_AUTO_SEND = "0";
    process.env.BIZNES_ATK_SEND_ALLOWED = "0";
    console.warn("[biznes] fiscal-boot:", e.message);
  }

  console.time("[biznes] initDatabase");
  await db.initDatabase();
  console.timeEnd("[biznes] initDatabase");

  setImmediate(() => {
    try {
      const { runAutoBackupOnStartup } = require("./biznes-backup");
      const auto = runAutoBackupOnStartup();
      if (auto.daily) {
        console.log(
          `[backup-auto] ditor OK → ${auto.daily.dest_dir} (${auto.daily.file_count} skedarë)`
        );
        try {
          const { logFiscalAction } = require("./fiscal/fiscal-audit");
          logFiscalAction(
            "backup_created",
            {
              auto: true,
              kind: "auto_daily",
              dest_dir: auto.daily.dest_dir,
              source_dir: auto.daily.source_dir,
              created_at: auto.daily.created_at,
              file_count: auto.daily.file_count,
            },
            "Sistem",
            "AUTO"
          );
        } catch (e) {
          console.warn("[backup-auto] audit daily:", e.message);
        }
      } else if (auto.skipped_daily) {
        console.log("[backup-auto] ditor — tashmë ekziston për sot");
      }
      if (auto.monthly) {
        console.log(
          `[backup-auto] mujor OK → ${auto.monthly.dest_dir} (${auto.monthly.file_count} skedarë)`
        );
        try {
          const { logFiscalAction } = require("./fiscal/fiscal-audit");
          logFiscalAction(
            "backup_created",
            {
              auto: true,
              kind: "auto_monthly",
              dest_dir: auto.monthly.dest_dir,
              source_dir: auto.monthly.source_dir,
              created_at: auto.monthly.created_at,
              file_count: auto.monthly.file_count,
            },
            "Sistem",
            "AUTO"
          );
        } catch (e) {
          console.warn("[backup-auto] audit monthly:", e.message);
        }
      }
      const pr = auto.pruned || { daily: [], monthly: [] };
      if ((pr.daily && pr.daily.length) || (pr.monthly && pr.monthly.length)) {
        console.log(
          `[backup-auto] prune — daily: ${(pr.daily || []).join(", ") || "—"}; monthly: ${(pr.monthly || []).join(", ") || "—"}`
        );
      }
    } catch (e) {
      console.warn("[backup-auto]", e.message);
    }
  });

  try {
    const { applyLocalRunDatabaseLockdown } = require("./fiscal/fiscal-boot");
    applyLocalRunDatabaseLockdown();
  } catch (e) {
    console.warn("[biznes] fiscal local lockdown:", e.message);
  }

  setImmediate(() => {
    try {
      const { purgeLegacyAuditNoise } = require("./fiscal/fiscal-audit");
      const purged = purgeLegacyAuditNoise();
      if (!purged.skipped && purged.deleted > 0) {
        console.log(`[biznes] audit log: u fshinë ${purged.deleted} rreshta test/debug`);
      }
    } catch (e) {
      console.warn("[biznes] audit purge:", e.message);
    }
  });

  try {
    const fsRow = db.getFiscalSettingsRow();
    console.log("[biznes] boot — fiscal_settings NF/TVSH:", {
      db: db.DB_PATH,
      taxpayer_nf: fsRow.taxpayer_nf,
      taxpayer_vat_number: fsRow.taxpayer_vat_number,
      taxpayer_nui: fsRow.taxpayer_nui,
    });
  } catch (e) {
    console.warn("[biznes] boot fiscal_settings log:", e.message);
  }

  try {
    const { syncAtkTransmissionFromSettings } = require("./fiscal/fiscal-boot");
    const atkSync = syncAtkTransmissionFromSettings(db);
    console.log(
      `[biznes] ATK ${atkSync.allowed ? "HTTP aktiv" : "lokal (pa HTTP)"} · auto_send=${atkSync.autoSend ? "ON" : "OFF"}`
    );
  } catch (e) {
    console.warn("[biznes] ATK sync:", e.message);
  }

  function scheduleDeferredPrinterBoot() {
    setImmediate(async () => {
      console.time("[biznes] printer-boot");
      try {
        const printer = require("./printer");
        await printer.persistDefaultReceiptPrinter(db);
        const status = await printer.getStatus(db);
        if (status.effective_name) {
          console.log(`[biznes] Printeri: ${status.effective_name} (${status.resolved_paper || "80mm"})`);
        }
      } catch (e) {
        console.warn("[biznes] printer boot:", e.message);
      } finally {
        console.timeEnd("[biznes] printer-boot");
      }
    });
  }

  scheduleDeferredPrinterBoot();

  /** Health + listen menjëherë — UI nuk ngec në splash ndërsa regjistrohen rrugët. */
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      app: "biznes",
      purpose: "ATK SEF test",
      desktop: true,
      routes_ready: !!global.__biznesRoutesReady,
    });
  });

  console.time("[biznes] listen-early");
  await new Promise((resolve, reject) => {
    const srv = app.listen(PORT, HOST, () => {
      console.timeEnd("[biznes] listen-early");
      console.log(`[biznes] LOKAL (health gati) → http://${HOST}:${PORT}`);
      httpServer = srv;
      resolve(srv);
    });
    srv.on("error", reject);
  });

  setImmediate(async () => {
  try {
  const { getDiskStatus, blocksNewRecords } = require("./disk-monitor");
  const { logFiscalAction } = require("./fiscal/fiscal-audit");
  let cachedDiskStatus = getDiskStatus(db.DB_PATH);

  function auditDiskStatus(status) {
    if (!status || status.level === "ok" || status.unknown) return;
    const action =
      status.level === "critical" ? "disk_space_critical" : "disk_space_warning";
    try {
      logFiscalAction(
        action,
        {
          free_mb: status.free_mb,
          free_bytes: status.free_bytes,
          path: status.path,
          at: new Date().toISOString(),
        },
        "SYSTEM",
        "DISK"
      );
    } catch (e) {
      console.warn("[biznes] disk audit:", e.message);
    }
  }

  function refreshDiskStatus() {
    cachedDiskStatus = getDiskStatus(db.DB_PATH);
    return cachedDiskStatus;
  }

  function diskGuardResponse(res) {
    const status = refreshDiskStatus();
    if (!blocksNewRecords(status)) return null;
    return res.status(507).json({
      ok: false,
      disk_full: true,
      error: status.message || "Disku i mbushur — lironi hapësirë",
      disk: status,
    });
  }

  function recordsGuardResponse(res) {
    if (global.DB_DECRYPT_FAILED) {
      return res.status(503).json({
        ok: false,
        db_decrypt_failed: true,
        error: "Databaza nuk lexohet — duhet rikthyer nga backup-i",
      });
    }
    return diskGuardResponse(res);
  }

  /** Bllokon POST/PUT/PATCH/DELETE kur DB nuk dekriptohet — lejon restore, login, backup. */
  const DB_DECRYPT_WRITE_ALLOW = new Set([
    "/api/backup/restore",
    "/api/backup/status",
    "/api/backup/open-folder",
    "/api/backup/run",
    "/api/auth/login",
    "/api/operators/verify-pin",
  ]);
  app.use((req, res, next) => {
    if (!global.DB_DECRYPT_FAILED) return next();
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const p = String(req.path || "").split("?")[0];
    if (DB_DECRYPT_WRITE_ALLOW.has(p)) return next();
    return res.status(503).json({
      ok: false,
      db_decrypt_failed: true,
      error: "Databaza nuk lexohet — duhet rikthyer nga backup-i",
    });
  });

  auditDiskStatus(cachedDiskStatus);
  setInterval(() => {
    auditDiskStatus(refreshDiskStatus());
  }, 30 * 60 * 1000);

  app.get("/api/system/disk-status", (_req, res) => {
    try {
      const status = refreshDiskStatus();
      res.json({
        ok: true,
        disk: status,
        blocks_new_records: blocksNewRecords(status),
        db_decrypt_failed: !!global.DB_DECRYPT_FAILED,
        blocks_sales: !!global.DB_DECRYPT_FAILED || blocksNewRecords(status),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/backup/run", (req, res) => {
    try {
      const { runBackup, pickBackupFolderDialog } = require("./biznes-backup");
      let target =
        req.body && req.body.targetPath ? String(req.body.targetPath).trim() : "";
      if (!target) target = pickBackupFolderDialog();
      if (!target) {
        return res.status(400).json({
          ok: false,
          error: "Backup u anulua — nuk u zgjodh folder.",
        });
      }

      const result = runBackup(target);
      const operatorName = String(req.body?.operator_name || "Operator").trim() || "Operator";
      const operatorId = String(req.body?.operator_id || "POS").trim() || "POS";

      logFiscalAction(
        "backup_created",
        {
          auto: false,
          kind: "manual",
          dest_dir: result.dest_dir,
          source_dir: result.source_dir,
          created_at: result.created_at,
          file_count: result.file_count,
        },
        operatorName,
        operatorId
      );

      res.json({
        ok: true,
        message: "Backup u krye me sukses",
        created_at: result.created_at,
        dest_dir: result.dest_dir,
        source_dir: result.source_dir,
        file_count: result.file_count,
      });
    } catch (e) {
      console.error("[backup]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/backup/status", (_req, res) => {
    try {
      const { getAutoBackupStatus } = require("./biznes-backup");
      res.json(getAutoBackupStatus());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/backup/open-folder", (_req, res) => {
    try {
      const { openBackupFolder } = require("./biznes-backup");
      const data = openBackupFolder();
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/backup/pick-restore-source", (_req, res) => {
    try {
      const { pickRestoreSourceDialog } = require("./biznes-backup");
      const sourcePath = pickRestoreSourceDialog();
      if (!sourcePath) {
        return res.json({ ok: true, cancelled: true, sourcePath: null });
      }
      res.json({ ok: true, cancelled: false, sourcePath });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/backup/restore/check-nui", async (req, res) => {
    try {
      const { validateRestoreBackupNui } = require("./biznes-backup");
      const sourcePath =
        req.body && req.body.sourcePath ? String(req.body.sourcePath).trim() : "";
      if (!sourcePath) {
        return res.status(400).json({ ok: false, error: "Mungon folderi i backup-it." });
      }
      const result = await validateRestoreBackupNui(sourcePath);
      if (!result.allowed) {
        return res.status(403).json({
          ok: false,
          allowed: false,
          error: result.error,
          current_nui: result.current_nui,
          backup_nui: result.backup_nui,
        });
      }
      res.json({
        ok: true,
        allowed: true,
        reason: result.reason,
        current_nui: result.current_nui,
        backup_nui: result.backup_nui,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/backup/restore", async (req, res) => {
    try {
      const {
        verifyRestoreOwnerCode,
        restoreFromBackup,
        pickRestoreSourceDialog,
        validateRestoreBackupNui,
      } = require("./biznes-backup");

      let sourcePath =
        req.body && req.body.sourcePath ? String(req.body.sourcePath).trim() : "";
      if (!sourcePath) sourcePath = pickRestoreSourceDialog();
      if (!sourcePath) {
        return res.status(400).json({
          ok: false,
          error: "Restore u anulua — nuk u zgjodh folderi i backup-it.",
        });
      }

      const nuiCheck = await validateRestoreBackupNui(sourcePath);
      if (!nuiCheck.allowed) {
        return res.status(403).json({
          ok: false,
          error: nuiCheck.error,
          current_nui: nuiCheck.current_nui,
          backup_nui: nuiCheck.backup_nui,
        });
      }

      if (!verifyRestoreOwnerCode(req.body?.owner_code)) {
        return res.status(403).json({
          ok: false,
          error: "Kodi i pronarit nuk është i saktë.",
        });
      }

      const result = await restoreFromBackup(sourcePath);
      const operatorName = String(req.body?.operator_name || "Operator").trim() || "Operator";
      const operatorId = String(req.body?.operator_id || "POS").trim() || "POS";

      logFiscalAction(
        "backup_restored",
        {
          restored_from: result.restored_from,
          safety_dir: result.safety_dir,
          keys_restored: result.keys_restored,
          needs_restart: true,
        },
        operatorName,
        operatorId
      );

      res.json({
        ok: true,
        message: "Të dhënat u kthyen me sukses — rinisni programin",
        needs_restart: true,
        restored_from: result.restored_from,
        safety_dir: result.safety_dir,
        keys_restored: result.keys_restored,
      });
    } catch (e) {
      console.error("[backup-restore]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
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

  app.get("/api/operators/status", (_req, res) => {
    try {
      res.json({ ok: true, active_count: db.countActiveOperators() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/operators", (req, res) => {
    try {
      const includeInactive = String(req.query?.all || "") === "1";
      res.json({
        ok: true,
        operators: db.getOperators({ includeInactive }),
        active_count: db.countActiveOperators(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/operators/verify-pin", (req, res) => {
    try {
      const pin = String(req.body?.pin_code || req.body?.pin || "").trim();
      if (!/^\d{4,6}$/.test(pin)) {
        return res.status(400).json({ ok: false, error: "Kodi i hyrjes nuk është valid" });
      }
      const op = db.getOperatorByPin(pin);
      if (!op) {
        return res.status(401).json({ ok: false, error: "Kodi i hyrjes nuk u gjet" });
      }
      res.json({ ok: true, id: op.id, name: op.name, pin_code: op.pin_code });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/operators", (req, res) => {
    try {
      const operator = db.addOperator(req.body?.name, req.body?.pin_code || req.body?.pin);
      res.json({ ok: true, operator });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/operators/:id", (req, res) => {
    try {
      const operator = db.updateOperator(req.params.id, {
        name: req.body?.name,
        pin_code: req.body?.pin_code || req.body?.pin,
      });
      res.json({ ok: true, operator });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/operators/:id/deactivate", (req, res) => {
    try {
      const operator = db.deactivateOperator(req.params.id);
      res.json({ ok: true, operator });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/operators/:id", (req, res) => {
    try {
      const result = db.deleteOperator(req.params.id);
      res.json({ ok: true, ...result });
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
      const status = await printer.getStatus(db);
      const current = {
        name: status.effective_name || db.getSetting("printer_name", "") || "",
        paper: status.resolved_paper || db.getSetting("printer_paper", "80mm") || "80mm",
        output: status.resolved_output || db.getSetting("printer_output", "auto") || "auto",
        manual: printer.isPrinterManuallyChosen(db),
      };
      res.json({
        ok: true,
        printers: list,
        current,
        electron: !!status.electron,
        electron_worker: !!require("./printer").resolveBundledElectronExe?.(),
        print_mode: status.electron ? "electron-gdi" : "electron-worker-gdi",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/printers", async (req, res) => {
    try {
      const printer = require("./printer");
      const name = String(req.body?.name || "").trim();
      const paper = String(req.body?.paper || "80mm").trim() || "80mm";
      const output =
        /tysso/i.test(name) ? "escpos" : String(req.body?.output || "auto").trim() || "auto";
      printer.savePrinterConfig(db, { name, paper, output, manual: true });
      if (/tysso/i.test(name)) {
        db.setSetting("fiscal_printer_name", name);
      }
      res.json({
        ok: true,
        current: {
          name: db.getSetting("printer_name", "") || "",
          paper: db.getSetting("printer_paper", "80mm") || "80mm",
          output: db.getSetting("printer_output", "auto") || "auto",
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/printers/test", async (_req, res) => {
    try {
      const printer = require("./printer");
      const result = await printer.printTestPage(db);
      const method = result?.method || result?.output || "gdi";
      const target = result?.printer || db.getSetting("printer_name", "") || "";
      const detail =
        method === "direct-com" || method === "escpos-com"
          ? `ESC/POS ${result?.port || "COM"} → ${target}`
          : method === "electron-gdi" ||
        method === "electron-worker-gdi" ||
        result?.output === "tysso-gdi" ||
        result?.output === "html" ||
        result?.output === "text"
          ? `Electron/GDI → ${target}`
          : method === "raw-spooler" || method === "raw-spooler-staged"
            ? `spooler RAW → ${target}`
            : method === "escpos-text"
              ? `ESC/POS → ${target}`
              : String(method);
      res.json({
        ok: true,
        message: `U dërgua te printeri (${detail})`,
        print: result,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/printers/repair-tysso", async (_req, res) => {
    try {
      const printer = require("./printer");
      const before = printer.getTyssoSetupDiagnostic(await printer.listPrinters());
      const repair = printer.repairTyssoWindowsPrinter();
      const after = printer.getTyssoSetupDiagnostic(await printer.listPrinters());
      if (repair.ok && after.main_name && !isPrinterManuallyBlocked(db)) {
        printer.savePrinterConfig(db, {
          name: after.main_name,
          paper: "80mm",
          output: "escpos",
          manual: false,
        });
      }
      res.json({ ok: repair.ok, repair, before, after });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  function isPrinterManuallyBlocked(db) {
    try {
      return require("./printer").isPrinterManuallyChosen(db);
    } catch {
      return false;
    }
  }

  app.get("/api/printers/diagnostic", async (_req, res) => {
    try {
      const printer = require("./printer");
      const status = await printer.getStatus(db);
      const tysso = status.tysso || printer.getTyssoSetupDiagnostic(status.printers);
      const electronExe = printer.resolveBundledElectronExe?.() || null;
      res.json({
        ok: true,
        electron_in_process: !!status.electron,
        electron_worker: !!electronExe,
        electron_worker_path: electronExe,
        printer: status.effective_name,
        output: status.output,
        resolved_output: status.resolved_output,
        paper: status.paper,
        message: status.message,
        tysso,
        hint: tysso.main_on_dead_com
          ? "Tysso: porti COM nuk ekziston — klikoni «Rregullo printerin» ose rinstaloni driverin USB (PRP) në USB001."
          : tysso.main_on_usb
            ? "Tysso: ESC/POS përmes USB001 (spooler RAW)"
            : status.resolved_output === "escpos" && /tysso/i.test(String(status.effective_name || ""))
              ? "Tysso: ESC/POS — kontrolloni portin USB001"
              : status.electron
                ? "Printim termik aktiv"
                : electronExe
                  ? "Printim termik aktiv"
                  : "Mungon runtime — ribuild paketën ose kontaktoni supportin",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
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

  app.post("/api/products", (req, res) => {
    try {
      const blocked = recordsGuardResponse(res);
      if (blocked) return blocked;
      const body = req.body || {};
      const unitCode = body.unit_code || "EA";
      const categoryCode = body.category_code || "TT";
      const product = db.createProduct({
        ...body,
        unit_code: unitCode,
        category_code: categoryCode,
      });
      res.status(201).json({ ok: true, product });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/products/:id", (req, res) => {
    try {
      const p = db.getProductById(req.params.id);
      if (!p) return res.status(404).json({ ok: false, error: "Produkti nuk u gjet" });
      res.json(p);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/products/:id", (req, res) => {
    try {
      const blocked = recordsGuardResponse(res);
      if (blocked) return blocked;
      const { name, price, vat_letter, unit_code, category_code } = req.body || {};
      const product = db.updateProduct(req.params.id, {
        name,
        price,
        vat_letter,
        unit_code: unit_code || "EA",
        category_code: category_code || "TT",
      });
      res.json({ ok: true, success: true, product });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/products/:id", (req, res) => {
    try {
      const result = db.deleteProduct(req.params.id);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/fiscal/settings", (_req, res) => {
    try {
      const { getSefIdentifier } = require("./fiscal/fiscal-numbering");
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      const { isAtkTestMode } = require("./fiscal/fiscal-test-mode-store");
      const { isAtkAutoSendEnabled } = require("./fiscal/fiscal-offline");
      const s = db.getFiscalSettingsRow();
      const atkAuto = isAtkAutoSendEnabled();
      const atkTestMode = isAtkTestMode();
      res.json({
        ok: true,
        settings: {
          ...s,
          sef_identifier_computed: getSefIdentifier() || "",
          atk_auto_send: atkAuto ? "1" : "0",
          atk_test_mode: atkTestMode ? "1" : "0",
        },
        atk: { ...getAtkStatus(), atk_auto_send: atkAuto, atk_test_mode: atkTestMode },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put("/api/fiscal/settings", async (req, res) => {
    try {
      const body = req.body || {};
      if (body.atk_auto_send !== undefined) {
        const autoOn =
          body.atk_auto_send === true ||
          body.atk_auto_send === 1 ||
          body.atk_auto_send === "1" ||
          body.atk_auto_send === "on";
        db.setSetting("atk_auto_send", autoOn ? "1" : "0");
        if (autoOn) db.setSetting("atk_send_allowed", "1");
      }
      if (body.atk_send_allowed !== undefined) {
        const on =
          body.atk_send_allowed === true ||
          body.atk_send_allowed === 1 ||
          body.atk_send_allowed === "1" ||
          body.atk_send_allowed === "on";
        db.setSetting("atk_send_allowed", on ? "1" : "0");
        if (!on) db.setSetting("atk_auto_send", "0");
      }
      if (body.atk_test_mode !== undefined) {
        const on =
          body.atk_test_mode === true ||
          body.atk_test_mode === 1 ||
          body.atk_test_mode === "1" ||
          body.atk_test_mode === "on";
        db.setSetting("atk_test_mode", on ? "1" : "0");
      }
      const saved = db.saveFiscalSettings({
        ...body,
        fiscal_enabled: true,
      });
      syncReportLanguage(saved);
      try {
        const { syncAtkTransmissionFromSettings } = require("./fiscal/fiscal-boot");
        syncAtkTransmissionFromSettings(db);
      } catch (e) {
        console.warn("[biznes] ATK sync pas ruajtjes:", e.message);
      }
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      const { isAtkTestMode } = require("./fiscal/fiscal-test-mode-store");
      const { isAtkAutoSendEnabled } = require("./fiscal/fiscal-offline");
      const atkAuto = isAtkAutoSendEnabled();
      const atkTestMode = isAtkTestMode();
      let pendingFlush = null;
      if (atkAuto && !require("./fiscal/fiscal-test-mode-store").isAtkTransmissionBlocked()) {
        try {
          const { processOfflineQueue } = require("./fiscal/fiscal-offline");
          pendingFlush = await processOfflineQueue({ manual: true });
        } catch (e) {
          pendingFlush = { processed: 0, error: e.message };
        }
      }
      res.json({
        ok: true,
        settings: {
          ...saved,
          atk_auto_send: atkAuto ? "1" : "0",
          atk_test_mode: atkTestMode ? "1" : "0",
        },
        atk: { ...getAtkStatus(), atk_auto_send: atkAuto, atk_test_mode: atkTestMode },
        pending_flush: pendingFlush,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/fiscal/atk-status", async (_req, res) => {
    try {
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      const {
        checkInternetConnection,
        getOfflineStatus,
        getOfflineWarning,
      } = require("./fiscal/fiscal-offline");
      const { getPaperBlockStatus } = require("./fiscal/fiscal-paper-block");
      try {
        await checkInternetConnection();
      } catch {
        /* */
      }
      res.json({
        ok: true,
        atk: getAtkStatus(),
        offline: getOfflineStatus(),
        offline_warning: getOfflineWarning(),
        paper_block: getPaperBlockStatus(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/fiscal/offline-compliance", (_req, res) => {
    try {
      const { evaluateOfflineCompliance } = require("./fiscal/fiscal-offline-compliance");
      res.json({ ok: true, compliance: evaluateOfflineCompliance() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/offline-compliance/ack", (req, res) => {
    try {
      const { acknowledgeOfflineCompliance } = require("./fiscal/fiscal-offline-compliance");
      const compliance = acknowledgeOfflineCompliance(
        req.body?.type,
        req.body?.operator_name || "Operator",
        req.body?.notes || ""
      );
      res.json({ ok: true, compliance });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/offline-compliance/export", (req, res) => {
    try {
      const { exportOfflineComplianceReport } = require("./fiscal/fiscal-offline-compliance");
      const result = exportOfflineComplianceReport(req.body?.type || "48h");
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/fiscal/paper-block", (_req, res) => {
    try {
      const { getPaperBlockStatus, listPaperBlockReceipts } = require("./fiscal/fiscal-paper-block");
      res.json({
        ok: true,
        status: getPaperBlockStatus(),
        receipts: listPaperBlockReceipts({ pendingOnly: false }),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/paper-block/enable", (req, res) => {
    try {
      const { enablePaperBlockMode } = require("./fiscal/fiscal-paper-block");
      const status = enablePaperBlockMode(req.body?.operator_name || "Operator", {
        batch_id: req.body?.batch_id,
        reason: req.body?.reason,
      });
      res.json({ ok: true, status });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/paper-block/disable", (req, res) => {
    try {
      const { disablePaperBlockMode } = require("./fiscal/fiscal-paper-block");
      const status = disablePaperBlockMode(req.body?.operator_name || "Operator", {
        force: !!req.body?.force,
      });
      res.json({ ok: true, status });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/paper-block/issue", (req, res) => {
    try {
      const { issuePaperBlockCoupon } = require("./fiscal/fiscal-paper-block");
      const result = issuePaperBlockCoupon(req.body || {});
      res.json({ ok: true, paper: result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/paper-block/register-all", async (req, res) => {
    try {
      const { registerAllPaperBlockInSef } = require("./fiscal/fiscal-paper-block");
      const result = await registerAllPaperBlockInSef({
        send_to_atk: req.body?.send_to_atk !== false,
        operator_name: req.body?.operator_name || "Operator",
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/paper-block/checkout", async (req, res) => {
    try {
      const blocked = recordsGuardResponse(res);
      if (blocked) return blocked;

      const {
        isPaperBlockModeActive,
        issuePaperBlockCoupon,
      } = require("./fiscal/fiscal-paper-block");

      if (!isPaperBlockModeActive()) {
        return res.status(409).json({
          ok: false,
          error: "Modaliteti bllok letër nuk është aktiv",
        });
      }

      const serial = String(req.body?.paper_serial || req.body?.serial_no || "").trim();
      if (!serial) {
        return res.status(400).json({
          ok: false,
          error: "Numri serik i bllokut letër mungon",
        });
      }

      const preview = db.previewSaleTotals({
        items: req.body?.items || [],
        cart_discount: req.body?.cart_discount || null,
        cart_surcharge: req.body?.cart_surcharge || null,
      });

      if (preview.total > 1000 && !req.body?.confirmed_over_1000) {
        return res.status(409).json({
          ok: false,
          needs_confirm_over_1000: true,
          total: preview.total,
          error: "Transaksioni mbi 1000€ kërkon konfirmim shtesë para finalizimit",
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

      const paper = issuePaperBlockCoupon({
        serial_no: serial,
        items: sale.items,
        subtotal: sale.subtotal,
        discount_amount: sale.discount_total,
        total_amount: sale.total,
        payment_method: sale.payment_method,
        operator_name: sale.operator_name,
        operator_id: req.body?.operator_id || "POS",
      });

      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print && paper.slip_text) {
        try {
          const printer = require("./printer");
          await printer.printPlainTextReceipt(paper.slip_text, db);
          printed = true;
        } catch (e) {
          printMessage = e.message || "print dështoi";
        }
      }

      res.json({
        ok: true,
        order_id: sale.id,
        total: sale.total,
        paper_block: true,
        paper,
        printed,
        printMessage,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/fiscal/onboard-atk", async (req, res) => {
    try {
      const settings = db.getFiscalSettingsRow();
      if (!settings || !settings.taxpayer_nui || settings.taxpayer_nui.length !== 9) {
        return res.status(400).json({ success: false, error: "Plotëso NUI (9 shifra) te Cilësimet para onboarding" });
      }
      if (!settings.fiscalization_number) {
        return res.status(400).json({ success: false, error: "Plotëso Numrin e Fiskalizimit te Cilësimet" });
      }
      if (!settings.pos_id) {
        return res.status(400).json({ success: false, error: "Plotëso POS ID te Cilësimet" });
      }
      if (!settings.application_id) {
        return res.status(400).json({ success: false, error: "Plotëso Application ID te Cilësimet" });
      }
      if (!settings.business_unit_number) {
        return res.status(400).json({ success: false, error: "Plotëso Numrin e Njësisë ARBK te Cilësimet" });
      }
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const onboardSettings = {
        ...settings,
        ...(body.pos_id != null && String(body.pos_id).trim() !== ""
          ? { pos_id: String(body.pos_id).trim() }
          : {}),
        ...(body.business_unit_number != null &&
        String(body.business_unit_number).trim() !== ""
          ? {
              business_unit_number: String(body.business_unit_number).trim(),
              unit_number: String(body.business_unit_number).trim(),
            }
          : {}),
        ...(body.fiscalization_number != null &&
        String(body.fiscalization_number).trim() !== ""
          ? { fiscalization_number: String(body.fiscalization_number).trim() }
          : {}),
        ...(body.application_id != null && String(body.application_id).trim() !== ""
          ? { application_id: String(body.application_id).trim() }
          : {}),
        ...(body.atk_api_url != null && String(body.atk_api_url).trim() !== ""
          ? { atk_api_url: String(body.atk_api_url).trim() }
          : {}),
      };
      if (body.pos_id != null || body.business_unit_number != null) {
        db.saveFiscalSettings({
          pos_id: onboardSettings.pos_id,
          business_unit_number: onboardSettings.business_unit_number,
          unit_number: onboardSettings.unit_number,
          fiscalization_number: onboardSettings.fiscalization_number,
          application_id: onboardSettings.application_id,
          atk_api_url: onboardSettings.atk_api_url,
          fiscal_enabled: true,
        });
      }
      const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
      const { getKeysDir, compareCertWithSettings } = require("./fiscal/fiscal-crypto");
      const atkNow = getAtkStatus();
      const certMatch = compareCertWithSettings(
        onboardSettings,
        atkNow.certificate_path || ""
      );
      if (
        atkNow.ready_for_atk &&
        !atkNow.certificate_is_placeholder &&
        certMatch.match &&
        req.body?.force !== true
      ) {
        db.setSetting("atk_send_allowed", "1");
        db.setSetting("atk_auto_send", "1");
        const { syncAtkTransmissionFromSettings } = require("./fiscal/fiscal-boot");
        syncAtkTransmissionFromSettings(db);
        return res.json({
          success: true,
          already_connected: true,
          business_name: onboardSettings.taxpayer_legal_name || "—",
          certificate_path: atkNow.certificate_path || "",
          private_key_path: onboardSettings.private_key_path || getKeysDir(),
          message: "Ky POS është tashmë i lidhur me ATK. Certifikata është e vulosur — nuk ndryshohet.",
          atk_sync: { allowed: true, auto_send: true },
        });
      }
      if (
        atkNow.ready_for_atk &&
        !atkNow.certificate_is_placeholder &&
        certMatch.match &&
        req.body?.force === true &&
        req.body?.replace_keys !== true
      ) {
        return res.status(409).json({
          success: false,
          already_connected: true,
          error:
            "Certifikata përputhet me cilësimet — NUK zëvendësohet. Mos shtyp «Lidhu me ATK» kur je i lidhur.",
        });
      }
      const result = await onboardPosAtAtk(onboardSettings);
      if (result && result.success !== false) {
        db.setSetting("atk_send_allowed", "1");
        db.setSetting("atk_auto_send", "1");
        const { syncAtkTransmissionFromSettings } = require("./fiscal/fiscal-boot");
        syncAtkTransmissionFromSettings(db);
        result.atk_sync = { allowed: true, auto_send: true };
      }
      res.json(result);
    } catch (err) {
      console.error("[ATK Onboard Error]", err.message);
      res.status(500).json({ success: false, error: err.message });
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
      const { isAtkTransmissionBlocked } = require("./fiscal/fiscal-test-mode-store");
      if (isAtkTransmissionBlocked()) {
        return res.status(403).json({
          ok: false,
          error: "Modalitet LOKAL — dërgimi te ATK është i çaktivizuar",
        });
      }
      const { processOfflineQueue } = require("./fiscal/fiscal-offline");
      // Vetëm dërgim me dorë — nuk varet nga atk_auto_send
      const result = await processOfflineQueue({ manual: true });
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
      const blocked = recordsGuardResponse(res);
      if (blocked) return blocked;

      const { isFiscalEnabled } = require("./fiscal/fiscal-config");
      if (isFiscalEnabled()) {
        const { verifyPrivateKeyReadable } = require("./fiscal/fiscal-crypto");
        const keyCheck = verifyPrivateKeyReadable();
        if (!keyCheck.ok && !keyCheck.skipped) {
          return res.status(503).json({
            ok: false,
            private_key_failed: true,
            error:
              keyCheck.error ||
              "Çelësi privat nuk lexohet — kuponi nuk printohet. Rikthe nga backup-i.",
          });
        }
      }

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
          error: "Transaksioni mbi 1000€ kërkon konfirmim shtesë para finalizimit",
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
        operator_id: resolveBodyOperatorId(req),
        total_amount: sale.total,
        subtotal: sale.subtotal,
        discount_amount: sale.discount_total,
        surcharge_amount: sale.surcharge_total,
        payment_splits: sale.payment_splits,
        language: req.body?.language,
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
      const { isAtkTransmissionBlocked } = require("./fiscal/fiscal-test-mode-store");

      const result = createCorrectionReceipt(
        nuikf,
        correctionType,
        correctionType === "return" ? req.body?.items || null : null,
        req.body?.reason || `${correctionType} ATK`,
        {
          operator_name: req.body?.operator_name || "Operator",
          operator_id: resolveBodyOperatorId(req),
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

      let atk = { atk_sent: false, atk_message: "LOKAL — pa dërgim te ATK" };
      let printOfflineBanner = false;
      if (!isAtkTransmissionBlocked()) {
        const { tryAutoSendFiscalReceiptById } = require("./fiscal/fiscal-offline");
        atk = await tryAutoSendFiscalReceiptById(result.id);
        if (
          !atk.atk_sent &&
          !atk.atk_test_mode &&
          atk.atk_status === "send_failed"
        ) {
          printOfflineBanner = true;
        }
      }

      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print && result.print_text) {
        const pr = await printFiscalBundle(result.print_text, qrResult, {
          printOfflineBanner,
        });
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
        atk,
        atk_sent: !!atk.atk_sent,
        atk_message: atk.atk_message,
      });
    } catch (e) {
      console.error("[storno]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Lista kuponësh fiskalë */
  app.get("/api/fiscal/receipts", (_req, res) => {
    try {
      const { listFiscalReceipts } = require("./fiscal/fiscal-receipts-list");
      const { isAtkTransmissionBlocked } = require("./fiscal/fiscal-test-mode-store");
      const atkBlocked = isAtkTransmissionBlocked();
      const rows = (listFiscalReceipts(100) || []).map((r) => ({
        ...r,
        sent_to_atk: r.sent_to_atk ? 1 : 0,
        is_offline: r.is_offline ? 1 : 0,
        atk_label: atkBlocked
          ? Number(r.sent_to_atk) === 1
            ? "ATK OK"
            : "LOKAL"
          : Number(r.sent_to_atk) === 1
            ? "ATK OK"
            : Number(r.is_offline) === 1
              ? "OFFLINE"
              : "Në pritje",
        atk_ok: Number(r.sent_to_atk) === 1,
      }));
      res.json({ ok: true, receipts: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Artikujt e kuponit origjinal (regular) — për kthim malli në UI. */
  app.get("/api/fiscal/receipts/lookup", (req, res) => {
    try {
      const nuikf = String(req.query.nuikf || "")
        .trim()
        .toUpperCase();
      if (!nuikf) throw new Error("NUIKF mungon");
      const { getOriginalReceipt, getReturnableItemsForReceipt } = require("./fiscal/fiscal-correction");
      const items = getReturnableItemsForReceipt(nuikf);
      if (!items) {
        return res.status(404).json({
          ok: false,
          error: "Kuponi origjinal (regular) nuk u gjet për këtë NUIKF",
        });
      }
      const receipt = getOriginalReceipt(nuikf);
      res.json({
        ok: true,
        receipt: {
          id: receipt.id,
          nuikf: receipt.nuikf,
          receipt_type: receipt.receipt_type,
          total_amount: receipt.total_amount,
          fiscal_date: receipt.fiscal_date,
          fiscal_time: receipt.fiscal_time,
          items: items.map((it) => ({
            name: it.name,
            quantity: it.remaining_quantity,
            original_quantity: it.original_quantity,
            already_returned: it.already_returned,
            remaining_quantity: it.remaining_quantity,
            price: it.unit_price,
            unit_price: it.unit_price,
            vat_norm: it.vat_norm,
            vat_letter: it.vat_norm,
          })),
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
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
      let reprint;
      if (req.body?.print_text && req.body?.nuikf) {
        reprint = {
          id: Number(req.params.id) || 0,
          print_text: String(req.body.print_text),
          nuikf: String(req.body.nuikf).trim().toUpperCase(),
          total_amount: Number(req.body.total_amount) || 0,
          fiscal_date: String(req.body.fiscal_date || ""),
          taxpayer_nui: String(req.body.taxpayer_nui || ""),
        };
      } else {
        reprint = prepareFiscalReceiptReprint(req.params.id);
      }
      let qrResult = null;
      try {
        qrResult = await generateFiscalQR({
          nuikf: reprint.nuikf,
          total_amount: reprint.total_amount,
          fiscal_date: reprint.fiscal_date,
          taxpayer_nui:
            reprint.taxpayer_nui ||
            db.getFiscalSettingsRow()?.taxpayer_nui ||
            "",
        });
      } catch (qe) {
        console.warn("[print] QR:", qe.message);
      }
      let printed = false;
      let printMessage = "";
      let printMethod = "";
      if (!req.body?.skip_print) {
        const pr = await printFiscalBundle(reprint.print_text, qrResult);
        printed = pr.printed;
        printMessage = pr.printMessage || "";
        printMethod = pr.printMethod || "";
      }
      res.json({
        ok: true,
        receipt_id: reprint.id,
        nuikf: reprint.nuikf,
        text: reprint.print_text,
        printed,
        printMessage,
        printMethod,
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
      const operatorName = req.body?.operator_name || "Operator";
      const operatorId = resolveBodyOperatorId(req);
      const details = getXReportSnapshot(operatorName, operatorId);
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");

      const text = buildXReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const { printFiscalReportText } = require("./fiscal/fiscal-main");
          const pr = await printFiscalReportText(text, {
            reportDetails: details,
            reportMode: "X",
            operatorId,
          });
          printed = pr.printed;
          if (!pr.printed) printMessage = pr.printMessage || "Printimi X dështoi";
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
      const operatorName = req.body?.operator_name || "Operator";
      const operatorId = resolveBodyOperatorId(req);
      const details = onDailySummaryPrinted(operatorName, operatorId);
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");

      const text = buildZReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const { printFiscalReportText } = require("./fiscal/fiscal-main");
          const pr = await printFiscalReportText(text, {
            reportDetails: details,
            reportMode: "Z",
            operatorId,
          });
          printed = pr.printed;
          if (!pr.printed) printMessage = pr.printMessage || "Printimi Z dështoi";
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
      const operatorName = req.body?.operator_name || "Operator";
      const operatorId = resolveBodyOperatorId(req);
      const details = getPeriodicFiscalReport(
        req.body?.from || req.body?.from_date,
        req.body?.to || req.body?.to_date,
        operatorName,
        operatorId
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");
      const text = buildFiscalDayReportText(details, settings, "PERIODIC");
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const { printFiscalReportText } = require("./fiscal/fiscal-main");
          const pr = await printFiscalReportText(text, {
            reportDetails: details,
            reportMode: "PERIODIC",
            operatorId,
          });
          printed = pr.printed;
          if (!pr.printed) printMessage = pr.printMessage || "Printimi periodik dështoi";
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
      const operatorName = req.body?.operator_name || "Operator";
      const operatorId = resolveBodyOperatorId(req);
      const details = getShortPeriodicFiscalReport(
        req.body?.from || req.body?.from_date,
        req.body?.to || req.body?.to_date,
        operatorName,
        operatorId
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");
      const text = buildShortPeriodicReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const { printFiscalReportText } = require("./fiscal/fiscal-main");
          const pr = await printFiscalReportText(text);
          printed = pr.printed;
          if (!pr.printed) {
            printMessage = pr.printMessage || "Printimi i raportit të shkurtër dështoi";
          }
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
        resolveMonthlyReportPeriod,
      } = require("./fiscal/fiscal-numbering");
      const { processPendingForPeriod } = require("./fiscal/fiscal-offline");
      const from = req.body?.from || req.body?.from_date;
      const to = req.body?.to || req.body?.to_date;
      const { from: periodFrom, to: periodTo } = resolveMonthlyReportPeriod(from, to);

      const transmission_flush = await processPendingForPeriod(periodFrom, periodTo, {
        manual: true,
      });

      const settings = db.getFiscalSettingsRow();
      const operatorName = req.body?.operator_name || "Operator";
      const operatorId = resolveBodyOperatorId(req);
      const details = getMonthlyFiscalMemoryReport(
        from,
        to,
        operatorName,
        operatorId
      );
      if (!details) throw new Error("Fiskalizimi nuk është aktiv");
      const text = buildMonthlyMemoryReportText(details, settings);
      let printed = false;
      let printMessage = "";
      if (!req.body?.skip_print) {
        try {
          const { printFiscalReportText } = require("./fiscal/fiscal-main");
          const pr = await printFiscalReportText(text);
          printed = pr.printed;
          if (!pr.printed) printMessage = pr.printMessage || "Printimi i raportit mujor dështoi";
        } catch (pe) {
          printMessage = pe.message || "Printimi i raportit mujor dështoi";
        }
      }
      res.json({
        ok: true,
        details: {
          ...details,
          sef_id: getSefIdentifier() || "",
          transmission_flush,
        },
        text,
        printed,
        printMessage,
      });
    } catch (e) {
      console.error("[monthly-memory]", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /** Eksport audit log CSV/PDF (Neni 26 / 7) — Save As në Electron */
  app.post("/api/fiscal/audit/export", (req, res) => {
    try {
      const { exportAuditCSV, exportAuditPDF } = require("./fiscal/fiscal-audit");
      const from = req.body?.from || req.body?.from_date;
      const to = req.body?.to || req.body?.to_date;
      const format = String(req.body?.format || "csv").toLowerCase();
      const savePath =
        req.body?.savePath || req.body?.targetPath
          ? String(req.body.savePath || req.body.targetPath).trim()
          : "";
      if (!savePath) {
        return res.status(400).json({
          ok: false,
          cancelled: true,
          error: "Eksporti u anulua — nuk u zgjodh vendi i ruajtjes.",
        });
      }
      const filePath =
        format === "pdf"
          ? exportAuditPDF(from, to, savePath)
          : exportAuditCSV(from, to, savePath);
      if (!filePath) {
        return res.status(400).json({
          ok: false,
          error: "Fiskalizimi nuk është aktiv ose eksporti dështoi.",
        });
      }
      res.json({ ok: true, format, filePath });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /**
   * Ndërrim artikulli: kthim (return) i të vjetrit + shitje e re.
   * Kusht: e njëjta normë TVSH. Çmimi i ri mund të jetë barabartë, më i lartë ose më i ulët.
   */
  app.post("/api/fiscal/exchange", async (req, res) => {
    try {
      const blocked = recordsGuardResponse(res);
      if (blocked) return blocked;

      const nuikf = String(req.body?.nuikf || "").trim().toUpperCase();
      if (!nuikf) throw new Error("NUIKF origjinal mungon");

      const { getOriginalReceipt, getReturnableItemsForReceipt, createCorrectionReceipt, buildExchangeCorrectionReason } = require("./fiscal/fiscal-correction");
      const original = getOriginalReceipt(nuikf);
      if (!original) throw new Error("Kuponi origjinal nuk u gjet");

      const returnableItems = getReturnableItemsForReceipt(nuikf) || [];
      const round2ex = (n) => Math.round((Number(n) || 0) * 100) / 100;
      const products = db.listProducts();
      let selectedOld = [];
      let saleItems = [];

      if (Array.isArray(req.body?.exchange_lines) && req.body.exchange_lines.length) {
        for (const raw of req.body.exchange_lines) {
          const name = String(raw?.name || "").trim();
          const price = Number(raw?.unit_price ?? raw?.price) || 0;
          const qty = Number(raw?.quantity) || 0;
          const newProductId = Number(raw?.new_product_id) || 0;
          if (!name || qty <= 0 || !newProductId) continue;

          const match = returnableItems.find(
            (o) => o.name === name && Math.abs(o.unit_price - price) < 0.0001
          );
          if (!match) {
            throw new Error(`Artikulli nuk është në kuponin origjinal: ${name}`);
          }
          const remaining = Number(match.remaining_quantity) || 0;
          if (qty > remaining + 1e-9) {
            throw new Error(`Sasia tejkalon të mbeturën për: ${name} (max ${remaining})`);
          }

          const neu = products.find((p) => Number(p.id) === newProductId);
          if (!neu) throw new Error(`Produkti i ri nuk ekziston për: ${name}`);

          const oldVat = String(match.vat_norm || "E").toUpperCase();
          const newVat = String(neu.vat_letter || "E").toUpperCase();
          if (oldVat !== newVat) {
            throw new Error(`Norma TVSH duhet e njëjtë për ${name} (${oldVat} ≠ ${newVat})`);
          }

          selectedOld.push({
            name: match.name,
            quantity: qty,
            price: match.unit_price,
            unit_price: match.unit_price,
            vat_norm: oldVat,
          });
          saleItems.push({
            product_id: neu.id,
            name: neu.name,
            price: Number(neu.price) || 0,
            quantity: qty,
            vat_letter: newVat,
          });
        }
      } else if (Array.isArray(req.body?.old_items) && req.body.old_items.length) {
        const newProductId = Number(req.body?.new_product_id);
        if (!newProductId) throw new Error("Produkti i ri mungon");
        for (const raw of req.body.old_items) {
          const name = String(raw?.name || "").trim();
          const price = Number(raw?.unit_price ?? raw?.price) || 0;
          const qty = Number(raw?.quantity) || 0;
          if (!name || qty <= 0) continue;
          const match = returnableItems.find(
            (o) => o.name === name && Math.abs(o.unit_price - price) < 0.0001
          );
          if (!match) {
            throw new Error(`Artikulli nuk është në kuponin origjinal: ${name}`);
          }
          const remaining = Number(match.remaining_quantity) || 0;
          if (qty > remaining + 1e-9) {
            throw new Error(`Sasia tejkalon të mbeturën për: ${name} (max ${remaining})`);
          }
          selectedOld.push({
            name: match.name,
            quantity: qty,
            price: match.unit_price,
            unit_price: match.unit_price,
            vat_norm: match.vat_norm,
          });
        }
      } else {
        const newProductId = Number(req.body?.new_product_id);
        if (!newProductId) throw new Error("Produkti i ri mungon");
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
        const match = returnableItems.find(
          (o) =>
            o.name === String(oldItem.name || "").trim() &&
            Math.abs(o.unit_price - (Number(oldItem.unit_price ?? oldItem.price) || 0)) < 0.0001
        );
        const qty = Number(req.body?.quantity || match?.remaining_quantity || oldItem.quantity || 1) || 1;
        if (qty <= 0) throw new Error("Sasia duhet > 0");
        const remaining = Number(match?.remaining_quantity ?? qty) || 0;
        if (qty > remaining + 1e-9) {
          throw new Error(`Sasia tejkalon të mbeturën për: ${oldItem.name} (max ${remaining})`);
        }
        selectedOld = [
          {
            name: String(oldItem.name || "").trim(),
            quantity: qty,
            price: Number(oldItem.unit_price ?? oldItem.price) || 0,
            unit_price: Number(oldItem.unit_price ?? oldItem.price) || 0,
            vat_norm: String(oldItem.vat_norm || oldItem.vat_letter || "E").toUpperCase(),
          },
        ];
        const neu = products.find((p) => Number(p.id) === newProductId);
        if (!neu) throw new Error("Produkti i ri nuk ekziston");
        const oldVat = String(selectedOld[0].vat_norm || "E").toUpperCase();
        const newVat = String(neu.vat_letter || "E").toUpperCase();
        if (oldVat !== newVat) {
          throw new Error(`Norma TVSH duhet e njëjtë (${oldVat} ≠ ${newVat})`);
        }
        saleItems = [
          {
            product_id: neu.id,
            name: neu.name,
            price: Number(neu.price) || 0,
            quantity: qty,
            vat_letter: newVat,
          },
        ];
      }

      if (!selectedOld.length) {
        throw new Error("Zgjidhni të paktën një artikull për ndërrim");
      }

      if (!saleItems.length) {
        const newProductId = Number(req.body?.new_product_id);
        if (!newProductId) throw new Error("Produkti i ri mungon");
        const neu = products.find((p) => Number(p.id) === newProductId);
        if (!neu) throw new Error("Produkti i ri nuk ekziston");
        const oldVatSet = new Set(selectedOld.map((it) => String(it.vat_norm || "E").toUpperCase()));
        if (oldVatSet.size !== 1) {
          throw new Error("Artikujt e zgjedhur duhet të kenë të njëjtën normë TVSH");
        }
        const oldVat = [...oldVatSet][0];
        const newVat = String(neu.vat_letter || "E").toUpperCase();
        if (oldVat !== newVat) {
          throw new Error(`Norma TVSH duhet e njëjtë (${oldVat} ≠ ${newVat})`);
        }
        const totalQty = selectedOld.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
        saleItems = [
          {
            product_id: neu.id,
            name: neu.name,
            price: Number(neu.price) || 0,
            quantity: totalQty,
            vat_letter: newVat,
          },
        ];
      }

      const oldLineTotal = round2ex(
        selectedOld.reduce(
          (s, it) => s + (Number(it.unit_price ?? it.price) || 0) * (Number(it.quantity) || 0),
          0
        )
      );
      const newLineTotal = round2ex(
        saleItems.reduce(
          (s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0),
          0
        )
      );
      const difference = round2ex(newLineTotal - oldLineTotal);
      let scenario = "equal";
      if (difference > 0.02) scenario = "upgrade";
      else if (difference < -0.02) scenario = "downgrade";

      const paymentMethod =
        String(req.body?.payment_method || original.payment_method || "cash")
          .trim()
          .toLowerCase() || "cash";

      if (scenario === "upgrade" && (paymentMethod === "cash" || paymentMethod === "mixed")) {
        const received = Number(req.body?.amount_received);
        if (!Number.isFinite(received) || received + 1e-9 < difference) {
          throw new Error(
            `Klienti duhet të paguajë diferencën ${difference.toFixed(2)} €` +
              (Number.isFinite(received)
                ? ` (marrë: ${received.toFixed(2)} €)`
                : " — vendosni shumën e marrë")
          );
        }
      }
      if (scenario === "downgrade" && !req.body?.refund_acknowledged) {
        throw new Error(
          `Konfirmoni kthimin e ${Math.abs(difference).toFixed(2)} € klientit (refund_acknowledged)`
        );
      }

      const reason = buildExchangeCorrectionReason(selectedOld, saleItems);

      const ret = createCorrectionReceipt(
        nuikf,
        "return",
        selectedOld,
        reason,
        { operator_name: req.body?.operator_name || "Operator", operator_id: resolveBodyOperatorId(req) }
      );

      const { processFiscalReceipt, printFiscalBundle } = require("./fiscal/fiscal-main");
      const { generateFiscalQR } = require("./fiscal/fiscal-qr");
      const { isAtkTransmissionBlocked } = require("./fiscal/fiscal-test-mode-store");

      // Kthimi komplet (si /api/fiscal/storno): QR → ATK → print — para shitjes së re
      let qr = null;
      try {
        const settings = db.getFiscalSettingsRow();
        qr = await generateFiscalQR({
          nuikf: ret.nuikf,
          total_amount: ret.total_amount,
          fiscal_date: ret.fiscal_date,
          taxpayer_nui: settings.taxpayer_nui,
        });
      } catch {
        /* */
      }

      let printedReturn = false;
      let atkReturn = { atk_sent: false, atk_message: "LOKAL — pa dërgim te ATK" };
      let printOfflineBanner = false;
      if (!isAtkTransmissionBlocked()) {
        const { tryAutoSendFiscalReceiptById } = require("./fiscal/fiscal-offline");
        atkReturn = await tryAutoSendFiscalReceiptById(ret.id);
        if (
          !atkReturn.atk_sent &&
          !atkReturn.atk_test_mode &&
          atkReturn.atk_status === "send_failed"
        ) {
          printOfflineBanner = true;
        }
      }

      if (!req.body?.skip_print && ret.print_text) {
        const pr = await printFiscalBundle(ret.print_text, qr, {
          printOfflineBanner,
        });
        printedReturn = !!pr.printed;
      }

      const sale = db.createSale({
        items: saleItems,
        payment_method: paymentMethod,
        operator_name: req.body?.operator_name || "Operator",
      });

      const fiscalNew = await processFiscalReceipt(sale.id, sale.payment_method, {
        items: sale.items,
        operator_name: sale.operator_name,
        operator_id: resolveBodyOperatorId(req),
        total_amount: sale.total,
        subtotal: sale.subtotal,
        amount_paid: newLineTotal,
        skip_print: !!req.body?.skip_print,
      });

      res.json({
        ok: true,
        exchange: {
          scenario,
          old_line_total: oldLineTotal,
          new_line_total: newLineTotal,
          difference,
          amount_received:
            scenario === "upgrade" ? round2ex(req.body?.amount_received) : null,
          refund_amount: scenario === "downgrade" ? round2ex(Math.abs(difference)) : null,
          payment_method: paymentMethod,
        },
        return_coupon: {
          id: ret.id,
          nuikf: ret.nuikf,
          original_nuikf: ret.original_nuikf,
          receipt_type: ret.receipt_type,
          total_amount: ret.total_amount,
          printed: printedReturn,
          atk: atkReturn,
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
      const result = await runFiscalSelfTest({ print: false });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Verifikim zinxhiri hash (Neni 26) */
  app.get("/api/fiscal/hash-chain/verify", (_req, res) => {
    try {
      const { verifyFullChain } = require("./fiscal/fiscal-hash-chain");
      const report = verifyFullChain(5000);
      res.json({ ok: !!report.ok, report });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Preview E2E — field 8 discount; pa body → shembull statik */
  function truthyApiFlag(v) {
    return v === true || v === 1 || v === "1" || v === "on" || v === "yes";
  }

  app.get("/api/fiscal/test-atk-discount", async (req, res) => {
    try {
      const { runAtkDiscountE2eTest } = require("./fiscal/fiscal-atk-discount-e2e");
      const useSample = req.query?.use_sample === "1" || req.query?.use_sample === "true";
      const result = await runAtkDiscountE2eTest({
        dry_run: true,
        use_sample: useSample || !req.body?.items?.length,
        require_cart: req.query?.require_cart === "1",
      });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  /**
   * E2E discount te ATK TEST — preview ose dërgim.
   * Body: items, cart_discount, cart_surcharge, payment_method, payment_splits, use_sample, send_to_atk, confirmed
   */
  app.post("/api/fiscal/test-atk-discount", async (req, res) => {
    try {
      const { runAtkDiscountE2eTest } = require("./fiscal/fiscal-atk-discount-e2e");
      const body = req.body || {};
      const send = !!(
        body.send_to_atk === true ||
        body.send_to_atk === 1 ||
        body.send_to_atk === "1"
      );
      const previewOnly = truthyApiFlag(body.dry_run) || (!send && !truthyApiFlag(body.send_to_atk));
      const result = await runAtkDiscountE2eTest({
        dry_run: previewOnly,
        send_to_atk: send,
        confirmed: truthyApiFlag(body.confirmed),
        operator_name: body.operator_name || "Operator",
        use_sample: truthyApiFlag(body.use_sample),
        require_cart: truthyApiFlag(body.require_cart),
        nuikf: body.nuikf,
        receipt_id: body.receipt_id,
        items: body.items,
        cart_discount: body.cart_discount || null,
        cart_surcharge: body.cart_surcharge || null,
        payment_method: body.payment_method,
        payment_splits: body.payment_splits,
      });
      res.json({ ok: !!result.ok, result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
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
    const { isAtkAutoSendEnabled, processOfflineQueue } = require("./fiscal/fiscal-offline");
    const { isFiscalLocalRun } = require("./fiscal/fiscal-local-env");
    if (isAtkAutoSendEnabled() && !isFiscalLocalRun()) {
      setTimeout(() => {
        processOfflineQueue({ manual: false })
          .then((r) => {
            const n = Number(r?.processed) || 0;
            if (n > 0) {
              console.log(`[biznes] ATK — u dërguan ${n} kupon(ë) në pritje (nisje)`);
            }
          })
          .catch((e) => console.warn("[biznes] ATK boot flush:", e.message));
      }, 4000);
    }
  } catch (e) {
    console.warn("[biznes] offline queue schedule:", e.message);
  }

  global.__biznesRoutesReady = true;
  console.timeEnd("[biznes] boot-total");
  console.log(`[biznes] Folder: ${__dirname}`);
  console.log(`[biznes] DB: ${db.DB_PATH}`);
  try {
    const { logStartupFiscalStatus, scheduleStartupSelfTest } = require("./fiscal/fiscal-boot");
    logStartupFiscalStatus();
    scheduleStartupSelfTest(2500);
  } catch (e) {
    console.warn("[biznes] fiscal-boot:", e.message);
  }
  try {
    const { getAtkStatus } = require("./fiscal/fiscal-atk-api");
    const a = getAtkStatus();
    console.log(`[biznes] ATK ${a.environment}: ${a.atk_pos_coupon_url} (HTTP ${a.atk_transmission_blocked ? "BLOCKED" : "ON"})`);
    console.log(`[biznes] Çelësat: ${a.keys_dir}`);
  } catch {
    /* */
  }
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
  setImmediate(() => {
    try {
      const { startOfflineMonitor } = require("./fiscal/fiscal-offline");
      startOfflineMonitor();
    } catch (e) {
      console.warn("[biznes] offline monitor:", e.message);
    }
  });
  } catch (routeErr) {
    console.error("[biznes] route registration:", routeErr && routeErr.message ? routeErr.message : routeErr);
  }
  });

  return httpServer;
}

function shutdownHttpServer() {
  if (httpServer) {
    try {
      httpServer.close();
    } catch {
      /* */
    }
    httpServer = null;
  }
}

module.exports = { boot, app, shutdownHttpServer };

function shutdownSecure() {
  try {
    const { lockPrivateKeysAtRest } = require("./fiscal/fiscal-crypto");
    lockPrivateKeysAtRest();
  } catch {
    /* */
  }
}

process.on("SIGINT", () => {
  shutdownSecure();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownSecure();
  process.exit(0);
});
process.on("exit", shutdownSecure);

if (require.main === module) {
  boot().catch((e) => {
    console.error("Boot failed:", e);
    process.exit(1);
  });
}
