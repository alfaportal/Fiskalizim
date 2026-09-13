/**
 * Vendos icon.ico në .exe pas build-it (kur signAndEditExecutable=false).
 * Vetëm ikona — asgjë tjetër.
 */
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const outDir = process.env.BIZNES_BUILD_OUT || "dist-atk-v2";
const exePath = path.join(
  ROOT,
  outDir,
  "win-unpacked",
  "Revolution Fiskalizim.exe"
);
const iconPath = path.join(ROOT, "icon.ico");
const rceditBin = path.join(
  ROOT,
  "node_modules",
  "rcedit",
  "bin",
  "rcedit-x64.exe"
);

const r = spawnSync(rceditBin, [exePath, "--set-icon", iconPath], {
  cwd: ROOT,
  stdio: "inherit",
  shell: false,
});

if (r.status !== 0) {
  console.error("[embed-exe-icon] FAIL — nuk u vendos ikona në:", exePath);
  process.exit(r.status || 1);
}
console.log("[embed-exe-icon] OK — ikona u vendos:", exePath);
