# Revolution Invest SH.P.K. · NUI 811314567 · ATK / SEF — Faza 2

## Përshkrim Teknik i Zgjidhjes Softuerike

### Sistem Fiskal Elektronik — Revolution Fiskalizim

| | |
|---|---|
| **Zhvilluesi** | Revolution Invest SH.P.K. |
| **NUI** | 811314567 |
| **Produkti** | Revolution Fiskalizim |
| **Dokument për** | Aplikim për Certifikim SEF — Faza 2 |
| **Baza** | Kodi real i projektit «biznes» (test ATK/SEF) |

---

## 1. Emri i produktit dhe zhvilluesi

Emri i produktit: **Revolution Fiskalizim**.

Zhvilluesi: **Revolution Invest SH.P.K.**, NUI 811314567.

Softueri është i destinuar për shitje me pakicë / hospitalitet në Republikën e Kosovës, në përputhje me kërkesat e Administratës Tatimore të Kosovës (ATK) për Sistemin Elektronik Fiskal (SEF).

---

## 2. Përshkrim i përgjithshëm i funksionalitetit të SEF

Moduli SEF mundëson fiskalizimin e shitjeve në pikën e shitjes (POS). Funksionalitetet kryesore të zbatuara në kod janë:

- Regjistrimi i shitjes (arka / checkout) dhe llogaritja e TVSH sipas normave A, C, D (8%), E (18%), me residual rounding të centralizuar.
- Emetimi i kuponit fiskal (tekst ESC/POS për printer termik), me NUIKF, SEF ID, numër ditor dhe numër total, logo RKS/MF dhe QR ATK.
- Kuponë korrigjues: storno, anulim (cancel) me arsye, kthim (return) dhe ndërrim artikulli (return + shitje e re).
- Zbritje dhe rritje çmimi në nivel artikulli ose në total/nën-total (vlerë ose përqindje).
- Pagesa: cash, kartelë/POS, voucher, çek; edhe pagesa të përziera në një kupon.
- Konfirmim shtesë për transaksione mbi 1 000 € (Neni 11).
- Modalitet offline: shënimi OFFLINE në kupon, radhë dërgimi dhe ridërgim automatik kur rikthehet lidhja.
- Rikuperim pas ndërprerjes (`pending_txn`): rifillim printimi me «MUNGESË RRYME» pa dublikim kuponësh.
- Raporte: Raporti X (Modi X — gjendja aktuale), Raporti Z (mbyllje ditore), Raport periodik mes dy datave.
- Shumëgjuhësia e kuponit: shqip (sq) dhe serbisht (sr).
- Eksporti i audit log-ut në CSV dhe PDF për kontroll nga ATK (Neni 26).
- Self-test fiskal dhe lista e kuponëve lokalë.

---

## 3. Arkitektura teknike

### 3.1 Komponentët

- **Electron** — aplikacion desktop Windows (Revolution Fiskalizim).
- **Node.js + Express** — server lokal HTTP për UI, API dhe printim.
- **SQLite lokal (`sql.js`)** — të dhënat e biznesit dhe tabelat fiskale (`fiscal_receipts`, `fiscal_settings`, `fiscal_audit_log`, `pending_txn`).
- **Printer termik ESC/POS** (p.sh. Tysso) — printimi i kuponit dhe raporteve.
- **Aplikacioni «biznes»** — POS i plotë i dedikuar për testim ATK/SEF me të njëjtin modul fiskal.

### 3.2 Vendndodhja e të dhënave

Databaza lokale ruhet në:

**`%APPDATA%\biznes-sef\biznes.db`**

Skedari i çelësit master (enkriptim): `%APPDATA%\biznes-sef\.db-master.dpapi`

Çelësat dhe certifikata ECDSA ruhen në folderin e çelësave fiskalë:

