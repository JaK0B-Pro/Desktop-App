import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { MonthChart } from "../components/MonthChart";
import { cashSign, TxGrid } from "../components/TransactionTable";
import { accountKindLabel } from "../components/labels";
import type { Dashboard as D, Party } from "../types";

export function Dashboard() {
  const { version, fmt, fail, navigate, openTx, t } = useApp();
  const [d, setD] = useState<D | null>(null);

  useEffect(() => {
    api.getDashboard().then(setD).catch(fail);
  }, [version, fail]);

  if (!d) return <div className="loading">{t("c.loading")}</div>;

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
      <p className="muted small">{t("dash.settledAll")}</p>
    );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("nav.dashboard")}</h1>
          <p className="muted">{t("dash.subtitle")}</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => openTx({ kind: "expense" })}>
            − {t("kind.expense")}
          </button>
          <button className="btn primary" onClick={() => openTx({ kind: "income" })}>
            + {t("kind.income")}
          </button>
        </div>
      </header>

      <section className="stats">
        <div className="stat">
          <span>{t("dash.totalFunds")}</span>
          <strong>{fmt(d.totalFunds)}</strong>
        </div>
        <div className="stat">
          <span>{t("dash.receivables")}</span>
          <strong className="pos">{fmt(d.receivables)}</strong>
        </div>
        <div className="stat">
          <span>{t("dash.payables")}</span>
          <strong className="neg">{fmt(d.payables)}</strong>
        </div>
        <div className="stat">
          <span>{t("dash.thisMonth")}</span>
          <strong>{fmt(d.monthIncome - d.monthExpense, { sign: true })}</strong>
          <small className="muted">{t("dash.inOut", { in: fmt(d.monthIncome), out: fmt(d.monthExpense) })}</small>
        </div>
      </section>

      <section className="card">
        <h3>{t("dash.accounts")}</h3>
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
                <small className="muted">{accountKindLabel(t, a.kind)}</small>
                <div>{a.name}</div>
              </span>
              <strong className={a.balance < 0 ? "neg" : ""}>{fmt(a.balance)}</strong>
            </button>
          ))}
        </div>
      </section>

      <div className="grid-main">
        <section className="card">
          <h3>{t("dash.last12")}</h3>
          <MonthChart data={d.monthly} />
        </section>
        <section className="card">
          <h3>{t("dash.oweYou")}</h3>
          {partyList(d.topDebtors, true)}
          <h3 className="mt">{t("dash.youOwe")}</h3>
          {partyList(d.topCreditors, false)}
        </section>
      </div>

      <section className="card flush">
        <div className="card-head padded">
          <h3>{t("dash.recent")}</h3>
          <button className="btn small ghost" onClick={() => navigate({ page: "journal", journal: "expense" })}>
            {t("dash.seeAll")}
          </button>
        </div>
        <TxGrid rows={d.recent} amountOf={cashSign} showType hide={["family"]} />
      </section>
    </div>
  );
}
