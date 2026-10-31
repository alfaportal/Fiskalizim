const {
  formatReceiptDateTime,
  pad,
  divider,
  labelValueLine,
  truncatedLabelValueLine,
  formatMoney,
  paperChars,
} = require("./receipt-text");

function dt(iso) {
  return formatReceiptDateTime(iso);
}

function money(n) {
  return `${formatMoney(n)} EUR`;
}

function buildShiftCloseLines({ fiscal = {}, restaurantName = "", data = {}, paper = "80mm" }) {
  const f = fiscal || {};
  const bizName = f.biz_name || restaurantName || "Fiskalizim";
  const w = paperChars(paper);
  const opened = dt(data.opened_at);
  const closed = dt(data.closed_at);
  const now = dt(new Date().toISOString());
  const itemSummary = data.item_summary || [];
  const opening = Number(data.opening_cash) || 0;
  const cashSales = Number(data.cash_total) || 0;
  const cardSales = Number(data.card_total) || 0;
  const discountTotal = Number(data.discount_total) || 0;
  const totalSales = Number(data.total_sales) || 0;
  const expected = Number(data.expected_closing_cash ?? opening + cashSales);
  const actual = data.closing_cash_actual;
  const diff = Number(data.cash_difference) || 0;
  const orderCount = Number(data.order_count) || 0;

  const lines = [pad(`${now.date} ${now.time}`, w, "center"), pad(bizName, w, "center")];
  const addr = [f.biz_address, f.biz_city].filter(Boolean).join(", ");
  if (addr) lines.push(pad(addr, w, "center"));
  lines.push(pad(`Tel: ${f.biz_phone || "—"}`, w, "center"));
  lines.push(divider(w));
  lines.push(pad("PAZARI I NDERRIMIT", w, "center"));
  lines.push(divider(w));
  lines.push(`Punonjësi: ${data.waiter_name || "—"}`);
  lines.push(`Hapur: ${opened.date} ${opened.time}`);
  lines.push(`Mbyllur: ${closed.date} ${closed.time}`);
  lines.push(`Arka: ${f.biz_register_number || "—"}`);
  lines.push(`Operatori: ${f.biz_cashier_operator || "—"}`);
  lines.push(divider(w, "-"));

  if (itemSummary.length) {
    lines.push("Artikujt e shitur");
    lines.push(divider(w, "-"));
    for (const it of itemSummary) {
      lines.push(truncatedLabelValueLine(`${it.name} x${it.quantity}`, money(it.line_total), w));
    }
    lines.push(divider(w, "-"));
  } else {
    lines.push("Nuk ka shitje në këtë nderrim.");
    lines.push(divider(w, "-"));
  }

  lines.push(labelValueLine("Porosi:", String(orderCount), w));
  lines.push(labelValueLine("Shitje cash:", money(cashSales), w));
  lines.push(labelValueLine("Shitje kartë:", money(cardSales), w));
  if (discountTotal > 0) {
    lines.push(labelValueLine("Zbritje totale:", `-${formatMoney(discountTotal)} EUR`, w));
  }
  lines.push(`^R^B${labelValueLine("TOTALI:", money(totalSales), w)}`);
  lines.push(divider(w, "-"));
  lines.push("Paratë në arkë");
  lines.push(divider(w, "-"));
  lines.push(labelValueLine("Paratë e nisjes:", money(opening), w));
  lines.push(labelValueLine("Paratë e pritshme:", money(expected), w));
  if (actual != null) {
    lines.push(labelValueLine("Paratë e numëruar:", money(actual), w));
    if (Math.abs(diff) < 0.005) {
      lines.push("Barazim: OK");
    } else if (diff < 0) {
      lines.push(labelValueLine("Mungesë:", money(Math.abs(diff)), w));
    } else {
      lines.push(labelValueLine("Tepricë:", money(diff), w));
    }
  }

  lines.push(divider(w));
  lines.push(pad("Barazohet me pronarin", w, "center"));
  lines.push(divider(w));
  return lines;
}

module.exports = {
  buildShiftCloseLines,
};
