/**
 * Electron desktop — Biznes (test ATK/SEF), si KAFENE: dritare + server lokal + printer.
 */
const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");
require("./portable-path").applyPortableEnv();
process.env.FISCAL_LOCAL_RUN = "1";
process.env.ATK_AUTO_SEND = "1";
process.env.BIZNES_ATK_SEND_ALLOWED = "0";
process.env.ATK_TEST_MODE = process.env.ATK_TEST_MODE || "0";
process.env.FISCAL_TEST_MODE = process.env.FISCAL_TEST_MODE || "0";
const https = require("https");
const { execSync, spawn } = require("child_process");
const http = require("http");

if (process.platform === "win32") {
  app.commandLine.appendSwitch("no-sandbox");
}

app.setName("Revolution POS SEF");
if (process.platform === "win32") {
  app.setAppUserModelId("com.biznes.sef-test");
}

const PORT = Number(process.env.BIZNES_PORT) || 3971;
let serverProc = null;
let inProcessServer = null;
let mainWindow = null;

function freePortIfNeeded() {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: "utf8" });
    const lines = String(out || "")
      .split(/\r?\n/)
      .filter((l) => l.includes("LISTENING"));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        } catch {
          /* */
        }
      }
    }
  } catch {
    /* port free */
  }
}

function getAppPaths() {
  if (app.isPackaged) {
    return {
      appRoot: path.dirname(process.execPath),
      serverPath: path.join(process.resourcesPath, "app.asar", "server.js"),
    };
  }
  return {
    appRoot: __dirname,
    serverPath: path.join(__dirname, "server.js"),
  };
}

async function startServer() {
  freePortIfNeeded();
  process.env.BIZNES_PORT = String(PORT);
  if (serverProc || inProcessServer) return;

  const { appRoot, serverPath } = getAppPaths();
  const env = { ...process.env, BIZNES_PORT: String(PORT) };

  // In-process kur packaged — electronFuses runAsNode=false bllokon spawn(ELECTRON_RUN_AS_NODE).
  if (app.isPackaged) {
    try {
      const { boot } = require("./server");
      boot()
        .then((s) => {
          inProcessServer = s;
        })
        .catch((e) => {
          console.error("[biznes] Server in-process:", e && e.message ? e.message : e);
        });
      return;
    } catch (e) {
      console.error("[biznes] Server in-process:", e && e.message ? e.message : e);
    }
  }

  const spawnOpts = {
    env,
    cwd: appRoot,
    stdio: "ignore",
    windowsHide: true,
  };

  if (app.isPackaged) {
    serverProc = spawn(process.execPath, [serverPath], {
      ...spawnOpts,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    });
  } else {
    serverProc = spawn("node", [serverPath], spawnOpts);
  }

  serverProc.on("error", (err) => {
    console.error("[biznes] Server spawn:", err && err.message ? err.message : err);
  });
  serverProc.on("exit", (code, signal) => {
    if (code && code !== 0) {
      console.error("[biznes] Server exit:", code, signal || "");
    }
    serverProc = null;
  });
}

function waitForServer(maxMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return retry();
          try {
            const j = JSON.parse(body || "{}");
            if (j.ok && j.routes_ready) return resolve();
          } catch {
            /* retry */
          }
          retry();
        });
      });
      req.on("error", retry);
      req.setTimeout(800, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > maxMs) {
        return reject(new Error("Serveri lokal nuk u nis (port " + PORT + ")"));
      }
      setTimeout(tryOnce, 250);
    };
    tryOnce();
  });
}

function getPreloadPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar", "preload.js");
  }
  return path.join(__dirname, "preload.js");
}

function registerAuditExportIpc() {
  ipcMain.handle("audit-export-pick-path", (event, format) => {
    try {
      const { BrowserWindow } = require("electron");
      const { pickAuditSaveDialog } = require("./fiscal/fiscal-audit");
      const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
      return pickAuditSaveDialog(format, win);
    } catch (e) {
      console.error("[audit-export] Save dialog:", e && e.message ? e.message : e);
      return null;
    }
  });
}

function attachDevToolsBlock(win) {
  if (!app.isPackaged) return;
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") {
      event.preventDefault();
      return;
    }
    if (input.control && input.shift && (input.key === "I" || input.key === "i")) {
      event.preventDefault();
    }
  });
}

function buildStartupSplashHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Revolution POS SEF</title>
<style>
  html,body{margin:0;height:100%;background:#1a2332;color:#e8eef5;font-family:Segoe UI,sans-serif;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
  .logo{font-size:22px;font-weight:600;letter-spacing:.3px}
  .sub{opacity:.75;font-size:14px}
  .spin{width:28px;height:28px;border:3px solid rgba(255,255,255,.15);border-top-color:#4da3ff;
  border-radius:50%;animation:r 1s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
</style></head><body><div class="spin"></div><div class="logo">Revolution POS SEF</div><div class="sub">Duke u hapur…</div></body></html>`;
}

function createWindow(initialUrl) {
  const work = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1440, Math.max(1024, work.width - 32));
  const winH = Math.min(960, Math.max(640, work.height - 32));
  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 960,
    minHeight: 600,
    title: "Revolution POS SEF",
    backgroundColor: "#1a2332",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      backgroundThrottling: false,
      preload: getPreloadPath(),
    },
  });

  attachDevToolsBlock(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 4000);

  global.__electronMainWindow = mainWindow;

  const splash =
    initialUrl ||
    "data:text/html;charset=utf-8," + encodeURIComponent(buildStartupSplashHtml());
  mainWindow.loadURL(splash);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopServer() {
  if (inProcessServer) {
    try {
      const { shutdownHttpServer } = require("./server");
      shutdownHttpServer();
    } catch {
      /* ignore */
    }
    inProcessServer = null;
  }
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* ignore */
    }
    serverProc = null;
  }
}

app.whenReady().then(async () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  const portable = require("./portable-path");
  const userData = path.join(app.getPath("appData"), "Revolution POS");
  const dbDir = portable.getDataDir();
  const resetFlag = path.join(userData, ".factory-reset-pending");
  const resetFlagExternal = path.join(
    app.getPath("appData"),
    "RevolutionInvest",
    "factory-reset-pending-biznes",
  );
  const wipeDirHard = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      let left = 0;
      try {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch {
            left += 1;
          }
        }
      } catch {
        left += 1;
      }
      if (left === 0) return;
    }
  };
  if (fs.existsSync(resetFlag) || fs.existsSync(resetFlagExternal)) {
    wipeDirHard(userData);
    wipeDirHard(dbDir);
    wipeDirHard(path.join(app.getPath("appData"), "RevolutionInvest", "BiznesLicense"));
    wipeDirHard(path.join(app.getPath("appData"), "RevolutionInvest", "KafeneLicense"));
    try {
      fs.unlinkSync(resetFlagExternal);
    } catch {
      /* ignore */
    }
    fs.mkdirSync(userData, { recursive: true });
  }
  try {
    app.setPath("userData", userData);
  } catch {
    /* ignore */
  }
  process.env.BIZNES_DB_PATH = path.join(dbDir, "biznes.db");

  const scheduleFactoryReset = () => {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(resetFlag, new Date().toISOString(), "utf8");
      fs.mkdirSync(path.dirname(resetFlagExternal), { recursive: true });
      fs.writeFileSync(resetFlagExternal, new Date().toISOString(), "utf8");
    } catch {
      /* ignore */
    }
    try {
      app.relaunch();
    } catch {
      /* ignore */
    }
    app.exit(0);
  };

  const heartbeatCloudLicense = () => {
    let key = "";
    try {
      const guard = require("./fiscal/license-guard");
      key = String(guard.readStoredLicenseKey(app) || "").trim();
    } catch {
      return;
    }
    if (!key) return;
    const body = JSON.stringify({
      celesi: key,
      app_type: "restorant",
    });
    const req = https.request(
      {
        hostname: "revolution-pos.com",
        path: "/api/v1/license/heartbeat",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data || "{}");
          } catch {
            parsed = {};
          }
          const code = String(parsed.code || "");
          const wipe =
            parsed.force_factory_reset ||
            (!parsed.valid && ["NOT_FOUND", "REVOKED", "EXPIRED"].includes(code));
          if (wipe) scheduleFactoryReset();
        });
      },
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(body);
    req.end();
  };

  registerAuditExportIpc();
  try {
    const { initSefAutoUpdate } = require("./sef-auto-update");
    initSefAutoUpdate({ getMainWindow: () => mainWindow });
  } catch (e) {
    console.warn("[biznes] sef-auto-update:", e && e.message ? e.message : e);
  }
  const startupT0 = Date.now();
  createWindow();
  await startServer();
  try {
    await waitForServer(120000);
    if (mainWindow) {
      await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
      try {
        const { getPublicState } = require("./sef-auto-update");
        mainWindow.webContents.send("sef-update-event", getPublicState());
      } catch {
        /* */
      }
    }
    console.log(`[biznes] startup ${Date.now() - startupT0}ms (deri UI)`);
    heartbeatCloudLicense();
    setInterval(heartbeatCloudLicense, 45000);
  } catch (e) {
    dialog.showErrorBox(
      "Revolution POS SEF - gabim",
      (e && e.message) +
        "\n\nProvo: mbyll dritaret e tjera të Revolution POS, pastaj hap përsëri ikonën."
    );
    stopServer();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopServer();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
