/**
 * fiscal/fiscal-atk-discount-e2e.js
 * Test E2E: CouponItem.discount (field 8) te ATK TEST.
 * Burimi i artikujve: shporta aktuale (POST) ose shembull statik (fallback).
 */
const { isFiscalEnabled, getFiscalSettings } = require("./fiscal-config");
const { buildPosCoupon, encodePosCoupon, toCents } = require("./atk-model-builder");
const {
  netLineAmount,
  resolveLineDiscountAmount,
  resolveLineSurchargeAmount,
} = require("./fiscal-line-discount");
const { round4, calculateVatTaxBreakdown } = require("./fiscal-vat");
const { generateNUIKF, getSefIdentifier, getNextDailyNumber, getNextTotalNumber } = require("./fiscal-numbering");
const { getFiscalTodayParts } = require("./fiscal-time-sync");
const { insertFiscalReceipt, getFiscalReceiptById } = require("./fiscal-db");
const { getOriginalReceipt } = require("./fiscal-correction");
const { signReceipt } = require("./fiscal-crypto");
const { generateFiscalQR } = require("./fiscal-qr");
const { sendReceiptToAtk, markReceiptSent } = require("./fiscal-offline");
const { getAtkStatus } = require("./fiscal-atk-api");
const { isAtkTransmissionBlocked } = require("./fiscal-test-mode-store");
const { logFiscalAction } = require("./fiscal-audit");

const E2E_MARKER = "__atk_discount_e2e__";

function truthyFlag(v) {
  return v === true || v === 1 || v === "1" || v === "on" || v === "yes";
}

/** Shembull statik (110.90 €) — vetëm kur shporta bosh ose use_sample=true. */
function getDiscountE2eSampleItems() {
  return [
    {
      name: "Export mallrash (elektronikë)",
      quantity: 1,
      qty: 1,
      price: 40,
      unit_price: 40,
      base_price: 50,
      line_discount_amount: 10,
      line_surcharge_amount: 0,
      vat_norm: "A",
      vat_letter: "A",
      line_discount: { type: "percent", value: 20 },
      [E2E_MARKER]: true,
    },
    {
      name: "Fizioterapi",
      quantity: 1,
      qty: 1,
      price: 27.5,
      unit_price: 27.5,
      base_price: 25,
      line_discount_amount: 0,
      line_surcharge_amount: 2.5,
      vat_norm: "C",
      vat_letter: "C",
      line_surcharge: { type: "percent", value: 10 },
      [E2E_MARKER]: true,
    },
    {
      name: "Bukë integrale",
      quantity: 1,
      qty: 1,
      price: 0.9,
      unit_price: 0.9,
      base_price: 0.9,
      vat_norm: "D",
      vat_letter: "D",
      [E2E_MARKER]: true,
    },
    {
      name: "Oriz 1kg",
      quantity: 1,
      qty: 1,
      price: 1.5,
      unit_price: 1.5,
      base_price: 1.5,
      vat_norm: "D",
      vat_letter: "D",
      [E2E_MARKER]: true,
    },
    {
      name: "Makarona 500g",
      quantity: 1,
      qty: 1,
      price: 1,
      unit_price: 1,
      base_price: 1,
      vat_norm: "D",
      vat_letter: "D",
      [E2E_MARKER]: true,
    },
    {
      name: "Cigare (pako)",
      quantity: 1,
      qty: 1,
      price: 3,
      unit_price: 3,
      base_price: 3,
      vat_norm: "E",
      vat_letter: "E",
      [E2E_MARKER]: true,
    },
    {
      name: "Parfum",
      quantity: 1,
      qty: 1,
      price: 27,
      unit_price: 27,
      base_price: 25,
      line_discount_amount: 0,
      line_surcharge_amount: 2,
      vat_norm: "E",
      vat_letter: "E",
      line_surcharge: { type: "value", value: 2 },
      [E2E_MARKER]: true,
    },
    {
      name: "Veshje — bluzë",
      quantity: 1,
      qty: 1,
      price: 10,
      unit_price: 10,
      base_price: 12,
      line_discount_amount: 2,
      line_surcharge_amount: 0,
      vat_norm: "E",
      vat_letter: "E",
      line_discount: { type: "value", value: 2 },
      [E2E_MARKER]: true,
    },
  ];
}

/** Alias për kompatibilitet. */
function getDiscountE2eItems() {
  return getDiscountE2eSampleItems();
}

