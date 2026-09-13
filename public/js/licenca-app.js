/** Tab Licenca — desktop Electron (poll 3s në dialog boot). */
const LicencaApp = {
  bridge() {
    return window.fiskalizimElectron || window.biznesElectron || null;
  },

  esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  },

  maskKey(key) {
    const k = String(key || "").trim();
    if (!k) return "—";
    if (k.length <= 12) return k;
    return `${k.slice(0, 4)}-****-${k.slice(-4)}`;
  },

  bindIpc() {
    if (this._ipcBound) return;
    this._ipcBound = true;
    const b = this.bridge();
    b?.onLicensePackageUpdated?.(() => this.render().catch(() => {}));
    b?.onLicenseKeyUpdated?.(() => this.render().catch(() => {}));
  },

  async render() {
    const root = document.getElementById("licenca-root");
    if (!root) return;
    const b = this.bridge();
    let st = {};
    if (b?.licenseStatus) {
      try {
        st = (await b.licenseStatus()) || {};
      } catch {
        st = {};
      }
    }
    const active = !!st.has_key && !st.revoked;
    root.innerHTML = `
      <h2 style="margin-top:8px">Licenca e aplikacionit</h2>
      <p class="hint" style="margin-bottom:16px;opacity:.85">
        Heartbeat ~60s · offline max 7 ditë · poll 3s gjatë aktivizimit (dialog i errët).
      </p>
      <div class="form-grid" style="max-width:560px">
        <div><strong>Statusi:</strong> ${active ? "✅ Aktive" : "❌ Jo aktive / prit regjistrim"}${st.offline_ok ? " (cache offline)" : ""}</div>
        <div><strong>Hardware ID:</strong> <code style="user-select:all">${this.esc(st.hardware_id || "—")}</code></div>
        <div><strong>Terminal ID:</strong> <code style="user-select:all">${this.esc(st.machine_id || "—")}</code></div>
        <div><strong>Skadon:</strong> ${this.esc(st.data_skadimit || "—")}</div>
        ${st.revoked ? `<div style="color:#f87171"><strong>Revokuar:</strong> ${this.esc(st.revoked_message || "")}</div>` : ""}
      </div>
      <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:8px">
        <button type="button" class="btn btn-primary" id="lic-btn-refresh">Rifresko</button>
        ${b?.openLicenseDialog ? '<button type="button" class="btn btn-ghost" id="lic-btn-dialog">Hap dialogun e aktivizimit</button>' : ""}
      </div>
      <p class="hint" style="margin-top:16px">WhatsApp: +383 48707880</p>`;

    document.getElementById("lic-btn-refresh")?.addEventListener("click", () => this.render());
    document.getElementById("lic-btn-dialog")?.addEventListener("click", async () => {
      try {
        await b.openLicenseDialog();
        await this.render();
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  },

  async init() {
    this.bindIpc();
    await this.render();
  },
};

window.LicencaApp = LicencaApp;
