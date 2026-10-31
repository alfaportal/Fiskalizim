# PUNA — FISKALIZIME

## 2026-10-31 — Skeda Ditari

- Skedë e re **Ditari** te pronari (pas Kuponët): shitjet, TOTALI, POROSI, CASH, KARTË.
- Debit/kredit dalin **Kartë**. Periudha: Sot / Kjo javë / Ky muaj + data.
- API `GET /api/ditari`. Nuk ka ndërrime — ky projekt s’i ka.
- Skedarë: `database.js` `getDitari`, `server.js` `/api/ditari`, `public/index.html` tab Ditari.
- Nuk u prek `fiscal/**`, ATK. Nuk u bë build.
- Në PC: vetëm pas Setup të ri + mbyllje e plotë + hapje.

## 2026-10-31 — Pagesa me kartelë: kupon / lista / termik

- Butoni CASH nuk e kthen më pagesën në cash nëse ke zgjedhur Debit ose Kredit (`public/index.html`).
- Butoni KARTELË ruan Debit nëse e ke zgjedhur Debit.
- Lista e kuponëve dhe audit te pronari: debit/kredit dalin **Kartë**, jo cash / debit_card.
- Kupon termik: debit/kredit → `karte` (`server.js` `posThermalPaymentLabel`) që në letër del Kartë.
- Nuk u prek `fiscal/**`, Kontabilisti, ATK. Nuk u bë build.
- Në PC: vetëm pas Setup të ri + mbyllje e plotë + hapje.

## 2026-10-31 — Build 1.1.15

- `package.json` 1.1.14 → 1.1.15
- Setup: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.1.15-win-x64.exe`
- Të vjetrat mbeten (1.1.10–1.1.14) për kthim prapa
- Nuk u dërgua asgjë te ATK. Në PC: instalo + mbyll plotësisht + hap përsëri

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
