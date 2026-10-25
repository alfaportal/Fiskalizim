"use strict";

const { execSync } = require("node:child_process");

const onRailway = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID,
);

if (onRailway) {
  execSync("cd server && npm install", { stdio: "inherit" });
} else {
  execSync("electron-builder --win nsis", { stdio: "inherit" });
}
