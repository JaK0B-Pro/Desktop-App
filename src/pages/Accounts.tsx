import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { AmountInput } from "../components/AmountInput";
import { ACCOUNT_COLORS, ACCOUNT_KIND_LABEL } from "../components/labels";
import { Empty, Field, Modal } from "../components/Modal";
import { TransactionTable } from "../components/TransactionTable";
import type { Account, AccountInput, AccountKind, Transaction } from "../types";

export function Accounts() {
  const { accounts, route, navigate, fmt, openTx } = useApp();
  const [editing, setEditing] = useState<AccountInput | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = accounts.filter((a) => showArchived || !a.archived);
  const total = accounts.filter((a) => !a.archived).reduce((s, a) => s + a.balance, 0);
  const selected = accounts.find((a) => a.id === route.accountId);

  if (selected) return <AccountDetail account={selected} onEdit={() => setEditing(selected)} editing={editing} setEditing={setEditing} />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="muted">
            Cash boxes, bank accounts and projects — total <strong>{fmt(total)}</strong>
          </p>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show
            archived
          </label>
          <button className="btn" onClick={() => openTx({ kind: "transfer" })}>
            ⇄ Transfer
          </button>
          <button className="btn primary" onClick={() => setEditing({ name: "", kind: "cash", openingBalance: 0, color: ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length] })}>
            + New account
          </button>
        </div>
      </header>

      {list.length === 0 ? (
        <Empty>No accounts yet. Create a cash box, a bank account or a project.</Empty>
      ) : (
        <div className="cards">
          {list.map((a) => (
            <button
              key={a.id}
              className={`account-card ${a.archived ? "archived" : ""}`}
              style={{ borderTopColor: a.color ?? undefined }}
              onClick={() => navigate({ page: "accounts", accountId: a.id })}
            >
              <small className="muted">
                {ACCOUNT_KIND_LABEL[a.kind]}
                {a.archived && " · archived"}
              </small>
              <h3>{a.name}</h3>
              <strong className={`big ${a.balance < 0 ? "neg" : ""}`}>{fmt(a.balance)}</strong>
            </button>
          ))}
        </div>
      )}
      {editing && <AccountEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountDetail({
  account,
  onEdit,
  editing,
  setEditing,
}: {
  account: Account;
  onEdit: () => void;
  editing: AccountInput | null;
  setEditing: (v: AccountInput | null) => void;
}) {
  const { version, fail, fmt, navigate, openTx } = useApp();
  const [rows, setRows] = useState<Transaction[]>([]);

  useEffect(() => {
    api
      .accountStatement(account.id)
      .then(([, txs]) => setRows(txs))
      .catch(fail);
  }, [account.id, version, fail]);

  const inSum = rows.filter((r) => (r.effect ?? 0) > 0).reduce((s, r) => s + (r.effect ?? 0), 0);
  const outSum = rows.filter((r) => (r.effect ?? 0) < 0).reduce((s, r) => s - (r.effect ?? 0), 0);

  return (
    <div className="page">
      <button className="link" onClick={() => navigate({ page: "accounts" })}>
        ← All accounts
      </button>
      <header className="page-head">
        <div>
          <h1>
            <span className="dot big" style={{ background: account.color ?? "var(--muted)" }} /> {account.name}
          </h1>
          <p className="muted">
            {ACCOUNT_KIND_LABEL[account.kind]} · opening balance {fmt(account.openingBalance)}
            {account.notes && ` · ${account.notes}`}
          </p>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={onEdit}>
            Edit
          </button>
          <button className="btn" onClick={() => openTx({ kind: "transfer", fromAccountId: account.id, lines: [] })}>
            ⇄ Transfer out
          </button>
          <button className="btn" onClick={() => openTx({ kind: "expense", lines: [{ accountId: account.id, amount: 0 }] })}>
            − Expense
          </button>
          <button className="btn primary" onClick={() => openTx({ kind: "income", lines: [{ accountId: account.id, amount: 0 }] })}>
            + Deposit
          </button>
        </div>
      </header>
      <section className="stats">
        <div className="stat">
          <span>Balance</span>
          <strong className={account.balance < 0 ? "neg" : ""}>{fmt(account.balance)}</strong>
        </div>
        <div className="stat">
          <span>Total in</span>
          <strong className="pos">{fmt(inSum)}</strong>
        </div>
        <div className="stat">
          <span>Total out</span>
          <strong className="neg">{fmt(outSum)}</strong>
        </div>
        <div className="stat">
          <span>Movements</span>
          <strong>{rows.length}</strong>
        </div>
      </section>
      <section className="card flush">
        <TransactionTable rows={rows} statement="account" />
      </section>
      {editing && <AccountEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountEditor({ value, onClose }: { value: AccountInput; onClose: () => void }) {
  const { refresh, toast, fail, confirm, navigate } = useApp();
  const [v, setV] = useState<AccountInput>(value);
  const set = (patch: Partial<AccountInput>) => setV((x) => ({ ...x, ...patch }));

  async function save() {
    try {
      await api.saveAccount(v);
      toast(v.id ? "Account updated" : "Account created");
      await refresh();
      onClose();
    } catch (e) {
      fail(e);
    }
  }

  async function remove() {
    if (!v.id || !(await confirm(`Delete account “${v.name}”? If it has transactions it will be archived instead.`))) return;
    try {
      const deleted = await api.deleteAccount(v.id);
      toast(deleted ? "Account deleted" : "Account has transactions — archived instead");
      await refresh();
      onClose();
      navigate({ page: "accounts" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Modal title={v.id ? "Edit account" : "New account"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input className="input" autoFocus value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Main cash box, Project Villa" />
        </Field>
        <div className="grid-2">
          <Field label="Type">
            <select className="input" value={v.kind} onChange={(e) => set({ kind: e.target.value as AccountKind })}>
              {Object.entries(ACCOUNT_KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Opening balance">
            <AmountInput value={v.openingBalance} onChange={(c) => set({ openingBalance: c ?? 0 })} />
          </Field>
        </div>
        <Field label="Color">
          <div className="swatches">
            {ACCOUNT_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${v.color === c ? "on" : ""}`}
                style={{ background: c }}
                onClick={() => set({ color: c })}
                aria-label={c}
              />
            ))}
          </div>
        </Field>
        <Field label="Notes">
          <textarea className="input" rows={2} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        {v.id && (
          <label className="check">
            <input type="checkbox" checked={!!v.archived} onChange={(e) => set({ archived: e.target.checked })} /> Archived
            (hidden from forms)
          </label>
        )}
        <footer className="form-actions">
          {v.id ? (
            <button type="button" className="btn danger ghost" onClick={remove}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
