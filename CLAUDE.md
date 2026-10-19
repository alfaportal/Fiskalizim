## GOLDEN RULE — ZERO REGRESSIONS (highest priority, above all other rules)
1. A fix must NEVER break something else. Before changing any function or file,
   find EVERY place that uses it (grep) and list them. After the change, re-test
   all of them, not only the one you fixed.
2. Do EXACTLY what Naser asked — nothing more, nothing less. No extra
   "improvements", no refactors, no renames, no touching unrelated code.
3. NEVER say "fixed", "done", "works" or "live" without PROOF:
   - code → run the tests and show the result
   - cloud → check /health git_commit AND test the real endpoint live
   - Railway → confirm the deploy is "Active" and not "Failed"
   - PC program → state clearly: "only after a new Setup"
   If you could not prove it, say: "NOT VERIFIED".
4. Tests must use the REAL program paths (real API calls, real UI flow).
   Never insert data directly into the database to fake a passing test.
   If a test passes only because of the test script, it is NOT a pass.
5. If anything is unclear, STOP and ask. Never guess, never assume.
6. One change at a time. If something breaks, revert immediately and report.
   Never hide a problem by adding more changes on top.
7. Everything new that the owner should see must also appear in the
   owner panel (phone too). Always say where it appears.
8. Communication: Naser reads Albanian. Write reports to him in simple Albanian,
   short and clear, without technical words.

---
## RREGULL ABSOLUT — IZOLIMI I PROJEKTEVE (nuk thyhet në asnjë rrethanë)

1. Çdo projekt ka serverin, të dhënat dhe strukturën e VET. Projektet NUK përzihen kurrë.

2. revolution-pos.com/owner/login është VETÊM DERA (hyrja). Pas hyrjes, çdo pronar
   shkon VETÊM te paneli dhe serveri i projektit të vet (kafene → restaurant,
   hotel → hotel, etj.). Asnjë projekt nuk mban faqe, kod apo të dhëna të projektit tjetër.

3. Kur punon brenda një projekti, ndryshon normalisht vetëm atë projekt.

4. Projekti tjetër: VETËM LEXIM. NDALOHET ABSOLUTISHT të ndryshosh, shtosh, fshish
   apo zhvendosësh ÇFARËDO në një projekt tjetër (server, kod, skedarë, konfigurim,
   databazë, deploy, gjithçka) pa lejen e Naserit.

5. Para çdo ndryshimi në projekt tjetër, pyet Naserin 4 HERË, një nga një, dhe prit
   konfirmimin e qartë "PO" çdo herë. Pa 4 konfirmime = MOS PREK.

6. Nëse nuk je i sigurt në cilin projekt je, NDALO dhe pyet.
7. KUJTESA E PUNËS — çdo projekt ka skedarin PUNA.md në rrënjë.
   - Para çdo detyre: LEXO PUNA.md që të dish çka është bërë, çka punon dhe çka jo.
   - Pas çdo ndryshimi: SHKRUAJ te PUNA.md: data, çka ndryshove (skedar + rresht),
     pse, çka provove, a funksionoi. Shkurt, por e saktë.
   - Nëse humbet, ngec ose nuk e di ku ishe: NDALO, lexo PUNA.md dhe git log,
     pastaj pyet Naserin. MOS vazhdo duke supozuar.
8. MOS PRISH ATË QË PUNON.
   - Një ndryshim në një kohë. Mos rregullo 3 gjëra njëherësh.
   - Para ndryshimit: kontrollo çka tjetër e përdor atë funksion/skedar.
   - Pas ndryshimit: ekzekuto testet (p.sh. protected-functions) dhe shiko git diff.
     Nëse diçka tjetër prishet, ktheje mbrapsht menjëherë dhe raporto.
   - Nëse një rregullim prish diçka tjetër, NDALO dhe raporto. Mos e mbulo
     me ndryshime të tjera.
9. MOS SHPIK. Nëse nuk e di si funksionon diçka, lexo kodin ose pyet.
   Mos supozo, mos thuaj "u rregullua" pa e provuar.

---

# CLAUDE.md

## RREGULL I DETYRUESHËM — LEXO PARA ÇFARËDO PUNE

### 1. LEXO RREGULLAT
Para se të bësh ÇFARËDO ndryshimi, LEXO PLOTËSISHT këtë skedar DHE .cursorrules (nëse ekziston).
Nëse nuk i lexon — NDALO dhe lexoji. Pa përjashtim.

### 2. MOS PREK PA LEJE — TELEFONI DHE PANELI I ADMINIT
Kodet e telefonit (waiter.js, mobile, cloud waiter) DHE panelit të adminit (admin.html, admin JS, tab-et, UI admin) janë ZONA TË MBROJTURA.
NUK GUXON me bë ASNJË ndryshim në këto zona pa lejen KONKRETE dhe DYHERE të Naserit.
- Herë e parë: Naser thotë "po bëje"
- Herë e dytë: Naser konfirmon përsëri "po, vazhdo"
Pa këto dy konfirmime — MOS PREK. Edhe nëse mendon se duhet ndryshim. Edhe nëse bug-u është aty. Pyet, mos prek.

### 3. MOS BO BUILD PA LEJE
Nuk guxon me bo build përveç nëse Naser thotë qartë "build" ose "bëje build".

### 4. MOS PREK LINKAT, CLOUD, SINKRONIZIMIN DHE TELEFONIN
Linkat e telefonit, sinkronizimi cloud, URL-të e serverave, bridge-at, secrets, dhe çdo lidhje mes projekteve janë ZONA TË MBROJTURA ABSOLUTISHT.
NUK GUXON me bë ASNJË ndryshim në:
- URL të serverave (Railway, Supabase, upstream)
- Bridge-at mes telefonit dhe serverave (marketAdminBridge, hotelAdminBridge, etj.)
- Secrets / API keys (ADMIN_SECRET, SUPER_ADMIN_SECRET, etj.)
- Endpoint-et e licencës (/api/v1/license/*, /api/license/*, etj.)
- Cloud sync (sinkronizim, heartbeat, watchdog, SSE, polling)
- Lidhjet mes projekteve
PA LEJEN KONKRETE dhe DYHERE të Naserit. Pa përjashtim.

### 5. KREJT PROJEKTET SHKOJNË PËRMES revolution-pos.com
- Çdo projekt (KAFENE, MARKET, HOTEL, FURRA, FISKALIZIME, SECURITY, KONTABILISTI) ka serverin e vet
- Por krejt linkat e telefonit shkojnë përmes revolution-pos.com (revolution-restaurant-server)
- Nuk lejohet me ndryshu këtë arkitekturë
- Nuk lejohet me kriju lidhje të reja mes serverave pa leje
- Nuk lejohet me përzier projektet (klientët e njërit nuk shkojnë te tjetri)
- Çdo projekt i ri që vjen — shkon përmes revolution-pos.com njëlloj si të tjerët

---

Revolution Fiskalizime (SEF / Biznes POS). Lexo `.cursor/rules/` dhe README për rregulla fiskale, ATK dhe build.
