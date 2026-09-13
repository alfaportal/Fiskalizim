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
  // Serveri spawn nga main.js me ELECTRON_RUN_AS_NODE=1 ka process.versions.electron
  // por NUK mund të require("electron") — vetëm procesi kryesor i dritares.
  if (String(process.env.ELECTRON_RUN_AS_NODE || "") === "1") return false;
  return !!(process.versions && process.versions.electron);
}

function resolveBundledElectronExe() {
  const execDir = process.execPath ? path.dirname(process.execPath) : "";
  const resourcesPath =
    process.resourcesPath || (execDir ? path.join(execDir, "resources") : "");
  const candidates = [
    path.join(execDir, "runtime", "electron", "electron.exe"),
    path.join(resourcesPath, "runtime", "electron", "electron.exe"),
    path.join(
      process.env.ProgramData || "C:\\ProgramData",
      "RevolutionInvest",
      "Revolution-Fiskalizim",
      "runtime",
      "electron",
      "electron.exe",
    ),
    path.join(__dirname, "..", "runtime", "electron", "electron.exe"),
    path.join(__dirname, "..", "..", "node_modules", "electron", "dist", "electron.exe"),
    path.join(__dirname, "node_modules", "electron", "dist", "electron.exe"),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function printHtmlViaElectronWorker(fullHtml, printerName, paper) {
  const electronExe = resolveBundledElectronExe();
  const workerPath = path.join(__dirname, "electron-print-worker.js");
  if (!electronExe || !fs.existsSync(workerPath)) {
    throw new Error(
      "Mungon Electron print worker (runtime/electron/electron.exe). Rindërto paketën ose hap nga Revolution Fiskalizim.lnk i ri.",
    );
  }
  const htmlPath = path.join(os.tmpdir(), `pos-print-${Date.now()}-${process.pid}.html`);
  fs.writeFileSync(htmlPath, fullHtml, "utf8");
  try {
    execSync(
      `"${electronExe}" "${workerPath}" "${printerName.replace(/"/g, '`"')}" "${htmlPath.replace(/"/g, '`"')}" "${paper}"`,
      { timeout: 120000, stdio: "pipe" },
    );
    return { method: "electron-worker-gdi", printer: printerName, paper };
  } finally {
    try {
      fs.unlinkSync(htmlPath);
    } catch {
      /* ignore */
    }
  }
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

let _printerListCache = null;
let _printerListCacheAt = 0;
const PRINTER_LIST_CACHE_MS = 20000;

function listWindowsPrintersPowerShell() {
  if (os.platform() !== "win32") return [];
  const now = Date.now();
  if (_printerListCache && now - _printerListCacheAt < PRINTER_LIST_CACHE_MS) {
    return _printerListCache;
  }
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
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    );
    if (!fs.existsSync(tmpJson)) return [];
    const trimmed = fs.readFileSync(tmpJson, "utf8").replace(/^\uFEFF/, "").trim();
    if (!trimmed) return [];
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : [data];
    const mapped = arr
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
    _printerListCache = mapped;
    _printerListCacheAt = Date.now();
    return mapped;
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

  // Prefero Tysso Copy 1 nëse ekziston (shpesh funksionon kur USB001 jo)
  const tyssoCopy1 = items.find((item) =>
    /tysso/i.test(String(item.name || "")) && /copy\s*1/i.test(String(item.name || "")),
  );
  if (tyssoCopy1) return tyssoCopy1.name;

  const tyssoMain = findTyssoMainPrinter(items);
  if (tyssoMain?.name) return tyssoMain.name;

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

function getPrinterPort(printer) {
  return String(printer?.port || printer?.portName || "").toLowerCase();
}

function isTyssoComDuplicate(name, port) {
  const n = String(name || "").toLowerCase();
  const p = String(port || "").toLowerCase();
  return n.includes("tysso") && (n.includes("copy") || p.includes("com"));
}

const TYOSSO_MAIN_QUEUE = "Tysso Thermal Receipt Printer";
const TYOSSO_DRIVER_NAME = "Tysso Thermal Receipt Printer";
const TYOSSO_USB_PORT = "USB001";

function getWindowsSerialPortNames() {
  if (os.platform() !== "win32") return [];
  try {
    const out = execSync(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "[System.IO.Ports.SerialPort]::GetPortNames() -join \',\'"',
      { encoding: "utf8", timeout: 10000 },
    );
    return out
      .trim()
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isComPortActive(port) {
  const p = normalizePortName(port).toUpperCase();
  if (!/^COM\d+$/.test(p)) return false;
  return getWindowsSerialPortNames().some((x) => String(x).toUpperCase() === p);
}

function listTyssoQueues(printers) {
  return (printers || []).filter((p) => /tysso/i.test(String(p.name || "")));
}

function findTyssoMainPrinter(printers) {
  const items = listTyssoQueues(printers).filter((p) => !isTyssoCopyQueueName(p.name));
  const usb = items.find((p) => getPrinterPort(p).includes("usb"));
  if (usb) return usb;
  const comOk = items.find((p) => {
    const port = normalizePortName(p.port || p.portName || "");
    return /^com\d+$/i.test(port) && isComPortActive(port);
  });
  if (comOk) return comOk;
  return items[0] || null;
}

function findTyssoUsbPrinter(printers) {
  const main = findTyssoMainPrinter(printers);
  if (main && getPrinterPort(main).includes("usb")) return main;
  return (printers || []).find((p) => {
    const n = String(p.name || "").toLowerCase();
    const port = getPrinterPort(p);
    if (!n.includes("tysso") || n.includes("copy")) return false;
    return port.includes("usb");
  });
}

function getTyssoSetupDiagnostic(printers) {
  const list = printers || listWindowsPrintersPowerShell();
  const activeCom = getWindowsSerialPortNames();
  const tyssoAll = listTyssoQueues(list);
  const copies = tyssoAll.filter((p) => isTyssoCopyQueueName(p.name));
  const main = findTyssoMainPrinter(list);
  const mainPort = main ? normalizePortName(main.port || main.portName || "") : "";
  const mainOnUsb = !!(main && getPrinterPort(main).includes("usb"));
  const mainOnDeadCom =
    !!(main && /^com\d+$/i.test(mainPort) && !isComPortActive(mainPort));
  const usbPortFree = !list.some(
    (p) => normalizePortName(p.port || p.portName || "").toUpperCase() === TYOSSO_USB_PORT,
  );
  const issues = [];
  if (!main) issues.push("missing_main_queue");
  if (mainOnDeadCom) issues.push("dead_com_port");
  if (copies.length) issues.push("copy_queues");
  if (main && !mainOnUsb && !mainOnDeadCom && !/^com\d+$/i.test(mainPort)) {
    issues.push("unexpected_port");
  }
  let message = "";
  if (!main) {
    message =
      "Printeri Tysso nuk u gjet në Windows. Lidhni USB-n dhe ekzekutoni «Rregullo printerin» ose skriptin e instalimit.";
  } else if (mainOnDeadCom) {
    message = `Printeri Tysso është në ${mainPort.toUpperCase()}, por ky port nuk ekziston (aktiv: ${activeCom.join(", ") || "asnjë"}). Duhet USB001.`;
  } else if (copies.length && !mainOnUsb) {
    const copy1 = copies.find((p) => /copy\s*1/i.test(p.name));
    message = copy1
      ? `Tysso Copy 1 i gjetur — zgjidhni «${copy1.name}» te Printeri.`
      : "Ka kopje Tysso — zgjidhni atë që printon (Copy 1).";
  } else if (mainOnUsb) {
    message = `Tysso i lidhur mirë në ${mainPort.toUpperCase()}.`;
  }
  return {
    ok: !issues.length || (issues.length === 1 && issues[0] === "copy_queues" && mainOnUsb),
    issues,
    main_name: main?.name || null,
    main_port: mainPort || null,
    main_on_usb: mainOnUsb,
    main_on_dead_com: mainOnDeadCom,
    active_com_ports: activeCom,
    usb_port_free: usbPortFree,
    copy_queues: copies.map((p) => p.name),
    message,
    repairable: !!(mainOnDeadCom || !main || (copies.length && mainOnUsb)),
  };
}

function repairTyssoWindowsPrinter(options = {}) {
  if (os.platform() !== "win32") {
    return { ok: false, error: "Vetëm Windows." };
  }
  _printerListCache = null;
  const driverPath =
    options.driverExe ||
    path.join(process.env.USERPROFILE || "", "Desktop", "Printer Driver of PRP-188 PRP-250 PRP-350.exe");
  const tmpPs1 = path.join(os.tmpdir(), `biznes-tysso-repair-${process.pid}.ps1`);
  const script = `
$ErrorActionPreference = 'Stop'
$mainName = '${TYOSSO_MAIN_QUEUE.replace(/'/g, "''")}'
$driverName = '${TYOSSO_DRIVER_NAME.replace(/'/g, "''")}'
$usbPort = '${TYOSSO_USB_PORT}'
$driverExe = '${String(driverPath).replace(/'/g, "''")}'
$actions = @()

function Test-Driver($name) {
  return [bool](Get-PrinterDriver -Name $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Driver $driverName)) {
  if (Test-Path -LiteralPath $driverExe) {
    Start-Process -FilePath $driverExe -Wait -ErrorAction SilentlyContinue
    $actions += 'driver_install_attempted'
  } else {
    $actions += 'driver_missing_no_installer'
  }
}

$main = Get-Printer -Name $mainName -ErrorAction SilentlyContinue
if ($main) {
  if ($main.PortName -ne $usbPort) {
    Set-Printer -Name $mainName -PortName $usbPort
    $actions += 'port_set_usb001'
  }
} elseif (Test-Driver $driverName) {
  Add-Printer -Name $mainName -DriverName $driverName -PortName $usbPort
  $actions += 'printer_added_usb001'
}

$copy1 = Get-Printer -Name ($mainName + ' (Copy 1)') -ErrorAction SilentlyContinue
$com4Active = [bool]([System.IO.Ports.SerialPort]::GetPortNames() -contains 'COM4')
if ($com4Active -and (Test-Driver $driverName)) {
  if ($copy1) {
    if ($copy1.PortName -ne 'COM4:') {
      Set-Printer -Name ($mainName + ' (Copy 1)') -PortName 'COM4:'
      $actions += 'copy1_port_com4'
    }
  } else {
    Add-Printer -Name ($mainName + ' (Copy 1)') -DriverName $driverName -PortName 'COM4:'
    $actions += 'copy1_added_com4'
  }
}

$final = Get-Printer -Name $mainName -ErrorAction SilentlyContinue
[PSCustomObject]@{
  ok = [bool]$final
  name = $final.Name
  port = $final.PortName
  status = [string]$final.PrinterStatus
  actions = ($actions -join ';')
} | ConvertTo-Json -Compress
`;
  try {
    fs.writeFileSync(tmpPs1, script, "utf8");
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1.replace(/"/g, '`"')}"`,
      { encoding: "utf8", timeout: 120000 },
    );
    _printerListCache = null;
    const parsed = JSON.parse(String(out || "").trim() || "{}");
    return {
      ok: !!parsed.ok,
      name: parsed.name || null,
      port: parsed.port || null,
      status: parsed.status || null,
      actions: String(parsed.actions || "")
        .split(";")
        .filter(Boolean),
      message: parsed.ok
        ? `Printeri Tysso u rregullua: ${parsed.name} → ${parsed.port}`
        : "Rregullimi dështoi — kontrolloni lidhjen USB dhe driverin PRP.",
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    try {
      fs.unlinkSync(tmpPs1);
    } catch {
      /* ignore */
    }
  }
}

function isTyssoCopyQueueName(name) {
  return /tysso/i.test(String(name || "")) && /copy/i.test(String(name || ""));
}

function collectTyssoSpoolerTargets(printerName, printers) {
  const list = printers || [];
  const targets = [];
  const push = (t) => {
    if (!t || targets.includes(t)) return;
    targets.push(t);
  };
  const chosen = String(printerName || "").trim();
  push(chosen);
  if (!isTyssoCopyQueueName(chosen)) {
    push(resolveTyssoSpoolerName(chosen, list));
    const usb = findTyssoUsbPrinter(list);
    if (usb?.name) push(usb.name);
  }
  return targets;
}

function resolveTyssoSpoolerName(printerName, printers) {
  const list = printers || [];
  const usb = findTyssoUsbPrinter(list);
  if (usb?.name) return usb.name;
  const n = String(printerName || "");
  if (/tysso/i.test(n) && !/copy/i.test(n)) return n;
  return n;
}

function isPrinterManuallyChosen(db) {
  if (!db) return false;
  return db.getSetting("printer_manual", "") === "1";
}

/** Instalime ekzistuese: nëse ka printer të ruajtur, mos e ndrysho më automatikisht. */
function ensurePrinterManualMigration(db) {
  if (!db) return;
  const saved = String(db.getSetting("printer_name", "") || "").trim();
  if (saved && db.getSetting("printer_manual", "") === "") {
    db.setSetting("printer_manual", "1");
  }
}

/** Copy/COM Tysso — auto-zgjedh USB001 vetëm kur përdoruesi nuk ka zgjedhur manualisht. */
function shouldRepickSavedPrinter(savedName, printers, db) {
  if (isPrinterManuallyChosen(db)) return false;
  if (!savedName || savedName === WINDOWS_DEFAULT) return false;
  const tyssoUsb = findTyssoUsbPrinter(printers);
  if (!tyssoUsb) return false;
  const saved = (printers || []).find((p) => p.name === savedName);
  if (!saved) return true;
  return isTyssoComDuplicate(saved.name, getPrinterPort(saved));
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

function savePrinterConfig(db, { name, kitchen_name, fiscal_name, paper, output, waiter_shift_print_enabled, manual }) {
  if (name !== undefined) {
    const n = String(name).trim();
    db.setSetting("printer_name", n);
    if (/tysso/i.test(n)) {
      db.setSetting("fiscal_printer_name", n);
      db.setSetting("printer_output", "escpos");
    }
  }
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
  if (manual === true) db.setSetting("printer_manual", "1");
  else if (manual === false) db.setSetting("printer_manual", "0");
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
    return pickFiscalWindowsPrinter(printers) || config.name || pickAutoPrinter(printers) || "";
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
    <div class="receipt-meta">Revolution Fiskalizim</div>
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

function buildTyssoTestReceiptText(paper) {
  const now = new Date();
  const w = paperChars(paper);
  const rule = "=".repeat(Math.min(w, 32));
  return [
    rule,
    "REVOLUTION FISKALIZIM",
    "TEST PRINT — ESC/POS",
    rule,
    `Data: ${now.toLocaleDateString("sq-AL")}`,
    `Ora: ${now.toLocaleTimeString("sq-AL", { hour: "2-digit", minute: "2-digit" })}`,
    `Letra: ${paper || "80mm"}`,
    rule,
    "Printimi funksionon",
    rule,
  ].join("\n");
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
param([string]$PrinterName, [string]$BinPath, [int]$ChunkSize = 512, [int]$DelayMs = 8)
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
      $offset = 0
      while ($offset -lt $bytes.Length) {
        $len = [Math]::Min($ChunkSize, $bytes.Length - $offset)
        $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)
        try {
          [Runtime.InteropServices.Marshal]::Copy($bytes, $offset, $p, $len)
          $written = 0
          if (-not [RawPrint]::WritePrinter($h, $p, $len, [ref]$written)) { throw "WritePrinter failed at offset $offset" }
          if ($written -le 0) { throw "WritePrinter wrote 0 at offset $offset" }
          $offset += $written
        } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
        if ($DelayMs -gt 0 -and $offset -lt $bytes.Length) { Start-Sleep -Milliseconds $DelayMs }
      }
    } finally { [void][RawPrint]::EndPagePrinter($h) }
  } finally { [void][RawPrint]::EndDocPrinter($h) }
} finally { [void][RawPrint]::ClosePrinter($h) }
`;

function isTyssoUsbMainPrinter(printerName, printers) {
  const match = (printers || []).find((p) => p.name === printerName);
  const n = String(printerName || "").toLowerCase();
  const port = getPrinterPort(match || { port: "" });
  return n.includes("tysso") && !n.includes("copy") && port.includes("usb");
}

function findTyssoComQueueName(printers) {
  const items = (printers || []).filter((p) => {
    const n = String(p.name || "").toLowerCase();
    return n.includes("tysso") && n.includes("copy");
  });
  if (!items.length) return null;
  const copy1 = items.find((p) => /copy 1/i.test(p.name));
  return (copy1 || items[0]).name;
}

function spoolerChunkParams(bufferLength) {
  if (bufferLength > 16384) return { chunkSize: 128, delayMs: 20 };
  if (bufferLength > 4096) return { chunkSize: 192, delayMs: 15 };
  if (bufferLength > 1500) return { chunkSize: 256, delayMs: 10 };
  return { chunkSize: 512, delayMs: 6 };
}
function findTyssoComPort(printers) {
  const items = (printers || []).filter((p) => {
    const n = String(p.name || "").toLowerCase();
    const port = normalizePortName(p.port || p.portName || "");
    return n.includes("tysso") && /^com\d+$/i.test(port) && isComPortActive(port);
  });
  if (!items.length) return null;
  const nonCopy = items.find((p) => !String(p.name || "").toLowerCase().includes("copy"));
  return normalizePortName((nonCopy || items[0]).port || (nonCopy || items[0]).portName || "");
}

function normalizePortName(port) {
  return String(port || "").trim().replace(/:$/, "");
}

/** Tysso ESC/POS — COM4 zakonisht 19200 (jo 9600); pa mode, shkrimi thotë OK por s’printon. */
function configureComPortForTysso(portName) {
  const port = normalizePortName(portName);
  if (!/^com\d+$/i.test(port)) return;
  try {
    execSync(`mode ${port}: BAUD=19200 PARITY=N DATA=8 STOP=1`, {
      timeout: 2000,
      stdio: "pipe",
    });
  } catch {
    /* printeri mund të jetë tashmë i konfiguruar */
  }
}

function findTyssoActiveComPort(printers) {
  const fromQueue = findTyssoComPort(printers);
  if (fromQueue) return fromQueue;
  const active = getWindowsSerialPortNames().map((p) => normalizePortName(p).toUpperCase());
  if (active.includes("COM4")) return "COM4";
  return (
    active.find((p) => /^COM\d+$/.test(p) && p !== "COM1" && p !== "COM6") || null
  );
}

function resolveTyssoDirectComPort(printerName, printers) {
  const list = printers || listWindowsPrintersPowerShell();
  if (isTyssoCopyQueueName(printerName)) {
    return findTyssoComPort(list) || findTyssoActiveComPort(list);
  }
  const match = list.find((p) => p.name === printerName);
  const port = normalizePortName(match?.port || match?.portName || "");
  if (/^com\d+$/i.test(port) && isComPortActive(port)) return port;
  if (/tysso/i.test(String(printerName || ""))) {
    return findTyssoActiveComPort(list);
  }
  return null;
}

function sleepMs(ms) {
  if (!ms || ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* prit — lejo printerin termik të përpunojë buffer-in */
  }
}

function writeBufferToComPort(fd, buffer, chunkSize = 512, delayMs = 4) {
  let offset = 0;
  let chunks = 0;
  while (offset < buffer.length) {
    const toWrite = Math.min(chunkSize, buffer.length - offset);
    const written = fs.writeSync(fd, buffer, offset, toWrite);
    if (!written || written <= 0) {
      throw new Error(`COM u bllokua pas ${offset}/${buffer.length} bajt`);
    }
    offset += written;
    chunks += 1;
    if (delayMs > 0 && offset < buffer.length) sleepMs(delayMs);
  }
  return { bytes: offset, chunks };
}

function printRawDirectPort(buffer, portName) {
  const port = normalizePortName(portName);
  if (!/^com\d+$/i.test(port)) {
    throw new Error(`Porti ${port || "?"} nuk mbështet shkrim direkt.`);
  }
  configureComPortForTysso(port);
  const devicePath = `\\\\.\\${port}`;
  const fd = fs.openSync(devicePath, "w");
  try {
    const chunkSize = buffer.length > 8192 ? 256 : buffer.length > 2048 ? 512 : 1024;
    const delayMs = buffer.length > 2048 ? 8 : 4;
    const stats = writeBufferToComPort(fd, buffer, chunkSize, delayMs);
    if (stats.bytes !== buffer.length) {
      throw new Error(`COM incomplete: ${stats.bytes}/${buffer.length} bajt`);
    }
    sleepMs(buffer.length > 512 ? 120 : 60);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  return { method: "direct-com", port, bytes: buffer.length };
}

function printRawSpooler(buffer, printerName) {
  const binPath = path.join(os.tmpdir(), `escpos-${Date.now()}-${process.pid}.bin`);
  const psPath = path.join(os.tmpdir(), `escpos-print-${Date.now()}-${process.pid}.ps1`);
  const { chunkSize, delayMs } = spoolerChunkParams(buffer.length);
  fs.writeFileSync(binPath, buffer);
  fs.writeFileSync(psPath, RAW_PRINT_PS, "utf8");
  const timeoutMs = buffer.length > 16384 ? 180000 : buffer.length > 8192 ? 120000 : 60000;
  try {
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}" -PrinterName "${printerName.replace(/"/g, '`"')}" -BinPath "${binPath.replace(/"/g, '`"')}" -ChunkSize ${chunkSize} -DelayMs ${delayMs}`,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
    );
    if (out && /WritePrinter failed|OpenPrinter failed/i.test(out)) {
      throw new Error(String(out).trim());
    }
  } finally {
    for (const f of [binPath, psPath]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  return { method: "raw-spooler", printer: printerName, bytes: buffer.length, chunkSize, delayMs };
}

const ESCPOS_QR_MARKER = Buffer.from([0x1d, 0x28, 0x6b]);
const ESCPOS_RASTER_MARKER = Buffer.from([0x1d, 0x76, 0x30]);

function isGsV0RasterAt(buffer, offset = 0) {
  return (
    buffer.length >= offset + 4 &&
    buffer[offset] === 0x1d &&
    buffer[offset + 1] === 0x76 &&
    buffer[offset + 2] === 0x30
  );
}

function rasterPixelWidthFromGsV0(buffer, offset = 0) {
  if (!isGsV0RasterAt(buffer, offset) || buffer.length < offset + 8) return 0;
  const widthBytes = buffer[offset + 4] + (buffer[offset + 5] << 8);
  return widthBytes * 8;
}

function resolveReceiptPaperDots() {
  try {
    const { resolvePaperDotsForPrint } = require("./fiscal/fiscal-logo");
    return resolvePaperDotsForPrint();
  } catch {
    return 504;
  }
}

/** GS L + ESC l — margjinë majtas para GS v 0 (delegon te fiscal-logo). */
function buildLogoRasterCenterPrefix(rasterPixelWidth, paperDots) {
  const margin = Math.max(0, Math.floor((paperDots - rasterPixelWidth) / 2));
  const { buildLogoCenterPrefix } = require("./fiscal/fiscal-logo");
  return buildLogoCenterPrefix(margin);
}

function countEscPosRasterMarkers(buffer) {
  if (!Buffer.isBuffer(buffer)) return 0;
  let count = 0;
  let pos = 0;
  while (pos < buffer.length) {
    const idx = buffer.indexOf(ESCPOS_RASTER_MARKER, pos);
    if (idx < 0) break;
    count += 1;
    pos = idx + 4;
  }
  return count;
}

/** Pas ESC @ (fazë e re), ri-vendos qendrimin e logos para GS v 0. */
function hasRecentGsLMargin(stage, rasterIdx) {
  const scanStart = Math.max(0, rasterIdx - 20);
  for (let i = scanStart; i + 3 < rasterIdx; i += 1) {
    if (stage[i] === 0x1d && stage[i + 1] === 0x4c) return true;
  }
  return false;
}

function ensureLogoMarginBeforeRaster(stage) {
  let out = stage;
  let searchFrom = 0;
  while (searchFrom < out.length) {
    const idx = out.indexOf(ESCPOS_RASTER_MARKER, searchFrom);
    if (idx < 0) break;
    if (hasRecentGsLMargin(out, idx)) {
      searchFrom = idx + 4;
      continue;
    }
    const rasterW = rasterPixelWidthFromGsV0(out, idx);
    if (rasterW <= 0) break;
    const prefix = buildLogoRasterCenterPrefix(rasterW, resolveReceiptPaperDots());
    out = Buffer.concat([out.subarray(0, idx), prefix, out.subarray(idx)]);
    searchFrom = idx + prefix.length + 4;
  }
  return out;
}

/** Pas ESC @, ri-vendos qendrimin e QR para GS ( k. */
function ensureQrCenterAlign(stage) {
  const idx = stage.indexOf(ESCPOS_QR_MARKER);
  if (idx < 0) return stage;
  if (idx >= 3 && stage[idx - 3] === 0x1b && stage[idx - 2] === 0x61 && stage[idx - 1] === 0x01) {
    return stage;
  }
  let moduleSize = 3;
  let dataLen = 200;
  try {
    const { estimateQrPrintWidthDots, buildQrCenterPrefix } = require("./fiscal/fiscal-qr");
    for (let i = idx; i + 8 < stage.length; i += 1) {
      if (
        stage[i] === 0x1d &&
        stage[i + 1] === 0x28 &&
        stage[i + 2] === 0x6b &&
        stage[i + 6] === 0x43
      ) {
        moduleSize = stage[i + 7] || 3;
        break;
      }
    }
    for (let i = idx; i + 10 < stage.length; i += 1) {
      if (
        stage[i] === 0x1d &&
        stage[i + 1] === 0x28 &&
        stage[i + 2] === 0x6b &&
        stage[i + 6] === 0x50
      ) {
        const pL = stage[i + 3];
        const pH = stage[i + 4];
        dataLen = Math.max(1, pL + (pH << 8) - 3);
        break;
      }
    }
    estimateQrPrintWidthDots(moduleSize, dataLen);
    const prefix = buildQrCenterPrefix(moduleSize, dataLen);
    const before = stage.subarray(0, idx);
    const after = stage.subarray(idx);
    return Buffer.concat([before, prefix, after]);
  } catch {
    return Buffer.concat([
      stage.subarray(0, idx),
      Buffer.from([0x1b, 0x61, 0x01]),
      stage.subarray(idx),
    ]);
  }
}

/**
 * Para dërgimit te spooler/COM — ri-vendos qendrimin e QR (native) dhe raster (QR+logo).
 * MOS hiq këtë thirrje nga printRawEscPos; ndryshe margjinat humbasin pas ESC @ / fazave.
 */
function prepareFiscalTailBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return buffer;
  const hasQr = buffer.indexOf(ESCPOS_QR_MARKER) >= 0;
  const hasRaster = buffer.indexOf(ESCPOS_RASTER_MARKER) >= 0;
  if (!hasQr && !hasRaster) return buffer;
  let out = hasQr ? ensureQrCenterAlign(buffer) : buffer;
  if (hasRaster) out = ensureLogoMarginBeforeRaster(out);
  return out;
}

