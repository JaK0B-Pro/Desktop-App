import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { AmountInput } from "../components/AmountInput";
import { PARTY_KIND_LABEL } from "../components/labels";
import { Empty, Field, Modal } from "../components/Modal";
import { TransactionTable } from "../components/TransactionTable";
import type { Party, PartyInput, PartyKind, Transaction } from "../types";

type Show = "all" | "owe-you" | "you-owe" | "settled";

/** "owes you $50" / "you owe $50" / "settled" */
export function useBalanceText() {
  const { fmt } = useApp();
  return (b: number) => (b > 0 ? `owes you ${fmt(b)}` : b < 0 ? `you owe ${fmt(-b)}` : "settled");
}

export function Parties() {
  const { parties, route, navigate, fmt } = useApp();
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
          <h1>Beneficiaries</h1>
          <p className="muted">Suppliers, clients and people you give money to or receive from</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ name: "", kind: "supplier", openingBalance: 0 })}>
          + New beneficiary
        </button>
      </header>

      <section className="stats three">
        <div className="stat">
          <span>They owe you</span>
          <strong className="pos">{fmt(receivable)}</strong>
        </div>
        <div className="stat">
          <span>You owe them</span>
          <strong className="neg">{fmt(payable)}</strong>
        </div>
        <div className="stat">
          <span>Net position</span>
          <strong className={receivable - payable < 0 ? "neg" : "pos"}>{fmt(receivable - payable, { sign: true })}</strong>
        </div>
      </section>

      <div className="filters">
        <input className="input grow" placeholder="Search name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="segmented">
          {(
            [
              ["all", "All"],
              ["owe-you", "Owe you"],
              ["you-owe", "You owe"],
              ["settled", "Settled"],
            ] as [Show, string][]
          ).map(([k, l]) => (
            <button key={k} className={show === k ? "on" : ""} onClick={() => setShow(k)}>
              {l}
            </button>
          ))}
        </div>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(PARTY_KIND_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
      </div>

      <section className="card flush">
        {list.length === 0 ? (
          <Empty>{parties.length ? "No match." : "No beneficiaries yet. Add your first supplier or client."}</Empty>
        ) : (
          <table className="table clickable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Phone</th>
                <th>Last activity</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} onClick={() => navigate({ page: "parties", partyId: p.id })}>
                  <td className="strong">
                    {p.name} {p.archived && <span className="chip">archived</span>}
                  </td>
                  <td>{PARTY_KIND_LABEL[p.kind]}</td>
                  <td>{p.phone ?? <span className="muted">—</span>}</td>
                  <td>{p.lastActivity ?? <span className="muted">—</span>}</td>
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
  const { version, fail, fmt, navigate, openTx, accounts } = useApp();
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
        ← All beneficiaries
      </button>
      <header className="page-head">
        <div>
          <h1>{party.name}</h1>
          <p className="muted">
            {PARTY_KIND_LABEL[party.kind]}
            {party.phone && ` · ${party.phone}`}
            {party.notes && ` · ${party.notes}`}
          </p>
        </div>
        <button className="btn ghost" onClick={() => setEditing(party)}>
          Edit
        </button>
      </header>

      <section className={`balance-banner ${party.balance > 0 ? "pos" : party.balance < 0 ? "neg" : ""}`}>
        <div>
          <span>Balance</span>
          <strong>{party.balance === 0 ? "Settled" : party.balance > 0 ? "They owe you" : "You owe them"}</strong>
        </div>
        <strong className="big">{fmt(settle)}</strong>
        {party.balance !== 0 && (
          <button
            className="btn primary"
            onClick={() =>
              openTx({
                kind: party.balance > 0 ? "income" : "expense",
                partyId: party.id,
                label: party.balance > 0 ? `Payment from ${party.name}` : `Payment to ${party.name}`,
                lines: cashbox ? [{ accountId: cashbox.id, amount: settle }] : [],
              })
            }
          >
            Settle {fmt(settle)}
          </button>
        )}
      </section>

      <div className="quick-actions">
        <button className="qa" onClick={() => openTx({ kind: "expense", partyId: party.id })}>
          <b>💸 Give money</b>
          <span>You pay them (cash out)</span>
        </button>
        <button className="qa" onClick={() => openTx({ kind: "income", partyId: party.id })}>
          <b>💰 Receive money</b>
          <span>They pay you (cash in)</span>
        </button>
        <button className="qa" onClick={() => openTx({ kind: "purchase", partyId: party.id })}>
          <b>📦 They gave me goods</b>
          <span>On credit — you owe them</span>
        </button>
        <button className="qa" onClick={() => openTx({ kind: "sale", partyId: party.id })}>
          <b>🧾 I gave them goods</b>
          <span>On credit — they owe you</span>
        </button>
      </div>

      <div className="summary-row">
        <span>Opening {balanceText(party.openingBalance)}</span>
        <span>
          Paid them <strong>{fmt(sumKind("expense"))}</strong>
        </span>
        <span>
          Received <strong>{fmt(sumKind("income"))}</strong>
        </span>
        <span>
          Bought on credit <strong>{fmt(sumKind("purchase"))}</strong>
        </span>
        <span>
          Sold on credit <strong>{fmt(sumKind("sale"))}</strong>
        </span>
      </div>

      <section className="card flush">
        <TransactionTable rows={rows} statement="party" balanceLabel={balanceText} />
      </section>
      {editing && <PartyEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PartyEditor({ value, onClose }: { value: PartyInput; onClose: () => void }) {
  const { refresh, toast, fail, confirm, navigate } = useApp();
  const [v, setV] = useState<PartyInput>(value);
  const [direction, setDirection] = useState<"owe-you" | "you-owe">(value.openingBalance < 0 ? "you-owe" : "owe-you");
  const set = (patch: Partial<PartyInput>) => setV((x) => ({ ...x, ...patch }));

  async function save() {
    const opening = Math.abs(v.openingBalance) * (direction === "you-owe" ? -1 : 1);
    try {
      const p = await api.saveParty({ ...v, openingBalance: opening });
      toast(v.id ? "Saved" : `${p.name} added`);
      await refresh();
      onClose();
    } catch (e) {
      fail(e);
    }
  }

  async function remove() {
    if (!v.id || !(await confirm(`Delete “${v.name}”? If there are transactions it will be archived instead.`))) return;
    try {
      const deleted = await api.deleteParty(v.id);
      toast(deleted ? "Deleted" : "Has transactions — archived instead");
      await refresh();
      onClose();
      navigate({ page: "parties" });
    } catch (e) {
      fail(e);
    }
  }

  return (
    <Modal title={v.id ? "Edit beneficiary" : "New beneficiary"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid-2">
          <Field label="Name">
            <input className="input" autoFocus value={v.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Type">
            <select className="input" value={v.kind} onChange={(e) => set({ kind: e.target.value as PartyKind })}>
              {Object.entries(PARTY_KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Phone">
          <input className="input" value={v.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Opening balance (before using the app)">
          <div className="row">
            <select className="input narrow" value={direction} onChange={(e) => setDirection(e.target.value as "owe-you" | "you-owe")}>
              <option value="owe-you">They owe me</option>
              <option value="you-owe">I owe them</option>
            </select>
            <AmountInput value={Math.abs(v.openingBalance)} onChange={(c) => set({ openingBalance: c ?? 0 })} />
          </div>
        </Field>
        <Field label="Notes">
          <textarea className="input" rows={2} value={v.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        {v.id && (
          <label className="check">
            <input type="checkbox" checked={!!v.archived} onChange={(e) => set({ archived: e.target.checked })} /> Archived
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
