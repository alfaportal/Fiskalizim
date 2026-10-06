"use strict";

const MESSAGE =
  "Duhet licencë aktive për me rikthy të dhënat. Aktivizoni licencën fillimisht.";

async function isLicenseActiveForDataRestore(app) {
  try {
    if (app && typeof app.isPackaged === "boolean" && !app.isPackaged) {
      return true;
    }
    const cloud = require("./protection/cloud-license");
    const { isProdLicenseSatisfied } = require("./protection/license-boot");
    return !!(await isProdLicenseSatisfied(cloud, app));
  } catch (e) {
    console.warn("[backup] license gate:", e.message || e);
    return false;
  }
}

module.exports = { MESSAGE, isLicenseActiveForDataRestore };
