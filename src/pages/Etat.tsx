import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { accountKindLabel, partyKindLabel } from "../components/labels";
import { Empty } from "../components/Modal";
import { printHtml } from "../print";
import type { AccountKind, BalanceRow, PartyKind } from "../types";

type Tab = "accounts" | "parties";

/**
 * "État des comptes": for each account (or beneficiary), the balance on the first day of the
 * period, what came in, what went out and the closing balance.
 */
export function Etat() {
  const { range, exercise, t, fmt, fail, version, reloadKey, navigate, settings } = useApp();
  const [tab, setTab] = useState<Tab>("accounts");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [rows, setRows] = useState<BalanceRow[] | null>(null);

  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range]);

  useEffect(() => {
    if (!from || !to || from > to) return;
    (tab === "accounts" ? api.accountsState(from, to) : api.partiesState(from, to)).then(setRows).catch(fail);
  }, [tab, from, to, version, reloadKey, fail]);

  const sum = (k: keyof BalanceRow) => (rows ?? []).reduce((s, r) => s + (r[k] as number), 0);
  const isAcc = tab === "accounts";
  const cols = isAcc
    ? [t("etat.initial"), t("etat.in"), t("etat.out"), t("etat.balance")]
    : [t("etat.initial"), t("etat.debit"), t("etat.credit"), t("etat.balance")];
  const situation = (b: number) =>
    b > 0 ? t("pt.balOwesYou", { v: fmt(b) }) : b < 0 ? t("pt.balYouOwe", { v: fmt(-b) }) : t("pt.balSettled");
  const kindName = (k: string) => (isAcc ? accountKindLabel(t, k as AccountKind) : partyKindLabel(t, k as PartyKind));

  function print() {
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const d = (x: string) => x.split("-").reverse().join("/");
    const body = (rows ?? [])
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${esc(kindName(r.kind))}</td>${[r.initial, r.debit, r.credit, r.balance]
            .map((v) => `<td class="num">${esc(fmt(v))}</td>`)
            .join("")}${isAcc ? "" : `<td>${esc(situation(r.balance))}</td>`}</tr>`,
      )
      .join("");
    printHtml(
      `<div class="p-doc"><div class="p-company"><strong>${esc(settings.company_name || "AccountBook")}</strong><div>${esc(
        settings.company_activity ?? "",
      )}</div></div>
      <h1 class="p-title">${t("etat.title")} — ${t(isAcc ? "etat.accounts" : "etat.parties")}</h1>
      <p class="p-period">${t("print.period", { from: d(from), to: d(to) })}</p>
      <table class="p-list"><thead><tr><th>${t("c.name")}</th><th>${t("c.type")}</th>${cols
        .map((c) => `<th class="num">${c}</th>`)
        .join("")}${isAcc ? "" : `<th>${t("etat.situation")}</th>`}</tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td colspan="2">${t("c.total")}</td>${(["initial", "debit", "credit", "balance"] as const)
        .map((k) => `<td class="num">${esc(fmt(sum(k)))}</td>`)
        .join("")}${isAcc ? "" : "<td></td>"}</tr></tfoot></table></div>`,
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>⚖ {t("etat.title")}</h1>
          <p className="muted">{t("etat.subtitle", { year: exercise })}</p>
        </div>
        <button className="btn" onClick={print} disabled={!rows?.length}>
          🖨 {t("c.print")}
        </button>
      </header>
      <div className="filters">
        <div className="segmented">
          <button className={isAcc ? "on" : ""} onClick={() => setTab("accounts")}>
            {t("etat.accounts")}
          </button>
          <button className={!isAcc ? "on" : ""} onClick={() => setTab("parties")}>
            {t("etat.parties")}
          </button>
        </div>
        <label className="inline-field">
          {t("app.from")}
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline-field">
          {t("app.to")}
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <section className="card flush">
        {rows && rows.length === 0 ? (
          <Empty>{t("c.empty")}</Empty>
        ) : (
          <table className="table grid clickable etat">
            <thead>
              <tr>
                <th>{t("c.name")}</th>
                <th>{t("c.type")}</th>
                {cols.map((c) => (
                  <th key={c} className="num">
                    {c}
                  </th>
                ))}
                {!isAcc && <th>{t("etat.situation")}</th>}
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr
                  key={r.id}
                  onClick={() => navigate(isAcc ? { page: "accounts", accountId: r.id } : { page: "parties", partyId: r.id })}
                >
                  <td className="strong">{r.name}</td>
                  <td className="muted">{kindName(r.kind)}</td>
                  <td className="num">{fmt(r.initial)}</td>
                  <td className="num pos">{fmt(r.debit)}</td>
                  <td className="num neg">{fmt(r.credit)}</td>
                  <td className={`num strong ${r.balance < 0 ? "neg" : ""}`}>{fmt(r.balance)}</td>
                  {!isAcc && <td className={r.balance > 0 ? "pos" : r.balance < 0 ? "neg" : "muted"}>{situation(r.balance)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>{t("c.total")}</td>
                <td className="num">{fmt(sum("initial"))}</td>
                <td className="num">{fmt(sum("debit"))}</td>
                <td className="num">{fmt(sum("credit"))}</td>
                <td className="num">{fmt(sum("balance"))}</td>
                {!isAcc && <td />}
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </div>
  );
}