/**
 * Kupon fiskal: QR raster + logo = 2× GS v 0 — gjithmonë një fazë (ndarja prish GS L).
 * Native QR + logo raster — e njëjta rregull.
 */
function splitEscPosStages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 256) return [buffer];
  const hasQr = buffer.indexOf(ESCPOS_QR_MARKER) >= 0;
  const hasRaster = buffer.indexOf(ESCPOS_RASTER_MARKER) >= 0;
  const rasterCount = hasRaster ? countEscPosRasterMarkers(buffer) : 0;
  if ((hasQr && hasRaster) || rasterCount >= 2) return [buffer];

  const qrIdx = buffer.indexOf(ESCPOS_QR_MARKER);
  const markers = [];
  if (qrIdx >= 0) markers.push(findQrStageStart(buffer, qrIdx));
  if (!markers.length) return [buffer];

  markers.sort((a, b) => a - b);
  const stages = [];
  let prev = 0;
  for (const idx of markers) {
    if (idx > prev) stages.push(buffer.subarray(prev, idx));
    prev = idx;
  }
  if (prev < buffer.length) stages.push(buffer.subarray(prev));
  return stages.filter((s) => s.length > 0);
}

function findQrStageStart(buffer, qrIdx) {
  let start = qrIdx;
  if (start >= 3 && buffer[start - 3] === 0x1b && buffer[start - 2] === 0x61) {
    start -= 3;
  }
  if (start >= 4 && buffer[start - 4] === 0x1d && buffer[start - 3] === 0x4c) {
    start -= 4;
  }
  if (start >= 3 && buffer[start - 3] === 0x1b && buffer[start - 2] === 0x6c) {
    start -= 3;
  }
  return start;
}

