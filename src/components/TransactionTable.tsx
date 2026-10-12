import { api } from "../api";
import { useApp } from "../context";
import type { Transaction, TxInput } from "../types";
import { KIND_LABEL } from "./labels";
import { Empty } from "./Modal";

/** Converts a stored transaction back into editable form input. */
export function toInput(t: Transaction): TxInput {
  if (t.kind === "transfer") {
    return {
      id: t.id,
      date: t.date,
      kind: t.kind,
      label: t.label,
      fromAccountId: t.lines.find((l) => l.amount < 0)?.accountId ?? null,
      lines: t.lines.filter((l) => l.amount > 0).map((l) => ({ accountId: l.accountId, amount: l.amount })),
      notes: t.notes,
    };
  }
  return {
    id: t.id,
    date: t.date,
    kind: t.kind,
    label: t.label,
    partyId: t.partyId,
    amount: t.lines.length ? null : t.amount,
    lines: t.lines.map((l) => ({ accountId: l.accountId, amount: Math.abs(l.amount) })),
    notes: t.notes,
  };
}

/**
 * Transactions table. In statement mode (`statement`) it shows the signed effect on the
 * account/party and the running balance.
 */
export function TransactionTable({
  rows,
  statement,
  balanceLabel,
  compact,
}: {
  rows: Transaction[];
  statement?: "account" | "party";
  balanceLabel?: (v: number) => string;
  compact?: boolean;
}) {
  const showParty = !compact && statement !== "party";
  const { fmt, openTx, refresh, toast, fail, confirm } = useApp();

  async function remove(t: Transaction) {
    if (!(await confirm(`Delete “${t.label}” (${fmt(t.amount)})? This cannot be undone.`))) return;
    try {
      await api.deleteTransaction(t.id);
      toast("Transaction deleted");
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  if (!rows.length) return <Empty>No transactions yet.</Empty>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Label</th>
          <th>Type</th>
          {showParty && <th>Beneficiary</th>}
          {!compact && <th>Accounts</th>}
          <th className="num">Amount</th>
          {statement && <th className="num">Balance</th>}
          {!compact && <th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const signed =
            statement && t.effect != null
              ? t.effect
              : t.kind === "income"
                ? t.amount
                : t.kind === "expense"
                  ? -t.amount
                  : t.amount;
          return (
            <tr key={t.id} onDoubleClick={() => openTx(toInput(t))}>
              <td className="nowrap">{t.date}</td>
              <td>
                <div className="cell-label">{t.label}</div>
                {t.notes && <div className="muted small">{t.notes}</div>}
              </td>
              <td>
                <span className={`chip k-${t.kind}`}>{KIND_LABEL[t.kind]}</span>
              </td>
              {showParty && <td>{t.partyName ?? <span className="muted">—</span>}</td>}
              {!compact && (
                <td className="small">
                  {t.lines.map((l) => (
                    <div className="nowrap" key={l.accountId + ":" + l.amount}>
                      {l.accountName} <span className={l.amount < 0 ? "neg" : "pos"}>{fmt(l.amount, { sign: true })}</span>
                    </div>
                  ))}
                  {!t.lines.length && <span className="muted">on credit</span>}
                </td>
              )}
              <td className={`num strong ${signed < 0 ? "neg" : t.kind === "transfer" && !statement ? "" : "pos"}`}>
                {t.kind === "transfer" && !statement ? fmt(t.amount) : fmt(signed, { sign: true })}
              </td>
              {statement && (
                <td className="num" title={balanceLabel?.(t.runningBalance ?? 0)}>
                  {balanceLabel ? balanceLabel(t.runningBalance ?? 0) : fmt(t.runningBalance ?? 0)}
                </td>
              )}
              {!compact && (
                <td className="actions">
                  <button className="icon-btn" title="Edit" onClick={() => openTx(toInput(t))}>
                    ✎
                  </button>
                  <button className="icon-btn danger" title="Delete" onClick={() => remove(t)}>
                    🗑
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
