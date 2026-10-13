import type { T } from "./i18n";
import type { Settings, Transaction } from "./types";
import { amountInWords } from "./words";

/** Escapes text for HTML. */
const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Prints `html` with the system print dialog. The app itself is hidden while printing (see styles.css). */
export function printHtml(html: string, pageCss = "@page { size: A4; margin: 14mm; }") {
  let root = document.getElementById("print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `<style>${pageCss}</style>${html}`;
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    root!.innerHTML = "";
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  // Let the browser lay out the print content first.
  setTimeout(() => {
    window.print();
    setTimeout(done, 1000);
  }, 50);
}

export interface PrintCtx {
  t: T;
  lang: "fr" | "en";
  settings: Settings;
  decimals: number;
  fmt: (cents: number) => string;
}

function words(c: PrintCtx, cents: number) {
  return amountInWords(
    cents,
    c.decimals,
    c.lang,
    c.settings.currency_name ?? "dinars",
    c.settings.currency_subunit ?? "centimes",
  );
}

const frDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
};

function companyHeader(c: PrintCtx) {
  return `<div class="p-company"><strong>${esc(c.settings.company_name || "AccountBook")}</strong>
    <div>${esc(c.settings.company_activity)}</div></div>`;
}

/** A4 voucher ("bon de dépense") for one transaction. */
export function printVoucher(c: PrintCtx, tx: Transaction) {
  const { t } = c;
  const rows: [string, string][] = [
    [t("col.date"), frDate(tx.date)],
    [
      t("col.account"),
      tx.lines
        .map((l) => `${esc(l.accountName)}${tx.lines.length > 1 ? ` : ${esc(c.fmt(Math.abs(l.amount)))}` : ""}`)
        .join("<br>"),
    ],
    [t("col.chantier"), esc([...new Set([tx.chantierName, ...tx.lines.map((l) => l.chantierName)].filter(Boolean))].join(", "))],
    [t("col.party"), esc(tx.partyName)],
    [t("col.family"), esc(tx.family)],
    [t("col.label"), esc(tx.label)],
  ];
  if (tx.chequeNo) rows.push([t("form.chequeNo"), `${esc(tx.chequeNo)}${tx.chequePayee ? ` — ${esc(tx.chequePayee)}` : ""}`]);
  if (tx.notes) rows.push([t("c.notes"), esc(tx.notes)]);
  printHtml(`
    <div class="p-doc">
      ${companyHeader(c)}
      <h1 class="p-title">${t(`print.voucher.${tx.kind}`)} N° ${tx.id}</h1>
      <table class="p-fields">${rows
        .filter(([, v]) => v)
        .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
        .join("")}</table>
      <div class="p-amount">${t("col.amount")} : <strong>${esc(c.fmt(tx.amount))}</strong></div>
      <p class="p-words">${t("print.amountWords")} : <em>${esc(words(c, tx.amount))}</em></p>
      <div class="p-signs"><div>${t("print.signature")}</div><div>${t("print.received")}</div></div>
    </div>`);
}

/** Prints the cheque fields at their positions on a bank cheque (mm), with calibration offsets. */
export function printCheque(c: PrintCtx, data: { amount: number; payee: string; date: string; crossed: boolean }) {
  const s = c.settings;
  const ox = Number.parseFloat(s.cheque_offset_x ?? "0") || 0;
  const oy = Number.parseFloat(s.cheque_offset_y ?? "0") || 0;
  const vertical = s.cheque_vertical === "1";
  const w = words(c, data.amount);
  // Split the words over the two lines of the cheque.
  const cut = w.length > 60 ? w.lastIndexOf(" ", 60) : -1;
  const [l1, l2] = cut > 0 ? [w.slice(0, cut), w.slice(cut + 1)] : [w, ""];
  const amount = c
    .fmt(data.amount)
    .replace(/\s*[^\d.,\s-]+\s*/g, "")
    .trim();
  const at = (x: number, y: number, text: string, cls = "") =>
    `<div class="chq-f ${cls}" style="left:${x + ox}mm;top:${y + oy}mm">${esc(text)}</div>`;
  const body = `
    <div class="chq ${vertical ? "vertical" : ""}">
      ${at(128, 7, `# ${amount} #`, "big")}
      ${at(32, 18, l1)}
      ${at(8, 25, l2 ? `${l2} ***` : "***")}
      ${at(18, 33, data.payee)}
      ${at(108, 43, s.cheque_city ?? "")}
      ${at(140, 43, frDate(data.date))}
      ${data.crossed ? `<div class="chq-cross" style="left:${6 + ox}mm;top:${1 + oy}mm"></div>` : ""}
    </div>`;
  printHtml(body, "@page { size: A4; margin: 0; }");
}

/** Prints a list of transactions as a table with a total, like the journal grid. */
export function printList(
  c: PrintCtx,
  title: string,
  from: string,
  to: string,
  rows: Transaction[],
  signed: (t: Transaction) => number,
) {
  const { t } = c;
  const total = rows.reduce((s, r) => s + signed(r), 0);
  const body = rows
    .map(
      (r) => `<tr>
        <td class="num">${r.id}</td><td>${frDate(r.date)}</td>
        <td>${esc(r.lines.map((l) => l.accountName).join(", ") || t("journal.onCredit"))}</td>
        <td>${esc([...new Set([r.chantierName, ...r.lines.map((l) => l.chantierName)].filter(Boolean))].join(", "))}</td>
        <td>${esc(r.partyName)}</td><td>${esc(r.label)}</td>
        <td class="num">${esc(c.fmt(signed(r)))}</td></tr>`,
    )
    .join("");
  printHtml(
    `<div class="p-doc">
      ${companyHeader(c)}
      <h1 class="p-title">${esc(title)}</h1>
      <p class="p-period">${t("print.period", { from: from ? frDate(from) : "…", to: to ? frDate(to) : "…" })}</p>
      <table class="p-list">
        <thead><tr><th>${t("col.num")}</th><th>${t("col.date")}</th><th>${t("col.account")}</th><th>${t("col.chantier")}</th>
        <th>${t("col.party")}</th><th>${t("col.label")}</th><th class="num">${t("col.amount")}</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="6">${t("c.total")} — ${t("c.count", { n: rows.length })}</td><td class="num">${esc(c.fmt(total))}</td></tr></tfoot>
      </table>
      <p class="p-period">${t("print.printedOn", { d: new Date().toLocaleString(c.lang === "fr" ? "fr-FR" : "en-GB") })}</p>
    </div>`,
    "@page { size: A4 landscape; margin: 10mm; }",
  );
}