function prependEscPosInit(stage, needed) {
  if (!needed || !stage.length) return stage;
  if (stage[0] === 0x1b && stage[1] === 0x40) return stage;
  let body = stage;
  if (body.indexOf(ESCPOS_QR_MARKER) >= 0) body = ensureQrCenterAlign(body);
  if (body.indexOf(ESCPOS_RASTER_MARKER) >= 0) body = ensureLogoMarginBeforeRaster(body);
  if (isGsV0RasterAt(body, 0)) {
    const rasterW = rasterPixelWidthFromGsV0(body, 0);
    if (rasterW > 0) {
      body = Buffer.concat([buildLogoRasterCenterPrefix(rasterW, resolveReceiptPaperDots()), body]);
    }
  }
  return Buffer.concat([Buffer.from([0x1b, 0x40]), body]);
}

function stagePauseMs(stageIndex, stageBytes, totalStages) {
  if (stageIndex >= totalStages - 1) return 0;
  if (stageBytes > 1200) return 500;
  if (stageBytes > 400) return 350;
  return 250;
}

function printRawSpoolerStaged(buffer, printerName) {
  const stages = splitEscPosStages(buffer);
  if (stages.length <= 1) {
    return printRawSpooler(buffer, printerName);
  }

  let totalBytes = 0;
  for (let i = 0; i < stages.length; i += 1) {
    const part = prependEscPosInit(stages[i], i > 0);
    const result = printRawSpooler(part, printerName);
    totalBytes += part.length;
    console.log(
      `[printer] spooler fazë ${i + 1}/${stages.length}: ${printerName} (${part.length} bajt)`,
    );
    const pause = stagePauseMs(i, part.length, stages.length);
    if (pause > 0) sleepMs(pause);
    if (i === stages.length - 1) {
      return {
        method: "raw-spooler-staged",
        printer: printerName,
        bytes: totalBytes,
        stages: stages.length,
        chunkSize: result.chunkSize,
        delayMs: result.delayMs,
      };
    }
  }
  return { method: "raw-spooler-staged", printer: printerName, bytes: totalBytes, stages: stages.length };
}

