/**
 * Kopjon BIZNES SEF në .protected-build, obfuskon JS, pastaj electron-builder.
 *   node scripts/obfuscate-build.mjs
 *   node scripts/obfuscate-build.mjs --prepare-only
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import JavaScriptObfuscator from "javascript-obfuscator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const distDir = path.join(root, "dist-atk-v2");
const prepareOnly = process.argv.includes("--prepare-only");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist-atk-v2",
  "dist-atk",
  ".protected-build",
  "tests",
  "_dev-only",
  ".cursor",
  ".git",
]);

function shouldSkipDir(name) {
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (name.startsWith("_tmp-")) return true;
  if (name.startsWith("_asar-")) return true;
  if (name.startsWith(".protected-build")) return true;
  return false;
}

const OBFUSCATE_FILES = [
  "main.js",
  "preload.js",
  "server.js",
  "printer.js",
  "electron-print-worker.js",
  "receipt-text.js",
  "vat-smart-map.js",
  "portable-path.js",
  "fiscal/fiscal-main.js",
  "fiscal/fiscal-config.js",
  "fiscal/fiscal-vat.js",
  "fiscal/fiscal-payment.js",
  "fiscal/fiscal-numbering.js",
  "fiscal/fiscal-print.js",
  "fiscal/fiscal-receipt-guard.js",
  "fiscal/fiscal-logo.js",
  "fiscal/fiscal-correction.js",
  "fiscal/fiscal-crypto.js",
  "fiscal/fiscal-qr.js",
  "fiscal/fiscal-offline.js",
  "fiscal/fiscal-audit.js",
  "fiscal/fiscal-i18n.js",
  "fiscal/fiscal-receipts-list.js",
  "fiscal/license-guard.js",
  "fiscal/fiscal-onboarding.js",
  "fiscal/fiscal-boot.js",
  "fiscal/fiscal-ui-status.js",
  "fiscal/fiscal-item-meta.js",
  "fiscal/fiscal-line-discount.js",
  "fiscal/fiscal-offline-compliance.js",
  "fiscal/atk-dns.js",
  "protection/cloud-license.js",
  "protection/cloud-health.js",
  "protection/factory-wipe.js",
  "protection/security-alert.js",
  "protection/license.js",
];

const NEVER_OBFUSCATE = new Set([
  "database.js",
  "db-crypto.js",
  "biznes-backup.js",
  "disk-monitor.js",
  "fiscal-db.js",
  "fiscal-self-test.js",
  "fiscal-hash-chain.js",
  "fiscal-atk-api.js",
  "atk-model-builder.js",
  "fiscal-time-sync.js",
  "fiscal-recovery.js",
  "fiscal-test-mode-store.js",
  "fiscal-local-env.js",
  "fiscal-paper-block.js",
]);

/** Skedarë në rrugën kritike të nisjes — obfuskim i lehtë (pa deadCode/controlFlow). */
const STARTUP_CRITICAL_FILES = new Set([
  "main.js",
  "server.js",
  "preload.js",
  "printer.js",
  "fiscal/fiscal-boot.js",
]);

const OBFUSCATE_RESERVED = {
  reservedNames: [
    "^require$",
    "^module$",
    "^exports$",
    "^__dirname$",
    "^__filename$",
    "^fiscalReceiptUpdate$",
    "^deleteTestFiscalReceipts$",
    "^initFiscalDB$",
    "^generateFiscalQR$",
    "^buildQrPayload$",
    "^printFiscalBundle$",
    "^signReceipt$",
    "^getNextTotalNumber$",
    "^getNextDailyNumber$",
    "^applyHashChainToReceipt$",
    "^attachChainToFiscalData$",
    "^getFiscalTodayParts$",
    "^getFiscalNowMs$",
    "^generateFiscalReceipt$",
    "^validateReceiptBeforePrint$",
    "^assertGeneratedReceiptText$",
    "^RECEIPT_FORMAT_HASH$",
    "^logFiscalAction$",
    "^runFiscalSelfTest$",
    "^runFiscalSelfTestBattery$",
  ],
  reservedStrings: [
    "fiscalReceiptUpdate",
    "deleteTestFiscalReceipts",
    "initFiscalDB",
    "getFiscalDbPath",
    "RECEIPT_UPDATE_ALLOWED",
    "generateFiscalQR",
    "buildQrPayload",
    "printFiscalBundle",
    "signReceipt",
    "generateNUIKF",
    "generateFiscalReceipt",
    "validateReceiptBeforePrint",
    "assertGeneratedReceiptText",
    "RECEIPT_FORMAT_HASH",
    "logFiscalAction",
    "runFiscalSelfTest",
    "runFiscalSelfTestBattery",
    "RevolutionInvest",
    "BiznesLicense",
    "KafeneLicense",
    "FiskalizimLicense",
    "sent_to_atk",
    "sent_at",
    "atk_response_json",
    "WRITE-ONCE",
  ],
};