function samplePaymentSplits(totalAmount) {
  const t = round4(totalAmount);
  if (t <= 30) {
    return [{ method: "cash", amount: t }];
  }
  return [
    { method: "cash", amount: round4(t - 30) },
    { method: "card", amount: 20 },
    { method: "voucher", amount: 10 },
  ];
}

function computeTotalsFromItems(items, cartDiscount = 0, cartSurcharge = 0) {
  const list = Array.isArray(items) ? items : [];
  const netLines = round4(list.reduce((s, it) => s + netLineAmount(it), 0));
  const lineDiscSum = round4(list.reduce((s, it) => s + resolveLineDiscountAmount(it), 0));
  const lineSurSum = round4(list.reduce((s, it) => s + resolveLineSurchargeAmount(it), 0));
  const totalAmount = round4(netLines - cartDiscount + cartSurcharge);
  const vatResult = calculateVatTaxBreakdown(list, { totalAmount });
  return {
    netLines,
    lineDiscSum,
    lineSurSum,
    cartDiscount: round4(cartDiscount),
    cartSurcharge: round4(cartSurcharge),
    totalAmount,
    totalWithoutTax: round4(vatResult?.totalWithoutTax ?? totalAmount),
    tax: vatResult?.tax || { A: 0, B: 0, C: 0, D: 0, E: 0 },
  };
}

/** @deprecated — përdor computeTotalsFromItems */
function computeDiscountE2eTotals(items, cartDiscount = 0) {
  return computeTotalsFromItems(items, cartDiscount, 0);
}

function parseItemsJson(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parsePaymentSplitsJson(raw) {
  if (Array.isArray(raw)) return raw.filter((p) => Number(p?.amount) > 0);
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.filter((p) => Number(p?.amount) > 0) : null;
  } catch {
    return null;
  }
}

/**
 * Burimi: kupon fiskal ekzistues (NUIKF ose ID).
 */
function resolveE2eInputFromReceipt(opts = {}) {
  const nuikf = String(opts.nuikf || "")
    .trim()
    .toUpperCase();
  const receiptId =
    opts.receipt_id != null && opts.receipt_id !== "" ? Number(opts.receipt_id) : null;

  let row = null;
  if (receiptId) {
    row = getFiscalReceiptById(receiptId);
  } else if (nuikf) {
    const rec = getOriginalReceipt(nuikf);
    if (rec) row = getFiscalReceiptById(rec.id);
  }

  if (!row) {
    throw new Error(
      receiptId
        ? `Kuponi #${receiptId} nuk u gjet`
        : `Kuponi NUIKF ${nuikf || "—"} nuk u gjet (vetëm regular)`
    );
  }

  if (String(row.receipt_type || "").toLowerCase() !== "regular") {
    throw new Error("Vetëm kuponët regular (i rregullt) mbështeten për test field 8");
  }

  const items = parseItemsJson(row.items_json).map((it) => ({ ...it, [E2E_MARKER]: true }));
  if (!items.length) {
    throw new Error(`Kuponi ${row.nuikf} nuk ka artikuj`);
  }

  const cartDiscount = Number(row.discount_amount) || 0;
  const lineNetSum = round4(items.reduce((s, it) => s + netLineAmount(it), 0));
  const storedTotal = round4(Number(row.total_amount) || 0);
  const cartSurcharge = round4(Math.max(0, storedTotal - lineNetSum + cartDiscount));
  const totals = computeTotalsFromItems(items, cartDiscount, cartSurcharge);
  totals.totalAmount = storedTotal;
  totals.totalWithoutTax = round4(Number(row.total_without_tax) || totals.totalWithoutTax);
  try {
    totals.tax = JSON.parse(row.vat_breakdown_json || "{}");
  } catch {
    /* mbet totals.tax */
  }

  const paymentMethod = String(row.payment_method || "cash").trim() || "cash";
  let paymentSplits = parsePaymentSplitsJson(row.payment_splits_json);
  if (!paymentSplits?.length && paymentMethod === "mixed") {
    paymentSplits = samplePaymentSplits(storedTotal);
  }

  return {
    source: "receipt",
    receipt_id: row.id,
    receipt_nuikf: row.nuikf,
    receipt_row: row,
    sent_to_atk: Number(row.sent_to_atk) === 1,
    items,
    totals,
    paymentMethod,
    paymentSplits,
    cart_discount_meta: cartDiscount > 0 ? { type: "value", value: cartDiscount } : null,
    cart_surcharge_meta: cartSurcharge > 0 ? { type: "value", value: cartSurcharge } : null,
  };
}

