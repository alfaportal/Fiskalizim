/**
 * preload.js — IPC i sigurt për dialog Save As (audit export).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("biznesElectron", {
  pickAuditSavePath: (format) => ipcRenderer.invoke("audit-export-pick-path", format),
  sefUpdate: {
    getState: () => ipcRenderer.invoke("sef-update-get-state"),
    checkNow: () => ipcRenderer.invoke("sef-update-check"),
    download: () => ipcRenderer.invoke("sef-update-download"),
    snooze: () => ipcRenderer.invoke("sef-update-snooze"),
    retry: () => ipcRenderer.invoke("sef-update-check"),
    onEvent: (callback) => {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, payload) => {
        try {
          callback(payload);
        } catch {
          /* */
        }
      };
      ipcRenderer.on("sef-update-event", handler);
      return () => ipcRenderer.removeListener("sef-update-event", handler);
    },
  },
});