const OBFUSCATE_OPTIONS_HEAVY = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.85,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.25,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  debugProtection: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ["base64", "rc4"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.9,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  target: "node",
  seed: 0x53454630, // SEF0
  ...OBFUSCATE_RESERVED,
};

/** Nisje e shpejtë — pa controlFlowFlattening/deadCodeInjection (server.js 400KB+ parse). */
const OBFUSCATE_OPTIONS_STARTUP = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.6,
  unicodeEscapeSequence: false,
  target: "node",
  seed: 0x53454631, // SEF1
  ...OBFUSCATE_RESERVED,
};

function obfuscateOptionsFor(rel) {
  return STARTUP_CRITICAL_FILES.has(rel) ? OBFUSCATE_OPTIONS_STARTUP : OBFUSCATE_OPTIONS_HEAVY;
}

function isTestJs(name) {
  return (
    name.startsWith("test-") ||
    name.endsWith(".test.js") ||
    name.includes("-e2e.js") ||
    name === "fiscal-test-coupon-data.js"
  );
}

/** Krejt JS në fiscal/, protection/ dhe root — përveç NEVER_OBFUSCATE dhe testeve. */
function collectObfuscateTargets() {
  const rels = new Set(OBFUSCATE_FILES);

  function walkDir(absDir, relPrefix) {
    if (!fs.existsSync(absDir)) return;
    for (const name of fs.readdirSync(absDir)) {
      if (shouldSkipDir(name)) continue;
      const abs = path.join(absDir, name);
      const rel = path.join(relPrefix, name).replace(/\\/g, "/");
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walkDir(abs, rel);
        continue;
      }
      if (!name.endsWith(".js") || isTestJs(name)) continue;
      if (NEVER_OBFUSCATE.has(name)) continue;
      rels.add(rel);
    }
  }

  for (const dir of ["fiscal", "protection"]) {
    walkDir(path.join(root, dir), dir);
  }

  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".js") || isTestJs(name)) continue;
    if (NEVER_OBFUSCATE.has(name)) continue;
    rels.add(name);
  }

  return [...rels].sort();
}

function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn("[obfuscate-build] Nuk u fshi:", dir, "—", e.message || e);
  }
}

/** Pastron vetëm temp — KURRË .exe / .blockmap / .protected-build* */
function cleanupTempArtifacts(distRoot) {
  if (!distRoot || !fs.existsSync(distRoot)) return;
  for (const name of fs.readdirSync(distRoot)) {
    const full = path.join(distRoot, name);
    if (name === "win-unpacked" || name.startsWith(".build-staging")) {
      rimraf(full);
      console.log("[obfuscate-build] pastruar temp:", full);
      continue;
    }
    if (name === "builder-debug.yml") {
      try {
        fs.unlinkSync(full);
        console.log("[obfuscate-build] pastruar temp:", full);
      } catch (e) {
        console.warn("[obfuscate-build] cleanup:", e.message || e);
      }
    }
  }
}