/**
 * Zgjedh burimin: kupon ekzistues, shporta (items nga frontend) ose shembull statik.
 * @param {object} opts
 */
function resolveE2eInput(opts = {}) {
  const nuikf = String(opts.nuikf || "").trim();
  const receiptId =
    opts.receipt_id != null && opts.receipt_id !== "" ? Number(opts.receipt_id) : null;
  if (nuikf || receiptId) {
    return resolveE2eInputFromReceipt(opts);
  }

  const useSample = truthyFlag(opts.use_sample);
  const rawItems = Array.isArray(opts.items) ? opts.items : [];

  if (!useSample && rawItems.length > 0) {
    const database = require("../database");
    const preview = database.previewSaleTotals({
      items: rawItems,
      cart_discount: opts.cart_discount || null,
      cart_surcharge: opts.cart_surcharge || null,
    });
    const items = preview.items.map((it) => ({ ...it, [E2E_MARKER]: true }));
    const totals = computeTotalsFromItems(
      items,
      preview.discount_total,
      preview.surcharge_total
    );
    const paymentMethod = String(opts.payment_method || "cash").trim() || "cash";
    let paymentSplits = Array.isArray(opts.payment_splits)
      ? opts.payment_splits.filter((p) => Number(p?.amount) > 0)
      : null;
    if (!paymentSplits?.length && paymentMethod === "mixed") {
      paymentSplits = samplePaymentSplits(totals.totalAmount);
    }
    return {
      source: "cart",
      items,
      totals,
      paymentMethod,
      paymentSplits,
      cart_discount_meta: opts.cart_discount || null,
      cart_surcharge_meta: opts.cart_surcharge || null,
    };
  }

  if (truthyFlag(opts.require_cart)) {
    throw new Error(
      "Shporta është bosh — shtoni artikuj në Arka ose zgjidhni «Shembull statik»"
    );
  }

  const items = getDiscountE2eSampleItems();
  const totals = computeTotalsFromItems(items, 0, 0);
  return {
    source: "sample",
    items,
    totals,
    paymentMethod: "mixed",
    paymentSplits: samplePaymentSplits(totals.totalAmount),
    cart_discount_meta: null,
    cart_surcharge_meta: null,
  };
}

