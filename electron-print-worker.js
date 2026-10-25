/**
 * Worker i veçantë Electron — vetëm printim GDI (si Kafene).
 * Nuk ngarkon server/DB; thirret nga printer.js kur app-i niset me node+Edge.
 *
 * Përdorimi: electron.exe electron-print-worker.js "<printer>" "<htmlPath>" [paper]
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");

if (process.platform === "win32") {
  app.commandLine.appendSwitch("no-sandbox");
}

const printerName = process.argv[2] || "";
const htmlPath = process.argv[3] || "";
const paper = process.argv[4] || "80mm";

function pageSizeFor(p) {
  if (p === "a4") return { width: 210000, height: 297000 };
  if (p === "58mm") return { width: 58000, height: 297000 };
  if (p === "100mm") return { width: 100000, height: 297000 };
  return { width: 80000, height: 297000 };
}

app.whenReady().then(async () => {
  if (!printerName || !htmlPath || !fs.existsSync(htmlPath)) {
    console.error("[print-worker] args:", printerName, htmlPath);
    app.exit(2);
    return;
  }

  const html = fs.readFileSync(htmlPath, "utf8");
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await win.loadURL(dataUrl);
    await new Promise((r) => setTimeout(r, 900));

    await new Promise((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          deviceName: printerName,
          copies: 1,
          printBackground: false,
          margins: { marginType: paper === "a4" ? "default" : "none" },
          pageSize: pageSizeFor(paper),
        },
        (success, failureReason) => {
          if (success) resolve();
          else reject(new Error(failureReason || "Printimi dështoi"));
        },
      );
    });
    app.exit(0);
  } catch (e) {
    console.error("[print-worker]", e.message || e);
    app.exit(1);
  } finally {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
});
