import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { AmountInput } from "../components/AmountInput";
import { PARTY_KINDS, partyKindLabel } from "../components/labels";
import { Empty, Field, Modal } from "../components/Modal";
import { TxGrid } from "../components/TransactionTable";
import type { Party, PartyInput, PartyKind, Transaction } from "../types";

type Show = "all" | "owe-you" | "you-owe" | "settled";

/** "vous doit 50 DA" / "vous lui devez 50 DA" / "réglé" */
export function useBalanceText() {
  const { fmt, t } = useApp();
  return (b: number) =>
    b > 0 ? t("pt.balOwesYou", { v: fmt(b) }) : b < 0 ? t("pt.balYouOwe", { v: fmt(-b) }) : t("pt.balSettled");
}

export function Parties() {
  const { parties, route, navigate, fmt, t } = useApp();
  const balanceText = useBalanceText();
  const [editing, setEditing] = useState<PartyInput | null>(null);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [kind, setKind] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);

  const selected = parties.find((p) => p.id === route.partyId);
  if (selected) return <PartyDetail party={selected} editing={editing} setEditing={setEditing} />;

  const active = parties.filter((p) => !p.archived);
  const receivable = active.filter((p) => p.balance > 0).reduce((s, p) => s + p.balance, 0);
  const payable = active.filter((p) => p.balance < 0).reduce((s, p) => s - p.balance, 0);
  const q = search.trim().toLowerCase();
  const list = parties.filter(
    (p) =>
      (showArchived || !p.archived) &&
      (!kind || p.kind === kind) &&
      (!q || p.name.toLowerCase().includes(q) || (p.phone ?? "").includes(q)) &&
      (show === "all" ||
        (show === "owe-you" && p.balance > 0) ||
        (show === "you-owe" && p.balance < 0) ||
        (show === "settled" && p.balance === 0)),
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t("nav.parties")}</h1>
          <p className="muted">{t("pt.subtitle")}</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ name: "", kind: "supplier", openingBalance: 0 })}>
          {t("pt.new")}
        </button>
      </header>

      <section className="stats three">
        <div className="stat">
          <span>{t("pt.oweYou")}</span>
          <strong className="pos">{fmt(receivable)}</strong>
        </div>
        <div className="stat">
          <span>{t("pt.youOwe")}</span>
          <strong className="neg">{fmt(payable)}</strong>
        </div>
        <div className="stat">
          <span>{t("pt.net")}</span>
          <strong className={receivable - payable < 0 ? "neg" : "pos"}>{fmt(receivable - payable, { sign: true })}</strong>
        </div>
      </section>

      <div className="filters">
        <input className="input grow" placeholder={t("pt.searchPh")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="segmented">
          {(
            [
              ["all", t("c.all")],
              ["owe-you", t("pt.oweYou")],
              ["you-owe", t("pt.youOwe")],
              ["settled", t("pt.settled")],
            ] as [Show, string][]
          ).map(([k, l]) => (
            <button key={k} className={show === k ? "on" : ""} onClick={() => setShow(k)}>
              {l}
            </button>
          ))}
        </div>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t("c.all")}</option>
          {PARTY_KINDS.map((k) => (
            <option key={k} value={k}>
              {partyKindLabel(t, k)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />{" "}
          {t("c.showArchived")}
        </label>
      </div>

      <section className="card flush">
        {list.length === 0 ? (
          <Empty>{parties.length ? t("c.noMatch") : t("pt.empty")}</Empty>
        ) : (
          <table className="table grid clickable">
            <thead>
              <tr>
                <th>{t("c.name")}</th>
                <th>{t("c.type")}</th>
                <th>{t("c.phone")}</th>
                <th>{t("c.lastActivity")}</th>
                <th className="num">{t("c.balance")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} onClick={() => navigate({ page: "parties", partyId: p.id })}>
                  <td className="strong">
                    {p.name} {p.archived && <span className="chip">{t("c.archived")}</span>}
                  </td>
                  <td>{partyKindLabel(t, p.kind)}</td>
                  <td>{p.phone}</td>
                  <td>{p.lastActivity?.split("-").reverse().join("/")}</td>
                  <td className={`num strong ${p.balance > 0 ? "pos" : p.balance < 0 ? "neg" : "muted"}`}>
                    {balanceText(p.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {editing && <PartyEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PartyDetail({
  party,
  editing,
  setEditing,
}: {
  party: Party;
  editing: PartyInput | null;
  setEditing: (v: PartyInput | null) => void;
}) {
  const { version, fail, fmt, navigate, openTx, accounts, t } = useApp();
  const balanceText = useBalanceText();
  const cashbox = accounts.find((a) => !a.archived);
  const [rows, setRows] = useState<Transaction[]>([]);

  useEffect(() => {
    api
      .partyStatement(party.id)
      .then(([, txs]) => setRows(txs))
      .catch(fail);
  }, [party.id, version, fail]);

  const settle = Math.abs(party.balance);
  const sumKind = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + r.amount, 0);

  return (
    <div className="page">
      <button className="link" onClick={() => navigate({ page: "parties" })}>
        {t("pt.all")}
      </button>
      <header className="page-head">
        <div>
          <h1>{party.name}</h1>
          <p className="muted">
            {partyKindLabel(t, party.kind)}
            {party.phone && ` · ${party.phone}`}
            {party.notes && ` · ${party.notes}`}
          </p>
        </div>
        <button className="btn ghost" onClick={() => setEditing(party)}>
          {t("c.edit")}
        </button>
      </header>

      <section className={`balance-banner ${party.balance > 0 ? "pos" : party.balance < 0 ? "neg" : ""}`}>
        <div>
          <span>{t("c.balance")}</span>
          <strong>{party.balance === 0 ? t("pt.settled") : party.balance > 0 ? t("pt.theyOwe") : t("pt.iOwe")}</strong>
        </div>
        <strong className="big">{fmt(settle)}</strong>
        {party.balance !== 0 && (
          <button
            className="btn primary"
            onClick={() =>
              openTx({
                kind: party.balance > 0 ? "income" : "expense",
                partyId: party.id,
                label: party.balance > 0 ? t("pt.paymentFrom", { name: party.name }) : t("pt.paymentTo", { name: party.name }),
                lines: cashbox ? [{ accountId: cashbox.id, amount: settle }] : [],
              })
            }
          >
            {t("pt.settle", { v: fmt(settle) })}
          </button>
        )}
      </section>

      <div className="quick-actions">
        <button className="qa" onClick={() => openTx({ kind: "expense", partyId: party.id })}>
          <b>{t("pt.give")}</b>
          <span>{t("pt.giveHint")}</span>
        </button>
        <button className="qa" onClick={() => openTx({ kind: "income", partyId: party.id })}>
          <b>{t("pt.receive")}</b>
          <span>{t("pt.receiveHint")}</span>
        </button>
        <button className="qa" onClick={() => openTx({ kind: "purchase", partyId: party.id })}>
          <b>{t("pt.gaveMe")}</b>
          <span>{t("pt.gaveMeHint")}</span>
        </button>
        <button className="qa" onClick={() => openTx({ kind: "sale", partyId: party.id })}>
          <b>{t("pt.gaveThem")}</b>
          <span>{t("pt.gaveThemHint")}</span>
        </button>
      </div>

      <div className="summary-row">
        <span>{t("pt.opening", { v: balanceText(party.openingBalance) })}</span>
        <span>
          {t("pt.paid")} <strong>{fmt(sumKind("expense"))}</strong>
        </span>
        <span>
          {t("pt.received")} <strong>{fmt(sumKind("income"))}</strong>
        </span>
        <span>
          {t("pt.bought")} <strong>{fmt(sumKind("purchase"))}</strong>
        </span>
        <span>
          {t("pt.sold")} <strong>{fmt(sumKind("sale"))}</strong>
        </span>
      </div>

      <section className="card flush">
        <TxGrid rows={rows} statement showType balanceLabel={balanceText} hide={["party"]} />
      </section>
      {editing && <PartyEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PartyEditor({ value, onClose }: { value: PartyInput; onClose: () => void }) {
  const { refresh, toast, fail, confirm, navigate, t } = useApp();
  const [v, setV] = useState<PartyInput>(value);
  const [direction, setDirection] = useState<"owe-you" | "you-owe">(value.openingBalance < 0 ? "you-owe" : "owe-you");
  const set = (patch: Partial<PartyInput>) => setV((x) => ({ ...x, ...patch }));

  async function save() {
    const opening = Math.abs(v.openingBalance) * (direction === "you-owe" ? -1 : 1);
    try {
      await api.saveParty({ ...v, openingBalance: opening });
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
      const deleted = await api.deleteParty(v.id);
      toast(deleted ? t("c.deleted") : t("c.archivedInstead"));
      await refresh();
      onClose();
      navigate({ page: "parties" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Modal title={v.id ? t("pt.edit") : t("pt.create")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid-2">
          <Field label={t("c.name")}>
            <input className="input" autoFocus value={v.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t("c.type")}>
            <select className="input" value={v.kind} onChange={(e) => set({ kind: e.target.value as PartyKind })}>
              {PARTY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {partyKindLabel(t, k)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t("c.phone")}>
          <input className="input" value={v.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label={t("pt.openingLabel")}>
          <div className="row nowrap-row">
            <select
              className="input narrow"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "owe-you" | "you-owe")}
            >
              <option value="owe-you">{t("pt.theyOweMe")}</option>
              <option value="you-owe">{t("pt.iOweThem")}</option>
            </select>
            <AmountInput value={Math.abs(v.openingBalance)} onChange={(c) => set({ openingBalance: c ?? 0 })} />
          </div>
        </Field>
        <Field label={t("c.notes")}>
          <textarea className="input" rows={2} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        {v.id && (
          <label className="check">
            <input type="checkbox" checked={!!v.archived} onChange={(e) => set({ archived: e.target.checked })} />{" "}
            {t("c.archived")}
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
