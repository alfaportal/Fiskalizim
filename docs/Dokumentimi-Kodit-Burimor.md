# Revolution Invest SH.P.K. · NUI 811314567 · ATK / SEF — Faza 2

## Dokumentimi i Kodit Burimor

### Revolution Fiskalizim

---

## 1. Informata të përgjithshme

| Fusha | Vlera |
|-------|-------|
| **Emri i softuerit** | Revolution Fiskalizim |
| **Versioni** | 1.0.0 |
| **Gjuha programuese** | JavaScript (Node.js) |
| **Platforma** | Electron 42.4.1 (desktop Windows) |
| **Databaza** | SQLite (`sql.js`), lokale, enkriptuar AES-256-GCM |
| **Vendndodhja e DB** | `%APPDATA%\biznes-sef\biznes.db` |
| **Serveri lokal** | Express 4.x, bind `127.0.0.1:3971` |
| **Licenca** | Pronësore (proprietary / UNLICENSED) |
| **Zhvilluesi** | Revolution Invest SH.P.K. · NUI 811314567 |

---

## 2. Struktura e skedarëve dhe moduleve

### 2.1 Skedarët kryesorë (rrënja e projektit)

| Skedar | Funksioni |
|--------|-----------|
| `main.js` | Aplikacioni Electron: dritare, nis serverin lokal, dialogë sistemi |
| `server.js` | Serveri Express me API-të (`/api/*`, `/api/fiscal/*`, backup, disk-status) |
| `database.js` | Menaxhimi i SQLite: produkte, shitje, settings; ngarkim/ruajtje të enkriptuar |
| `db-crypto.js` | Enkriptim AES-256-GCM i `biznes.db` dhe çelësave privat `.pem.enc` |
| `biznes-backup.js` | Kopjim i plotë i folderit `biznes-sef` në USB/folder të zgjedhur |
| `disk-monitor.js` | Kontroll hapësire disku; paralajmërim <500 MB, bllokim <100 MB |
| `receipt-text.js` | Ndihmës ESC/POS: formatim teksti, gjerësi letre, konvertim plain → ESC/POS |
| `printer.js` | Komunikimi me printerin termik Windows (ESC/POS, Tysso, etj.) |
| `vat-smart-map.js` | Mapim automatik TVSH A/C/D/E nga emri/barkodi i produktit |
| `public/index.html` | UI: arka, kuponë, raporte X/Z, audit, cilësimet SEF |

### 2.2 Moduli fiskal (`fiscal/`)

#### Orkestrim dhe fluks kryesor

| Skedar | Funksioni |
|--------|-----------|
| `fiscal/fiscal-main.js` | Orkestrimi i fiskalizimit pas checkout: TVSH, NUIKF, QR, print, ATK, audit |
| `fiscal/fiscal-config.js` | Lexon/ruan `fiscal_settings`; aktivizon modulin vetëm kur `fiscal_enabled=1` |
| `fiscal/fiscal-vat.js` | Llogaritja e TVSH sipas normave A/C/D/E me residual rounding |
| `fiscal/fiscal-numbering.js` | Numri ditor, NUIKF unik, SEF identifier; raporte X/Z/periodik |
| `fiscal/fiscal-payment.js` | Mënyrat e pagesës të lejuara për fiskalizim |

#### Kupon, validim, print

| Skedar | Funksioni |
|--------|-----------|
| `fiscal/fiscal-receipt-guard.js` | Validon strukturën e kuponit para printimit (fushat e detyrueshme ATK) |
| `fiscal/fiscal-print.js` | Gjeneron layout-in e tekstit të kuponit fiskal (ATK); përfshin «e-kuponi» |
| `fiscal/fiscal-qr.js` | QR fiskal: CitizenCoupon Protobuf + nënshkrim ECDSA; buffer ESC/POS |
| `fiscal/fiscal-logo.js` | Logo fiskale RKS/MF në ESC/POS (raster ose tekst stilizuar) |
| `fiscal/fiscal-receipts-list.js` | Listë kuponësh dhe preview teksti për panelin e operatorit |

#### Protobuf dhe ATK

