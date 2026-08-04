# Biznes — Test ATK / SEF

Projekt i veçantë, i thjeshtë, **vetëm për Faza e Testimit SEF (ATK)**.

**Nuk ka lidhje me KAFENE apo FURRA.** Nuk përfshin tavolina, kamarier, KDS, QR-ordering, AI, pako/tier.

## Çfarë përmban

- Moduli fiskal i plotë (ECDSA, Protobuf, QR ATK, residual TVSH, Emri/Telefoni i Njësisë, Mënyra e Pagesës, Kupon Ditor Nr., SEF ID `{unit}-{nui}-{pos}`)
- Regjistrim shitjeje + arkë/checkout
- Emetim kuponi fiskal + printim + QR
- Anulim / storno kuponi
- Raporti Fiskal Ditor (Z-report)
- Produkte test sipas normës: **A, C, D, E** (nga 8 secila)

## Nisja (Windows) — dritare desktop si KAFENE

1. Duhet **Node.js** (https://nodejs.org — LTS)
2. Hap folderin `biznes`
3. **Dyklik** mbi **`START.bat`**
4. Hapet **dritare aplikacioni** (Electron), jo faqja e browserit
5. Tab **Printeri** → zgjidh termikun → **Test print** → pastaj shitje nga **Arka**

Vetëm për debug në browser: `START-BROWSER.bat`

## Të dhënat lokale

- DB: `%APPDATA%\biznes-sef\biznes.db`
- Çelësat ECDSA: `%APPDATA%\biznes-sef\fiscal-keys\`

Fiskalizimi është **ON** me cilësime prove (ndryshoji te **Cilësimet SEF** para testit zyrtar ATK).

## Ku i shkruan të dhënat e fiskalizimit?

Në aplikacion → tab **«Cilësimet SEF»** (pas `START.bat`).

| Çfarë | Ku |
|--------|-----|
| Emri, NUI, NF, TVSH, adresa | Forma në Cilësimet SEF |
| Emri/Telefoni i Njësisë, Nr. ARBK, POS ID | Po aty → SEF ID llogaritet vetë |
| URL ATK TEST/PROD | Po aty (default: **TEST**) |
| Kodi i fiskalizimit + Application ID | Nga **EDI ATK** / certifikimi SEF → po aty |
| `private-key.pem` + `signed-certificate.pem` | Folderi i çelësave (`Hap folderin e çelësave`) |

Folderi: `%APPDATA%\biznes-sef\fiscal-keys\`

## Si të testosh me ATK

1. Hap **Cilësimet SEF** → plotëso biznesin (NUI 9 shifra, etj.)
2. Lë URL në **TEST** (`fiskalizimi-test.atk-ks.org`)
3. Vendos certifikatën e nënshkruar nga ATK në folderin e çelësave
4. Plotëso **Application ID** (kur ta kesh nga ATK)
5. **Ruaj** → Arka → shitje prove A/C/D/E
6. Kuponi dërgohet te ATK (`POST /pos/coupon`); kontrollo statusin në Cilësimet
7. Storno + Raporti Z si zakonisht

Swagger TEST: https://fiskalizimi-test.atk-ks.org/swagger/index.html  
Aplikimi SEF: https://apps.atk-ks.org/sefaplikimi/
