/**
 * fiscal/fiscal-ui-bridge.js — shërben klientin UI dhe injekton script në index.html.
 * Regjistrohet automatikisht nga fiscal-boot.js (pa prekur server.js / public/).
 */
const fs = require("fs");
const path = require("path");

let registered = false;

function resolvePublicDir() {
  try {
    const serverDir = path.dirname(require.resolve("../server.js"));
    return path.join(serverDir, "public");
  } catch {
    return path.join(process.cwd(), "public");
  }
}

function createIndexOverrideMiddleware(publicDir) {
  const indexPath = path.join(publicDir, "index.html");
  const marker = "/fiscal-ui/client.js";

  return function fiscalUiIndexOverride(req, res, next) {
    if (req.method !== "GET") return next();
    const p = req.path === "/index.html" ? "/index.html" : req.path === "/" ? "/" : null;
    if (!p) return next();
    if (!fs.existsSync(indexPath)) return next();

    try {
      let html = fs.readFileSync(indexPath, "utf8");
      if (!html.includes(marker)) {
        html = html.replace(/<\/body>/i, `<script src="${marker}" defer></script>\n</body>`);
      }
      res.type("html").send(html);
    } catch {
      next();
    }
  };
}

function insertMiddlewareBeforeStatic(app, handler) {
  const Layer = require("express/lib/router/layer");
  const stack = app && app._router && app._router.stack;
  if (!Array.isArray(stack)) {
    app.use(handler);
    return;
  }
  let insertAt = stack.length;
  for (let i = 0; i < stack.length; i++) {
    const name = stack[i] && stack[i].name;
    if (name === "serveStatic" || name === "static") {
      insertAt = i;
      break;
    }
  }
  const layer = new Layer("/", {}, handler);
  layer.name = "fiscalUiIndexOverride";
  stack.splice(insertAt, 0, layer);
}

function registerFiscalUi(app) {
  if (registered || !app) return;
  registered = true;

  const publicDir = resolvePublicDir();
  insertMiddlewareBeforeStatic(app, createIndexOverrideMiddleware(publicDir));

  app.get("/fiscal-ui/client.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(__dirname, "fiscal-ui-client.js"));
  });
}

function patchExpressListenForFiscalUi() {
  if (patchExpressListenForFiscalUi._done) return;
  patchExpressListenForFiscalUi._done = true;

  try {
    const express = require("express");
    const Application = express.application;
    const origListen = Application.listen;
    Application.listen = function fiscalUiListen(...args) {
      try {
        registerFiscalUi(this);
      } catch (e) {
        console.warn("[fiscal-ui] register:", e.message || e);
      }
      return origListen.apply(this, args);
    };
  } catch (e) {
    console.warn("[fiscal-ui] listen patch:", e.message || e);
  }
}

module.exports = {
  registerFiscalUi,
  patchExpressListenForFiscalUi,
};