function printRawEscPos(buffer, printerName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Buffer ESC/POS bosh.");
  }
  if (os.platform() !== "win32") {
    throw new Error("Printimi ESC/POS kërkon Windows.");
  }

  buffer = prepareFiscalTailBuffer(buffer);

  const printers = listWindowsPrintersPowerShell();
  const name = String(printerName || "");
  if (!name) throw new Error("Nuk është zgjedhur printer.");

  const isTysso = /tysso/i.test(name);
  const comPort = resolveTyssoDirectComPort(name, printers);
  const tyssoOnUsb = isTysso && (() => {
    const match = printers.find((p) => p.name === name);
    return getPrinterPort(match || {}).includes("usb");
  })();

  const trySpooler = (target, payload = buffer) => {
    const result = printRawSpooler(payload, target);
    console.log(`[printer] spooler OK: ${target} (${payload.length} bajt)`);
    return result;
  };

  const tryCom = (port = comPort) => {
    const result = printRawDirectPort(buffer, port);
    console.log(`[printer] COM OK: ${port} (${buffer.length} bajt)`);
    return result;
  };

  /* Tysso USB001: spooler RAW shpesh thotë OK por nuk printon — COM4 (19200) është rruga reale. */
  if (isTysso) {
    let lastErr = null;

    if (comPort) {
      try {
        return tryCom(comPort);
      } catch (e) {
        lastErr = e;
        console.warn("[printer] Tysso COM dështoi:", comPort, e.message);
      }
    }

    const spoolerTargets = collectTyssoSpoolerTargets(name, printers);
    for (const target of spoolerTargets) {
      try {
        const result = printRawSpoolerStaged(buffer, target);
        console.log(
          `[printer] spooler OK: ${target} (${buffer.length} bajt, fazat=${result.stages || 1})`,
        );
        return result;
      } catch (e) {
        lastErr = e;
        console.warn("[printer] spooler Tysso dështoi:", target, e.message);
      }
    }

    const hint = tyssoOnUsb && comPort
      ? ` USB001 nuk printon — provo të rilidhësh kabllon USB (COM4: ${comPort}).`
      : isTyssoCopyQueueName(name)
        ? " Kontrolloni që «Copy 1» është i ndezur dhe i lidhur me USB."
        : " Kontrolloni që printeri Tysso është i ndezur dhe i lidhur me USB001/COM4.";
    throw new Error(
      (lastErr?.message || "Printimi Tysso dështoi (COM + spooler).") + hint
    );
  }

  if (comPort) {
    try {
      return tryCom(comPort);
    } catch (directErr) {
      console.warn("[printer] direct COM dështoi:", comPort, directErr.message);
    }
  }

  return trySpooler(name);
}