function resolveOutDir() {
  const primary = path.join(root, ".protected-build");
  if (!fs.existsSync(primary)) return primary;
  try {
    fs.rmSync(primary, { recursive: true, force: true });
    return primary;
  } catch (e) {
    const stale = fs
      .readdirSync(root)
      .filter((n) => /^\.protected-build-\d+$/.test(n))
      .sort((a, b) => b.localeCompare(a));
    for (const name of stale) {
      const candidate = path.join(root, name);
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
        console.warn("[obfuscate-build] u pastrua staging i vjetër:", name);
        return primary;
      } catch {
        console.warn("[obfuscate-build] staging i kyçur, anashkalo:", name);
      }
    }
    const fallback = path.join(root, `.protected-build-${Date.now()}`);
    console.warn(
      "[obfuscate-build] .protected-build i bllokuar — folder i ri:",
      path.basename(fallback)
    );
    return fallback;
  }
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (shouldSkipDir(name)) continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  const outDir = resolveOutDir();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = pkg.version || "3.0.0";
  console.log("\n🔒 Përgatit build të mbrojtur — Revolution Fiskalizim", version);

  copyRecursive(root, outDir);

  const obfuscateTargets = collectObfuscateTargets();
  console.log(`Obfuskim i skedarëve JS (${obfuscateTargets.length} skedarë)...`);
  for (const rel of obfuscateTargets) {
    const base = path.basename(rel);
    if (NEVER_OBFUSCATE.has(base)) {
      console.log("  · skip (never)", rel);
      continue;
    }
    const target = path.join(outDir, rel);
    if (!fs.existsSync(target)) {
      console.log("  · skip (missing)", rel);
      continue;
    }
    const code = fs.readFileSync(target, "utf8");
    const opts = obfuscateOptionsFor(rel);
    const result = JavaScriptObfuscator.obfuscate(code, opts);
    fs.writeFileSync(target, result.getObfuscatedCode(), "utf8");
    console.log("  ✓", rel, STARTUP_CRITICAL_FILES.has(rel) ? "(startup-light)" : "");
  }

  console.log("\nInstalim node_modules në build...");
  execSync("npm install --omit=dev", { cwd: outDir, stdio: "inherit" });
  execSync("npm install --no-save electron electron-builder", {
    cwd: outDir,
    stdio: "inherit",
  });

  if (prepareOnly) {
    console.log("Prepare-only done:", outDir);
    return;
  }

  const buildOut = "dist-atk-v2";
  const builtDist = path.join(outDir, buildOut);
  fs.mkdirSync(distDir, { recursive: true });
  rimraf(builtDist);

  console.log("\n📦 1/3 — electron-builder (dir)...");
  execSync(
    `npx electron-builder --win dir --config.directories.output=${buildOut} --config.win.signAndEditExecutable=false`,
    {
      cwd: outDir,
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    },
  );

  console.log("\n🖼  2/3 — embed icon.ico (logo e firmës)...");
  const buildOutAbs = path.join(outDir, buildOut);
  execSync(`node "${path.join(root, "scripts", "embed-exe-icon.js")}"`, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      BIZNES_BUILD_OUT: path.relative(root, buildOutAbs),
    },
  });

  console.log("\n📦 3/3 — electron-builder (NSIS)...");
  execSync(
    `npx electron-builder --win nsis --config.directories.output=${buildOut} --prepackaged=${path.join(buildOutAbs, "win-unpacked")} --config.win.signAndEditExecutable=false`,
    {
      cwd: outDir,
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    },
  );

  if (fs.existsSync(builtDist)) {
    for (const name of fs.readdirSync(builtDist)) {
      const src = path.join(builtDist, name);
      const dest = path.join(distDir, name);
      if (name.endsWith(".exe") || name.endsWith(".blockmap")) {
        fs.copyFileSync(src, dest);
        console.log("  →", dest);
      }
    }
    cleanupTempArtifacts(builtDist);
  }

  cleanupTempArtifacts(distDir);

  const exeName = `Revolution-Fiskalizim-Setup-${version}-win-x64.exe`;
  const exePath = path.join(distDir, exeName);
  console.log("\n✅ Instaluesi i mbrojtur:", exePath);
  console.log("   .protected-build/ mbetet — Naseri pastron manualisht kur duhet.");
  console.log("Done.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
