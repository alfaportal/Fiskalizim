const {
  formatReceiptDateTime,
  pad,
  divider,
  labelValueLine,
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
  const whoOpened = data.opened_by || data.waiter_name || "—";
  const whoClosed = data.closed_by || data.waiter_name || "—";
  const diff = Number(data.cash_difference) || 0;
  const lines = [pad(`${now.date} ${now.time}`, w, "center"), pad(bizName, w, "center")];
  lines.push(divider(w));
  lines.push(pad("MBYLLJE NDËRRIMI", w, "center"));
  lines.push(divider(w));
  lines.push(`Hyrja: ${whoOpened}`);
  lines.push(`${opened.date} ${opened.time}`);
  lines.push(`Mbyllja: ${whoClosed}`);
  lines.push(`${closed.date} ${closed.time}`);
  lines.push(divider(w, "-"));
  lines.push(labelValueLine("Paratë në nisje:", money(data.opening_cash), w));
  lines.push(labelValueLine("Cash nga shitjet:", money(data.cash_total), w));
  lines.push(labelValueLine("Kartë:", money(data.card_total), w));
  lines.push(labelValueLine("Pritet në arkë:", money(data.expected_closing_cash), w));
  lines.push(labelValueLine("Numëruar:", money(data.closing_cash_actual), w));
  if (Math.abs(diff) < 0.005) lines.push("Arka: në rregull");
  else if (diff < 0) lines.push(labelValueLine("Mungesë:", money(Math.abs(diff)), w));
  else lines.push(labelValueLine("Tepricë:", money(diff), w));
  lines.push(divider(w));
  lines.push(pad("Ndërrimi u mbyll", w, "center"));
  lines.push(divider(w));
  return lines;
}

module.exports = {
  buildShiftCloseLines,
};
