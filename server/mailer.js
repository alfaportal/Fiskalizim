const DEFAULT_EMAIL_FROM = "Revolution POS <noreply@revolution-pos.com>";

const OFFLINE_NOTICE =
  "Kuponi fiskal nuk është dërguar te ATK prej 44 orësh. Kontrolloni lidhjen.";

function resolveEmailFrom() {
  const raw = String(process.env.EMAIL_FROM || "").trim();
  if (!raw) return DEFAULT_EMAIL_FROM;
  return raw.replace(/@revolutioninvest\.com/gi, "@revolution-pos.com");
}

function isEmailConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
}

async function deliverEmail({ to, subject, text, html }) {
  if (!isEmailConfigured()) {
    throw new Error("Emaili nuk është i konfiguruar. Vendosni RESEND_API_KEY në Railway.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(process.env.RESEND_API_KEY).trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resolveEmailFrom(),
      to: [String(to).trim().toLowerCase()],
      subject,
      text,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || data.error || `HTTP ${res.status}`;
    throw new Error(`Email send failed: ${detail}`);
  }
  return data;
}

async function sendOwnerOfflineEmail({ to, clientName }) {
  const name = clientName || "Pronar";
  const subject = `Paralajmërim: kuponi fiskal — ${name}`;
  const text = [`Përshëndetje ${name},`, "", OFFLINE_NOTICE, "", "Ky është njoftimi i vetëm për këtë ndërprerje."].join(
    "\n",
  );
  const html = `<p>Përshëndetje <strong>${escapeHtml(name)}</strong>,</p><p>${OFFLINE_NOTICE}</p><p>Ky është njoftimi i vetëm për këtë ndërprerje.</p>`;
  return deliverEmail({ to, subject, text, html });
}

module.exports = {
  isEmailConfigured,
  sendOwnerOfflineEmail,
};