| Skedar | Funksioni |
|--------|-----------|
| `fiscal/atk-models.proto` | Skema Protobuf zyrtare ATK (PosCoupon, CitizenCoupon, TaxGroup, Payment, CouponItem) |
| `fiscal/atk-model-builder.js` | Ndërton dhe enkodon objekte Protobuf nga të dhënat e kuponit |
| `fiscal/fiscal-crypto.js` | Çelësa ECDSA P-256; `signReceipt()` — SHA-256 + nënshkrim; menaxhim `.pem.enc` |
| `fiscal/fiscal-atk-api.js` | Dërgimi HTTP POST te ATK (`/pos/coupon`); status çelësave/certifikatës |
| `fiscal/atk-dns.js` | Rezolvim DNS për ATK kur DNS lokal dështon (DoH, IP fallback) |

#### Databazë, audit, offline, rikuperim

| Skedar | Funksioni |
|--------|-----------|
| `fiscal/fiscal-db.js` | DDL tabelat fiskale; INSERT write-once; trigger SQL anti-DELETE/UPDATE |
| `fiscal/fiscal-audit.js` | Audit log write-once; eksport CSV/PDF |
| `fiscal/fiscal-offline.js` | Radha offline; monitor 60s; dërgim automatik kur rikthehet lidhja |
| `fiscal/fiscal-recovery.js` | Rikuperim pas ndërprerjes (`pending_txn`) |
| `fiscal/fiscal-correction.js` | Kuponë korrigjues: cancel, return, storno (INSERT i ri) |

#### Të tjera

| Skedar | Funksioni |
|--------|-----------|
| `fiscal/fiscal-i18n.js` | Përkthime sq/sr për kuponin fiskal dhe UI SEF |
| `fiscal/fiscal-self-test.js` | Test lokal i modulit fiskal pa dërgim ATK |
| `fiscal/license-guard.js` | Mbrojtje licencë lokale (hardware lock) |
| `fiscal/assets/generate-rks-mf-logo.js` | Gjeneron PNG `logo_rks_mf.png` për printim ESC/POS |

---

## 3. Tabelat e databazës fiskale (SQLite)

Tabelat krijohen nga `fiscal/fiscal-db.js` dhe ruhen në `biznes.db` (enkriptuar).

### 3.1 `fiscal_receipts`

Ruan çdo kupon fiskal. **Write-once** — UPDATE vetëm për `sent_to_atk`, `sent_at`, `atk_response_json`.

Fusha kryesore: `id`, `sale_id`, `nuikf`, `sef_id`, `receipt_type` (`regular` / `cancel` / `return` / `storno`), `original_nuikf`, `daily_number`, `total_number`, `fiscal_date`, `fiscal_time`, `operator_name`, `operator_id`, `taxpayer_*`, `items_json`, `subtotal`, `total_amount`, `vat_breakdown_json`, `payment_method`, `qr_code_data`, `digital_signature`, `is_offline`, `sent_to_atk`, `sent_at`, `atk_response_json`, `created_at`.

### 3.2 `fiscal_settings`

Cilësimet SEF: NUI, emri ligjor, adresa, NF, TVSH, POS ID, numri i njësisë ARBK, `fiscalization_number`, `sef_identifier`, `certificate_path`, `private_key_path`, `atk_api_url` (TEST/PROD), `language`, `daily_receipt_counter`, `total_receipt_counter`, `last_z_report_date`, etj.

### 3.3 `fiscal_audit_log`

Regjistri i auditimit — **INSERT only**, mbrohet me trigger SQL.

Fusha: `id`, `action`, `details_json`, `operator_name`, `operator_id`, `created_at`.

### 3.4 `pending_txn`

Checkpoint rikuperimi pas ndërprerjes (Neni 11).

Fusha: `id`, `order_id`, `fiscal_receipt_id`, `nuikf`, `stage`, `status`, `print_text`, `details_json`, `created_at`, `updated_at`.

---

## 4. Rrjedha e fiskalizimit (workflow)

