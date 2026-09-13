/**
 * Njësia (unit) dhe lloji (category/type) për artikuj fiskal — ATK PosCoupon.
 * Burimi i autoritetit: tabela products (mos lejo EA/TT default nëse produkti ekziston).
 */
const ALLOWED_UNITS = new Set([
  "EA", "CP", "LTR", "GRM", "KGB", "KGN", "TN", "MIN", "HUR", "DAY", "UDH", "KMT", "LM", "PK", "SET", "XBX", "PAL",
]);

function lookupProductMeta(productId) {
  if (productId == null || !Number.isFinite(Number(productId))) return null;
  try {
    const sqlite = require("../database").db;
    return (
      sqlite
        .prepare("SELECT id, unit_code, category_code FROM products WHERE id = ? AND active = 1")
        .get(Number(productId)) ||
      sqlite
        .prepare("SELECT id, unit_code, category_code FROM menu_items WHERE id = ?")
        .get(Number(productId))
    );
  } catch {
    return null;
  }
}

function lookupProductMetaByName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  try {
    const sqlite = require("../database").db;
    const rows = sqlite
      .prepare(
        "SELECT id, unit_code, category_code FROM products WHERE name = ? AND active = 1"
      )
      .all(n);
    return rows.length === 1 ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} item — rresht shitje / kupon
 * @param {{ authoritativeDb?: boolean }} [opts] — true (default): DB fiton mbi line item
 */
function resolveItemUnitCategory(item, opts = {}) {
  const authoritativeDb = opts.authoritativeDb !== false;
  const src = item && typeof item === "object" ? item : {};
  let unitCode = String(src.unit_code || src.unit || src.njesi || src.uom || "")
    .trim()
    .toUpperCase();
  let categoryCode = String(src.category_code || src.item_type || src.category || "")
    .trim()
    .toUpperCase();

  const productId = src.product_id ?? src.menu_item_id ?? null;
  let dbRow = productId != null ? lookupProductMeta(productId) : null;
  if (!dbRow) dbRow = lookupProductMetaByName(src.name || src.emri || src.title);

  if (dbRow) {
    const dbUnit = String(dbRow.unit_code || "EA").trim().toUpperCase() || "EA";
    const dbCat = String(dbRow.category_code || "TT").trim().toUpperCase() || "TT";
    if (authoritativeDb || !unitCode) unitCode = dbUnit;
    if (authoritativeDb || !categoryCode) categoryCode = dbCat;
  }

  if (!ALLOWED_UNITS.has(unitCode)) unitCode = "EA";

  return {
    unit_code: unitCode || "EA",
    category_code: categoryCode || "TT",
    product_id: dbRow?.id ?? productId ?? null,
  };
}

/** Forcon unit/category për çdo artikull — thirret para ruajtjes së kuponit dhe para ATK encode. */
function enrichItemsUnitCategory(items, opts = {}) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const meta = resolveItemUnitCategory(item, opts);
    return {
      ...item,
      unit_code: meta.unit_code,
      category_code: meta.category_code,
      product_id: item.product_id ?? item.menu_item_id ?? meta.product_id ?? null,
      menu_item_id: item.menu_item_id ?? item.product_id ?? meta.product_id ?? null,
    };
  });
}

/** Kontroll para dërgimit ATK — kthen artikuj ku line ≠ DB (pas enrich duhet të jetë bosh). */
function findItemMetaMismatches(items) {
  const mismatches = [];
  for (const item of Array.isArray(items) ? items : []) {
    const pid = item?.product_id ?? item?.menu_item_id ?? null;
    const dbRow = pid != null ? lookupProductMeta(pid) : lookupProductMetaByName(item?.name);
    if (!dbRow) continue;
    const dbUnit = String(dbRow.unit_code || "EA").trim().toUpperCase();
    const dbCat = String(dbRow.category_code || "TT").trim().toUpperCase();
    const lineUnit = String(item.unit_code || item.unit || "EA").trim().toUpperCase();
    const lineCat = String(item.category_code || "TT").trim().toUpperCase();
    if (lineUnit !== dbUnit || lineCat !== dbCat) {
      mismatches.push({
        name: item.name,
        product_id: dbRow.id,
        expected: { unit: dbUnit, category: dbCat },
        got: { unit: lineUnit, category: lineCat },
      });
    }
  }
  return mismatches;
}

module.exports = {
  lookupProductMeta,
  lookupProductMetaByName,
  resolveItemUnitCategory,
  enrichItemsUnitCategory,
  findItemMetaMismatches,
  ALLOWED_UNITS,
};
