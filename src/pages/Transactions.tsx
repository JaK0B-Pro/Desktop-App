import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { TransactionTable } from "../components/TransactionTable";
import { KIND_LABEL, TX_KINDS } from "../components/labels";
import type { Transaction, TxFilter } from "../types";

export function Transactions() {
  const { version, fail, accounts, parties, fmt, openTx } = useApp();
  const [filter, setFilter] = useState<TxFilter>({ limit: 500 });
  const [rows, setRows] = useState<Transaction[]>([]);

  useEffect(() => {
    const t = setTimeout(() => api.listTransactions(filter).then(setRows).catch(fail), 120);
    return () => clearTimeout(t);
  }, [filter, version, fail]);

  const set = (patch: Partial<TxFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const sum = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + r.amount, 0);
  const hasFilter = !!(filter.search || filter.kind || filter.accountId || filter.partyId || filter.from || filter.to);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Transactions</h1>
          <p className="muted">Double-click a row to edit it</p>
        </div>
        <button className="btn primary" onClick={() => openTx()}>
          + New transaction
        </button>
      </header>

      <div className="filters">
        <input
          className="input grow"
          placeholder="Search label, notes, beneficiary…"
          value={filter.search ?? ""}
          onChange={(e) => set({ search: e.target.value })}
        />
        <select className="input" value={filter.kind ?? ""} onChange={(e) => set({ kind: e.target.value || null })}>
          <option value="">All types</option>
          {TX_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filter.accountId ?? ""}
          onChange={(e) => set({ accountId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filter.partyId ?? ""}
          onChange={(e) => set({ partyId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">All beneficiaries</option>
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input className="input" type="date" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
        <input className="input" type="date" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
        {hasFilter && (
          <button className="btn ghost" onClick={() => setFilter({ limit: 500 })}>
            Clear
          </button>
        )}
      </div>

      <div className="summary-row">
        <span>{rows.length} transactions</span>
        <span>
          In <strong className="pos">{fmt(sum("income"))}</strong>
        </span>
        <span>
          Out <strong className="neg">{fmt(sum("expense"))}</strong>
        </span>
        <span>
          On credit: bought <strong>{fmt(sum("purchase"))}</strong> · sold <strong>{fmt(sum("sale"))}</strong>
        </span>
      </div>

      <section className="card flush">
        <TransactionTable rows={rows} />
      </section>
    </div>
  );
}
