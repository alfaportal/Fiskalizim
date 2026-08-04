/**
 * Electron desktop — Biznes (test ATK/SEF), si KAFENE: dritare + server lokal + printer.
 */
const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { spawn, execSync } = require("child_process");
const http = require("http");

if (process.platform === "win32") {
  app.commandLine.appendSwitch("no-sandbox");
}

app.setName("Biznes — Test ATK / SEF");
if (process.platform === "win32") {
  app.setAppUserModelId("com.biznes.sef-test");
}

const PORT = Number(process.env.BIZNES_PORT) || 3971;
let serverProc = null;
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

function startServer() {
  freePortIfNeeded();
  const script = path.join(__dirname, "server.js");
  const env = {
    ...process.env,
    BIZNES_PORT: String(PORT),
    ELECTRON_RUN_AS_NODE: "1",
  };

  // Nis serverin me të njëjtin Electron binary (si Node) — pa varësi nga PATH
  serverProc = spawn(process.execPath, [script], {
    cwd: __dirname,
    env,
    stdio: "inherit",
  });

  serverProc.on("error", (err) => {
    console.error("[biznes] Server:", err.message);
  });
  serverProc.on("exit", (code) => {
    console.warn("[biznes] Server doli me kod:", code);
  });
}

function waitForServer(maxMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "Biznes — Test ATK / SEF",
    backgroundColor: "#1a2332",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopServer() {
  if (!serverProc) return;
  try {
    if (process.platform === "win32" && serverProc.pid) {
      try {
        execSync(`taskkill /PID ${serverProc.pid} /T /F`, { stdio: "ignore" });
      } catch {
        serverProc.kill();
      }
    } else {
      serverProc.kill();
    }
  } catch {
    /* */
  }
  serverProc = null;
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
    createWindow();
  } catch (e) {
    dialog.showErrorBox(
      "Biznes — gabim",
      (e && e.message) +
        "\n\nProvo: mbyll dritaret e tjera të Biznes, pastaj START.bat përsëri."
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
