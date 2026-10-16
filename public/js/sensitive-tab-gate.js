/**
 * Mbrojtje tab-eve Audit / Cilësimet SEF — krahasim SHA-256 (pa plaintext në kod).
 */
(function (root) {
  const GATES = {
    audit: "daacea17b3721cd8bd0f8f412a0ff13d3359544d984f97a1bb151b868169af27",
    settings: "805e6df904f2bc97d50f883f07da483338d7b29ff601cfc48b033b2b7d44088d",
  };

  const SESSION = {
    audit: "fiskal_gate_audit_v1",
    settings: "fiskal_gate_sef_v1",
  };

  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(String(text ?? ""));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function isUnlocked(tab) {
    const key = SESSION[tab];
    return !!(key && sessionStorage.getItem(key) === "1");
  }

  function unlock(tab) {
    const key = SESSION[tab];
    if (key) sessionStorage.setItem(key, "1");
  }

  async function verify(tab, password) {
    const want = GATES[tab];
    if (!want) return false;
    const got = await sha256Hex(password);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i += 1) {
      diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
    }
    return diff === 0;
  }

  root.SensitiveTabGate = {
    verify,
    isUnlocked,
    unlock,
  };
})(typeof window !== "undefined" ? window : globalThis);
