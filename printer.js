const os = require("os");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const {
  plainTextFromServerBundle,
  finalizeReceiptText,
  buildEscPosFromPlainText,
  ensureEscPosCut,
  cutOnlyEscPosBuffer,
  paperChars,
  labelValueLine,
} = require("./receipt-text");

const WINDOWS_DEFAULT = "__WINDOWS_DEFAULT__";

const FISCAL_KEYWORDS = [
  "fiskal",
  "fiscal",
  "arka",
  "datecs",
  "tremol",
  "daisy",
  "eltrade",
  "fp-",
  "fprint",
  "cash register",
  "gorenje",
  "incotex",
  "mettler",
  "epson fp",
  "sam4s",
  "partner",
  "swissbit",
];

const THERMAL_KEYWORDS = [
  "thermal",
  "receipt",
  "pos",
  "tysso",
  "epson tm",
  "star tsp",
  "star micronics",
  "bixolon",
  "xprinter",
  "escpos",
  "rp80",
  "rp58",
  "zebra",
  "citizen",
  "rongta",
  "gprinter",
];

function isElectron() {
  return !!(process.versions && process.versions.electron);
}

function isVirtualPrinter(name) {
  const l = String(name || "").toLowerCase();
  return (
    l.includes("pdf") ||
    l.includes("onenote") ||
    l.includes("xps") ||
    l.includes("fax") ||
    l.includes("microsoft print")
  );
}

function classifyPrinter(name, driver = "", port = "") {
  const l = String(name || "").toLowerCase();
  const d = String(driver || "").toLowerCase();
  const p = String(port || "").toLowerCase();
  const combined = `${l} ${d} ${p}`;

  if (FISCAL_KEYWORDS.some(k => combined.includes(k))) {
    return { type: "fiscal", label: "Arkë fiskale (Windows)", paper: "80mm", output: "text" };
  }
  if (
    THERMAL_KEYWORDS.some(k => combined.includes(k)) ||
    combined.includes("thermal") ||
    combined.includes("receipt") ||
    combined.includes("pos printer") ||
    (p.includes("usb") && (combined.includes("80") || combined.includes("58") || d.includes("esc")))
  ) {
    const isTysso = combined.includes("tysso");
    return {
      type: "thermal",
      label: isTysso ? "Tysso — printer termik" : "Printer termik",
      paper: combined.includes("58") ? "58mm" : "80mm",
      output: "escpos",
      brand: isTysso ? "tysso" : "",
    };
  }
  if (l.includes("laser") || l.includes("inkjet") || l.includes("officejet") || l.includes("deskjet")) {
    return { type: "standard", label: "Printer standard (A4)", paper: "a4", output: "html" };
  }
  return { type: "standard", label: "Printer tjetër", paper: "a4", output: "html" };
}

function mapWinPrinterStatus(code) {
  if (code === 0 || code === null || code === undefined) return "ok";
  return "warning";
}

function getWindowsDefaultPrinterName() {
  if (os.platform() !== "win32") return null;
  try {
    const out = execSync(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Printer -Filter \'Default=True\').Name"',
      { encoding: "utf8", timeout: 15000 },
    );
    const name = out.trim();
    return name || null;
  } catch {
    return null;
  }
}

