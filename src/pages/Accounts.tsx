import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { AmountInput } from "../components/AmountInput";
import { ACCOUNT_COLORS, ACCOUNT_KINDS, accountKindLabel } from "../components/labels";
import { Empty, Field, Modal } from "../components/Modal";
import { TxGrid } from "../components/TransactionTable";
import type { Account, AccountInput, AccountKind, Transaction } from "../types";

export function Accounts() {
  const { accounts, route, navigate, fmt, openTx, t } = useApp();
  const [editing, setEditing] = useState<AccountInput | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = accounts.filter((a) => showArchived || !a.archived);
  const total = accounts.filter((a) => !a.archived).reduce((s, a) => s + a.balance, 0);
  const selected = accounts.find((a) => a.id === route.accountId);

  if (selected)
    return <AccountDetail account={selected} onEdit={() => setEditing(selected)} editing={editing} setEditing={setEditing} />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("nav.accounts")}</h1>
          <p className="muted">{t("acc.subtitle", { total: fmt(total) })}</p>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />{" "}
            {t("c.showArchived")}
          </label>
          <button className="btn" onClick={() => openTx({ kind: "transfer" })}>
            {t("acc.transfer")}
          </button>
          <button
            className="btn primary"
            onClick={() =>
              setEditing({
                name: "",
                kind: "cash",
                openingBalance: 0,
                color: ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length],
              })
            }
          >
            {t("acc.new")}
          </button>
        </div>
      </header>

      {list.length === 0 ? (
        <Empty>{t("acc.empty")}</Empty>
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
                {accountKindLabel(t, a.kind)}
                {a.archived && ` · ${t("c.archived")}`}
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
  const { version, fail, fmt, navigate, openTx, t } = useApp();
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
        {t("acc.all")}
      </button>
      <header className="page-head">
        <div>
          <h1>
            <span className="dot big" style={{ background: account.color ?? "var(--muted)" }} /> {account.name}
          </h1>
          <p className="muted">
            {accountKindLabel(t, account.kind)} · {t("acc.openingInfo", { v: fmt(account.openingBalance) })}
            {account.notes && ` · ${account.notes}`}
          </p>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={onEdit}>
            {t("c.edit")}
          </button>
          <button className="btn" onClick={() => openTx({ kind: "transfer", fromAccountId: account.id, lines: [] })}>
            {t("acc.transfer")}
          </button>
          <button className="btn" onClick={() => openTx({ kind: "expense", lines: [{ accountId: account.id, amount: 0 }] })}>
            − {t("kind.expense")}
          </button>
          <button
            className="btn primary"
            onClick={() => openTx({ kind: "income", lines: [{ accountId: account.id, amount: 0 }] })}
          >
            + {t("kind.income")}
          </button>
        </div>
      </header>
      <section className="stats">
        <div className="stat">
          <span>{t("c.balance")}</span>
          <strong className={account.balance < 0 ? "neg" : ""}>{fmt(account.balance)}</strong>
        </div>
        <div className="stat">
          <span>{t("acc.totalIn")}</span>
          <strong className="pos">{fmt(inSum)}</strong>
        </div>
        <div className="stat">
          <span>{t("acc.totalOut")}</span>
          <strong className="neg">{fmt(outSum)}</strong>
        </div>
        <div className="stat">
          <span>{t("acc.moves")}</span>
          <strong>{rows.length}</strong>
        </div>
      </section>
      <section className="card flush">
        <TxGrid rows={rows} statement showType hide={["account"]} />
      </section>
      {editing && <AccountEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountEditor({ value, onClose }: { value: AccountInput; onClose: () => void }) {
  const { refresh, toast, fail, confirm, navigate, t } = useApp();
  const [v, setV] = useState<AccountInput>(value);
  const set = (patch: Partial<AccountInput>) => setV((x) => ({ ...x, ...patch }));

  async function save() {
    try {
      await api.saveAccount(v);
      toast(t("c.saved"));
      await refresh();
      onClose();
    } catch (e) {
      fail(e);
    }
  }

  async function remove() {
    if (!v.id || !(await confirm(t("c.confirmDeleteOrArchive", { name: v.name })))) return;
    try {
      const deleted = await api.deleteAccount(v.id);
      toast(deleted ? t("c.deleted") : t("c.archivedInstead"));
      await refresh();
      onClose();
      navigate({ page: "accounts" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Modal title={v.id ? t("acc.edit") : t("acc.create")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t("c.name")}>
          <input
            className="input"
            autoFocus
            value={v.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={t("acc.namePh")}
          />
        </Field>
        <div className="grid-2">
          <Field label={t("c.type")}>
            <select className="input" value={v.kind} onChange={(e) => set({ kind: e.target.value as AccountKind })}>
              {ACCOUNT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {accountKindLabel(t, k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("acc.opening")}>
            <AmountInput value={v.openingBalance} onChange={(c) => set({ openingBalance: c ?? 0 })} />
          </Field>
        </div>
        <Field label={t("acc.color")}>
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
        <Field label={t("c.notes")}>
          <textarea className="input" rows={2} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        {v.id && (
          <label className="check">
            <input type="checkbox" checked={!!v.archived} onChange={(e) => set({ archived: e.target.checked })} />{" "}
            {t("acc.archivedHint")}
          </label>
        )}
        <footer className="form-actions">
          {v.id ? (
            <button type="button" className="btn danger ghost" onClick={remove}>
              {t("c.delete")}
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("c.cancel")}
            </button>
            <button type="submit" className="btn primary">
              {t("c.save")}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
