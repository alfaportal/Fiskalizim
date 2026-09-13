# FISKALIZIMI — I MBYLLUR (LOCKED)

**Mos prek fiskalizimin pa leje eksplicite nga pronari i projektit.**

Kjo vlen për **krejt** fiskalizimin (jo vetëm logon): `fiscal/**`, ATK, çelësa, kuponë, QR, print, offline queue, licence fiskale, endpoint-e `/api/fiscal/**`, dhe çdo integrim në `server.js` / `database.js` / `printer.js`.

## Për agentët / Cursor

Shih rregullën: `.cursor/rules/fiscal-locked.mdc` (`alwaysApply: true`).

Para çdo ndryshimi:

1. Merr leje të qartë
2. Pyet **herën e dytë** për konfirmim
3. Vetëm pastaj prek — dhe vetëm atë që u lejua

Pa konfirmim dysh → **ndalo**.
