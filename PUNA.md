# PUNA.md

## 2026-11-10 — Arka gjen barkodin e etiketës

Fusha te arka është `#pos-scan`. Etiketa «Printo etiketë» shkruan barkodin e ruajtur, jo kodin `590` + id. Kërkimi: barkodi i ruajtur, pastaj vetëm shifrat. Nëse gjendet, `addProduct` e fut në shportë.

| Skedar | Ndryshimi |
|--------|-----------|
| `public/index.html` | Kërkimi te arka |

Nuk u bë Setup.

## 2026-11-10 — Produktet: dy rreshta, barkod, kategoritë ATK

Te paneli, skeda Produktet, forma qëndron në dy rreshta pa rrëshqitje anash. Rreshti i parë: Barkod, Emri i produktit, Kategoria, Çmimi, TVSH. Rreshti i dytë: Njësia ATK, Kategoria ATK (25: TT deri SHN, MPM «Mish/produkte mishi»), Më shumë, Shto. Skaneri hyn te Barkod. Nëse barkodi ekziston, shfaqen emri, çmimi, kategoria, TVSH, njësia dhe kategoria ATK, dhe nuk krijohet i dyti. Zgjedhja ATK ruhet. Kodi jashtë listës mbetet TT.

| Skedar | Ndryshimi |
|--------|-----------|
| `public/index.html` | dy rreshta; emri veç barkodit; njësia dhe 25 kategoritë ATK jashtë «Më shumë» |
| `database.js` | vetëm 25 kodet ATK ruhen; barkodi i njëjtë refuzohet |

Prova në databazë të re: «Prove Barkod» id 201, 2.50 €, TVSH D, njësi CP, ATK AU, barkod 89044534241091. I njëjti barkod u refuzua. Kodi XX u ruajt TT. Forma në gjerësi 1100: pa rrëshqitje, një fushë njësie, 25 kategori, shifrat 89 nga emri shkuan te Barkod. Nuk u dërgua kupon te ATK. Nuk u bë Setup.

## 2026-11-10 — Barkod te rreshti i produktit

Te Produktet, fusha Barkod është para Emrit. Skaneri shkon te Barkod. Emri mbetet bosh për ta shkruar. Nëse barkodi ekziston, plotësohen emri, kategoria, çmimi dhe TVSH. Nëse nuk ekziston, fushat mbeten bosh dhe «Shto» e ruan me barkod. Kërkimi dhe lista poshtë nuk u prekën.

| Skedar | Ndryshimi |
|--------|-----------|
| `public/index.html` | Fusha Barkod në krye të formës; kërkim barkodi; ruajtja e njëjtë |

Prova në server të përkohshëm, port 3398, databazë e re: barkodi `89044534241091` plotësoi «Prove Barkod», 2.50 €, Bulmet, TVSH 8%. Barkodi i panjohur la emrin bosh, çmimin 0.00, kategorinë e parë dhe TVSH 18%. «Shto» ruajti «Artikull i ri» 1.25 €, Pije, TVSH 8%, barkod `1111111111111` (id 202). I njëjti barkod i vjetër nuk u dyfishua. Kërkimi mbeti «Kërko produkt...». Nuk u dërgua kupon te ATK. Nuk u bë Setup. Databaza e instaluar nuk u prek.

## 2026-11-10 — Ditari dhe ndërrimi, kutia Kartë

Kutia «Kartë» te Ditari dhe te mbyllja e ndërrimit tani mblidhin debit, kredit, mobile (`sms`), çek, transfer, voucher dhe kartë. Pagesa e përzier mbetet vetëm pjesa jo-cash.

| Skedar | Ndryshimi |
|--------|-----------|
| `database.js` | `isCardPayment` për Ditarin |
| `fiskalizime-pos-shift.js` | `isCardPayment` për `card_total` e ndërrimit |

Provë në databazë të re: 9 shitje. Ditari, ndërrimi i hapur dhe i mbyllur: cash 3.50 €, kartë 15.00 €, shitje 18.50 €. E përziera (1 € cash + 1 € mobile) hyri 1 € te kartë. Butonat e arkës janë të njëjtët me MARKET. Nuk u dërgua asgjë te ATK. Databaza e instaluar nuk u prek. Nuk u bë Setup.

## 2026-11-10 — Setup 1.100.0

Version `1.1.22` → `1.100.0` te `package.json`. `node scripts/obfuscate-build.mjs` përfundoi me kod 0.