1. Operatori zgjedh artikujt dhe mënyrën e pagesës → klikon «Paguaj + Kupon fiskal».
2. Sistemi llogarit TVSH-në sipas normave (`fiscal-vat.js`) me residual rounding.
3. Gjenerohen NUIKF dhe numri ditor (`fiscal-numbering.js`).
4. Krijohet kuponi fiskal në databazë (`fiscal-db.js` → `fiscal_receipts`).
5. Regjistrohet në audit log (`fiscal-audit.js` → `receipt_created`).
6. Ndërtohet PosCoupon Protobuf (`atk-model-builder.js` + `atk-models.proto`).
7. Ndërtohet CitizenCoupon për QR (`atk-model-builder.js`).
8. Nënshkruhet me ECDSA P-256: SHA-256 → `signReceipt()` (`fiscal-crypto.js`).
9. QR = `base64(protobuf) + "|" + base64(signature)` (`fiscal-qr.js`).
10. Kuponi printohet termik (`fiscal-print.js` + `fiscal-logo.js` + `printer.js`).
11. PosCoupon dërgohet te ATK (`fiscal-atk-api.js`): POST `/pos/coupon`.
12. ATK kthen përgjigje — ruhet `sent_to_atk=1`, `atk_response_json`.
13. Nëse s'ka internet: ruhet offline (`fiscal-offline.js`); dërgohet automatikisht kur rikthehet lidhja.
14. Pas ndërprerjes: rikuperim nga `pending_txn` (`fiscal-recovery.js`).

---

## 5. Librari të përdorura (sipas `package.json`)

### Varësi runtime (`dependencies`)

| Libraria | Versioni | Qëllimi |
|----------|----------|---------|
| **express** | ^4.21.2 | Server HTTP lokal |
| **sql.js** | ^1.14.1 | SQLite në memorie/skedar |
| **protobufjs** | ^8.7.1 | Serializim Protobuf për ATK |
| **qrcode** | ^1.5.4 | Gjenerim QR kod |
| **crypto** (Node.js) | builtin | AES-256-GCM, ECDSA P-256, SHA-256 |

### Varësi zhvillimi (`devDependencies`)

| Libraria | Versioni | Qëllimi |
|----------|----------|---------|
| **electron** | 42.4.1 | Aplikacion desktop Windows |
| **electron-builder** | ^26.0.12 | Paketim NSIS `.exe` |

**Nuk përdoren:** pdf-lib, ExcelJS (audit PDF bëhet në `fiscal-audit.js` pa dependency të jashtme).

---

## 6. Siguria e kodit burimor dhe e të dhënave

### 6.1 Kodi burimor dhe paketimi

