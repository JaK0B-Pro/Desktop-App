import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { MonthChart } from "../components/MonthChart";
import { TransactionTable } from "../components/TransactionTable";
import { ACCOUNT_KIND_LABEL } from "../components/labels";
import type { Dashboard as D, Party } from "../types";

export function Dashboard() {
  const { version, fmt, fail, navigate, openTx } = useApp();
  const [d, setD] = useState<D | null>(null);

  useEffect(() => {
    api.getDashboard().then(setD).catch(fail);
  }, [version, fail]);

  if (!d) return <div className="loading">Loading…</div>;

  const partyList = (list: Party[], owe: boolean) =>
    list.length ? (
      <ul className="mini-list">
        {list.map((p) => (
          <li key={p.id} onClick={() => navigate({ page: "parties", partyId: p.id })}>
            <span>{p.name}</span>
            <strong className={owe ? "pos" : "neg"}>{fmt(Math.abs(p.balance))}</strong>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted small">Nobody — all settled.</p>
    );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Your money at a glance</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => openTx({ kind: "expense" })}>
            − Expense
          </button>
          <button className="btn primary" onClick={() => openTx({ kind: "income" })}>
            + Deposit
          </button>
        </div>
      </header>

      <section className="stats">
        <div className="stat">
          <span>Total in accounts</span>
          <strong>{fmt(d.totalFunds)}</strong>
        </div>
        <div className="stat">
          <span>They owe you</span>
          <strong className="pos">{fmt(d.receivables)}</strong>
        </div>
        <div className="stat">
          <span>You owe</span>
          <strong className="neg">{fmt(d.payables)}</strong>
        </div>
        <div className="stat">
          <span>This month</span>
          <strong>{fmt(d.monthIncome - d.monthExpense, { sign: true })}</strong>
          <small className="muted">
            in {fmt(d.monthIncome)} · out {fmt(d.monthExpense)}
          </small>
        </div>
      </section>

      <section className="card">
        <h3>Accounts</h3>
        <div className="account-strip">
          {d.accounts.map((a) => (
            <button
              key={a.id}
              className="account-pill"
              style={{ borderColor: a.color ?? undefined }}
              onClick={() => navigate({ page: "accounts", accountId: a.id })}
            >
              <span className="dot" style={{ background: a.color ?? "var(--muted)" }} />
              <span>
                <small className="muted">{ACCOUNT_KIND_LABEL[a.kind]}</small>
                <div>{a.name}</div>
              </span>
              <strong className={a.balance < 0 ? "neg" : ""}>{fmt(a.balance)}</strong>
            </button>
          ))}
        </div>
      </section>

      <div className="grid-main">
        <section className="card">
          <h3>Last 12 months</h3>
          <MonthChart data={d.monthly} />
        </section>
        <section className="card">
          <h3>Owe you</h3>
          {partyList(d.topDebtors, true)}
          <h3 className="mt">You owe</h3>
          {partyList(d.topCreditors, false)}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Recent transactions</h3>
          <button className="btn small ghost" onClick={() => navigate({ page: "transactions" })}>
            See all →
          </button>
        </div>
        <TransactionTable rows={d.recent} />
      </section>
    </div>
  );
}
