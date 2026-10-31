# PUNA — FISKALIZIME

## 2026-10-31 — Kupon / QR / Z / magjistar si BIZNES

Çka: i barazova hallkat e kuponit fiskal me BIZNES (pa dërgim te ATK, pa build).

Skedarë:
- `fiscal/fiscal-qr.js` — kopje identike BIZNES (QR i plotë + hapësirë `\n`)
- `fiscal/fiscal-z-report-atk.js` — kopje BIZNES (Raporti Z lokal, HTTP vetëm nëse ka `ATK_Z_REPORT_PATH`)
- `fiscal/fiscal-repair-wizard.js` — kopje BIZNES (5 hapa, pa send kur lokal)
- `fiscal/fiscal-atk-api.js` — mesazhe 400/401/403 (Neni 31)
- `fiscal/fiscal-main.js` — QR `buildFiscalQrReceiptData` + mesazh refuzimi ATK
- `fiscal/fiscal-audit.js` — `writeTextReportPdf`, `z_report_generated`, `repair_wizard`
- `fiscal/fiscal-self-test.js` — `runWizardStepAtk` / `runWizardStepDb`
- `server.js` — `/api/fiscal/z-report` delivery, `/z-report/send-atk`, `/repair-wizard/*`
- `public/index.html` — butoni Z, magjistari te Cilësimet
- `scripts/obfuscate-build.mjs` — dy skedarët e rinj në listë

Provë: hash QR/Z/wizard = BIZNES; require i moduleve OK. Onboarding nuk u prek.

Nuk u prek: BIZNES, build, çelësa, dërgim HTTP te ATK.