async function persistDefaultReceiptPrinter(db) {
  ensurePrinterManualMigration(db);
  if (isPrinterManuallyChosen(db)) {
    return db.getSetting("printer_name", "") || null;
  }
  const printers = await listPrinters();
  const picked = pickAutoPrinter(printers);
  if (!picked) return null;
  const current = String(db.getSetting("printer_name", "") || "").trim();
  if (!current || shouldRepickSavedPrinter(current, printers, db)) {
    db.setSetting("printer_name", picked);
    db.setSetting("fiscal_printer_name", picked);
    const info = classifyPrinter(picked);
    const paper = db.getSetting("printer_paper", "80mm");
    if (!paper || paper === "auto" || paper === "100mm") {
      db.setSetting("printer_paper", info.paper || "80mm");
    }
    if (info.brand === "tysso" || /tysso/i.test(picked)) {
      db.setSetting("printer_output", "escpos");
    }
    console.log("[printer] standard i ruajtur:", picked, `(${info.paper || "80mm"})`);
  } else if (/tysso/i.test(current) && String(db.getSetting("printer_output", "") || "").toLowerCase() === "html") {
    db.setSetting("printer_output", "escpos");
  }
  return db.getSetting("printer_name", picked);
}

async function isTyssoReceiptPrinter(db) {
  try {
    const { printerName } = await ensureReceiptPrinter(db, "bar");
    if (!printerName) return false;
    const info = classifyPrinter(printerName);
    return info.brand === "tysso" || /tysso/i.test(String(printerName));
  } catch {
    return false;
  }
}

