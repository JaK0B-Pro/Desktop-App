import { useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { today } from "../money";
import type { PartyKind, Suggestion, TxInput, TxKind } from "../types";
import { AmountInput } from "./AmountInput";
import { LabelInput } from "./LabelInput";
import { KIND_HELP, KIND_LABEL, PARTY_KIND_LABEL, TX_KINDS } from "./labels";
import { Field, Modal } from "./Modal";

interface Line {
  key: number;
  accountId: number | null;
  amount: number | null;
}

let lineKey = 0;
const newLine = (accountId: number | null = null, amount: number | null = null): Line => ({
  key: ++lineKey,
  accountId,
  amount,
});

const usesLines = (k: TxKind) => k === "income" || k === "expense" || k === "transfer";

export function TransactionForm({ initial, onClose }: { initial: Partial<TxInput>; onClose: () => void }) {
  const { accounts, parties, refresh, toast, fail, fmt } = useApp();
  const active = accounts.filter((a) => !a.archived);
  const defaultAccount = active[0]?.id ?? null;

  const [kind, setKind] = useState<TxKind>(initial.kind ?? "income");
  const [date, setDate] = useState(initial.date ?? today());
  const [label, setLabel] = useState(initial.label ?? "");
  const [partyId, setPartyId] = useState<number | null>(initial.partyId ?? null);
  const [fromAccountId, setFromAccountId] = useState<number | null>(initial.fromAccountId ?? defaultAccount);
  const [amount, setAmount] = useState<number | null>(initial.amount ?? null);
  const [lines, setLines] = useState<Line[]>(
    initial.lines?.length
      ? initial.lines.map((l) => newLine(l.accountId, l.amount || null))
      : [newLine(active.find((a) => a.id !== initial.fromAccountId)?.id ?? defaultAccount)],
  );
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [splitTotal, setSplitTotal] = useState<number | null>(null);
  const [autoFilled, setAutoFilled] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newParty, setNewParty] = useState<{ name: string; kind: PartyKind } | null>(null);

  const isEdit = initial.id != null;
  const linesTotal = useMemo(() => lines.reduce((s, l) => s + (l.amount ?? 0), 0), [lines]);
  const total = usesLines(kind) ? linesTotal : amount ?? 0;
  const remaining = splitTotal != null ? splitTotal - linesTotal : null;

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addLine() {
    const used = new Set(lines.map((l) => l.accountId));
    const next = active.find((a) => !used.has(a.id) && a.id !== (kind === "transfer" ? fromAccountId : -1));
    setLines((ls) => [...ls, newLine(next?.id ?? null, remaining && remaining > 0 ? remaining : null)]);
  }

  /** Divides the total equally; the rounding remainder goes to the first line. */
  function splitEqually() {
    const t = splitTotal ?? linesTotal;
    if (!t || lines.length === 0) return;
    const share = Math.floor(t / lines.length);
    const rest = t - share * lines.length;
    setLines((ls) => ls.map((l, i) => ({ ...l, amount: share + (i === 0 ? rest : 0) })));
    setSplitTotal(t);
  }

  /** Every account receives the same amount as the first line. */
  function sameForAll() {
    const first = lines[0]?.amount;
    if (!first) return;
    setLines((ls) => ls.map((l) => ({ ...l, amount: first })));
    setSplitTotal(null);
  }

  function fillRemaining(key: number) {
    if (remaining == null) return;
    const line = lines.find((l) => l.key === key);
    updateLine(key, { amount: (line?.amount ?? 0) + remaining });
  }

  /** Learned auto-fill: only fills fields the user has not filled yet. */
  function onPick(s: Suggestion) {
    const filled: string[] = [];
    const noAmounts = usesLines(kind) ? lines.every((l) => !l.amount) : !amount;
    let k = kind;
    if (s.lastKind && s.lastKind !== kind && noAmounts && !isEdit) {
      k = s.lastKind;
      setKind(k);
      filled.push("type");
    }
    if (partyId == null && s.lastPartyId != null && k !== "transfer" && parties.some((p) => p.id === s.lastPartyId && !p.archived)) {
      setPartyId(s.lastPartyId);
      filled.push("beneficiary");
    }
    if (noAmounts) {
      if (usesLines(k)) {
        const valid = s.lastLines.filter((l) => active.some((a) => a.id === l.accountId));
        if (valid.length) {
          setLines(valid.map((l) => newLine(l.accountId, l.amount)));
          setSplitTotal(null);
          filled.push(valid.length > 1 ? `split over ${valid.length} accounts` : "account & amount");
        }
        if (k === "transfer" && s.lastFromAccountId != null && active.some((a) => a.id === s.lastFromAccountId)) {
          setFromAccountId(s.lastFromAccountId);
        }
      } else if (s.lastAmount) {
        setAmount(s.lastAmount);
        filled.push("amount");
      }
    }
    setAutoFilled(filled.length ? `Filled ${filled.join(", ")} from your last “${s.label}” (used ${s.uses}×)` : null);
  }

  async function createParty() {
    if (!newParty?.name.trim()) return;
    try {
      const p = await api.saveParty({ name: newParty.name, kind: newParty.kind, openingBalance: 0 });
      await refresh();
      setPartyId(p.id);
      setNewParty(null);
    } catch (e) {
      fail(e);
    }
  }

  async function save(andNew: boolean) {
    const input: TxInput = {
      id: initial.id ?? null,
      date,
      kind,
      label,
      partyId: kind === "transfer" ? null : partyId,
      fromAccountId: kind === "transfer" ? fromAccountId : null,
      amount: usesLines(kind) ? null : amount,
      lines: usesLines(kind)
        ? lines.filter((l) => l.accountId != null).map((l) => ({ accountId: l.accountId!, amount: l.amount ?? 0 }))
        : [],
      notes,
    };
    if (usesLines(kind) && lines.some((l) => l.accountId == null)) return fail("Choose an account for every line");
    if (remaining != null && remaining !== 0 && lines.length > 1)
      return fail(`The split does not match the total: ${fmt(remaining)} left to assign`);
    setSaving(true);
    try {
      await api.saveTransaction(input);
      toast(isEdit ? "Transaction updated" : `${KIND_LABEL[kind]} saved — ${fmt(total)}`);
      await refresh();
      if (andNew) {
        setLabel("");
        setAmount(null);
        setNotes("");
        setPartyId(null);
        setSplitTotal(null);
        setAutoFilled(null);
        setLines([newLine(defaultAccount)]);
      } else {
        onClose();
      }
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  }

  const accountOptions = (selected: number | null) =>
    accounts
      .filter((a) => !a.archived || a.id === selected)
      .map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ));

  const partyLabel = kind === "income" ? "Received from" : kind === "expense" ? "Paid to" : "Beneficiary";

  return (
    <Modal title={isEdit ? "Edit transaction" : "New transaction"} onClose={onClose} wide>
      <form
        className="tx-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save(false);
          }
        }}
      >
        <div className="kind-tabs">
          {TX_KINDS.map((k) => (
            <button
              type="button"
              key={k}
              className={`kind-tab k-${k} ${k === kind ? "on" : ""}`}
              onClick={() => setKind(k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="muted small">{KIND_HELP[kind]}</p>

        <div className="grid-2">
          <Field label="Label">
            <LabelInput value={label} onChange={setLabel} onPick={onPick} kind={kind} partyId={partyId} autoFocus />
          </Field>
          <Field label="Date">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {autoFilled && <div className="smart-note">✨ {autoFilled}</div>}

        {kind !== "transfer" && (
          <Field label={partyLabel + (kind === "purchase" || kind === "sale" ? "" : " (optional)")}>
            {newParty ? (
              <div className="row">
                <input
                  className="input"
                  autoFocus
                  placeholder="Name"
                  value={newParty.name}
                  onChange={(e) => setNewParty({ ...newParty, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createParty();
                    }
                  }}
                />
                <select
                  className="input narrow"
                  value={newParty.kind}
                  onChange={(e) => setNewParty({ ...newParty, kind: e.target.value as PartyKind })}
                >
                  {Object.entries(PARTY_KIND_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn" onClick={createParty}>
                  Add
                </button>
                <button type="button" className="btn ghost" onClick={() => setNewParty(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <select
                className="input"
                value={partyId ?? ""}
                onChange={(e) => {
                  if (e.target.value === "__new") setNewParty({ name: "", kind: "supplier" });
                  else setPartyId(e.target.value ? Number(e.target.value) : null);
                }}
              >
                <option value="">— None —</option>
                {parties
                  .filter((p) => !p.archived || p.id === partyId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.balance > 0 ? `owes you ${fmt(p.balance)}` : p.balance < 0 ? `you owe ${fmt(-p.balance)}` : "settled"})
                    </option>
                  ))}
                <option value="__new">+ New beneficiary…</option>
              </select>
            )}
          </Field>
        )}

        {usesLines(kind) ? (
          <div className="lines">
            {kind === "transfer" && (
              <Field label="From account">
                <select
                  className="input"
                  value={fromAccountId ?? ""}
                  onChange={(e) => setFromAccountId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">— Choose —</option>
                  {accountOptions(fromAccountId)}
                </select>
              </Field>
            )}
            <div className="lines-head">
              <span className="field-label">
                {kind === "income" ? "Deposit into" : kind === "expense" ? "Pay from" : "To account(s)"}
              </span>
              <div className="split-tools">
                <span className="muted small">Total to split</span>
                <div className="split-total">
                  <AmountInput value={splitTotal} onChange={setSplitTotal} placeholder="optional" />
                </div>
                <button type="button" className="btn small ghost" onClick={splitEqually} disabled={lines.length < 2}>
                  Split equally
                </button>
                <button type="button" className="btn small ghost" onClick={sameForAll} disabled={lines.length < 2}>
                  Same amount each
                </button>
              </div>
            </div>
            {lines.map((l, i) => (
              <div className="line" key={l.key}>
                <select
                  className="input"
                  value={l.accountId ?? ""}
                  onChange={(e) => updateLine(l.key, { accountId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">— Account —</option>
                  {accountOptions(l.accountId)}
                </select>
                <AmountInput
                  value={l.amount}
                  onChange={(v) => updateLine(l.key, { amount: v })}
                  autoFocus={i > 0 && l.amount == null}
                />
                {remaining != null && remaining !== 0 && (
                  <button type="button" className="btn small ghost" title="Put the rest here" onClick={() => fillRemaining(l.key)}>
                    +rest
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="lines-foot">
              <button type="button" className="btn small" onClick={addLine}>
                + Add another account
              </button>
              <div className="lines-total">
                {remaining != null && remaining !== 0 && (
                  <span className={remaining > 0 ? "warn" : "neg"}>
                    {remaining > 0 ? `${fmt(remaining)} left to assign` : `${fmt(-remaining)} over the total`}
                  </span>
                )}
                <span>
                  Total <strong>{fmt(linesTotal)}</strong>
                </span>
              </div>
            </div>
          </div>
        ) : (
          <Field label="Amount">
            <AmountInput value={amount} onChange={setAmount} />
          </Field>
        )}

        <Field label="Notes (optional)">
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <footer className="form-actions">
          <span className="muted small">Ctrl+Enter to save</span>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            {!isEdit && (
              <button type="button" className="btn" disabled={saving} onClick={() => save(true)}>
                Save & new
              </button>
            )}
            <button type="submit" className={`btn primary`} disabled={saving}>
              {isEdit ? "Save changes" : `Save ${KIND_LABEL[kind].toLowerCase()}`}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
