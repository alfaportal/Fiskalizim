/**
 * Build SEF: dir → embed icon.ico → NSIS installer.
 *
 * BUILD PROTOCOL (Naseri):
 * 1. Versioni në package.json sipas udhëzimit të pronarit
 * 2. Instaluesit e vjetër .exe — KURRË mos i fshi automatikisht (vetëm Naseri)
 * 3. Pas build-it → cleanupDistArtifacts() (win-unpacked, .build-staging*, builder-debug.yml)
 * 4. .protected-build* — KURRË mos i fshi automatikisht
 * 5. Build VETËM me leje të qartë nga pronari
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
/** Gjithmonë dist-atk-v2 — mos krijo dist-atk-v309 etj. */
const outDir = "dist-atk-v2";
const pkg = require("../package.json");
const version = String(pkg.version || "0.0.0").trim();
const exeName = `Revolution-Fiskalizim-Setup-${version}-win-x64.exe`;
const exePath = path.join(ROOT, outDir, exeName);

function listExistingInstallers() {
  const dir = path.join(ROOT, outDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^Revolution-Fiskalizim-Setup-.+-win-x64\.exe$/i.test(f))
    .sort();
}

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ...env },
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

/** Pastron vetëm artefaktet temp — KURRË .exe / .blockmap / .protected-build* */
function cleanupDistArtifacts() {
  const distRoot = path.join(ROOT, outDir);
  if (!fs.existsSync(distRoot)) return;
  for (const name of fs.readdirSync(distRoot)) {
    const full = path.join(distRoot, name);
    if (name === "win-unpacked" || name.startsWith(".build-staging")) {
      try {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
        console.log("[build-sef] pastruar:", name);
      } catch (e) {
        console.warn("[build-sef] cleanup:", name, e.message || e);
      }
      continue;
    }
    if (name === "builder-debug.yml") {
      try {
        fs.unlinkSync(full);
        console.log("[build-sef] pastruar:", name);
      } catch (e) {
        console.warn("[build-sef] cleanup:", name, e.message || e);
      }
    }
  }
}

const existing = listExistingInstallers();
if (existing.includes(exeName)) {
  console.error("");
  console.error("[build-sef] NDALIM — instaluesi ekziston tashmë:");
  console.error("  ", exePath);
  console.error("[build-sef] Rrit versionin në package.json (patch +1), p.sh.:");
  console.error("       2.0.0 → 2.0.1");
  console.error("[build-sef] Instaluesit e vjetër mbeten — mos i fshi.");
  if (existing.length) {
    console.error("[build-sef] Në folder:", existing.join(", "));
  }
  console.error("");
  process.exit(1);
}

console.log(`[build-sef] version=${version} → ${exeName}`);
if (existing.length) {
  console.log("[build-sef] instalues të ruajtur:", existing.join(", "));
}

cleanupDistArtifacts();

/** Staging i përkohshëm — emër unik për të shmangur bllokimin e win-unpacked të vjetër. */
const stagingOut = path.join(outDir, `.build-staging-${Date.now()}`);
const stagingRoot = path.join(ROOT, stagingOut);

console.log("[build-sef] 1/3 — packaging (dir)…");
run("npx", [
  "electron-builder",
  "--win",
  "dir",
  `--config.directories.output=${stagingOut}`,
  "--config.win.signAndEditExecutable=false",
]);

console.log("[build-sef] 2/3 — embed icon.ico…");
run("node", [path.join(__dirname, "embed-exe-icon.js")], {
  BIZNES_BUILD_OUT: stagingOut,
});

console.log("[build-sef] 3/3 — NSIS installer…");
run("npx", [
  "electron-builder",
  "--win",
  "nsis",
  `--config.directories.output=${outDir}`,
  `--prepackaged=${path.join(stagingOut, "win-unpacked")}`,
  "--config.win.signAndEditExecutable=false",
]);

try {
  if (fs.existsSync(stagingRoot)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
  }
} catch (e) {
  console.warn("[build-sef] staging cleanup pas build:", e.message || e);
}

cleanupDistArtifacts();

const kept = listExistingInstallers();
console.log("[build-sef] DONE —", path.join(outDir, exeName));
console.log("[build-sef] të gjithë instaluesit:", kept.join(", ") || exeName);