**`%APPDATA%\biznes-sef\fiscal-keys\`**

(`private-key.pem` / `signed-certificate.pem`, ose `.pem.enc` kur janë të enkriptuara)

---

## 4. Mënyra e integrimit me ATK

### 4.1 Protobuf

Kuponi dërgohet te ATK si PosCoupon i koduar me Protobuf (`protobufjs`), sipas skemës `fiscal/atk-models.proto`. Endpoint: **POST `/pos/coupon`** në mjedisin TEST (`fiskalizimi-test.atk-ks.org`) ose PROD (`fiskalizimi.atk-ks.org`).

### 4.2 ECDSA P-256

Nënshkrimi digjital i kuponit / QR bëhet me ECDSA mbi lakoren P-256, duke përdorur çelësin privat të SEF dhe certifikatën e nënshkruar nga ATK (`fiscal/fiscal-crypto.js` → `signReceipt()`). Self-testi fiskal verifikon gjenerimin e nënshkrimit ECDSA P-256.

### 4.3 QR code (base64 + signature)

QR i kuponit përmban payload-in e koduar (protobuf në base64) të ndarë me `|` nga nënshkrimi digjital (base64). Printimi përdor ESC/POS native QR (Model 2) dhe/ose PNG; madhësia plotëson kërkesën minimale ATK (≥ 12×12 mm në printer termik tipik 203 DPI).

### 4.4 Formati i identifikuesit SEF

Numri Identifikues SEF (Neni 25): `[Numri i Njësisë ARBK]-[NUI]-[PosID]`, p.sh. `1-811314567-01`.

Funksioni `getSefIdentifier()` e ndërton nga `unit_number`, `taxpayer_nui` dhe `pos_id`. NUIKF është kod unik 16-karakterësh alfanumerik për çdo kupon.

---

## 5. Siguria e të dhënave

- **Write-once:** tabelat `fiscal_receipts` dhe `fiscal_audit_log` mbrohen me trigger SQL; UPDATE lejohet vetëm për fusha të kufizuara (`sent_to_atk`, `sent_at`, `atk_response_json`).
- **Audit log:** çdo veprim kritik (`receipt_created`, `z_report`, `x_report`, `correction_created`, `power_recovery`, `backup_created`, `disk_space_warning`, etj.) regjistrohet me INSERT të pandryshueshëm.
- **Çelësat privatë dhe certifikata** ruhen jashtë kodit burimor, në folder lokal të mbrojtur.

### Enkriptimi i databazës dhe çelësave

- **Databaza SQLite** enkriptohet me **AES-256-GCM** (`db-crypto.js`, format `BIZENC1`).
- **Çelësi master** (32 byte) mbrohet me **Windows DPAPI** → skedari **`.db-master.dpapi`**.
- **Çelësat ECDSA** privat ruhen si **`.pem.enc`** (të enkriptuara) kur nuk përdoren aktivisht.

### Backup dhe monitorim disku

- **Backup (`biznes-backup.js`):** kopjon krejt folderin `biznes-sef` (DB, master key, fiscal-keys) në USB ose folder të zgjedhur; logon `backup_created` në audit.
- **Alarm disku (`disk-monitor.js`):** paralajmëron kur hapësira < **500 MB**; bllokon regjistrimin e ri kur < **100 MB**; logon në `fiscal_audit_log`.

### Mbrojtje shtesë

- **Validim para printit** (`fiscal-receipt-guard`): bllokon printimin nëse mungojnë elemente të detyrueshme (NUIKF, QR, logo, TOTAL, TVSH, etj.).
- **Idempotencë:** një porosi nuk krijon dy kuponë fiskalë (kontroll `is_fiscalized` / `fiscal_receipt_id`).

---

## 6. Funksionimi offline dhe rikuperimi pas ndërprerjes

### 6.1 Offline

Kur nuk ka lidhje interneti, kuponi shtohet në radhë offline (`is_offline=1`), printohet me shënimin **`*** OFFLINE ***`**, dhe monitori periodik (çdo 60s) përpiqet ta dërgojë te ATK kur lidhja rikthehet. Ekziston edhe dërgim manual i kuponëve në pritje.

### 6.2 Rikuperimi (`pending_txn`)

Sipas Nenit 11, pika 7, sistemi mban checkpoint në tabelën `pending_txn` midis hapave kritikë:

`started` → `coupon_ready` → `printing` → `done`

Nëse ndërpritet energjia/programi pas krijimit të kuponit por para përfundimit të printimit, në boot sistemi:

- Identifikon transaksionet e hapura (pending).
- Nuk krijon kupon të dytë (përdor idempotencën ekzistuese).
- Rifillon printimin me rreshtin special **«MUNGESË RRYME»** dhe përsërit rreshtin e fundit të printuar para ndërprerjes.
- Pending në fazën `started` (pa kupon) shënohet `abandoned` — operatori ribën checkout-in.

---

## 7. Lista e teknologjive dhe librarive kryesore

### Varësi runtime (`dependencies`)

| Libraria | Versioni | Qëllimi |
|----------|----------|---------|
| **express** | ^4.21.2 | Server HTTP lokal |
| **sql.js** | ^1.14.1 | SQLite lokale |
| **protobufjs** | ^8.7.1 | Serializim PosCoupon për ATK |
| **qrcode** | ^1.5.4 | Gjenerim QR kod |
| **crypto** (Node.js) | builtin | AES-256-GCM, ECDSA P-256 |

### Varësi zhvillimi (`devDependencies`)

| Libraria | Versioni | Qëllimi |
|----------|----------|---------|
| **electron** | 42.4.1 | Aplikacion desktop Windows |
| **electron-builder** | ^26.0.12 | Paketim NSIS `.exe` |

### Module të brendshme (pa dependency npm)

| Modul | Qëllimi |
|-------|---------|
| **db-crypto.js** | Enkriptim AES-256-GCM i DB dhe çelësave |
| **biznes-backup.js** | Backup i folderit `biznes-sef` |
| **disk-monitor.js** | Alarm hapësire disku |
| **ESC/POS** | Printim termik (printer.js, receipt-text.js) |

**Nuk përdoren:** `better-sqlite3`, `pdf-lib`, `ExcelJS`, `electron-updater`. Eksporti audit PDF bëhet me gjenerator minimal në `fiscal-audit.js`.

---

## 8. Lista e skenarëve të mbuluar (ATK / Shtojca F / Neni 25)

1. Kupon i rregullt — shitje + print fiskal + NUIKF/SEF/QR.
2. Ulje në artikull (vlerë ose %).
3. Ulje në total / nën-total (vlerë ose %).
4. Rritje çmimi në artikull dhe në total.
5. Storno / kthim me referencë te kuponi origjinal (`original_nuikf`).
6. Anulim (cancel) me arsye të shënuar dhe lidhje me kuponin origjinal.
7. Ndërrim artikulli — kthim i të vjetrit + shitje e re (çmim ≥, e njëjta normë TVSH).
8. Kupon me të 4 normat TVSH A, C, D, E të përziera.
9. Pagesa të përziera (Cash + POS/Kartelë + Voucher/Çek).
10. Transaksion mbi 1 000 € — dritare konfirmimi shtesë para finalizimit.
11. Modaliteti OFFLINE — shënim në kupon + dërgim automatik kur rikthehet lidhja.
12. Rikuperim pas ndërprerjeje — `pending_txn` + «MUNGESË RRYME» pa dublikim.
13. Raporti X (Modi X) — lexues/printues shumë herë, pa reset numri ditor.
14. Raporti Z — mbyllje ditore (1×/ditë) me reset të numrit ditor.
15. Raport periodik — mes dy datave.
16. Shumëgjuhësia shqip / serbisht në kupon (dhe etiketat SEF).
17. Eksporti i log-eve CSV/PDF për kontroll nga ATK.

---

## 9. Formati i kuponit fiskal (sipas Nenit 25)

Çdo kupon fiskal i printuar përmban elementet e mëposhtme sipas kërkesave të ATK:

- Emri ligjor i biznesit dhe emri i njësisë (degës).
- NUI (Numri Unik i Identifikimit) — 9 shifra.
- Numri Fiskal (NF) dhe Numri i TVSH-së.
- Adresa e njësisë dhe telefoni.
- Numri Identifikues SEF: `[Numri i Njësisë]-[NUI]-[PosID]`.
- NUIKF — Numri Unik i Kuponit Fiskal (16 karaktere alfanumerike).
- Data dhe ora e emetimit.
- Lista e artikujve: emri, sasia, çmimi, norma TVSH, totali.
- TVSH e ndarë sipas normave (A 0%, C 0%, D 8%, E 18%).
- Totali pa TVSH dhe Totali me TVSH.
- Mënyra e pagesës (KESH, KARTË/POS, VAUÇER, ÇEK).
- Numri i kuponit fiskal (total) dhe numri i kuponit fiskal ditor.
- QR kodi i kuponit (base64 protobuf + nënshkrim ECDSA).
- Logoja fiskale RKS/MF (20×10 mm).
- Teksti «e-kuponi».

---

## 10. Deklarata e pajtueshmërisë

Revolution Invest SH.P.K. deklaron që zgjidhja softuerike Revolution Fiskalizim është e zhvilluar në përputhje të plotë me:

- Ligjin Nr. 08/L-257 për Sistemin Elektronik Fiskal.
- Udhëzimin Administrativ MF Nr. 01/2026 dhe amendamentin 22/06/2026.
- Kërkesat Teknike të ATK-së (dokumenti 88-faqësh) dhe Shtojcën F.
- Udhëzuesin e Testimit dhe Certifikimit të SEF nga ATK.

---

## 11. Përfundim

Ky dokument përshkruan zgjidhjen softuerike të Revolution Invest SH.P.K. siç është implementuar në produktin Revolution Fiskalizim. Të gjitha funksionalitetet e kërkuara nga ATK janë të zbatuara dhe të testuara me sukses në mjedisin e testimit (`fiskalizimi-test.atk-ks.org`). Dokumenti është përgatitur për **Fazën 2 — Aplikimi për Certifikim SEF** pranë ATK.

---

**Konfidencial — për aplikim certifikimi SEF**  
Revolution Invest SH.P.K. · NUI 811314567  
Data e dokumentit: 10.08.2026