function buildPreviewPayload(settings, input) {
  const resolved = input || resolveE2eInput({ use_sample: true });
  const { items, totals, paymentMethod, paymentSplits, source } = resolved;
  const { fiscal_date, fiscal_time } = getFiscalTodayParts();

  const receiptRow =
    resolved.receipt_row && source === "receipt"
      ? {
          ...resolved.receipt_row,
          items_json: JSON.stringify(items),
          total_amount: totals.totalAmount,
          total_without_tax: totals.totalWithoutTax,
          discount_amount: totals.cartDiscount,
          payment_method: paymentMethod,
          payment_splits_json: paymentSplits?.length ? JSON.stringify(paymentSplits) : null,
          vat_breakdown_json: JSON.stringify(totals.tax),
        }
      : {
          items_json: JSON.stringify(items),
          total_amount: totals.totalAmount,
          total_without_tax: totals.totalWithoutTax,
          discount_amount: totals.cartDiscount,
          payment_method: paymentMethod,
          payment_splits_json: paymentSplits?.length ? JSON.stringify(paymentSplits) : null,
          receipt_type: "regular",
          fiscal_date,
          fiscal_time,
          nuikf: "E2EDISC00000001",
          sef_id: getSefIdentifier() || "",
          taxpayer_nui: settings.taxpayer_nui || "",
          taxpayer_address: settings.taxpayer_address || "",
          operator_id: "E2E-DISC",
          daily_number: 4,
          total_number: 4,
          vat_breakdown_json: JSON.stringify(totals.tax),
        };

  const pos = buildPosCoupon(receiptRow, {
    settings,
    payment_splits: paymentSplits || undefined,
  });
  const protoItems = (pos.items || []).map((it, idx) => ({
    row: idx + 1,
    name: it.name,
    discount_field8_cents: Number(it.discount) || 0,
    discount_field8_eur: round4((Number(it.discount) || 0) / 100),
    price_units: Number(it.price),
    total_cents: Number(it.total),
    total_eur: round4((Number(it.total) || 0) / 100),
  }));

  let protoBytes = 0;
  try {
    const buf = encodePosCoupon(receiptRow, {
      settings,
      payment_splits: paymentSplits || undefined,
    });
    protoBytes = buf?.length || 0;
  } catch (e) {
    return { ok: false, error: "encodePosCoupon: " + e.message, source };
  }

  const itemsSumCents = protoItems.reduce((s, it) => s + (Number(it.total_cents) || 0), 0);
  const targetTotalCents = toCents(totals.totalAmount);
  const itemsSumOk = itemsSumCents === targetTotalCents;
  const totalOk = Number(pos.total) === targetTotalCents;
  const expectedTotalDiscountCents = toCents(totals.lineDiscSum + totals.cartDiscount);
  const totalDiscountOk = Number(pos.totalDiscount) === expectedTotalDiscountCents;
  const field8Ok = itemsSumOk && totalOk && totalDiscountOk;

  return {
    ok: field8Ok,
    field8_ok: field8Ok,
    items_sum_ok: itemsSumOk,
    total_ok: totalOk,
    total_discount_ok: totalDiscountOk,
    source,
    receipt_nuikf: resolved.receipt_nuikf || null,
    receipt_id: resolved.receipt_id || null,
    item_count: items.length,
    proto_bytes: protoBytes,
    items_sum_cents: itemsSumCents,
    items_sum_eur: round4(itemsSumCents / 100),
    pos_total_cents: Number(pos.total) || 0,
    total_discount_cents: Number(pos.totalDiscount) || 0,
    total_discount_eur: round4((Number(pos.totalDiscount) || 0) / 100),
    line_discounts_eur: totals.lineDiscSum,
    line_surcharges_eur: totals.lineSurSum,
    cart_discount_eur: totals.cartDiscount,
    cart_surcharge_eur: totals.cartSurcharge,
    total_amount: totals.totalAmount,
    total_without_tax: totals.totalWithoutTax,
    payment_method: paymentMethod,
    items: protoItems,
    legal_note: "CouponItem.discount = field 8 (cent); price/total = neto pas zbritjes së rreshtit",
  };
}

function assertCanSendToAtk(settings) {
  const atk = getAtkStatus();
  if (isAtkTransmissionBlocked()) {
    return {
      allowed: false,
      reason: "ATK HTTP i bllokuar (FISCAL_LOCAL_RUN / modalitet lokal). Provo vetëm preview lokal.",
      atk,
    };
  }
  if (!atk.ready_for_atk) {
    return {
      allowed: false,
      reason: "Certifikata / Application ID nuk janë gati për ATK.",
      atk,
    };
  }
  const url = String(settings.atk_api_url || atk.atk_base_url || "");
  const isTest = /fiskalizimi-test/i.test(url);
  if (!isTest) {
    return {
      allowed: false,
      reason: "E2E discount lejohet vetëm te mjedisi TEST (fiskalizimi-test.atk-ks.org).",
      atk,
      url,
    };
  }
  return { allowed: true, atk, url, environment: "TEST" };
}

/**
 * @param {object} opts — items, cart_discount, cart_surcharge, payment_method, payment_splits, use_sample, dry_run, send_to_atk, confirmed
 */
