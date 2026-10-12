import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { MonthChart } from "../components/MonthChart";
import { KIND_LABEL } from "../components/labels";
import { Empty } from "../components/Modal";
import type { Report, TxKind } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function preset(name: string): [string, string] {
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
      return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    default:
      return [`${y}-01-01`, `${y}-12-31`];
  }
}

const PRESETS: [string, string][] = [
  ["month", "This month"],
  ["last-month", "Last month"],
  ["quarter", "This quarter"],
  ["year", "This year"],
  ["last-year", "Last year"],
];

export function Reports() {
  const { version, fail, fmt } = useApp();
  const [range, setRange] = useState<[string, string]>(preset("year"));
  const [active, setActive] = useState("year");
  const [r, setR] = useState<Report | null>(null);
  const [kind, setKind] = useState<TxKind>("expense");

  useEffect(() => {
    if (range[0] && range[1] && range[0] <= range[1]) api.getReport(range[0], range[1]).then(setR).catch(fail);
  }, [range, version, fail]);

  const rows = r?.byLabel.filter((l) => l.kind === kind) ?? [];
  const max = Math.max(1, ...rows.map((l) => l.total));
  const total = rows.reduce((s, l) => s + l.total, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">Where your money comes from and where it goes, by label</p>
        </div>
      </header>
      <div className="filters">
        <div className="segmented">
          {PRESETS.map(([k, l]) => (
            <button
              key={k}
              className={active === k ? "on" : ""}
              onClick={() => {
                setActive(k);
                setRange(preset(k));
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          className="input"
          type="date"
          value={range[0]}
          onChange={(e) => {
            setActive("");
            setRange([e.target.value, range[1]]);
          }}
        />
        <span className="muted">to</span>
        <input
          className="input"
          type="date"
          value={range[1]}
          onChange={(e) => {
            setActive("");
            setRange([range[0], e.target.value]);
          }}
        />
      </div>

      {r && (
        <>
          <section className="stats">
            <div className="stat">
              <span>Money in</span>
              <strong className="pos">{fmt(r.income)}</strong>
            </div>
            <div className="stat">
              <span>Money out</span>
              <strong className="neg">{fmt(r.expense)}</strong>
            </div>
            <div className="stat">
              <span>Net cash flow</span>
              <strong>{fmt(r.income - r.expense, { sign: true })}</strong>
            </div>
            <div className="stat">
              <span>On credit</span>
              <strong>{fmt(r.purchases)}</strong>
              <small className="muted">bought · sold {fmt(r.sales)}</small>
            </div>
          </section>
          <section className="card">
            <h3>By month</h3>
            <MonthChart data={r.monthly} />
          </section>
          <section className="card">
            <div className="card-head">
              <h3>By label</h3>
              <div className="segmented">
                {(["expense", "income", "purchase", "sale"] as TxKind[]).map((k) => (
                  <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
            {rows.length === 0 ? (
              <Empty>Nothing in this period.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th className="num">Count</th>
                    <th style={{ width: "40%" }}>Share</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.label + l.kind}>
                      <td className="strong">{l.label}</td>
                      <td className="num">{l.count}</td>
                      <td>
                        <div className="share" title={`${((l.total / total) * 100).toFixed(1)}%`}>
                          <div style={{ width: `${(l.total / max) * 100}%` }} />
                          <span>{((l.total / total) * 100).toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="num strong">{fmt(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
