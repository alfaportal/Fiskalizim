/**
 * fiscal/fiscal-ui-client.js — aplikon statusin ATK në DOM (modalitet LOKAL).
 * Ngarkohet automatikisht nga fiscal-ui-bridge.js — mos prek public/index.html.
 */
(function fiscalUiClient() {
  "use strict";

  const IDS = {
    pillAtk: "pill-atk",
    headerBadge: "header-env-badge",
    autoCb: "s-atk-auto",
    autoHint: "atk-auto-hint",
    sendBtn: "btn-send-pending",
    statusBox: "atk-status-box",
    footer: "settings-msg",
    autoLabel: "atk-auto-label",
  };

  function setPill(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "pill" + (cls ? " " + cls : "");
    el.innerHTML = '<span class="dot"></span> ' + text;
  }

  function setMsg(el, text, ok) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("ok", "err");
    el.classList.add(ok ? "ok" : "err");
  }

  function applyUi(atk) {
    if (!atk || !atk.ui) return;
    const ui = atk.ui;

    setPill(IDS.pillAtk, ui.pill_text || "ATK: —", ui.pill_class || "");

    const badge = document.getElementById(IDS.headerBadge);
    if (badge && ui.header_badge) badge.textContent = ui.header_badge;

    const autoCb = document.getElementById(IDS.autoCb);
    if (autoCb) {
      autoCb.checked = !!ui.auto_send_checked;
      autoCb.disabled = !!ui.auto_send_disabled;
      if (ui.auto_send_disabled) autoCb.removeAttribute("checked");
    }

    const autoWrap = autoCb && autoCb.closest("label");
    if (autoWrap) {
      autoWrap.style.opacity = ui.auto_send_disabled ? "0.45" : "";
      autoWrap.style.pointerEvents = ui.auto_send_disabled ? "none" : "";
      autoWrap.title = ui.auto_send_disabled ? "Dërgimi te ATK është i bllokuar (modalitet lokal)" : "";
    }

    const autoHint = document.getElementById(IDS.autoHint);
    if (autoHint && ui.auto_hint_html) autoHint.innerHTML = ui.auto_hint_html;

    const sendBtn = document.getElementById(IDS.sendBtn);
    if (sendBtn) {
      sendBtn.disabled = !!ui.send_pending_disabled;
      sendBtn.style.display = ui.send_pending_hidden ? "none" : "";
      sendBtn.title = ui.send_pending_disabled
        ? "Dërgimi manual te ATK është i bllokuar (modalitet lokal)"
        : "";
    }

    const box = document.getElementById(IDS.statusBox);
    if (box && Array.isArray(ui.status_lines)) {
      setMsg(box, ui.status_lines.join("\n"), !!ui.status_ok);
    }

    const footer = document.getElementById(IDS.footer);
    if (footer && ui.footer_message) {
      setMsg(footer, ui.footer_message, !!ui.footer_ok);
    }
  }

  async function refreshFromApi() {
    try {
      const r = await fetch("/api/fiscal/atk-status");
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.atk) applyUi(data.atk);
    } catch {
      /* */
    }
  }

  function hookFetch() {
    if (window.__fiscalUiFetchHooked) return;
    window.__fiscalUiFetchHooked = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
      const res = await orig(input, init);
      try {
        const url = typeof input === "string" ? input : input && input.url ? input.url : "";
        if (/\/api\/fiscal\/(settings|atk-status)/.test(url)) {
          const clone = res.clone();
          clone
            .json()
            .then((data) => {
              const atk = data && (data.atk || (data.ok && data.atk));
              if (atk) applyUi(atk);
            })
            .catch(() => {});
        }
      } catch {
        /* */
      }
      return res;
    };
  }

  function onTabClick() {
    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.getAttribute("data-tab") === "settings") {
          setTimeout(refreshFromApi, 50);
        }
      });
    });
  }

  hookFetch();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      refreshFromApi();
      onTabClick();
    });
  } else {
    refreshFromApi();
    onTabClick();
  }
})();
