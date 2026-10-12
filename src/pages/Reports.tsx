import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { TKey } from "../i18n";
import { MonthChart } from "../components/MonthChart";
import { kindLabel } from "../components/labels";
import { Empty } from "../components/Modal";
import type { LabelTotal, Report, TxKind } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function preset(name: string, exercise: number): [string, string] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (name) {
    case "month":
      return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case "last-month":
      return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "quarter": {
      const q = Math.floor(m / 3) * 3;
      return [iso(new Date(y, q, 1)), iso(new Date(y, q + 3, 0))];
    }
    case "last-year":
      return [`${exercise - 1}-01-01`, `${exercise - 1}-12-31`];
    default:
      return [`${exercise}-01-01`, `${exercise}-12-31`];
  }
}

const PRESETS: [string, TKey][] = [
  ["month", "rep.month"],
  ["last-month", "rep.lastMonth"],
  ["quarter", "rep.quarter"],
  ["year", "rep.year"],
  ["last-year", "rep.lastYear"],
];

type Tab = "label" | "family" | "chantier";

export function Reports() {
  const { version, fail, fmt, t, exercise, navigate } = useApp();
  const [active, setActive] = useState("year");
  const [range, setRange] = useState<[string, string]>(preset("year", exercise));
  const [r, setR] = useState<Report | null>(null);
  const [kind, setKind] = useState<TxKind>("expense");
  const [tab, setTab] = useState<Tab>("label");

  useEffect(() => {
    if (active) setRange(preset(active, exercise));
  }, [exercise, active]);

  useEffect(() => {
    if (range[0] && range[1] && range[0] <= range[1]) api.getReport(range[0], range[1]).then(setR).catch(fail);
  }, [range, version, fail]);

  const totalsTable = (list: LabelTotal[], empty: string) => {
    const rows = list.filter((l) => l.kind === kind);
    const max = Math.max(1, ...rows.map((l) => l.total));
    const total = rows.reduce((s, l) => s + l.total, 0);
    if (rows.length === 0) return <Empty>{t("rep.nothing")}</Empty>;
    return (
      <table className="table grid">
        <thead>
          <tr>
            <th>{tab === "family" ? t("col.family") : t("col.label")}</th>
            <th className="num">{t("c.type")}</th>
            <th style={{ width: "40%" }}>{t("rep.share")}</th>
            <th className="num">{t("c.total")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.label + l.kind}>
              <td className="strong">{l.label || <span className="muted">{empty}</span>}</td>
              <td className="num">{l.count}</td>
              <td>
                <div className="share">
                  <div style={{ width: `${(l.total / max) * 100}%` }} />
                  <span>{((l.total / total) * 100).toFixed(1)}%</span>
                </div>
              </td>
              <td className="num strong">{fmt(l.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>{t("c.total")}</td>
            <td className="num">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    );
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("nav.reports")}</h1>
          <p className="muted">{t("rep.subtitle")}</p>
        </div>
      </header>
      <div className="filters">
        <div className="segmented">
          {PRESETS.map(([k, l]) => (
            <button key={k} className={active === k ? "on" : ""} onClick={() => setActive(k)}>
              {l === "rep.year" ? `${t(l)} ${exercise}` : t(l)}
            </button>
          ))}
        </div>
        <label className="inline-field">
          {t("app.from")}
          <input
            className="input"
            type="date"
            value={range[0]}
            onChange={(e) => {
              setActive("");
              setRange([e.target.value, range[1]]);
            }}
          />
        </label>
        <label className="inline-field">
          {t("app.to")}
          <input
            className="input"
            type="date"
            value={range[1]}
            onChange={(e) => {
              setActive("");
              setRange([range[0], e.target.value]);
            }}
          />
        </label>
      </div>

      {r && (
        <>
          <section className="stats">
            <div className="stat">
              <span>{t("rep.in")}</span>
              <strong className="pos">{fmt(r.income)}</strong>
            </div>
            <div className="stat">
              <span>{t("rep.out")}</span>
              <strong className="neg">{fmt(r.expense)}</strong>
            </div>
            <div className="stat">
              <span>{t("rep.net")}</span>
              <strong>{fmt(r.income - r.expense, { sign: true })}</strong>
            </div>
            <div className="stat">
              <span>{t("rep.credit")}</span>
              <strong>{fmt(r.purchases)}</strong>
              <small className="muted">{t("rep.creditHint", { v: fmt(r.sales) })}</small>
            </div>
          </section>
          <section className="card">
            <h3>{t("rep.byMonth")}</h3>
            <MonthChart data={r.monthly} />
          </section>
          <section className="card">
            <div className="card-head">
              <div className="segmented">
                {(["label", "family", "chantier"] as Tab[]).map((k) => (
                  <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                    {t(k === "label" ? "rep.byLabel" : k === "family" ? "rep.byFamily" : "rep.byChantier")}
                  </button>
                ))}
              </div>
              {tab !== "chantier" && (
                <div className="segmented">
                  {(["expense", "income", "purchase", "sale"] as TxKind[]).map((k) => (
                    <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                      {kindLabel(t, k)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {tab === "label" && totalsTable(r.byLabel, "")}
            {tab === "family" && totalsTable(r.byFamily, t("rep.noFamily"))}
            {tab === "chantier" &&
              (r.byChantier.length === 0 ? (
                <Empty>{t("rep.nothing")}</Empty>
              ) : (
                <table className="table grid clickable">
                  <thead>
                    <tr>
                      <th>{t("col.chantier")}</th>
                      <th className="num">{t("ch.income")}</th>
                      <th className="num">{t("ch.expense")}</th>
                      <th className="num">{t("ch.purchases")}</th>
                      <th className="num">{t("ch.result")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byChantier.map((c) => {
                      const res = c.income - c.expense;
                      return (
                        <tr key={c.id} onClick={() => navigate({ page: "chantiers", chantierId: c.id })}>
                          <td className="strong">🏗 {c.name}</td>
                          <td className="num pos">{fmt(c.income)}</td>
                          <td className="num neg">{fmt(c.expense)}</td>
                          <td className="num">{fmt(c.purchases)}</td>
                          <td className={`num strong ${res < 0 ? "neg" : "pos"}`}>{fmt(res)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ))}
          </section>
        </>
      )}
    </div>
  );
}
