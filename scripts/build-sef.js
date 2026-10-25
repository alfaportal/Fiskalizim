/**
 * Build SEF: obfuscation → dir → embed icon.ico → NSIS installer → latest.yml
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
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
/** Gjithmonë dist-atk-v2 — mos krijo dist-atk-v309 etj. */
const outDir = "dist-atk-v2";
const pkg = require("../package.json");
const version = String(pkg.version || "0.0.0").trim();
const exeName = `Revolution-POS-SEF-${version}-win-x64.exe`;
const exePath = path.join(ROOT, outDir, exeName);

function listExistingInstallers() {
  const dir = path.join(ROOT, outDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^Revolution-POS-SEF-.+-win-x64\.exe$/i.test(f))
    .sort();
}

function run(cmd, args, env = {}, options = {}) {
  const cwd = options.cwd || ROOT;
  const useShell =
    process.platform === "win32" && (cmd === "npx" || cmd === "npm" || cmd === "npm.cmd");
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: useShell,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ...env },
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

/** Pas --prepare-only: lexon rrugën e .protected-build nga marker ose fallback. */
function resolveProtectedBuildRoot() {
  const markerPath = path.join(ROOT, ".protected-build-path");
  if (fs.existsSync(markerPath)) {
    const rel = fs.readFileSync(markerPath, "utf8").trim();
    const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (fs.existsSync(path.join(full, "package.json"))) return full;
  }
  const primary = path.join(ROOT, ".protected-build");
  if (fs.existsSync(path.join(primary, "package.json"))) return primary;
  const fallbacks = fs
    .readdirSync(ROOT)
    .filter((n) => /^\.protected-build-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a));
  for (const name of fallbacks) {
    const full = path.join(ROOT, name);
    if (fs.existsSync(path.join(full, "package.json"))) return full;
  }
  console.error("[build-sef] .protected-build mungon pas obfuscate — provo përsëri.");
  process.exit(1);
}

/** Pastron vetëm artefaktet temp — KURRË .exe / .blockmap / .protected-build* */
function sha512Base64(filePath) {
  const hash = crypto.createHash("sha512");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

/** latest.yml për electron-updater (generic provider). */
function writeLatestYml(exeFilePath, ver, fileName) {
  if (!fs.existsSync(exeFilePath)) {
    console.warn("[build-sef] latest.yml — .exe mungon:", exeFilePath);
    return;
  }
  const stat = fs.statSync(exeFilePath);
  const sha512 = sha512Base64(exeFilePath);
  const releaseDate = new Date().toISOString();
  const yml = [
    `version: ${ver}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
  const ymlPath = path.join(path.dirname(exeFilePath), "latest.yml");
  fs.writeFileSync(ymlPath, yml, "utf8");
  console.log("[build-sef] latest.yml →", ymlPath);
}

function cleanupDistArtifacts(distRoot) {
  if (!distRoot || !fs.existsSync(distRoot)) return;
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

/** Kopjon .exe / .blockmap nga dist i mbrojtur te dist-atk-v2 kryesor. */
function copyInstallerArtifacts(fromDist, toDist) {
  fs.mkdirSync(toDist, { recursive: true });
  if (!fs.existsSync(fromDist)) return;
  for (const name of fs.readdirSync(fromDist)) {
    if (name.endsWith(".exe") || name.endsWith(".blockmap")) {
      const dest = path.join(toDist, name);
      fs.copyFileSync(path.join(fromDist, name), dest);
      console.log("[build-sef] →", dest);
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

cleanupDistArtifacts(path.join(ROOT, outDir));

console.log("[build-sef] 0/4 — obfuscation (protected build prep)…");
run("node", [path.join(__dirname, "obfuscate-build.mjs"), "--prepare-only"]);

const BUILD_ROOT = resolveProtectedBuildRoot();
const buildRootRel = path.relative(ROOT, BUILD_ROOT).replace(/\\/g, "/");
console.log("[build-sef] build root:", buildRootRel);

/** Staging i përkohshëm — emër unik për të shmangur bllokimin e win-unpacked të vjetër. */
const stagingOut = path.join(outDir, `.build-staging-${Date.now()}`);
const stagingRootInBuild = path.join(BUILD_ROOT, stagingOut);

console.log("[build-sef] 1/4 — packaging (dir)…");
run(
  "npx",
  [
    "electron-builder",
    "--win",
    "dir",
    `--config.directories.output=${stagingOut}`,
    "--config.win.signAndEditExecutable=false",
  ],
  {},
  { cwd: BUILD_ROOT },
);

console.log("[build-sef] 2/4 — embed icon.ico…");
run(
  "node",
  [path.join(__dirname, "embed-exe-icon.js")],
  {
    BIZNES_BUILD_OUT: path.join(buildRootRel, stagingOut).replace(/\\/g, "/"),
  },
);

console.log("[build-sef] 3/4 — NSIS installer…");
run(
  "npx",
  [
    "electron-builder",
    "--win",
    "nsis",
    `--config.directories.output=${outDir}`,
    `--prepackaged=${path.join(stagingOut, "win-unpacked")}`,
    "--config.win.signAndEditExecutable=false",
  ],
  {},
  { cwd: BUILD_ROOT },
);

const protectedDist = path.join(BUILD_ROOT, outDir);
copyInstallerArtifacts(protectedDist, path.join(ROOT, outDir));

try {
  if (fs.existsSync(stagingRootInBuild)) {
    fs.rmSync(stagingRootInBuild, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 });
  }
} catch (e) {
  console.warn("[build-sef] staging cleanup pas build:", e.message || e);
}

cleanupDistArtifacts(path.join(ROOT, outDir));
cleanupDistArtifacts(protectedDist);

if (fs.existsSync(exePath)) {
  writeLatestYml(exePath, version, exeName);
} else {
  console.warn("[build-sef] latest.yml — instaluesi nuk u gjet:", exePath);
}

const kept = listExistingInstallers();
console.log("[build-sef] DONE —", path.join(outDir, exeName));
console.log("[build-sef] të gjithë instaluesit:", kept.join(", ") || exeName);
console.log("[build-sef] .protected-build/ mbetet — pastro manualisht kur duhet.");