function listWindowsPrintersPowerShell() {
  if (os.platform() !== "win32") return [];
  const tmpPs1 = path.join(os.tmpdir(), `biznes-printers-${process.pid}.ps1`);
  const tmpJson = path.join(os.tmpdir(), `biznes-printers-${process.pid}.json`);
  try {
    // Skedar .ps1 — shmang gabimet e quoting nga execSync
    const script = `
$ErrorActionPreference = 'Stop'
$def = $null
try { $def = (Get-CimInstance Win32_Printer -Filter "Default=True" -ErrorAction SilentlyContinue).Name } catch {}
$rows = @()
try {
  $rows = @(Get-CimInstance Win32_Printer | ForEach-Object {
    [PSCustomObject]@{
      Name = $_.Name
      PrinterStatus = [int]$_.PrinterStatus
      PortName = $_.PortName
      DriverName = $_.DriverName
      IsDefault = ($_.Name -eq $def)
    }
  })
} catch {
  $rows = @(Get-Printer | ForEach-Object {
    [PSCustomObject]@{
      Name = $_.Name
      PrinterStatus = [int]$_.PrinterStatus
      PortName = $_.PortName
      DriverName = $_.DriverName
      IsDefault = ($_.Name -eq $def)
    }
  })
}
$rows | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path '${tmpJson.replace(/'/g, "''")}' -Encoding UTF8
`;
    fs.writeFileSync(tmpPs1, script, "utf8");
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`,
      { encoding: "utf8", timeout: 25000, windowsHide: true }
    );
    if (!fs.existsSync(tmpJson)) return [];
    const trimmed = fs.readFileSync(tmpJson, "utf8").replace(/^\uFEFF/, "").trim();
    if (!trimmed) return [];
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : [data];
    return arr
      .filter((p) => p && p.Name)
      .map((p) => {
        const info = classifyPrinter(p.Name, p.DriverName, p.PortName);
        return {
          name: p.Name,
          status: mapWinPrinterStatus(p.PrinterStatus),
          port: p.PortName || "",
          driver: p.DriverName || "",
          isDefault: !!p.IsDefault,
          type: info.type,
          typeLabel: info.label,
          suggestedPaper: info.paper,
          brand: info.brand || "",
        };
      });
  } catch (e) {
    console.error("listWindowsPrintersPowerShell:", e.message);
    return [];
  } finally {
    try {
      fs.unlinkSync(tmpPs1);
    } catch {
      /* */
    }
    try {
      fs.unlinkSync(tmpJson);
    } catch {
      /* */
    }
  }
}

async function listPrintersElectron() {
  if (!isElectron()) return null;
  try {
    const win = global.__electronMainWindow;
    if (!win?.webContents?.getPrintersAsync) return null;
    const printers = await win.webContents.getPrintersAsync();
    return printers.map(p => {
      const info = classifyPrinter(p.name);
      return {
        name: p.name,
        status: p.status === 0 ? "ok" : "warning",
        port: p.options?.system_driver_info?.port || "",
        driver: p.description || "",
        isDefault: !!p.isDefault,
        type: info.type,
        typeLabel: info.label,
        suggestedPaper: info.paper,
      };
    });
  } catch (e) {
    console.error("listPrintersElectron:", e.message);
    return null;
  }
}

async function listPrinters() {
  const electronList = await listPrintersElectron();
  if (electronList && electronList.length) return electronList;
  return listWindowsPrintersPowerShell();
}

function isThermalItem(item) {
  if (item.type === "thermal") return true;
  const combined = `${item.name || ""} ${item.driver || ""} ${item.port || ""}`.toLowerCase();
  if (THERMAL_KEYWORDS.some(k => combined.includes(k))) return true;
  if (combined.includes("thermal") || combined.includes("receipt")) return true;
  if (item.port && /^usb/i.test(item.port) && !FISCAL_KEYWORDS.some(k => combined.includes(k))) {
    return combined.includes("pos") || combined.includes("80") || combined.includes("58");
  }
  return false;
}

function pickAutoPrinter(printers) {
  const items = printers
    .map(p => (typeof p === "string" ? { name: p } : p))
    .filter(p => p.name && !isVirtualPrinter(p.name));

  // Prefero Tysso USB (jo Copy 1/2 në COM)
  const tyssoUsb = items.find((item) => {
    const n = String(item.name || "").toLowerCase();
    const port = String(item.port || "").toLowerCase();
    return n.includes("tysso") && !n.includes("copy") && (port.includes("usb") || !port.includes("com"));
  });
  if (tyssoUsb) return tyssoUsb.name;

  const tyssoAny = items.find((item) =>
    String(item.name || "").toLowerCase().includes("tysso")
  );
  if (tyssoAny) return tyssoAny.name;

  for (const item of items) {
    if (isThermalItem(item)) return item.name;
  }
  for (const item of items) {
    if (item.type === "fiscal") return item.name;
  }
  const names = items.map(p => p.name);
  for (const name of names) {
    const l = name.toLowerCase();
    if (l.includes("thermal") || l.includes("receipt")) return name;
  }
  const def = items.find(p => p.isDefault);
  if (def) return def.name;
  const winDef = getWindowsDefaultPrinterName();
  if (winDef && names.includes(winDef)) return winDef;
  return names[0] || null;
}

function getPrinterConfig(db) {
  return {
    name: db.getSetting("printer_name", "") || "",
    kitchen_name: db.getSetting("kitchen_printer_name", "") || "",
    fiscal_name: db.getSetting("fiscal_printer_name", "") || "",
    paper: db.getSetting("printer_paper", "auto") || "auto",
    output: db.getSetting("printer_output", "auto") || "auto",
    waiter_shift_print_enabled: db.getSetting("waiter_shift_print_enabled", "1") === "1",
  };
}

function savePrinterConfig(db, { name, kitchen_name, fiscal_name, paper, output, waiter_shift_print_enabled }) {
  if (name !== undefined) db.setSetting("printer_name", String(name).trim());
  if (kitchen_name !== undefined) {
    db.setSetting("kitchen_printer_name", String(kitchen_name || "").trim());
  }
  if (fiscal_name !== undefined) {
    db.setSetting("fiscal_printer_name", String(fiscal_name || "").trim());
  }
  if (paper !== undefined) db.setSetting("printer_paper", String(paper).trim());
  if (output !== undefined) db.setSetting("printer_output", String(output).trim());
  if (waiter_shift_print_enabled !== undefined) {
    db.setSetting("waiter_shift_print_enabled", waiter_shift_print_enabled ? "1" : "0");
  }
}

function pickFiscalWindowsPrinter(printers) {
  const items = (printers || [])
    .filter(p => !isVirtualPrinter(p.name))
    .map(p => ({
      name: p.name,
      ...classifyPrinter(p.name, p.driverName || "", p.portName || ""),
    }))
    .filter(p => p.type === "fiscal");
  if (!items.length) return null;
  return items[0].name;
}

function stationConfigName(db, station = "bar", printers = []) {
  const config = getPrinterConfig(db);
  if (station === "kitchen") {
    // Printer i veçantë kuzhine, ose i njëjti si banaku (2 fletë të ndara te 1 pajisje)
    return config.kitchen_name || config.name || "";
  }
  if (station === "fiscal") {
    if (config.fiscal_name) return config.fiscal_name;
    const registerName = String(db.getSetting("fiscal_register_name", "") || "").trim();
    if (registerName && printers.length) {
      const match = printers.find(p =>
        String(p.name || "").toLowerCase().includes(registerName.toLowerCase()),
      );
      if (match) return match.name;
    }
    return pickFiscalWindowsPrinter(printers) || "";
  }
  return config.name || "";
}

function resolvePrinterName(configName, printers) {
  if (!configName || configName === WINDOWS_DEFAULT) {
    const def = printers.find(p => p.isDefault);
    if (def) return def.name;
    return getWindowsDefaultPrinterName() || printers[0]?.name || null;
  }
  return configName;
}

function resolvePaper(paperSetting, printerName) {
  if (paperSetting && paperSetting !== "auto") return paperSetting;
  return classifyPrinter(printerName).paper;
}

function resolveOutput(outputSetting, printerName) {
  if (outputSetting && outputSetting !== "auto") return outputSetting;
  return classifyPrinter(printerName).output;
}

function paperCss(paper) {
  if (paper === "58mm") {
    return {
      page: "@page { size: 58mm auto; margin: 1mm; }",
      body: "width: 52mm; font-size: 9px;",
    };
  }
  if (paper === "100mm") {
    return {
      page: "@page { size: 100mm auto; margin: 2mm; }",
      body: "width: 92mm; font-size: 12px;",
    };
  }
  if (paper === "a4") {
    return {
      page: "@page { size: A4; margin: 12mm; }",
      body: "width: auto; max-width: 180mm; font-size: 12px;",
    };
  }
  return {
    page: "@page { size: 80mm auto; margin: 2mm; }",
    body: "width: 72mm; font-size: 11px;",
  };
}

function buildPrintableDocument(innerHtml, paper = "80mm") {
  const css = paperCss(paper);
  return `<!DOCTYPE html>
<html lang="sq">
<head>
  <meta charset="UTF-8">
  <style>
    ${css.page}
    * { box-sizing: border-box; }
    body {
      ${css.body}
      margin: 0 auto;
      padding: 4px;
      font-family: "Courier New", Courier, monospace;
      font-weight: bold;
      color: #000;
      text-align: center;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .receipt-body { text-align: left; font-weight: bold; color: #000; }
    .receipt-rule { text-align: center; letter-spacing: 1px; margin: 4px 0; font-size: 0.95em; font-weight: bold; color: #000; }
    .receipt-name { font-size: 1.15em; font-weight: bold; text-align: center; margin: 4px 0; color: #000; }
    .receipt-meta { font-size: 0.95em; margin: 2px 0; font-weight: bold; color: #000; }
    .receipt-item { display: flex; justify-content: space-between; gap: 6px; margin: 2px 0; font-weight: bold; color: #000; }
    .receipt-total { display: flex; justify-content: space-between; font-size: 1.05em; font-weight: bold; margin-top: 4px; color: #000; }
    .receipt-thanks { text-align: center; margin-top: 6px; line-height: 1.35; font-weight: bold; color: #000; }
    .receipt-atk-seal { text-align: center; margin: 6px 0 2px; }
    .receipt-atk-caption { font-size: 8pt; font-weight: 700; text-align: center; margin-bottom: 4px; color: #111; }
    .receipt-fiscal-legal { font-size: 8.5pt; text-align: center; margin: 2px 0 4px; font-weight: bold; }
    .receipt-invoice { font-weight: bold; font-size: 1.05em; }
  </style>
</head>
<body>${innerHtml}</body>
</html>`;
}

/** Deleguar te receipt-text.js — një burim i vetëm i së vërtetës për gjerësinë e letrës. */
function lineWidthForPaper(paper) {
  return paperChars(paper);
}

/** Deleguar te receipt-text.js — e njëjta formatuese përdoret nga faturat dhe raportet. */
function padLine(left, right, width) {
  return labelValueLine(String(left), String(right), width);
}

// Sentinel used to mark two-span rows (label + value) before tags are stripped,
// so buildTextReceipt can pad them into aligned columns instead of gluing the
// two values together with no separator (e.g. "2x Kafe Espresso3.00 EUR").
const PAIR_MARKER = "@@PAIR@@";

function markPairedRows(html) {
  return String(html || "").replace(
    /<div[^>]*class="[^"]*(?:receipt-item|receipt-total)[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/div>/gi,
    (_m, left, right) => {
      const clean = (s) => String(s)
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .trim();
      return `${PAIR_MARKER}${clean(left)}${PAIR_MARKER}${clean(right)}${PAIR_MARKER}\n`;
    },
  );
}

function stripHtml(html) {
  return markPairedRows(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildTextReceipt(innerHtml, paper = "80mm") {
  const width = lineWidthForPaper(paper);
  const plain = stripHtml(innerHtml);
  const lines = plain.split("\n").map(l => l.trim()).filter(Boolean);
  const out = [];
  const rule = "=".repeat(width);
  const dash = "-".repeat(width);
  for (const line of lines) {
    if (line.startsWith(PAIR_MARKER)) {
      const parts = line.split(PAIR_MARKER);
      // parts = ["", left, right] — split() puts an empty string before the leading marker
      out.push(padLine(parts[1] || "", parts[2] || "", width));
    } else if (line.match(/^=+$/)) out.push(rule);
    else if (line.match(/^-+$/)) out.push(dash);
    else if (line.length > width) {
      let rest = line;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (rest) out.push(rest);
    } else out.push(line);
  }
  return out.join("\r\n") + "\r\n";
}

function buildTestReceiptHtml(paper) {
  const now = new Date();
  const data = now.toLocaleDateString("sq-AL");
  const ora = now.toLocaleTimeString("sq-AL", { hour: "2-digit", minute: "2-digit" });
  const paperLabel =
    paper === "a4"
      ? "A4"
      : paper === "58mm"
        ? "58mm thermal"
        : paper === "100mm"
          ? "100mm thermal"
          : "80mm thermal";
  return `
    <div class="receipt-rule">================================</div>
    <div class="receipt-name">TEST PRINT</div>
    <div class="receipt-meta">Sistemi i Restorantit / Kafenes</div>
    <div class="receipt-rule">================================</div>
    <div class="receipt-body">
      <div class="receipt-meta">Data: ${data}</div>
      <div class="receipt-meta">Ora: ${ora}</div>
      <div class="receipt-meta">Formati: ${paperLabel}</div>
      <div class="receipt-meta">Printer / arkë fiskale</div>
      <div class="receipt-rule">--------------------------------</div>
      <div class="receipt-item"><span>1× Test artikull</span><span>1.00 €</span></div>
      <div class="receipt-rule">--------------------------------</div>
      <div class="receipt-total"><span>TOTALI:</span><span>1.00 €</span></div>
    </div>
    <div class="receipt-rule">================================</div>
    <div class="receipt-thanks">Printimi funksionon ✅</div>
    <div class="receipt-rule">================================</div>
  `;
}

function printTextWindows(text, printerName) {
  const tmp = path.join(os.tmpdir(), `receipt-${Date.now()}.txt`);
  fs.writeFileSync(tmp, text, "utf8");
  const safeFile = tmp.replace(/'/g, "''");
  const safePrinter = printerName.replace(/'/g, "''");
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '${safeFile}' -Raw -Encoding UTF8 | Out-Printer -Name '${safePrinter}'"`,
      { timeout: 45000 },
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

const RAW_PRINT_PS = String.raw`
param([string]$PrinterName, [string]$BinPath)
$bytes = [System.IO.File]::ReadAllBytes($BinPath)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv")] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h, int lvl, [In] DOCINFO di);
  [DllImport("winspool.drv")] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool WritePrinter(IntPtr h, IntPtr buf, int cb, out int written);
}
'@
$di = New-Object RawPrint+DOCINFO
$di.pDocName = 'Receipt'
$di.pDataType = 'RAW'
$h = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter($PrinterName, [ref]$h, [IntPtr]::Zero)) { throw "OpenPrinter failed: $PrinterName" }
try {
  if (-not [RawPrint]::StartDocPrinter($h, 1, $di)) { throw 'StartDocPrinter failed' }
  try {
    if (-not [RawPrint]::StartPagePrinter($h)) { throw 'StartPagePrinter failed' }
    try {
      $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
        $written = 0
        if (-not [RawPrint]::WritePrinter($h, $p, $bytes.Length, [ref]$written)) { throw 'WritePrinter failed' }
      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
    } finally { [void][RawPrint]::EndPagePrinter($h) }
  } finally { [void][RawPrint]::EndDocPrinter($h) }
} finally { [void][RawPrint]::ClosePrinter($h) }
`;

function printRawEscPos(buffer, printerName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Buffer ESC/POS bosh.");
  }
  if (os.platform() !== "win32") {
    throw new Error("Printimi ESC/POS kërkon Windows.");
  }
  const binPath = path.join(os.tmpdir(), `escpos-${Date.now()}.bin`);
  const psPath = path.join(os.tmpdir(), `escpos-print-${Date.now()}.ps1`);
  fs.writeFileSync(binPath, buffer);
  fs.writeFileSync(psPath, RAW_PRINT_PS, "utf8");
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}" -PrinterName "${printerName.replace(/"/g, '`"')}" -BinPath "${binPath.replace(/"/g, '`"')}"`,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );
  } finally {
    for (const f of [binPath, psPath]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

async function ensureReceiptPrinter(db, station = "bar") {
  const printers = await listPrinters();
  const names = printers.map(p => p.name);
  const config = getPrinterConfig(db);
  let saved = stationConfigName(db, station, printers);

  if (station === "bar" && (!saved || (saved !== WINDOWS_DEFAULT && !names.includes(saved)))) {
    const picked = pickAutoPrinter(printers);
    if (picked) {
      db.setSetting("printer_name", picked);
      const info = classifyPrinter(picked);
      if (config.paper === "auto") db.setSetting("printer_paper", info.paper);
      if (config.output === "auto") db.setSetting("printer_output", info.output);
      saved = picked;
    }
  }

  const printerName = saved ? resolvePrinterName(saved, printers) : null;
  const paper = resolvePaper(getPrinterConfig(db).paper, printerName);
  return { printerName, paper, printers, station };
}

async function printEscPosReceipt(escposBase64, db, station = "bar") {
  return printEscPosReceiptAt(escposBase64, db, station);
}

async function printEscPosReceiptAt(escposBase64, db, station = "bar") {
  const { printerName, paper } = await ensureReceiptPrinter(db, station);
  if (!printerName) throw new Error("Nuk u gjet printer termik.");

  let buf = Buffer.from(String(escposBase64 || ""), "base64");
  if (!buf.length) throw new Error("Buffer ESC/POS bosh.");
  buf = ensureEscPosCut(buf);

  printRawEscPos(buf, printerName);
  return { printer: printerName, paper, output: "escpos", station };
}

async function printPlainTextReceipt(text, db, station = "bar") {
  return printPlainTextReceiptAt(text, db, station);
}

async function printPlainTextReceiptAt(text, db, station = "bar") {
  const { printerName, paper } = await ensureReceiptPrinter(db, station);
  if (!printerName) throw new Error("Nuk u gjet printer termik.");

  const normalized = finalizeReceiptText(String(text || ""), paper).trim();
  if (!normalized) throw new Error("Teksti i faturës është bosh.");

  try {
    printRawEscPos(buildEscPosFromPlainText(normalized), printerName);
    return { printer: printerName, paper, output: "escpos-text", station };
  } catch (err) {
    try {
      printTextWindows(`${normalized.replace(/\r?\n/g, "\r\n")}\r\n`, printerName);
      printRawEscPos(cutOnlyEscPosBuffer(), printerName);
      return { printer: printerName, paper, output: "text+cut", station };
    } catch (cutErr) {
      throw err;
    }
  }
}

/** Njësoj si printPlainTextReceiptAt (ESC/POS raw + CP1252) por pa finalizeReceiptText —
 * për raporte (X/Z) që s'kanë rreshta "Pagesa:"/"Faleminderit!" për t'u rirenditur si faturë. */
async function printPlainTextAt(text, db, station = "bar") {
  const { printerName, paper } = await ensureReceiptPrinter(db, station);
  if (!printerName) throw new Error("Nuk u gjet printer termik.");

  const normalized = String(text || "").trim();
  if (!normalized) throw new Error("Teksti është bosh.");

  try {
    printRawEscPos(buildEscPosFromPlainText(normalized), printerName);
    return { printer: printerName, paper, output: "escpos-text", station };
  } catch (err) {
    try {
      printTextWindows(`${normalized.replace(/\r?\n/g, "\r\n")}\r\n`, printerName);
      printRawEscPos(cutOnlyEscPosBuffer(), printerName);
      return { printer: printerName, paper, output: "text+cut", station };
    } catch (cutErr) {
      throw err;
    }
  }
}

async function printServerReceipt(bundle, db, station = "bar") {
  return printServerReceiptAt(bundle, db, station);
}

async function printServerReceiptAt(bundle, db, station = "bar") {
  const plainText = plainTextFromServerBundle(bundle);
  if (plainText.trim()) {
    try {
      return await printPlainTextReceiptAt(plainText, db, station);
    } catch (err) {
      if (!bundle?.escpos_base64) throw err;
    }
  }

  if (bundle?.escpos_base64) {
    return printEscPosReceiptAt(bundle.escpos_base64, db, station);
  }

  throw new Error("Fatura nga serveri nuk përmban ESC/POS ose tekst.");
}

async function printHtmlDocument(fullHtml, printerName, paper) {
  if (!printerName) throw new Error("Nuk është zgjedhur printer.");

  if (isElectron()) {
    const { BrowserWindow } = require("electron");
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`;
    await printWin.loadURL(dataUrl);
    await new Promise(r => setTimeout(r, 450));

    const pageSize =
      paper === "a4"
        ? { width: 210000, height: 297000 }
        : paper === "58mm"
          ? { width: 58000, height: 297000 }
          : paper === "100mm"
            ? { width: 100000, height: 297000 }
            : { width: 80000, height: 297000 };

    return new Promise((resolve, reject) => {
      printWin.webContents.print(
        {
          silent: true,
          deviceName: printerName,
          copies: 1,
          printBackground: false,
          margins: { marginType: paper === "a4" ? "default" : "none" },
          pageSize,
        },
        (success, failureReason) => {
          printWin.destroy();
          if (success) resolve();
          else reject(new Error(failureReason || "Printimi dështoi"));
        },
      );
    });
  }

  if (os.platform() === "win32") {
    printTextWindows(stripHtml(fullHtml), printerName);
    return;
  }

  throw new Error("Printimi kërkon Windows dhe aplikacionin .exe");
}

/** Prerje e letrës (ESC/POS GS V B 0) pas çdo faturë — mbyllje tavoline ose ndërrimi.
 * A4/laser nuk ka prerëse fizike; nëse pajisja s'pranon RAW ESC/POS, injorohet e heshtur. */
function cutPaperBestEffort(printerName, paper) {
  if (!printerName || paper === "a4") return;
  try {
    printRawEscPos(cutOnlyEscPosBuffer(), printerName);
  } catch {
    /* printeri nuk mbështet ESC/POS raw — vazhdo pa prerje shtesë */
  }
}

async function printReceipt(innerHtml, db) {
  return printReceiptAt(innerHtml, db, "bar");
}

async function printReceiptAt(innerHtml, db, station = "bar") {
  const config = getPrinterConfig(db);
  const printers = await listPrinters();
  const saved = stationConfigName(db, station, printers);
  const printerName = saved ? resolvePrinterName(saved, printers) : null;
  if (!printerName) {
    const label = station === "fiscal" ? "printer fiskal" : station === "kitchen" ? "printer kuzhine" : "printer";
    throw new Error(`Nuk është zgjedhur ${label}.`);
  }

  const paper = resolvePaper(config.paper, printerName);
  const output = station === "fiscal"
    ? (resolveOutput(config.output, printerName) === "html" ? "text" : resolveOutput(config.output, printerName))
    : resolveOutput(config.output, printerName);

  if (output === "text") {
    const text = buildTextReceipt(innerHtml, paper);
    if (isElectron()) {
      const doc = buildPrintableDocument(`<pre style="font-family:monospace;white-space:pre-wrap;text-align:left;font-weight:bold;color:#000">${text.replace(/</g, "&lt;")}</pre>`, paper);
      try {
        await printHtmlDocument(doc, printerName, paper);
        cutPaperBestEffort(printerName, paper);
        return { printer: printerName, paper, output, station };
      } catch {
        /* fallback text spooler */
      }
    }
    printTextWindows(text, printerName);
    cutPaperBestEffort(printerName, paper);
    return { printer: printerName, paper, output: "text", station };
  }

  const doc = innerHtml.trim().startsWith("<!DOCTYPE")
    ? innerHtml
    : buildPrintableDocument(innerHtml, paper);
  await printHtmlDocument(doc, printerName, paper);
  cutPaperBestEffort(printerName, paper);
  return { printer: printerName, paper, output: "html", station };
}

async function printTestPage(db) {
  const config = getPrinterConfig(db);
  const printers = await listPrinters();
  const printerName = resolvePrinterName(config.name, printers);
  if (!printerName) throw new Error("Zgjidhni printerin fillimisht.");
  const paper = resolvePaper(config.paper, printerName);
  const inner = buildTestReceiptHtml(paper);
  return printReceipt(inner, db);
}

async function getStatus(db) {
  const config = getPrinterConfig(db);
  const printers = await listPrinters();
  const effectiveName = resolvePrinterName(config.name, printers);
  const kitchenEffective = config.kitchen_name
    ? resolvePrinterName(config.kitchen_name, printers)
    : "";
  const fiscalEffective = stationConfigName(db, "fiscal", printers)
    ? resolvePrinterName(stationConfigName(db, "fiscal", printers), printers)
    : "";
  const names = printers.map(p => p.name);
  let connected = false;
  let message = "";
  let typeLabel = "";
  let suggestedPaper = "80mm";
  let suggestedOutput = "auto";

  if (effectiveName && names.includes(effectiveName)) {
    connected = true;
    const p = printers.find(x => x.name === effectiveName);
    const info = classifyPrinter(effectiveName);
    typeLabel = p?.typeLabel || info.label;
    suggestedPaper = resolvePaper(config.paper, effectiveName);
    suggestedOutput = resolveOutput(config.output, effectiveName);
    const portInfo = p?.port ? ` · port: ${p.port}` : "";
    message = `${typeLabel} i lidhur: ${effectiveName}${portInfo}`;
    try {
      const i18n = require("./i18n");
      if (i18n.isFrench()) {
        message = `${i18n.t(typeLabel) || typeLabel} ${i18n.t("i lidhur")}: ${effectiveName}${portInfo}`;
      }
    } catch { /* ignore */ }
  } else if (config.name && config.name !== WINDOWS_DEFAULT) {
    message = `Printeri/arka "${config.name}" nuk u gjet në Windows. Kontrolloni lidhjen ose zgjidhni tjetër.`;
  } else {
    const auto = pickAutoPrinter(printers);
    if (auto) {
      const info = classifyPrinter(auto);
      message = `Nuk ka pajisje të ruajtur. Sugjerim: ${auto} (${info.label}) — klikoni «Auto-zgjidh».`;
      typeLabel = info.label;
    } else {
      message =
        "Nuk u gjet asnjë printer. Instaloni driverin (termik, A4, ose arkë fiskale) pastaj rifreskoni listën.";
    }
  }

  const defaultPrinter = printers.find(p => p.isDefault)?.name || getWindowsDefaultPrinterName();

  return {
    ...config,
    effective_name: effectiveName,
    kitchen_effective_name: kitchenEffective,
    kitchen_connected: !!(kitchenEffective && names.includes(kitchenEffective)),
    fiscal_effective_name: fiscalEffective,
    fiscal_connected: !!(fiscalEffective && names.includes(fiscalEffective)),
    connected,
    printers,
    message,
    electron: isElectron(),
    suggested: pickAutoPrinter(printers),
    type_label: typeLabel,
    resolved_paper: effectiveName ? suggestedPaper : config.paper,
    resolved_output: effectiveName ? suggestedOutput : config.output,
    default_printer: defaultPrinter,
    windows_default_value: WINDOWS_DEFAULT,
  };
}

async function startupAutoDetect(db) {
  const printers = await listPrinters();
  const names = printers.map(p => p.name);
  const config = getPrinterConfig(db);
  const saved = config.name;

  if (saved && (saved === WINDOWS_DEFAULT || names.includes(saved))) {
    const effective = resolvePrinterName(saved, printers);
    console.log(`  🖨️  Printeri/arka: ${effective}`);
    return effective;
  }

  const picked = pickAutoPrinter(printers);
  if (picked) {
    db.setSetting("printer_name", picked);
    const info = classifyPrinter(picked);
    if (config.paper === "auto") db.setSetting("printer_paper", info.paper);
    if (config.output === "auto") db.setSetting("printer_output", info.output);
    console.log(`  🖨️  Auto-zgjedhur: ${picked} (${info.label})`);
    return picked;
  }

  if (saved) {
    console.warn(`  ⚠️  Pajisja e ruajtur "${saved}" nuk është e lidhur.`);
  } else {
    console.warn("  ⚠️  Nuk u gjet printer / arkë fiskale.");
  }
  return null;
}

module.exports = {
  WINDOWS_DEFAULT,
  listPrinters,
  classifyPrinter,
  pickAutoPrinter,
  getPrinterConfig,
  savePrinterConfig,
  getStatus,
  startupAutoDetect,
  printReceipt,
  printReceiptAt,
  printReceiptHtml: (html, db) => printReceipt(html, db),
  printServerReceipt,
  printServerReceiptAt,
  printEscPosReceipt,
  printEscPosReceiptAt,
  printPlainTextReceipt,
  printPlainTextReceiptAt,
  printPlainTextAt,
  ensureReceiptPrinter,
  stationConfigName,
  printRawEscPos,
  printTestPage,
  buildPrintableDocument,
};
