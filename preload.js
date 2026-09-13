/**
 * preload.js — IPC i sigurt (audit export + licenca).
 */
const { contextBridge, ipcRenderer } = require("electron");

function subscribeIpc(channel, callback) {
  const handler = (_event, payload) => {
    if (typeof callback === "function") callback(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const electronApi = {
  isElectron: true,
  pickAuditSavePath: (format) => ipcRenderer.invoke("audit-export-pick-path", format),
  licenseStatus: () => ipcRenderer.invoke("license:status"),
  licenseActivate: (payload) => ipcRenderer.invoke("license:activate", payload),
  licenseHardwareId: () => ipcRenderer.invoke("license:hardware-id"),
  licenseDeviceId: () => ipcRenderer.invoke("license:device-id"),
  openLicenseDialog: () => ipcRenderer.invoke("license:open-dialog"),
  onLicensePackageUpdated: (callback) => subscribeIpc("license:package-updated", callback),
  onLicenseKeyUpdated: (callback) => subscribeIpc("license:key-updated", callback),
};

contextBridge.exposeInMainWorld("biznesElectron", electronApi);
contextBridge.exposeInMainWorld("fiskalizimElectron", electronApi);
