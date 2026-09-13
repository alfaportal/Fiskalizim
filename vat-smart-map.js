/**
 * Smart mapping TVSH Kosovë — emër/kategori → A/C/D/E + %.
 * Burimi: TVSH-Kosove-ATK/tvsh-kosove-databaze.json
 */
const fs = require("fs");
const path = require("path");

let _db = null;

function resolveDbPath() {
  const candidates = [
    path.join(__dirname, "tvsh-kosove-databaze.json"),
    path.join(__dirname, "..", "TVSH-Kosove-ATK", "tvsh-kosove-databaze.json"),
    path.join(__dirname, "data", "tvsh-kosove-databaze.json"),
    path.join(__dirname, "fiscal", "tvsh-kosove-databaze.json"),
    "C:\\Users\\1\\Desktop\\TVSH-Kosove-ATK\\tvsh-kosove-databaze.json",
    "C:\\Users\\1\\Desktop\\firmat\\TVSH-Kosove-ATK\\tvsh-kosove-databaze.json",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* */
    }
  }
  return null;
}

function loadDb() {
  if (_db) return _db;
  const p = resolveDbPath();
  if (!p) {
    _db = { products: [], categories: [], project_templates: {}, vat_letters: {} };
    return _db;
  }
  _db = JSON.parse(fs.readFileSync(p, "utf8"));
  return _db;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ë/g, "e")
    .replace(/ç/g, "c")
    .trim();
}

function rateFromLetter(letter) {
  const L = String(letter || "E").toUpperCase();
  if (L === "D") return 8;
  if (L === "A" || L === "B" || L === "C") return 0;
  return 18;
}

function letterFromRate(rate) {
  const n = Number(rate);
  if (n === 8) return "D";
  if (n === 0) return "A";
  return "E";
}

/**
 * @returns {{ letter: string, rate: number, label: string, source: string, confidence: string, disputed?: boolean }}
 */
function suggestVatFromName(name, opts = {}) {
  const db = loadDb();
  const n = normalize(name);
  const category = normalize(opts.category || "");

  if (!n) {
    return {
      letter: "E",
      rate: 18,
      label: "E · 18%",
      source: "default_empty",
      confidence: "low",
    };
  }

  // 1) Exact / keyword match on products
  for (const p of db.products || []) {
    const keys = [p.name, ...(p.keywords || [])].map(normalize).filter(Boolean);
    if (keys.some((k) => k && (n === k || n.includes(k) || k.includes(n)))) {
      const letter = String(p.letter || "E").toUpperCase();
      const rate = Number(p.rate != null ? p.rate : rateFromLetter(letter));
      return {
        letter,
        rate,
        label: `${letter} · ${rate}%`,
        source: `product:${p.name}`,
        confidence: "high",
        legal: p.legal || "",
        hs_hint: p.hs_hint || "",
      };
    }
  }

  // 2) Category keyword buckets (skip disputed)
  for (const c of db.categories || []) {
    if (c.id === "disputed_verify" || c.letter == null) continue;
    const keys = (c.keywords || []).map(normalize).filter(Boolean);
    if (keys.some((k) => k && n.includes(k))) {
      const letter = String(c.letter).toUpperCase();
      const rate = Number(c.rate != null ? c.rate : rateFromLetter(letter));
      return {
        letter,
        rate,
        label: `${letter} · ${rate}%`,
        source: `category:${c.id}`,
        confidence: "medium",
        legal: c.legal || "",
      };
    }
  }

  // 3) Disputed → do not auto-assign firmly
  for (const c of db.categories || []) {
    if (c.id !== "disputed_verify") continue;
    const keys = (c.keywords || []).map(normalize).filter(Boolean);
    if (keys.some((k) => k && n.includes(k))) {
      return {
        letter: "E",
        rate: 18,
        label: "E · 18% (verifiko)",
        source: "disputed",
        confidence: "low",
        disputed: true,
        legal: c.legal || "",
      };
    }
  }

  // 4) Project menu-category default
  const projectKey = String(opts.project || "").toUpperCase();
  const tmpl = (db.project_templates || {})[projectKey];
  if (tmpl && category) {
    for (const mc of tmpl.menu_categories || []) {
      if (normalize(mc.name) === category || category.includes(normalize(mc.name))) {
        const letter = String(mc.default_letter || "E").toUpperCase();
        const rate = Number(mc.default_rate != null ? mc.default_rate : rateFromLetter(letter));
        return {
          letter,
          rate,
          label: `${letter} · ${rate}%`,
          source: `project_category:${mc.name}`,
          confidence: "medium",
        };
      }
    }
  }

  return {
    letter: "E",
    rate: 18,
    label: "E · 18%",
    source: "default",
    confidence: "low",
  };
}

function getProjectTemplate(projectKey) {
  const db = loadDb();
  return (db.project_templates || {})[String(projectKey || "").toUpperCase()] || null;
}

module.exports = {
  loadDb,
  resolveDbPath,
  normalize,
  rateFromLetter,
  letterFromRate,
  suggestVatFromName,
  getProjectTemplate,
};
