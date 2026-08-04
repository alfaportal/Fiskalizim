/**
 * fiscal/fiscal-payment.js — HAPI 4: mënyrat e pagesës për fiskalizim.
 * Modal/UI përdoret VETËM kur isFiscalEnabled()=true.
 */
const { isFiscalEnabled } = require("./fiscal-config");

const PAYMENT_METHODS = Object.freeze([
  { id: "cash", label: "Para e gatshme (cash)", default: true },
  { id: "debit_card", label: "Debit kartelë" },
  { id: "credit_card", label: "Kredit kartelë" },
  { id: "bank_account", label: "Llogari bankare" },
  { id: "voucher", label: "Vauçer" },
  { id: "check", label: "Çek" },
  { id: "sms", label: "SMS" },
]);

const PAYMENT_METHOD_IDS = Object.freeze(PAYMENT_METHODS.map((m) => m.id));

const DEFAULT_PAYMENT_METHOD = "cash";

function isFiscalPaymentMethod(id) {
  return PAYMENT_METHOD_IDS.includes(String(id || "").trim().toLowerCase());
}

/**
 * Normalizon metodën e pagesës. Kur fiscal OFF, mban cash/karte si deri tash.
 * Kur fiscal ON, lejon 7 metodat SEF.
 */
function normalizeFiscalPaymentMethod(raw) {
  const v = String(raw || DEFAULT_PAYMENT_METHOD)
    .trim()
    .toLowerCase();
  if (isFiscalPaymentMethod(v)) return v;
  if (["karte", "kartë", "card", "kart"].includes(v)) return "karte";
  return DEFAULT_PAYMENT_METHOD;
}

function paymentMethodLabel(id) {
  const v = String(id || "").trim().toLowerCase();
  const found = PAYMENT_METHODS.find((m) => m.id === v);
  if (found) return found.label;
  if (v === "karte") return "Kartë";
  return "Para e gatshme (cash)";
}

/** A duhet të shfaqet modali i pagesës para mbylljes? */
function shouldShowPaymentModal() {
  return isFiscalEnabled();
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_IDS,
  DEFAULT_PAYMENT_METHOD,
  isFiscalPaymentMethod,
  normalizeFiscalPaymentMethod,
  paymentMethodLabel,
  shouldShowPaymentModal,
};