- Kodi burimor mbahet në repositor privat.
- Paketimi Electron me **asar** (`asar: true`).
- Çelësat privatë ECDSA **nuk** përfshihen në kod — ruhen në `%APPDATA%\biznes-sef\fiscal-keys\`.
- Instaluesi NSIS: `perMachine: false` (instalim për përdorues).

### 6.2 Enkriptimi i databazës dhe çelësave

- **`biznes.db`** enkriptohet me **AES-256-GCM** (`db-crypto.js`, format `BIZENC1`).
- **Çelësi master** (32 byte) mbrohet me **Windows DPAPI** → `.db-master.dpapi`.
- Fallback jo-Windows: scrypt + fingerprint makine.
- Çelësat privat ECDSA ruhen si **`.pem.enc`** kur nuk përdoren.

### 6.3 Backup dhe monitorim disku

- **`biznes-backup.js`**: kopjim i plotë i `biznes-sef`; audit `backup_created`.
- **`disk-monitor.js`**: paralajmërim <500 MB; bllokim regjistrimesh <100 MB; audit `disk_space_warning` / `disk_space_critical`.

### 6.4 Mbrojtje fiskale (write-once)

- `fiscal_receipts` dhe `fiscal_audit_log`: trigger SQL që bllokon DELETE dhe UPDATE të palejuar.
- Kupon korrigjues = **INSERT i ri**, jo ndryshim i kuponit origjinal.

---

## 7. LLOJET E KUPONËVE FISKALË

### 7.1 SALE — shitje e rregullt (`receipt_type = regular`)

- Përmban: artikujt, sasia, çmimi, norma TVSH (A/C/D/E), totali, mënyra e pagesës.
- Gjeneron NUIKF unik, numër ditor, QR, nënshkrim digjital.
- Dërgohet te ATK pas printimit (ose mbetet në radhë offline).

### 7.2 CANCEL — anulim (`receipt_type = cancel`)

- Referon kuponin origjinal me **NUIKF** (`original_nuikf`).
- Përmban arsyen e anulimit (`correction_reason`).
- INSERT i ri në `fiscal_receipts`; kuponi origjinal **nuk** ndryshohet.

### 7.3 RETURN — kthim (`receipt_type = return`)

- Referon kuponin origjinal me NUIKF.
- Përmban artikujt e kthyer (sasi/çmim).
- Lejohet më shumë se një kthim për të njëjtin kupon origjinal.

### 7.4 STORNO — storno (`receipt_type = storno`)

- Anulim/storno i plotë i kuponit origjinal (si cancel, por tip i veçantë ATK).
- Vetëm **një** storno/anulim për kupon origjinal.

### 7.5 Elementet e përbashkëta të çdo kuponi

- **QR kod** fiskal (CitizenCoupon + nënshkrim ECDSA).
- **Logo fiskale RKS/MF** (pas QR-së).
- Teksti **«e-kuponi»** në fund të kuponit (`fiscal-print.js`).

### 7.6 Kupon OFFLINE

- Kur nuk ka lidhje me ATK: `is_offline = 1`, `sent_to_atk = 0`.
- Printohet me mbishkrimin **`*** OFFLINE ***`**.
- Ruhet në `fiscal_receipts`; checkpoint në `pending_txn` për rikuperim printimi.
- Dërgohet automatikisht kur rikthehet lidhja (`fiscal-offline.js`).

---

## 8. NORMAT E TVSH-SË

Normat programohen në `fiscal/fiscal-vat.js` dhe shënohen me **shkronja latine A, C, D, E**:

| Norma | Shkalla | Baza ligjore / përshkrim |
|-------|---------|--------------------------|
| **A** | 0% | Eksporte (Neni 31) |
| **C** | 0% | Përjashtime / lirime (Neni 27 + 28) |
| **D** | 8% | Shkalla e ulët (Neni 26.2) |
| **E** | 18% | Shkalla standarde (default) |

- Llogaritja përdor **residual rounding** (mbetja shpërndahet në normën e fundit).
- Produktet mapehen automatikisht me `vat-smart-map.js` (keywords ATK).
- Në kupon shfaqen shumat e TVSH-së sipas normës (A/C/D/E).

---

## 9. RAPORTET FISKALE

Implementohen në `fiscal/fiscal-numbering.js` dhe API `/api/fiscal/*`.

### 9.1 Raporti X

- Snapshot i ditës **pa resetim** të numrit ditor.
- Përmbledhje: numri i kuponëve, totalet, TVSH sipas normave.
- Printohet me **QR + Logo RKS/MF**.
- Logon në `fiscal_audit_log` (`action = x_report`).

### 9.2 Raporti Z (RFD — mbyllja ditore)

- Mbyllja fiskale ditore; reseton numrin ditor (1× në ditë).
- Përmbledhje ditore e plotë; printohet me **QR + Logo RKS/MF**.
- Logon në `fiscal_audit_log` (`action = z_report`).
- Transmetohet te ATK (përmes modulit fiskal / raportit ditor).

### 9.3 Raporti Periodik

- Përmbledhje ndërmjet dy datave (nga UI tab «Periodik»).
- Variante: raport periodik, raport i shkurtër periodik, raport mujor memorie.
- Printohet me **QR + Logo RKS/MF**.
- Logon në `fiscal_audit_log` (`periodic_report`, `short_periodic_report`, `monthly_memory_report`).

### 9.4 Audit i raporteve

- Çdo raport regjistrohet në `fiscal_audit_log` me operator, datë dhe detaje JSON.

---

## 10. LOGO FISKALE

- **Stema e Kosovës** me tekstin **RKS** dhe **MF**.
- **Dimensione ATK:** min **15 mm × 8 mm**, max **20 mm × 10 mm**.
- Printohet në **fund të çdo kuponi fiskal** dhe **çdo raporti X / Z / Periodik**.
- Radha e printimit: tekst kupon → QR → logo RKS/MF → «e-kuponi» → cut.
- **Skedari:** `fiscal/assets/logo_rks_mf.png` (160×80 px, B/W).
- **Gjenerimi:** `fiscal/assets/generate-rks-mf-logo.js`.
- **Implementimi print:** `fiscal/fiscal-logo.js` (ESC/POS GS v 0 raster); fallback tekst nëse PNG mungon.

---

## 11. MODALITETI OFFLINE

- Kuponi **gjenerohet me QR dhe nënshkrim** edhe **pa internet** (`fiscal-offline.js`).
- Ruhet në `fiscal_receipts` me `is_offline = 1`; checkpoint në `pending_txn` për rikuperim.
- Printohet me mbishkrimin **`*** OFFLINE ***`**.
- **Dërgohet automatikisht** te ATK kur rikthehet lidhja (monitor çdo 60s).
- **Njoftim vizual** në UI kur operohet offline (`offline_start` / `offline_end` në audit; status në topbar).
- Audit: `offline_start`, `offline_end`, `receipt_sent` pas dërgimit të suksesshëm.

---

## 12. FORMATI I PRINTIMIT

- **Letër termike:** 58 mm, 80 mm (default), 100 mm (`printer.js`, `receipt-text.js`).
- **Minimum ~18 karaktere** për rresht (58 mm = 32 kolona; 80 mm = 42; 100 mm = 48).
- **Protokolli ESC/POS** (bold, cut, QR raster, logo raster GS v 0).
- **Kopje e kuponit:** riprint me shënimin **«KOPJE E KUPONIT»** (`/api/fiscal/receipts/:id/print-copy`).
- Printeri termik (p.sh. Tysso) zgjidhet nga UI tab «Printeri».

---

## 13. MËNYRAT E PAGESËS

Përcaktuara në `fiscal/fiscal-payment.js`:

| ID | Etiketa |
|----|---------|
| `cash` | Para e gatshme |
| `debit_card` | Debit kartelë |
| `credit_card` | Kredit kartelë |
| `bank_account` | Llogari bankare |
| `check` | Çek |
| `voucher` | Vauçer / kupon |
| `sms` | SMS |

- **Nuk ruhen të dhëna bankare** (PAN, CVV, PIN) — vetëm **lloji i pagesës**.
- Pagesa me kartelë kryhet nga **terminali POS i jashtëm**; softueri regjistron vetëm metodën.
- Pagesa e përzier (mixed) mbështetet në checkout me shpërndarje cash/card/voucher.

---

## 14. GJUHËT

- **Shqip (sq)** dhe **Serbisht (sr)** — sipas Nenit 24/14 të specifikave ATK.
- Implementuar në `fiscal/fiscal-i18n.js`; zgjedhja nga `fiscal_settings.language`.
- **Shkronja latine**; mbështet karaktere të veçanta të gjuhëve zyrtare (ë, ç, š, ž, etj.).
- Gjuha ndikon **vetëm kuponin fiskal dhe UI SEF**, jo modulet e tjera.

---

## 15. DEKLARATË PRIVATËSIE

- Të dhënat fiskale ruhen **ekskluzivisht lokalisht** te tatimpaguesi (`%APPDATA%\biznes-sef\`).
- Zhvilluesi (**Revolution Invest SH.P.K.**) **NUK ka qasje** në të dhënat e klientëve.
- **Nuk ka server cloud** — vetëm lidhje HTTPS me **ATK** për dërgim kuponësh.
- Klienti (tatimpaguesi) është **kontrollor i vetëm** i të dhënave të veta.
- Databaza dhe çelësat privat enkriptohen lokalisht (`db-crypto.js`).

---

## 16. PËRPUTHSHMËRIA LIGJORE

Softueri zhvilluohet në përputhje me:

- **Udhëzimin Administrativ (MF) Nr. 01/2026**
- **Ligjin Nr. 08/L-257** për TVSH
- **Kërkesat Specifike Teknike dhe Funksionale për PEF/SF/SEF** (29.05.2026)
- **Ndryshim-plotësimin** (22.06.2026)

Funksionalitete kyçe të përputhshme: kupon fiskal, QR, logo RKS/MF, norma TVSH A/C/D/E, raporte X/Z/periodik, audit log write-once, offline queue, storno/anulim/kthim, mbrojtje e të dhënave lokale.

---

**Konfidencial — për aplikim certifikimi SEF**  
Revolution Invest SH.P.K. · NUI 811314567  
Data e dokumentit: 10.08.2026
