/**
 * Rezolvim DNS për ATK kur router DNS / getaddrinfo dështon (ENOTFOUND / ESERVFAIL).
 * 1) dns.resolve4 me servera publikë
 * 2) DNS-over-HTTPS (Cloudflare / Google)
 * 3) IP fallback të njohura (ELB TEST/PROD) + SNI
 */
const dns = require("dns");
const https = require("https");

const PUBLIC_DNS = ["8.8.8.8", "1.1.1.1", "8.8.4.4"];
const ATK_DNS_TIMEOUT_MS = 3000;

/** IPs të njohura (AWS ELB) — përditëso nëse ATK i ndryshon */
const FALLBACK_IPS = {
  "fiskalizimi-test.atk-ks.org": ["52.28.236.65", "3.120.220.139"],
  "fiskalizimi.atk-ks.org": ["52.28.236.65", "3.120.220.139"],
  "efiskalizimi.atk-ks.org": ["52.28.236.65", "3.120.220.139"],
};

try {
  dns.setServers(PUBLIC_DNS);
} catch {
  /* */
}

function dohResolve4(hostname) {
  return new Promise((resolve) => {
    const url =
      "https://cloudflare-dns.com/dns-query?name=" +
      encodeURIComponent(hostname) +
      "&type=A";
    const req = https.request(
      url,
      {
        method: "GET",
        headers: { Accept: "application/dns-json" },
        timeout: ATK_DNS_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            const ips = (j.Answer || [])
              .filter((a) => a.type === 1 && a.data)
              .map((a) => a.data);
            resolve(ips);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

function resolve4Promise(hostname, timeoutMs = ATK_DNS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (addrs) => {
      if (done) return;
      done = true;
      resolve(addrs);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    dns.resolve4(hostname, (err, addresses) => {
      clearTimeout(timer);
      if (err || !addresses || !addresses.length) finish([]);
      else finish(addresses);
    });
  });
}

async function resolveAtkHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  let ips = await resolve4Promise(host);
  if (ips.length) return ips;
  ips = await dohResolve4(host);
  if (ips.length) return ips;
  const fb = FALLBACK_IPS[host];
  if (fb && fb.length) return fb.slice();
  return [];
}

function atkDnsLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const opts = options || {};
  resolveAtkHost(hostname)
    .then((ips) => {
      if (!ips || !ips.length) {
        dns.lookup(hostname, opts, callback);
        return;
      }
      // Node 18+ / autoSelectFamily: kur all=true duhet array {address,family}
      if (opts.all) {
        callback(
          null,
          ips.map((address) => ({ address, family: 4 })),
        );
        return;
      }
      callback(null, ips[0], 4);
    })
    .catch(() => dns.lookup(hostname, opts, callback));
}

module.exports = {
  PUBLIC_DNS,
  FALLBACK_IPS,
  resolveAtkHost,
  atkDnsLookup,
  dohResolve4,
};