async function ensureReceiptPrinter(db, station = "bar") {
  ensurePrinterManualMigration(db);
  const printers = await listPrinters();
  const names = printers.map(p => p.name);
  const config = getPrinterConfig(db);
  let saved = stationConfigName(db, station, printers);

  const missingSaved = !saved || (saved !== WINDOWS_DEFAULT && !names.includes(saved));
  const manual = isPrinterManuallyChosen(db);
  const repickTysso = !manual && shouldRepickSavedPrinter(saved, printers, db);
  const autoStation = station === "bar" || station === "fiscal" || station === "kitchen";

  if (autoStation && !manual && (missingSaved || repickTysso)) {
    const picked = pickAutoPrinter(printers);
    if (picked) {
      if (station === "kitchen") {
        db.setSetting("kitchen_printer_name", picked);
      } else {
        db.setSetting("printer_name", picked);
        if (station === "fiscal" && !config.fiscal_name) {
          db.setSetting("fiscal_printer_name", picked);
        }
      }
      const info = classifyPrinter(picked);
      if (config.paper === "auto" || config.paper === "100mm") {
        db.setSetting("printer_paper", info.paper || "80mm");
      }
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

  const send = printRawEscPos(buf, printerName);
  return { printer: printerName, paper, output: "escpos", station, ...send };
}

async function printPlainTextReceipt(text, db, station = "bar") {
  return printPlainTextReceiptAt(text, db, station);
}

async function printPlainTextReceiptAt(text, db, station = "bar") {
  const { printerName, paper } = await ensureReceiptPrinter(db, station);
  if (!printerName) throw new Error("Nuk u gjet printer termik.");

  const normalized = finalizeReceiptText(String(text || ""), paper).trim();
  if (!normalized) throw new Error("Teksti i faturës është bosh.");

  if (isTyssoPrinterName(printerName)) {
    const send = printTyssoEscPosText(normalized, printerName, paper);
    return { ...send, station };
  }

  try {
    const send = printRawEscPos(buildEscPosFromPlainText(normalized), printerName);
    return { printer: printerName, paper, output: "escpos-text", station, ...send };
  } catch (err) {
    try {
      printTextWindows(`${normalized.replace(/\r?\n/g, "\r\n")}\r\n`, printerName);
      const cut = printRawEscPos(cutOnlyEscPosBuffer(), printerName);
      return { printer: printerName, paper, output: "text+cut", station, ...cut };
    } catch (cutErr) {
      throw err;
    }
  }
}

/** Njësoj si printPlainTextReceiptAt (ESC/POS raw + CP1252) por pa finalizeReceiptText —
 * për raporte (X/Z) që s'kanë rreshta "Pagesa:"/"Faleminderit!" për t'u rirenditur si faturë. */
function isTyssoPrinterName(name) {
  return /tysso/i.test(String(name || ""));
}

/** Tysso: ESC/POS përmes COM4 (si Kafene) — GDI worker shpesh thotë OK por nuk printon. */
function printTyssoEscPosText(text, printerName, paper, opts = {}) {
  const normalized = finalizeReceiptText(String(text || ""), paper).trim();
  if (!normalized) throw new Error("Teksti i faturës është bosh.");
  const buf = buildEscPosFromPlainText(normalized, {
    cut: opts.cut !== false,
    keepAlbanian: true,
    dark: false,
    fiscalEmphasized: false,
    allowDoubleSize: false,
    ...opts.escpos,
  });
  const send = printRawEscPos(buf, printerName);
  return {
    printer: printerName,
    paper,
    output: "escpos-text",
    method: send.method || "escpos-com",
    ...send,
  };
}

async function printTyssoReceiptBestEffort(innerHtml, printerName, paper) {
  const text = buildTextReceipt(innerHtml, paper);
  try {
    return printTyssoEscPosText(text, printerName, paper);
  } catch (err) {
    console.warn("[printer] Tysso ESC/POS dështoi:", err.message);
    const copyHint = /copy/i.test(String(printerName || ""))
      ? " Kontrolloni lidhjen USB dhe që printeri është i ndezur."
      : "";
    throw new Error(`${err.message || "Printimi Tysso dështoi."}${copyHint}`);
  }
}

/** Tysso — i njëjti pipeline si Kafene: HTML → Electron print (pa RAW cut). */
async function printTyssoHtmlReceipt(innerHtml, printerName, paper) {
  if (!printerName) throw new Error("Nuk është zgjedhur printer.");
  const doc = String(innerHtml || "").trim().startsWith("<!DOCTYPE")
    ? innerHtml
    : buildPrintableDocument(innerHtml, paper);

  await printHtmlDocument(doc, printerName, paper);
  return {
    printer: printerName,
    paper,
    output: "html",
    method: isElectron() ? "electron-gdi" : "electron-worker-gdi",
  };
}

function escapeHtmlText(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function plainTextToReceiptHtml(text) {
  const lines = String(text || "").split(/\r?\n/);
  const body = lines
    .map((line) => `<div class="receipt-meta">${escapeHtmlText(line) || "&nbsp;"}</div>`)
    .join("\n");
  return `
    <div class="receipt-rule">================================</div>
    <div class="receipt-name">REVOLUTION FISKALIZIM</div>
    <div class="receipt-body">${body}</div>
    <div class="receipt-rule">================================</div>
  `;
}

/** Tysso në Windows: driver-i printon përmes GDI (Electron/Out-Printer), jo RAW ESC/POS. */
async function printPlainTextGdi(text, printerName, paper) {
  return printTyssoHtmlReceipt(plainTextToReceiptHtml(text), printerName, paper);
}

/** Kupon fiskal Tysso — HTML si Kafene (tekst + logo + QR PNG), pa RAW cut. */
async function printTyssoGdiBundle(text, db, station = "bar", extras = {}) {
  const { printerName, paper } = await ensureReceiptPrinter(db, station);
  const normalized = String(text || "").trim();
  if (!normalized) throw new Error("Teksti i kuponit është bosh.");

  const lines = normalized.split(/\r?\n/).map(
    (line) => `<div class="receipt-meta">${escapeHtmlText(line) || "&nbsp;"}</div>`,
  );
  const chunks = [
    `<div class="receipt-rule">================================</div>`,
    `<div class="receipt-body">${lines.join("\n")}</div>`,
  ];
  if (extras.logoText) {
    chunks.push(
      `<div class="receipt-atk-seal"><div class="receipt-atk-caption">${escapeHtmlText(extras.logoText).replace(/\n/g, "<br>")}</div></div>`,
    );
  }
  if (extras.qrPngBase64) {
    chunks.push(
      `<div class="receipt-atk-seal"><img src="data:image/png;base64,${String(extras.qrPngBase64)}" width="160" alt="QR fiskal"/></div>`,
    );
  } else if (extras.qrAscii) {
    chunks.push(
      `<pre style="font-family:monospace;font-size:8px;text-align:center;white-space:pre;margin:8px 0">${escapeHtmlText(extras.qrAscii)}</pre>`,
    );
  }
  chunks.push(
    `<div class="receipt-rule">${escapeHtmlText(extras.footerLine || "================================")}</div>`,
  );

  const send = await printTyssoHtmlReceipt(chunks.join("\n"), printerName, paper);
  return { ...send, station, output: "tysso-gdi" };
}

async function printPlainTextAt(text, db, station = "bar") {
  const { printerName, paper } = await ensureReceiptPrinter(db, station);
  if (!printerName) throw new Error("Nuk u gjet printer termik.");

  const normalized = String(text || "").trim();
  if (!normalized) throw new Error("Teksti është bosh.");

  if (isTyssoPrinterName(printerName)) {
    const send = printTyssoEscPosText(normalized, printerName, paper, { cut: true });
    return { ...send, station };
  }

  try {
    const send = printRawEscPos(buildEscPosFromPlainText(normalized), printerName);
    return { printer: printerName, paper, output: "escpos-text", station, ...send };
  } catch (err) {
    try {
      printTextWindows(`${normalized.replace(/\r?\n/g, "\r\n")}\r\n`, printerName);
      const cut = printRawEscPos(cutOnlyEscPosBuffer(), printerName);
      return { printer: printerName, paper, output: "text+cut", station, ...cut };
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
    let BrowserWindow;
    try {
      ({ BrowserWindow } = require("electron"));
    } catch (e) {
      console.warn("[printer] electron require failed:", e.message);
    }
    if (BrowserWindow) {
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`;
    await printWin.loadURL(dataUrl);
    await new Promise((r) => setTimeout(r, isTyssoPrinterName(printerName) ? 900 : 450));

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
  }

  if (os.platform() === "win32") {
    try {
      return printHtmlViaElectronWorker(fullHtml, printerName, paper);
    } catch (workerErr) {
      console.warn("[printer] electron-worker:", workerErr.message);
      printTextWindows(stripHtml(fullHtml), printerName);
      return { method: "out-printer-fallback", printer: printerName, paper };
    }
  }

  throw new Error("Printimi kërkon Windows.");
}

/** Prerje e letrës (ESC/POS GS V B 0) pas çdo faturë — mbyllje tavoline ose ndërrimi.
 * A4/laser nuk ka prerëse fizike; nëse pajisja s'pranon RAW ESC/POS, injorohet e heshtur. */
function cutPaperBestEffort(printerName, paper) {
  if (!printerName || paper === "a4" || isTyssoPrinterName(printerName)) return;
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

  if (isTyssoPrinterName(printerName)) {
    const send = await printTyssoReceiptBestEffort(innerHtml, printerName, paper);
    return { ...send, station };
  }

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
        return { printer: printerName, paper, output, station, method: "electron-gdi" };
      } catch {
        /* fallback text spooler */
      }
    }
    printTextWindows(text, printerName);
    cutPaperBestEffort(printerName, paper);
    return { printer: printerName, paper, output: "text", station, method: "out-printer" };
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
  if (isTyssoPrinterName(printerName)) {
    return printTyssoEscPosText(buildTyssoTestReceiptText(paper), printerName, paper);
  }
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

  const tyssoDiag = getTyssoSetupDiagnostic(printers);

  if (effectiveName && names.includes(effectiveName)) {
    connected = true;
    const p = printers.find(x => x.name === effectiveName);
    const info = classifyPrinter(effectiveName);
    typeLabel = p?.typeLabel || info.label;
    suggestedPaper = resolvePaper(config.paper, effectiveName);
    suggestedOutput = resolveOutput(config.output, effectiveName);
    const portInfo = p?.port ? ` · port: ${p.port}` : "";
    message = `${typeLabel} i lidhur: ${effectiveName}${portInfo}`;
    if (/tysso/i.test(effectiveName) && tyssoDiag.main_on_dead_com) {
      connected = false;
      message = tyssoDiag.message;
    }
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
    tysso: tyssoDiag,
  };
}

async function startupAutoDetect(db) {
  let printers = await listPrinters();
  const tyssoDiag = getTyssoSetupDiagnostic(printers);
  if (tyssoDiag.repairable && (tyssoDiag.main_on_dead_com || !tyssoDiag.main_name)) {
    const repair = repairTyssoWindowsPrinter();
    if (repair.ok) {
      console.log(`  🔧 Tysso u rregullua: ${repair.name} → ${repair.port}`);
      _printerListCache = null;
      printers = await listPrinters();
    } else if (repair.error) {
      console.warn("  ⚠️  Rregullimi automatik Tysso:", repair.error);
    }
  }
  const names = printers.map(p => p.name);
  const config = getPrinterConfig(db);
  const saved = config.name;

  if (
    saved &&
    (saved === WINDOWS_DEFAULT || names.includes(saved)) &&
    !shouldRepickSavedPrinter(saved, printers, db)
  ) {
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
  isPrinterManuallyChosen,
  ensurePrinterManualMigration,
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
  printPlainTextGdi,
  printTyssoHtmlReceipt,
  printTyssoGdiBundle,
  resolveBundledElectronExe,
  ensureReceiptPrinter,
  persistDefaultReceiptPrinter,
  isTyssoReceiptPrinter,
  stationConfigName,
  printRawEscPos,
  resolveTyssoDirectComPort,
  printTestPage,
  buildPrintableDocument,
  getTyssoSetupDiagnostic,
  repairTyssoWindowsPrinter,
  findTyssoMainPrinter,
};
