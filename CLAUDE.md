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