async function runAtkDiscountE2eTest(opts = {}) {
  if (!isFiscalEnabled()) {
    throw new Error("Fiskalizimi nuk është aktiv");
  }

  const settings = getFiscalSettings();
  const input = resolveE2eInput(opts);
  const preview = buildPreviewPayload(settings, input);
  if (!preview.ok) {
    return {
      ok: false,
      phase: "preview",
      preview,
      source: input.source,
      error:
        preview.error ||
        `Protobuf nuk përputhet: artikuj=${preview.items_sum_eur}€ vs total=${preview.total_amount}€`,
    };
  }

  const dryRun = opts.dry_run !== false && !opts.send_to_atk;
  if (dryRun) {
    const sendCheck = assertCanSendToAtk(settings);
    const srcLabel =
      input.source === "receipt"
        ? `kuponi ${input.receipt_nuikf || preview.receipt_nuikf || "—"}`
        : input.source === "cart"
          ? "shporta aktuale"
          : "shembull statik";
    const alreadySent =
      input.source === "receipt" && input.sent_to_atk
        ? " (kuponi është dërguar tashmë te ATK)"
        : "";
    return {
      ok: true,
      dry_run: true,
      source: input.source,
      receipt_nuikf: input.receipt_nuikf || preview.receipt_nuikf || null,
      receipt_id: input.receipt_id || preview.receipt_id || null,
      preview,
      send_ready: sendCheck.allowed && !(input.source === "receipt" && input.sent_to_atk),
      send_block_reason:
        input.source === "receipt" && input.sent_to_atk
          ? "Kuponi është dërguar tashmë te ATK"
          : sendCheck.allowed
            ? null
            : sendCheck.reason,
      message:
        `Preview OK (${srcLabel}) — ${preview.item_count} artikuj, total ${preview.total_amount}€, zbritje ${preview.total_discount_eur}€ (field 8). Pa INSERT/HTTP.${alreadySent}`,
    };
  }

  if (!opts.send_to_atk) {
    throw new Error("Për dërgim te ATK: send_to_atk=true dhe confirmed=true");
  }
  if (!opts.confirmed) {
    throw new Error("Kërkohet confirmed=true — dërgimi te ATK TEST është me qëllim");
  }

  const sendCheck = assertCanSendToAtk(settings);
  if (!sendCheck.allowed) {
    return {
      ok: false,
      phase: "send_blocked",
      preview,
      source: input.source,
      error: sendCheck.reason,
      atk: sendCheck.atk,
    };
  }

  if (input.source === "receipt") {
    const row = getFiscalReceiptById(input.receipt_id);
    if (!row) {
      return {
        ok: false,
        phase: "receipt_missing",
        preview,
        source: input.source,
        error: "Kuponi nuk u gjet në databazë",
      };
    }
    if (Number(row.sent_to_atk) === 1) {
      return {
        ok: false,
        phase: "already_sent",
        preview,
        source: input.source,
        receipt_nuikf: row.nuikf,
        error: `Kuponi ${row.nuikf} është dërguar tashmë te ATK`,
      };
    }

    const operatorName = String(opts.operator_name || "Operator").trim() || "Operator";
    const atkResult = await sendReceiptToAtk(row);
    let atkSent = false;
    if (atkResult?.sent) {
      markReceiptSent(row.id, atkResult);
      atkSent = true;
    }

    try {
      logFiscalAction(
        "receipt_sent",
        {
          e2e: "atk_discount_field8",
          source: "receipt",
          resend_existing: true,
          fiscal_receipt_id: row.id,
          nuikf: row.nuikf,
          field8_preview: preview.items,
          total_discount_eur: preview.total_discount_eur,
          total_amount: Number(row.total_amount) || preview.total_amount,
          atk_sent: atkSent,
          atk_error: atkSent ? null : atkResult?.error || null,
          transaction_id: atkResult?.transaction_id || null,
        },
        operatorName,
        "E2E-DISC"
      );
    } catch (e) {
      console.warn("[fiscal-atk-discount-e2e] audit:", e.message);
    }

    return {
      ok: atkSent,
      dry_run: false,
      source: input.source,
      receipt_nuikf: row.nuikf,
      receipt_id: row.id,
      preview,
      fiscal_receipt_id: row.id,
      nuikf: row.nuikf,
      total_amount: Number(row.total_amount) || preview.total_amount,
      total_discount_eur: preview.total_discount_eur,
      line_discounts_eur: input.totals.lineDiscSum,
      cart_discount_eur: input.totals.cartDiscount,
      atk_sent: atkSent,
      atk_result: {
        sent: atkSent,
        error: atkResult?.error || null,
        status: atkResult?.status || null,
        transaction_id: atkResult?.transaction_id || null,
        url: atkResult?.url || sendCheck.url,
      },
      verify_hint:
        "Kontrolloni në portal ATK — shuma artikujve = totali për pagesë; Zbritja totale > 0 nëse ka zbritje rreshti.",
      message: atkSent
        ? `ATK TEST — kuponi ekzistues ${row.nuikf} (${preview.total_amount}€) u dërgua.`
        : `Dërgimi i kuponit ${row.nuikf} te ATK dështoi: ${atkResult?.error || "?"}`,
    };
  }

  const { items, totals, paymentMethod, paymentSplits } = input;
  const { fiscal_date, fiscal_time } = getFiscalTodayParts();
  const nuikf = generateNUIKF();
  const sefId = getSefIdentifier() || "";
  const dailyNumber = getNextDailyNumber();
  const totalNumber = getNextTotalNumber();
  const operatorName = String(opts.operator_name || "Operator").trim() || "Operator";

  let signature = null;
  try {
    signature = signReceipt({
      nuikf,
      total_amount: totals.totalAmount,
      fiscal_date,
      fiscal_time,
      taxpayer_nui: settings.taxpayer_nui,
      sef_id: sefId,
      daily_number: dailyNumber,
      total_number: totalNumber,
      receipt_type: "regular",
    });
  } catch (e) {
    console.warn("[fiscal-atk-discount-e2e] sign:", e.message);
  }

  let qrPayload = "";
  try {
    const qr = await generateFiscalQR({
      nuikf,
      total_amount: totals.totalAmount,
      fiscal_date,
      taxpayer_nui: settings.taxpayer_nui,
    });
    qrPayload = qr?.payload || "";
  } catch (e) {
    console.warn("[fiscal-atk-discount-e2e] QR:", e.message);
  }

  const fiscalId = insertFiscalReceipt({
    sale_id: 0,
    nuikf,
    sef_id: sefId,
    receipt_type: "regular",
    daily_number: dailyNumber,
    total_number: totalNumber,
    fiscal_date,
    fiscal_time,
    operator_name: "TEST",
    operator_id: "E2E-DISC",
    taxpayer_nui: settings.taxpayer_nui || "",
    taxpayer_vat: settings.taxpayer_vat_number || null,
    taxpayer_name: settings.taxpayer_legal_name || "Biznesi",
    taxpayer_address: settings.taxpayer_address || "",
    items_json: JSON.stringify(items),
    subtotal: round4(totals.netLines + totals.cartDiscount - totals.cartSurcharge),
    discount_amount: totals.cartDiscount,
    total_amount: totals.totalAmount,
    total_without_tax: totals.totalWithoutTax,
    vat_breakdown_json: JSON.stringify(totals.tax),
    payment_method: paymentMethod,
    payment_splits_json: paymentSplits?.length ? JSON.stringify(paymentSplits) : null,
    currency: "EUR",
    qr_code_data: qrPayload || nuikf,
    digital_signature: signature,
    is_offline: 0,
    sent_to_atk: 0,
  });

  const row = getFiscalReceiptById(fiscalId);
  const atkResult = await sendReceiptToAtk(row);

  let atkSent = false;
  if (atkResult?.sent) {
    markReceiptSent(fiscalId, atkResult);
    atkSent = true;
  }

  try {
    logFiscalAction(
      "receipt_sent",
      {
        e2e: "atk_discount_field8",
        source: input.source,
        fiscal_receipt_id: fiscalId,
        nuikf,
        field8_preview: preview.items,
        total_discount_eur: preview.total_discount_eur,
        total_amount: totals.totalAmount,
        atk_sent: atkSent,
        atk_error: atkSent ? null : atkResult?.error || null,
        transaction_id: atkResult?.transaction_id || null,
      },
      operatorName,
      "E2E-DISC"
    );
  } catch (e) {
    console.warn("[fiscal-atk-discount-e2e] audit:", e.message);
  }

  const srcLabel = input.source === "cart" ? "shportës" : "shembullit statik";
  return {
    ok: atkSent,
    dry_run: false,
    source: input.source,
    preview,
    fiscal_receipt_id: fiscalId,
    nuikf,
    total_amount: totals.totalAmount,
    total_discount_eur: preview.total_discount_eur,
    line_discounts_eur: totals.lineDiscSum,
    cart_discount_eur: totals.cartDiscount,
    atk_sent: atkSent,
    atk_result: {
      sent: atkSent,
      error: atkResult?.error || null,
      status: atkResult?.status || null,
      transaction_id: atkResult?.transaction_id || null,
      url: atkResult?.url || sendCheck.url,
    },
    verify_hint:
      "Kontrolloni në portal ATK — shuma artikujve = totali për pagesë; Zbritja totale > 0 nëse ka zbritje rreshti.",
    message: atkSent
      ? `ATK TEST — kuponi nga ${srcLabel} (${preview.total_amount}€) u dërgua.`
      : "Kuponi u ruajt lokalisht por dërgimi te ATK dështoi: " + (atkResult?.error || "?"),
  };
}

module.exports = {
  getDiscountE2eItems,
  getDiscountE2eSampleItems,
  computeDiscountE2eTotals,
  computeTotalsFromItems,
  resolveE2eInput,
  buildPreviewPayload,
  runAtkDiscountE2eTest,
  E2E_MARKER,
};