Setup: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.100.0-win-x64.exe` (115979440 byte). Setup-et 1.1.21 dhe 1.1.22 mbetën. Nuk u prek databaza e instaluar.

PC: instalo Setup 1.100.0 → mbyll programin plotësisht → hape përsëri.

## 2026-11-10 — TVSH 8% në shportë, kolonat në Ditari, blloku i letrës bosh

Shporta tregon veç TVSH 8% dhe TVSH 18%, plus TVSH totale. Butoni 🔄 te Produktet mbetet në kod, por nuk shfaqet. Ditari ka kolonat TVSH 8% dhe TVSH 18%. Instalimi i ri nuk fut qarkullim. Katër kuponët provë të 25.10.2026 (GAP-1792968225491, GAP-CHK-1792968226311, PB1792968292481-OK, PB1792968292481-CHK1) hiqen një herë në nisjen tjetër. Nuk u dërgua asgjë te ATK. Nuk u bë Setup. Databaza e instaluar në AppData nuk u hap.

| Skedar | Rreshta | Pse |
|--------|---------|-----|
| `public/index.html` | 1705, 2502–2504, 2838, 8834–8911 | Rreshti 8% shihet; butoni fshihet; Ditari ndan 8% dhe 18% |
| `database.js` | 19, 1030–1095, 1205, 2020, 2272 | Ditari kthen tvsh_8 dhe tvsh_18; nisja e re është bosh; kuponët provë të 25.10.2026 hiqen një herë |

Prova: Bukë 0.50 + Coca-Cola 1.00 → TVSH 8% 0.04 €, TVSH 18% 0.15 €, TVSH totale 0.19 €. Ditari: Pa TVSH 1.31 €, 0.04 €, 0.15 €, 0.19 €, total 1.50 €. Blloku i letrës: 0 kuponë. Databazat e provës janë në Temp.

## 2026-11-09 — Forma e produktit: 5 fusha + Më shumë

Forma «Ndrysho» dhe «Shto» tregon Emri, Kategoria, Çmimi, TVSH dhe Ruaje / Anulo. Barkodi, njësia, kategoria ATK dhe përshkrimi janë te «Më shumë». Përshkrimi ruhet. «Printo etiketë» kërkon barkod dhe hap një faqe të shkurtër. Nuk ka stok të ruajtur në këtë projekt. Butoni «Përditëso TVSH» nuk ishte në faqe. Butoni 🔄 i auto-kategorizimit mbetet.

Prova në databazë të re: pas ndryshimit përshkrimi «ndryshuar fiskal», çmimi 1.40, TVSH E. Databaza e provës u fshi. Databaza e instaluar nuk u prek. Nuk u bë Setup.

## 2026-11-09 — Katalogu 200 produkte, 20 kategori

U hoqën 26 produktet e vjetra. U vendosën 200 të reja. 40 me TVSH 8%, 160 me TVSH 18%. Sheqeri, fasulja, salca, thjerrëzat dhe Bepanthen Krem janë 18%. Të tjerat në bukë, bulmet, vezë, ushqim bazë dhe barna janë 8%. Krejt pjesa tjetër është 18%.

Prova në databazë të re: 200 produkte, 20 kategori. Bukë e bardhë 0.50 € me 8%. Sheqer 1.10 € me 18%. Paracetamol 1.00 € me 8%. Bepanthen 3.50 € me 18%. Coca-Cola 1.00 € me 18%. Kostum 120.00 € me 18%. Produktet e vjetra (Pepsi, Akullore, Cigare) nuk janë. Databaza e provës u fshi. Databaza e instaluar nuk u prek. Nuk u bë Setup.

Në nisjen e parë të programit të ri, zëvendësohen vetëm produktet. Shitjet, punonjësit, licenca, printeri dhe fiskali mbeten.

| Skedar | Ndryshimi |
|---|---|
| `data/default-products.json` | 200 produkte me çmim, kategori dhe TVSH |
| `database.js` | kategoritë e reja; zëvendësimi i katalogut një herë |
| `public/index.html` | 20 kategoritë në arkë; shfaqen edhe produktet me 8% |

## 2026-11-09 — Kuponi pa kamarier

Te kuponi u hoq «Kamarieri» dhe «Pranuar nga». Mbeti operatori. Në fund shkruhet «Ju faleminderit për vizitën!». Nuk u bë Setup.

## 2026-11-08 — Stornoja e pagesës së përzier ndahet cash dhe kartë

| Skedar | Rreshta | Pse |
|--------|---------|-----|
| `fiscal/fiscal-correction.js` | 71–116, 486 | Storno dhe kthimi marrin ndarjen cash/kartë të shitjes |
| `database.js` | 1889–1903, 1981, 2038 | Ditari e zbret sipas asaj ndarjeje |
| `fiskalizime-pos-shift.js` | 27–43, 116, 127 | Arka e zbret njësoj |

Prova e njëjtë: cash 53.90 €, kartë 75.00 €, total 128.90 €, arka e pritur 103.90 €. Storno cash −72.00 € vetëm nga cash. Storno kartë −8.00 € vetëm nga kartë. Databaza e provës u fshi. Nuk u bë build.

## 2026-11-08 — TVSH e njëjtë te Z dhe Ditari, arka zbret stornon

| Skedar | Rreshta | Pse |
|--------|---------|-----|
| `database.js` | 1942–1970, 1976–2103 | Ditari merr TVSH-në e ruajtur te kuponi, njësoj si Z |
| `public/index.html` | 8726–8729 | Ekrani tregon atë TVSH, nuk e llogarit përsëri |
| `fiskalizime-pos-shift.js` | 110–137, 166–170, 210–214 | Mbyllja e ndërrimit zbret stornon dhe kthimin |

Prova e njëjtë: Z 57.20 €, TVSH 6.22 €. Ditari 57.20 €, TVSH 6.22 €. Arka: cash 46.40 €, kartë 10.80 €, total 57.20 €, pritet 46.40 €. Databaza e provës u fshi. Nuk u bë build.

## 2026-11-08 — Storno dhe kthimi me minus, Ditari, TVSH e Z në cent

| Skedar | Rreshta | Pse |
|--------|---------|-----|
| `fiscal/fiscal-correction.js` | 391–399, 431–435, 520–524 | Storno, anulim dhe kthim ruhen me shumë negative |
| `database.js` | 1980–2035 | Ditari i tregon këto rreshta dhe i zbret nga totali |
| `fiscal/fiscal-numbering.js` | 303–305 | TVSH e Z rrumbullakohet në cent |

Printimi i kuponit mbetet me shumat e letës si më parë. Prova me databazë të përkohshme: Z 133.20 €, Ditari 133.20 €, storno −17.00 € (Pa −16.11, TVSH −0.89), kthimi −20.00 € (Pa −16.95, TVSH −3.05). TVSH e Z: D 4.98 €, E 8.54 €. Databaza e provës u fshi. Nuk u bë build.

## 2026-11-08 — TVSH te zbritja dhe kolonat në Ditari

Udhëzimi i mëparshëm (kthim pa NUIKF, Raporti Z me shitje termike) nuk kishte prekur asnjë skedar. Kthimi mbetet me NUIKF. Raporti Z lexon vetëm kuponët fiskalë.

| Skedar | Rreshta | Pse |
|--------|---------|-----|
| `public/index.html` | 6202–6206 | TVSH llogaritet mbi çmimin pas zbritjes |
| `public/index.html` | 2798–2804, 8723–8849 | Ditari tregon Pa TVSH, TVSH dhe Totalin |

Prova e llogaritjes: 2× 5.50 € me 20% = 8.80 € → TVSH 0.65 €. Shitja 41.00 € (18%+8%) → Pa TVSH 35.61 €, TVSH 5.39 €. Nuk u hap programi. Nuk u bë build.

## 2026-11-06 — Raporti Z pas obfuskimit

`scripts/obfuscate-build.mjs`: `printFiscalReportText` dhe funksionet e printit Z nuk riemërtohen mes skedarëve. Pa këtë, Setup-i hedh «is not a function» kur shtypet Raporti Z. Butoni i hyrjes «Kyçu» mbetet. Nuk u bë build.



## 2026-11-06 — Email pronari pas 44 orësh pa heartbeat

Një email te `clients.email` kur `last_seen` kalon 44 orë (`app_type` fiskalizim). Nuk përsëritet derisa heartbeat-i të kthehet. Teksti: kuponi fiskal nuk është dërguar te ATK.

| Skedar | Ndryshimi |
|--------|-----------|
| `server/mailer.js` | Resend |
| `server/offlineNotificationService.js` | kontrolli 44 orë |
| `server/jobs/offlineNotifications.js` | cron çdo orë |
| `server/index.js` | nismë e cron-it |
| `server/sql/offline_notifications.sql` | tabela + RLS |

`node --check` kaloi. Nuk u ekzekutua SQL. Nuk u bë push.



## 2026-11-03 — Firewall LAN në Setup (pa build)

Rregull TCP në installer.nsh (nsExec, pa popup). Nuk u bë build.
# PUNA — FISKALIZIME

## 2026-11-02 — ENABLE_RLS.sql (vetëm skedar, pa ekzekutim)

| Skedar | Ndryshimi |
|--------|-----------|
| `supabase/ENABLE_RLS.sql` | ENABLE RLS + REVOKE anon/authenticated për 4 tabela live (`oqquiuisreztzcyehpiq`) |

**Nuk u ekzekutua** SQL. Nuk u bë build/git.

## 2026-11-02 — Super Admin: set-password / owner-email

Rrugë admin për email/fjalëkalim pronari (model HOTEL). bcrypt 12. `users` + `clients.email` në Supabase Fiskalizim.

| Skedar | Ndryshimi |
|--------|-----------|
| `server/routes/admin.js` | POST set-password / password, PATCH owner-email |
| `server/adminService.js` | `setOwnerPasswordForClient`, `setOwnerEmailForClient` |
| `server/package.json` | `bcryptjs` |
| `supabase/users.sql` | tabelë `users` + RLS (nuk u ekzekutua) |

Provë: `node --check`. Commit/push/deploy te ky hap. Duhet ekzekutuar `users.sql` në Supabase Fiskalizim para se rrugët të shkruajnë `users`.

**Nuk preka:** `fiscal/**`, ATK, çelësa, desktop Setup.

---

## 2026-11-01 — Setup 1.1.22

Version `1.1.21` → `1.1.22`. `node scripts/obfuscate-build.mjs` exit 0.
Setup: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.1.22-win-x64.exe` (115965602 byte).
PC: instalo Setup 1.1.22 → mbyll programin → hape përsëri.

## 2026-11-01 — Pazari i ndërrimit si restoranti

- Mbyllja e ndërrimit tani **shtyp** PAZARI I NDERRIMIT (tekst i thjeshtë).
- Pa logo RKS/MF, pa QR, pa e-kuponi. Hapja mbetet me paratë e nisjes.
- Skedarë: `fiskalizime-shift-report.js`, `fiskalizime-pos-shift.js`, `server.js`, `package.json`.
- Nuk u prek ATK, BIZNES. Nuk u bë build.
- Në PC: vetëm pas Setup të ri + mbyllje e plotë + hapje.

## 2026-10-31 — Build 1.1.21 OK

- `package.json` 1.1.20 → 1.1.21
- Setup: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.1.21-win-x64.exe` (109133543 byte)
- Të vjetrat mbeten (1.1.18, 1.1.19, 1.1.20) për kthim.
- Në asar: `fiskalizime-pos-shift.js` (hapje/mbyllje ndërrimi te Arka).
- Nuk u dërgua ATK. Në PC: instalo + mbyll plotësisht + hap përsëri.

## 2026-10-31 — Commit / push / deploy (nderrimi te Arka)

- Commit: hapje/mbyllje ndërrimi te Arka (`fiskalizime-pos-shift.js`, `database.js`, `server.js`, `public/index.html`, `package.json`).
- Nuk u shtuan Setup, `.protected-build`, çelësa.
- Push `origin/main` + deploy Railway. Nuk u dërgua ATK. Nuk u bë build.
- Në PC: vetëm pas Setup të ri.

## 2026-10-31 — Nderrimi te Arka (si Butiku)

- Te Arka: **Mbyll nderrimin** pranë MONEDHA NË ARKË.
- Hapje: sa para ke në arkë. Mbyllje: cash/kartë + paratë e pritshme.
- Shitjet lidhen me nderrimin. Te Ditari del tabela Nderrimet.
- Skedarë: `fiskalizime-pos-shift.js`, `database.js`, `server.js`, `public/index.html`, `package.json`.
- Nuk u prek `fiscal/**`, ATK. Nuk u bë build.
- Në PC: vetëm pas Setup të ri + mbyllje e plotë + hapje.

## 2026-10-31 — Build 1.1.20 OK

- `package.json` 1.1.19 → 1.1.20
- Setup: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.1.20-win-x64.exe` (109127318 byte)
- Të vjetrat mbeten (1.1.18, 1.1.19) për kthim.
- Në asar: `auto-backup-location.cjs` (një folder pas ikonës).
- Nuk u dërgua ATK. Në PC: instalo + mbyll plotësisht + hap përsëri.

## 2026-10-31 — Commit / push / deploy (backup pas ikonës)

- Commit: një folder backup pas ikonës (`auto-backup-location.cjs`, `auto-backup.js`, `main.js`, `server.js`, `PUNA.md`, version 1.1.19).
- Nuk u shtuan Setup, `.protected-build`, çelësa.
- Push `origin/main` + deploy Railway. Nuk u dërgua ATK. Nuk u bë build.

## 2026-10-31 — Një backup, pas ikonës së programit

- Setup: së pari ikona `Revolution Fiskalizim`, pastaj një folder `Revolution Backup FISKALIZIMI`.
- Instal i ri / update: i njëjti folder, të dhënat e vjetra. Nuk hapet Explorer.
- Nuk u prek `fiscal/**`, ATK, build. Folderët e vjetër në desktop nuk u fshinë.
- Në PC: vetëm pas Setup të ri + mbyllje e plotë + hapje.

## 2026-10-31 — Build 1.1.19 OK

- `package.json` 1.1.18 → 1.1.19
- Setup: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.1.19-win-x64.exe`
- Të vjetrat mbeten (1.1.10–1.1.18) për kthim.
- Nuk u dërgua ATK. Në PC: instalo + mbyll plotësisht + hap përsëri.

## 2026-10-31 — Pa dritare «Pagesa u krye»

- Pas pagesës me kupon termik nuk del më dritarja «Pagesa u krye / Shtyp Kuponin / Vazhdo».
- Shporta pastrohet menjëherë (`finalizePosPostPaySuccess`).
- Skedar: `public/index.html`. Nuk u prek `fiscal/**`, ATK, build.

## 2026-10-31 — Monedha në arkë te Arka

- Te header i Arkës: **MONEDHA NË ARKË** me totalin e shitjeve të sotme (`GET /api/ditari?period=sot` → `totalSales`).
- Rifreskohet pas pagesës dhe kur hyn operatori.
- Nuk u shtua ndërrim / Mbyll ndërrimin / Dil — ky projekt s’i ka.
- Skedar: `public/index.html`. Nuk u prek `fiscal/**`, ATK.
- Në PC: mbyll programin plotësisht + hapje (ose rifresko Arka).

## 2026-10-31 — Ditari 404 + pagesa te kupon termik

- E kuqja «Not Found» te Ditari: `/api/ditari` mungonte te serveri i hapur (i vjetër). Shitjet ISHIN te `orders` (17 sot, 151.18 €).
- Pas nisjes së `server.js` të ri: `GET /api/ditari?period=sot` OK — 17 porosi, Cash 131.18, Kartë 20.
- Data nga/deri mbushen nga API (`public/index.html`).
- Kupon termik: `Pagesa: Cash / Kartë Debit / Kartë Kredit / Përzier` (`receipt-text.js`, `server.js` e kalon `payment_method` siç është).
- Raporti X mbetet 0 për kupon TERMIK — X lexon vetëm `fiscal_receipts`, jo termik. Nuk u prek `fiscal/**`.
- Nuk u dërgua ATK. Nuk u bë build.

## 2026-10-31 — Build 1.1.18 OK

- Version `package.json` 1.1.18
- Setup i plotë: `dist-atk-v2\Revolution-Fiskalizim-Setup-1.1.18-win-x64.exe` (109126420 byte)
- Kopje edhe te Desktop. 1.1.10–1.1.15 mbeten për kthim.
- NSIS te `dist-atk-v2` dështoi (197 KB); u bë te Temp me emër të shkurtër, pastaj u kopjua.
- Nuk i fshiva stubet e vegjël 1.1.16/1.1.17. Nuk u dërgua ATK.
- Në PC: instalo Setup 1.1.18 → mbyll plotësisht → hape përsëri.

## 2026-10-31 — Build 1.1.16 / 1.1.17 DËSHTOI

- Version 1.1.15 → 1.1.16 → 1.1.17
- NSIS: «Can't open output file» — Setup doli 197 KB (i prishur), jo ~109 MB
- Të vjetrat mbeten: 1.1.10–1.1.15
- Nuk i fshiva skedarët e vegjël. Nuk u dërgua ATK.

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
