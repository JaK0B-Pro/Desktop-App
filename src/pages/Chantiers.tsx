import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Empty, Field, Modal } from "../components/Modal";
import { TxGrid } from "../components/TransactionTable";
import type { Chantier, ChantierInput, Transaction } from "../types";

/** Cash result: credit purchases are paid later by expenses, so they are shown but not subtracted. */
const result = (c: Chantier) => c.income - c.expense;

export function Chantiers() {
  const { chantiers, route, navigate, fmt, t } = useApp();
  const [editing, setEditing] = useState<ChantierInput | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");

  const selected = chantiers.find((c) => c.id === route.chantierId);
  if (selected) return <ChantierDetail chantier={selected} editing={editing} setEditing={setEditing} />;

  const q = search.trim().toLowerCase();
  const list = chantiers.filter(
    (c) => (showArchived || !c.archived) && (!q || c.name.toLowerCase().includes(q) || (c.client ?? "").toLowerCase().includes(q)),
  );
  const sum = (f: (c: Chantier) => number) => list.reduce((s, c) => s + f(c), 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("nav.chantiers")}</h1>
          <p className="muted">{t("ch.subtitle")}</p>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t("c.showArchived")}
          </label>
          <button className="btn primary" onClick={() => setEditing({ name: "" })}>
            {t("ch.new")}
          </button>
        </div>
      </header>
      <div className="filters">
        <input className="input grow" placeholder={t("c.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <section className="card flush">
        {list.length === 0 ? (
          <Empty>{chantiers.length ? t("c.noMatch") : t("ch.empty")}</Empty>
        ) : (
          <table className="table grid clickable">
            <thead>
              <tr>
                <th>{t("c.name")}</th>
                <th>{t("ch.client")}</th>
                <th>{t("c.lastActivity")}</th>
                <th className="num">{t("ch.income")}</th>
                <th className="num">{t("ch.expense")}</th>
                <th className="num">{t("ch.purchases")}</th>
                <th className="num" title={t("ch.resultHint")}>
                  {t("ch.result")}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} onClick={() => navigate({ page: "chantiers", chantierId: c.id })}>
                  <td className="strong">
                    🏗 {c.name} {c.archived && <span className="chip">{t("c.archived")}</span>}
                  </td>
                  <td>{c.client}</td>
                  <td>{c.lastActivity?.split("-").reverse().join("/")}</td>
                  <td className="num pos">{fmt(c.income)}</td>
                  <td className="num neg">{fmt(c.expense)}</td>
                  <td className="num">{fmt(c.purchases)}</td>
                  <td className={`num strong ${result(c) < 0 ? "neg" : "pos"}`}>{fmt(result(c))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>{t("c.total")}</td>
                <td className="num">{fmt(sum((c) => c.income))}</td>
                <td className="num">{fmt(sum((c) => c.expense))}</td>
                <td className="num">{fmt(sum((c) => c.purchases))}</td>
                <td className="num">{fmt(sum(result))}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
      {editing && <ChantierEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ChantierDetail({
  chantier,
  editing,
  setEditing,
}: {
  chantier: Chantier;
  editing: ChantierInput | null;
  setEditing: (v: ChantierInput | null) => void;
}) {
  const { version, fail, fmt, navigate, openTx, t } = useApp();
  const [rows, setRows] = useState<Transaction[]>([]);

  useEffect(() => {
    api
      .chantierStatement(chantier.id)
      .then(([, txs]) => setRows(txs))
      .catch(fail);
  }, [chantier.id, version, fail]);

  return (
    <div className="page">
      <button className="link" onClick={() => navigate({ page: "chantiers" })}>
        {t("ch.all")}
      </button>
      <header className="page-head">
        <div>
          <h1>🏗 {chantier.name}</h1>
          <p className="muted">
            {chantier.client}
            {chantier.notes && ` · ${chantier.notes}`}
          </p>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => setEditing(chantier)}>
            {t("c.edit")}
          </button>
          <button className="btn" onClick={() => openTx({ kind: "expense", chantierId: chantier.id })}>
            − {t("kind.expense")}
          </button>
          <button className="btn primary" onClick={() => openTx({ kind: "income", chantierId: chantier.id })}>
            + {t("kind.income")}
          </button>
        </div>
      </header>
      <section className="stats">
        <div className="stat">
          <span>{t("ch.income")}</span>
          <strong className="pos">{fmt(chantier.income)}</strong>
        </div>
        <div className="stat">
          <span>{t("ch.expense")}</span>
          <strong className="neg">{fmt(chantier.expense)}</strong>
        </div>
        <div className="stat">
          <span>{t("ch.purchases")}</span>
          <strong>{fmt(chantier.purchases)}</strong>
        </div>
        <div className="stat">
          <span title={t("ch.resultHint")}>{t("ch.result")}</span>
          <strong className={result(chantier) < 0 ? "neg" : "pos"}>{fmt(result(chantier))}</strong>
        </div>
      </section>
      <section className="card flush">
        <TxGrid rows={rows} statement showType hide={["chantier"]} />
      </section>
      {editing && <ChantierEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ChantierEditor({ value, onClose }: { value: ChantierInput; onClose: () => void }) {
  const { refresh, toast, fail, confirm, navigate, t } = useApp();
  const [v, setV] = useState<ChantierInput>(value);
  const set = (patch: Partial<ChantierInput>) => setV((x) => ({ ...x, ...patch }));

  async function save() {
    try {
      await api.saveChantier(v);
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
      const deleted = await api.deleteChantier(v.id);
      toast(deleted ? t("c.deleted") : t("c.archivedInstead"));
      await refresh();
      onClose();
      navigate({ page: "chantiers" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Modal title={v.id ? t("ch.edit") : t("ch.create")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t("c.name")}>
          <input className="input" autoFocus value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="200 LOGTS OPGI" />
        </Field>
        <Field label={t("ch.client")}>
          <input className="input" value={v.client ?? ""} onChange={(e) => set({ client: e.target.value })} />
        </Field>
        <Field label={t("c.notes")}>
          <textarea className="input" rows={2} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        {v.id && (
          <label className="check">
            <input type="checkbox" checked={!!v.archived} onChange={(e) => set({ archived: e.target.checked })} /> {t("c.archived")}
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
