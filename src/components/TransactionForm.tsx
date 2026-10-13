import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { today } from "../money";
import { printCheque, printVoucher } from "../print";
import type { Suggestion, TxInput, TxKind, TxStatus } from "../types";
import { AmountInput } from "./AmountInput";
import { LabelInput } from "./LabelInput";
import { kindLabel, STATUSES, statusLabel, TX_KINDS } from "./labels";
import { Field, Modal } from "./Modal";
import { AccountSelect, ChantierSelect, PartySelect } from "./QuickSelect";
import { TxHistory } from "./TxHistory";

interface Line {
  key: number;
  accountId: number | null;
  amount: number | null;
  /** null = same chantier as the transaction */
  chantierId: number | null;
}

let lineKey = 0;
const newLine = (accountId: number | null = null, amount: number | null = null, chantierId: number | null = null): Line => ({
  key: ++lineKey,
  accountId,
  amount,
  chantierId,
});

const usesLines = (k: TxKind) => k === "income" || k === "expense" || k === "transfer";

export function TransactionForm({ initial, onClose }: { initial: Partial<TxInput>; onClose: () => void }) {
  const { accounts, parties, chantiers, families, notifySaved, toast, fail, fmt, t, lang, settings, money, canEdit, isClosed } =
    useApp();
  const active = accounts.filter((a) => !a.archived);
  const defaultAccount = active[0]?.id ?? null;

  const [kind, setKind] = useState<TxKind>(initial.kind ?? "expense");
  const [date, setDate] = useState(initial.date ?? today());
  const [label, setLabel] = useState(initial.label ?? "");
  const [partyId, setPartyId] = useState<number | null>(initial.partyId ?? null);
  const [chantierId, setChantierId] = useState<number | null>(initial.chantierId ?? null);
  const [family, setFamily] = useState(initial.family ?? "");
  const [status, setStatus] = useState<TxStatus>(initial.status ?? "ok");
  const [chequeNo, setChequeNo] = useState(initial.chequeNo ?? "");
  const [chequeCrossed, setChequeCrossed] = useState(initial.chequeCrossed ?? initial.id == null);
  const [chequePayee, setChequePayee] = useState(initial.chequePayee ?? "");
  const [fromAccountId, setFromAccountId] = useState<number | null>(initial.fromAccountId ?? defaultAccount);
  const [amount, setAmount] = useState<number | null>(initial.amount ?? null);
  const [lines, setLines] = useState<Line[]>(
    initial.lines?.length
      ? initial.lines.map((l) => newLine(l.accountId, l.amount || null, l.chantierId ?? null))
      : [newLine(active.find((a) => a.id !== initial.fromAccountId)?.id ?? defaultAccount)],
  );
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [splitTotal, setSplitTotal] = useState<number | null>(null);
  const [autoFilled, setAutoFilled] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nextCheque, setNextCheque] = useState<string | null>(null);

  const isEdit = initial.id != null;
  // Entries of a closed fiscal year, and everything for read-only users, open in view mode.
  const readOnly = !canEdit || isClosed(initial.date ?? date) || (isEdit && isClosed(date));
  const linesTotal = useMemo(() => lines.reduce((s, l) => s + (l.amount ?? 0), 0), [lines]);
  const total = usesLines(kind) ? linesTotal : (amount ?? 0);
  const remaining = splitTotal != null ? splitTotal - linesTotal : null;
  const chequeAccount = kind === "transfer" ? fromAccountId : (lines[0]?.accountId ?? null);
  const showCheque = kind !== "purchase" && kind !== "sale";
  const partyName = parties.find((p) => p.id === partyId)?.name ?? "";

  // Smart: suggest the next cheque number of the paying account.
  useEffect(() => {
    if (!showCheque || chequeAccount == null) return setNextCheque(null);
    api
      .nextChequeNo(chequeAccount)
      .then(setNextCheque)
      .catch(() => setNextCheque(null));
  }, [chequeAccount, showCheque]);

  // A transfer never goes to its own source: move the first destination to another account.
  useEffect(() => {
    if (kind !== "transfer" || fromAccountId == null || lines[0]?.accountId !== fromAccountId) return;
    const other = active.find((a) => a.id !== fromAccountId && !lines.some((l) => l.accountId === a.id));
    setLines((ls) => ls.map((l, i) => (i === 0 ? { ...l, accountId: other?.id ?? null } : l)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, fromAccountId]);

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
    const tot = splitTotal ?? linesTotal;
    if (!tot || lines.length === 0) return;
    const share = Math.floor(tot / lines.length);
    const rest = tot - share * lines.length;
    setLines((ls) => ls.map((l, i) => ({ ...l, amount: share + (i === 0 ? rest : 0) })));
    setSplitTotal(tot);
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
      filled.push(t("form.f.type"));
    }
    if (
      partyId == null &&
      s.lastPartyId != null &&
      k !== "transfer" &&
      parties.some((p) => p.id === s.lastPartyId && !p.archived)
    ) {
      setPartyId(s.lastPartyId);
      filled.push(t("form.f.party"));
    }
    if (
      chantierId == null &&
      s.lastChantierId != null &&
      k !== "transfer" &&
      chantiers.some((c) => c.id === s.lastChantierId && !c.archived)
    ) {
      setChantierId(s.lastChantierId);
      filled.push(t("form.f.chantier"));
    }
    if (!family.trim() && s.lastFamily) {
      setFamily(s.lastFamily);
      filled.push(t("form.f.family"));
    }
    if (noAmounts) {
      if (usesLines(k)) {
        const valid = s.lastLines.filter((l) => active.some((a) => a.id === l.accountId));
        if (valid.length) {
          setLines(valid.map((l) => newLine(l.accountId, l.amount, l.chantierId ?? null)));
          setSplitTotal(null);
          filled.push(valid.length > 1 ? t("form.f.split", { n: valid.length }) : t("form.f.account"));
        }
        if (k === "transfer" && s.lastFromAccountId != null && active.some((a) => a.id === s.lastFromAccountId)) {
          setFromAccountId(s.lastFromAccountId);
        }
      } else if (s.lastAmount) {
        setAmount(s.lastAmount);
        filled.push(t("form.f.amount"));
      }
    }
    setAutoFilled(
      filled.length
        ? t("form.autofill", {
            label: s.label,
            n: s.uses,
            fields: filled.join(", "),
          })
        : null,
    );
  }

  // Transfers get an automatic label ("Virement Caisse → Banque BNA") when none is typed.
  const accountName = (id: number | null | undefined) => accounts.find((a) => a.id === id)?.name ?? "?";
  const autoLabel =
    kind === "transfer" && fromAccountId != null && lines[0]?.accountId != null
      ? t("tr.autoLabel", {
          from: accountName(fromAccountId),
          to: lines.map((l) => accountName(l.accountId)).join(", "),
        })
      : "";
  const effectiveLabel = label.trim() || autoLabel;

  /** Balance of each account touched by the transfer: now, movement, after (edits ignore the old version). */
  const transferPreview = useMemo(() => {
    if (kind !== "transfer") return [];
    const delta = new Map<number, number>();
    const add = (id: number | null | undefined, v: number) => id != null && delta.set(id, (delta.get(id) ?? 0) + v);
    add(fromAccountId, -linesTotal);
    for (const l of lines) add(l.accountId, l.amount ?? 0);
    // When editing, the current balances already include the original entry: remove it first.
    const original = new Map<number, number>();
    if (isEdit && initial.kind === "transfer") {
      const tot = (initial.lines ?? []).reduce((s, l) => s + l.amount, 0);
      if (initial.fromAccountId != null) original.set(initial.fromAccountId, -tot);
      for (const l of initial.lines ?? []) original.set(l.accountId, (original.get(l.accountId) ?? 0) + l.amount);
    }
    return [...delta.entries()].map(([id, change]) => {
      const now = (accounts.find((a) => a.id === id)?.balance ?? 0) - (original.get(id) ?? 0);
      return { id, name: accountName(id), now, change, after: now + change };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, fromAccountId, lines, linesTotal, accounts, isEdit]);

  function swapTransfer() {
    const to = lines[0]?.accountId ?? null;
    if (lines.length !== 1) return;
    setLines([{ ...lines[0], accountId: fromAccountId }]);
    setFromAccountId(to);
  }

  function validate(): string | null {
    if (!effectiveLabel) return t("form.err.label");
    if (usesLines(kind)) {
      if (kind === "transfer" && fromAccountId == null) return t("form.err.from");
      if (lines.some((l) => l.accountId == null)) return t("form.err.account");
      if (lines.some((l) => !l.amount || l.amount <= 0)) return t("form.err.amount");
      if (remaining != null && remaining !== 0 && lines.length > 1) return t("form.err.split", { v: fmt(remaining) });
    } else {
      if (partyId == null) return t("form.err.party");
      if (!amount || amount <= 0) return t("form.err.amount");
    }
    return null;
  }

  async function save(after: "close" | "new" | "print") {
    const err = validate();
    if (err) return fail(err);
    const input: TxInput = {
      id: initial.id ?? null,
      date,
      kind,
      label: effectiveLabel,
      partyId: kind === "transfer" ? null : partyId,
      chantierId: kind === "transfer" ? null : chantierId,
      family: family.trim() || null,
      status,
      chequeNo: showCheque ? chequeNo.trim() || null : null,
      chequeCrossed: showCheque && chequeCrossed,
      chequePayee: showCheque ? chequePayee.trim() || null : null,
      fromAccountId: kind === "transfer" ? fromAccountId : null,
      amount: usesLines(kind) ? null : amount,
      lines: usesLines(kind)
        ? lines.map((l) => ({
            accountId: l.accountId!,
            amount: l.amount ?? 0,
            chantierId: kind === "transfer" ? null : l.chantierId,
          }))
        : [],
      notes,
    };
    setSaving(true);
    try {
      const saved = await api.saveTransaction(input);
      toast(
        isEdit
          ? t("form.updated")
          : t("form.savedMsg", {
              kind: kindLabel(t, kind),
              amount: fmt(total),
            }),
      );
      await notifySaved(saved);
      if (after === "print") printVoucher({ t, lang, settings, decimals: money.decimals, fmt }, saved);
      if (after === "new") {
        setLabel("");
        setAmount(null);
        setNotes("");
        setPartyId(null);
        setChequeNo("");
        setChequePayee("");
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

  function doPrintCheque() {
    if (!total) return fail(t("form.err.amount"));
    printCheque(
      { t, lang, settings, decimals: money.decimals, fmt },
      {
        amount: total,
        payee: chequePayee.trim() || partyName,
        date,
        crossed: chequeCrossed,
      },
    );
  }

  const chantierOptions = (selected: number | null) =>
    chantiers
      .filter((c) => !c.archived || c.id === selected)
      .map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ));

  const title =
    (isEdit ? t("form.edit", { kind: kindLabel(t, kind).toLowerCase() }) : t("form.new")) + (isEdit ? ` — N° ${initial.id}` : "");

  return (
    <Modal title={title} onClose={onClose} wide>
      {readOnly && (
        <div className="locked-note">
          🔒 {canEdit ? t("ex.locked", { year: (initial.date ?? date).slice(0, 4) }) : t("err.forbidden")}
        </div>
      )}
      <form
        className={`tx-form ${readOnly ? "read-only" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save("close");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !readOnly) {
            e.preventDefault();
            void save("close");
          }
        }}
      >
        <fieldset className="plain" disabled={readOnly}>
          <div className="kind-tabs">
            {TX_KINDS.map((k) => (
              <button type="button" key={k} className={`kind-tab k-${k} ${k === kind ? "on" : ""}`} onClick={() => setKind(k)}>
                {kindLabel(t, k)}
              </button>
            ))}
          </div>
          <p className="muted small">{t(`help.${kind}`)}</p>

          <div className="form-grid three">
            <Field label={t("form.date")}>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            {kind !== "transfer" ? (
              <Field label={t("form.family")}>
                <input
                  className="input"
                  list="families"
                  value={family}
                  placeholder={t("form.familyPh")}
                  onChange={(e) => setFamily(e.target.value)}
                />
                <datalist id="families">
                  {families.map((f) => (
                    <option key={f.name} value={f.name} />
                  ))}
                </datalist>
              </Field>
            ) : (
              <span />
            )}
            <Field label={t("form.status")}>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as TxStatus)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(t, s)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t("form.label")}>
            <LabelInput
              placeholder={autoLabel || undefined}
              value={label}
              onChange={setLabel}
              onPick={onPick}
              kind={kind}
              partyId={partyId}
              chantierId={chantierId}
              autoFocus={!readOnly}
            />
          </Field>
          {autoFilled && <div className="smart-note">✨ {autoFilled}</div>}

          {kind !== "transfer" && (
            <div className="form-grid">
              <Field label={t("form.chantier")}>
                <ChantierSelect value={chantierId} onChange={setChantierId} />
              </Field>
              <Field label={kind === "income" ? t("form.partyIncome") : t("form.party")}>
                <PartySelect value={partyId} onChange={setPartyId} />
              </Field>
            </div>
          )}

          {usesLines(kind) ? (
            <div className="lines">
              {kind === "transfer" && (
                <div className="transfer-from">
                  <Field label={t("form.fromAccount")}>
                    <AccountSelect value={fromAccountId} onChange={setFromAccountId} />
                  </Field>
                  <button
                    type="button"
                    className="btn swap"
                    title={t("tr.swap")}
                    disabled={lines.length !== 1}
                    onClick={swapTransfer}
                  >
                    ⇅ {t("tr.swap")}
                  </button>
                </div>
              )}
              <div className="lines-head">
                <span className="field-label">{t(`form.lines.${kind as "income" | "expense" | "transfer"}`)}</span>
                {lines.length > 1 && (
                  <div className="split-tools">
                    <span className="muted small">{t("form.splitTotal")}</span>
                    <div className="split-total">
                      <AmountInput value={splitTotal} onChange={setSplitTotal} placeholder={t("form.optional")} />
                    </div>
                    <button type="button" className="btn small ghost" onClick={splitEqually}>
                      {t("form.splitEqually")}
                    </button>
                    <button type="button" className="btn small ghost" onClick={sameForAll}>
                      {t("form.sameEach")}
                    </button>
                  </div>
                )}
              </div>
              <div className={`line line-head ${kind === "transfer" ? "no-chantier" : ""}`}>
                <span>{t("form.account")}</span>
                {kind !== "transfer" && <span>{t("form.chantier")}</span>}
                <span className="num">{t("form.amount")}</span>
                <span />
              </div>
              {lines.map((l, i) => (
                <div className={`line ${kind === "transfer" ? "no-chantier" : ""}`} key={l.key}>
                  <AccountSelect
                    value={l.accountId}
                    exclude={kind === "transfer" ? fromAccountId : null}
                    onChange={(id) => updateLine(l.key, { accountId: id })}
                  />
                  {kind !== "transfer" && (
                    <select
                      className={`input ${l.chantierId == null ? "muted-select" : ""}`}
                      value={l.chantierId ?? ""}
                      onChange={(e) =>
                        updateLine(l.key, {
                          chantierId: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    >
                      <option value="">
                        {t("form.sameChantier")}
                        {chantierId != null ? ` (${chantiers.find((c) => c.id === chantierId)?.name ?? ""})` : ""}
                      </option>
                      {chantierOptions(l.chantierId)}
                    </select>
                  )}
                  <AmountInput
                    value={l.amount}
                    onChange={(v) => updateLine(l.key, { amount: v })}
                    autoFocus={i > 0 && l.amount == null}
                  />
                  <div className="line-actions">
                    {remaining != null && remaining !== 0 && (
                      <button type="button" className="btn small ghost" onClick={() => fillRemaining(l.key)}>
                        {t("form.rest")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t("c.delete")}
                      disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              <div className="lines-foot">
                <button type="button" className="btn small" onClick={addLine}>
                  {t("form.addLine")}
                </button>
                <div className="lines-total">
                  {remaining != null && remaining !== 0 && (
                    <span className={remaining > 0 ? "warn" : "neg"}>
                      {remaining > 0 ? t("form.left", { v: fmt(remaining) }) : t("form.over", { v: fmt(-remaining) })}
                    </span>
                  )}
                  <span>
                    {t("c.total")} <strong>{fmt(linesTotal)}</strong>
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <Field label={t("form.amount")}>
              <AmountInput value={amount} onChange={setAmount} />
            </Field>
          )}

          {kind === "transfer" && linesTotal > 0 && transferPreview.length > 0 && (
            <div className="transfer-preview">
              <table>
                <thead>
                  <tr>
                    <th>{t("tr.preview")}</th>
                    <th className="num">{t("tr.now")}</th>
                    <th className="num">{t("tr.change")}</th>
                    <th className="num">{t("tr.after")}</th>
                  </tr>
                </thead>
                <tbody>
                  {transferPreview.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="num">{fmt(p.now)}</td>
                      <td className={`num ${p.change < 0 ? "neg" : "pos"}`}>{fmt(p.change, { sign: true })}</td>
                      <td className={`num strong ${p.after < 0 ? "neg" : ""}`}>{fmt(p.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {transferPreview
                .filter((p) => p.after < 0 && p.change < 0)
                .map((p) => (
                  <div key={p.id} className="warn small">
                    ⚠ {t("tr.negative", { name: p.name })}
                  </div>
                ))}
            </div>
          )}

          {showCheque && (
            <fieldset className="cheque">
              <div className="cheque-grid">
                <Field
                  label={t("form.chequeNo")}
                  hint={
                    nextCheque && !chequeNo ? (
                      <button type="button" className="link small" onClick={() => setChequeNo(nextCheque)}>
                        {t("form.nextCheque")} : {nextCheque}
                      </button>
                    ) : undefined
                  }
                >
                  <input
                    className="input"
                    value={chequeNo}
                    placeholder={nextCheque ?? ""}
                    onChange={(e) => setChequeNo(e.target.value)}
                  />
                </Field>
                <Field label={t("form.payee")}>
                  <input
                    className="input"
                    value={chequePayee}
                    placeholder={partyName}
                    onChange={(e) => setChequePayee(e.target.value)}
                  />
                </Field>
                <label className="check cheque-crossed">
                  <input type="checkbox" checked={chequeCrossed} onChange={(e) => setChequeCrossed(e.target.checked)} />{" "}
                  {t("form.chequeCrossed")}
                </label>
                <button type="button" className="btn" onClick={doPrintCheque}>
                  🖨 {t("form.printCheque")}
                </button>
              </div>
            </fieldset>
          )}

          <Field label={t("c.notes")}>
            <textarea className="input" rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </fieldset>
        {isEdit && <TxHistory id={initial.id!} />}

        <footer className="form-actions">
          <div className="row">
            {!readOnly && (
              <button type="button" className="btn" disabled={saving} onClick={() => save("print")}>
                🖨 {t("form.printVoucher")}
              </button>
            )}
            {!readOnly && <span className="muted small">{t("form.ctrlEnter")}</span>}
          </div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onClose}>
              {readOnly ? t("c.close") : t("c.cancel")}
            </button>
            {!isEdit && !readOnly && (
              <button type="button" className="btn" disabled={saving} onClick={() => save("new")}>
                {t("form.saveNew")}
              </button>
            )}
            {!readOnly && (
              <button type="submit" className="btn primary" disabled={saving}>
                {t("c.save")}
              </button>
            )}
          </div>
        </footer>
      </form>
    </Modal>
  );
}
