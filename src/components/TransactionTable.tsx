import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { Transaction, TxInput } from "../types";
import { kindLabel, statusLabel } from "./labels";
import { Empty } from "./Modal";

/** Converts a stored transaction back into editable form input. */
export function toInput(t: Transaction): TxInput {
  const common = {
    id: t.id,
    date: t.date,
    kind: t.kind,
    label: t.label,
    family: t.family,
    status: t.status,
    chequeNo: t.chequeNo,
    chequeCrossed: t.chequeCrossed,
    chequePayee: t.chequePayee,
    notes: t.notes,
  };
  if (t.kind === "transfer") {
    return {
      ...common,
      fromAccountId: t.lines.find((l) => l.amount < 0)?.accountId ?? null,
      lines: t.lines.filter((l) => l.amount > 0).map((l) => ({ accountId: l.accountId, amount: l.amount })),
    };
  }
  return {
    ...common,
    partyId: t.partyId,
    chantierId: t.chantierId,
    amount: t.lines.length ? null : t.amount,
    lines: t.lines.map((l) => ({
      accountId: l.accountId,
      amount: Math.abs(l.amount),
      // Lines on the transaction's chantier follow it ("same chantier").
      chantierId: l.chantierId === t.chantierId ? null : l.chantierId,
    })),
  };
}

/** Signed cash effect used in the general journal: + money in, − money out. */
export function cashSign(t: Transaction): number {
  if (t.kind === "income") return t.amount;
  if (t.kind === "expense") return -t.amount;
  return t.amount;
}

export const chantierNames = (t: Transaction) =>
  [...new Set([t.chantierName, ...t.lines.map((l) => l.chantierName)].filter(Boolean))].join(", ");

export type SortKey = "num" | "date" | "account" | "chantier" | "party" | "family" | "label" | "amount";

/**
 * Grid of transactions, modelled on a classic treasury journal:
 * N° · Date · Compte · Chantier · Bénéficiaire · Famille · Libellé · Montant, with a total row.
 *
 * Keyboard: ↑/↓ select, Enter edit, Delete delete. Double-click edits.
 * In statement mode it adds the running balance column and uses `effect` as the amount.
 */
export function TxGrid({
  rows,
  amountOf,
  statement,
  balanceLabel,
  showType,
  hide = [],
  selectedId,
  onSelect,
  emptyText,
}: {
  rows: Transaction[];
  /** Amount shown for a row (defaults to the effect in statements, or the total). */
  amountOf?: (t: Transaction) => number;
  statement?: boolean;
  balanceLabel?: (v: number) => string;
  showType?: boolean;
  hide?: SortKey[];
  selectedId?: number | null;
  onSelect?: (id: number | null) => void;
  emptyText?: string;
}) {
  const { fmt, openTx, refresh, toast, fail, confirm, t } = useApp();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [localSel, setLocalSel] = useState<number | null>(null);
  const sel = selectedId !== undefined ? selectedId : localSel;
  const select = (id: number | null) => (onSelect ? onSelect(id) : setLocalSel(id));
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const amount = useMemo(
    () => amountOf ?? ((r: Transaction) => (statement ? r.effect ?? 0 : r.amount)),
    [amountOf, statement],
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const val = (r: Transaction): string | number => {
      switch (sort.key) {
        case "num":
          return r.id;
        case "date":
          return r.date + String(r.id).padStart(10, "0");
        case "account":
          return r.lines.map((l) => l.accountName).join(", ").toLowerCase();
        case "chantier":
          return chantierNames(r).toLowerCase();
        case "party":
          return (r.partyName ?? "").toLowerCase();
        case "family":
          return (r.family ?? "").toLowerCase();
        case "label":
          return r.label.toLowerCase();
        case "amount":
          return amount(r);
      }
    };
    const out = [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.desc ? out.reverse() : out;
  }, [rows, sort, amount]);

  // Keep the selected row visible while navigating with the keyboard.
  useEffect(() => {
    bodyRef.current?.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  async function remove(row: Transaction) {
    if (!(await confirm(t("c.confirmDelete", { name: `${row.id} · ${row.label} (${fmt(row.amount)})` })))) return;
    try {
      await api.deleteTransaction(row.id);
      toast(t("c.deleted"));
      select(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!sorted.length) return;
    const i = sorted.findIndex((r) => r.id === sel);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      select(sorted[Math.min(i + 1, sorted.length - 1)].id);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(sorted[Math.max(i - 1, 0)].id);
    } else if (e.key === "Enter" && i >= 0) {
      e.preventDefault();
      openTx(toInput(sorted[i]));
    } else if (e.key === "Delete" && i >= 0) {
      e.preventDefault();
      void remove(sorted[i]);
    }
  }

  const show = (k: SortKey) => !hide.includes(k);
  const head = (key: SortKey, label: string, cls = "") =>
    show(key) ? (
      <th
        className={`sortable col-${key} ${cls}`}
        onClick={() => setSort((s) => (s?.key === key ? (s.desc ? null : { key, desc: true }) : { key, desc: false }))}
      >
        {label}
        {sort?.key === key ? (sort.desc ? " ▼" : " ▲") : ""}
      </th>
    ) : null;

  const total = sorted.reduce((s, r) => s + amount(r), 0);
  const accountText = (r: Transaction) =>
    r.kind === "transfer"
      ? `${r.lines.filter((l) => l.amount < 0).map((l) => l.accountName).join(", ")} → ${r.lines
          .filter((l) => l.amount > 0)
          .map((l) => l.accountName)
          .join(", ")}`
      : r.lines.map((l) => l.accountName).join(", ");

  return (
    <div className="grid-wrap" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="grid-scroll">
        <table className="table grid fixed">
          <thead>
            <tr>
              <th className="icon-col" />
              {head("num", t("col.num"), "num")}
              {head("date", t("col.date"))}
              {showType && <th className="col-type">{t("col.type")}</th>}
              {head("account", t("col.account"))}
              {head("chantier", t("col.chantier"))}
              {head("party", t("col.party"))}
              {head("family", t("col.family"))}
              {head("label", t("col.label"))}
              {head("amount", t("col.amount"), "num")}
              {statement && <th className="num col-balance">{t("col.balance")}</th>}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {sorted.map((r) => {
              const a = amount(r);
              return (
                <tr
                  key={r.id}
                  className={r.id === sel ? "selected" : ""}
                  onClick={() => select(r.id)}
                  onDoubleClick={() => openTx(toInput(r))}
                >
                  <td className="icon-col" title={statusLabel(t, r.status) + (r.chequeNo ? ` · ${t("col.cheque")} ${r.chequeNo}` : "")}>
                    {r.status === "pending" ? "⏳" : r.chequeNo ? "🧾" : ""}
                  </td>
                  {show("num") && <td className="num muted">{r.id}</td>}
                  {show("date") && <td className="clip">{r.date.split("-").reverse().join("/")}</td>}
                  {showType && (
                    <td className="clip">
                      <span className={`chip k-${r.kind}`}>{kindLabel(t, r.kind)}</span>
                    </td>
                  )}
                  {show("account") && (
                    <td className="clip" title={r.lines.map((l) => `${l.accountName} ${fmt(l.amount, { sign: true })}`).join("\n")}>
                      {r.lines.length ? accountText(r) : <span className="muted">{t("journal.onCredit")}</span>}
                    </td>
                  )}
                  {show("chantier") && <td className="clip">{chantierNames(r)}</td>}
                  {show("party") && <td className="clip">{r.partyName}</td>}
                  {show("family") && <td className="clip">{r.family}</td>}
                  {show("label") && (
                    <td className="clip label-col" title={r.notes ?? undefined}>
                      {r.label}
                    </td>
                  )}
                  {show("amount") && <td className={`num strong clip ${a < 0 ? "neg" : ""}`}>{fmt(a)}</td>}
                  {statement && (
                    <td className="num clip">{balanceLabel ? balanceLabel(r.runningBalance ?? 0) : fmt(r.runningBalance ?? 0)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && <Empty>{emptyText ?? t("c.empty")}</Empty>}
      </div>
      <div className="grid-foot">
        <span>{t("c.count", { n: sorted.length })}</span>
        {!statement && (
          <span>
            {t("c.total")} <strong className={total < 0 ? "neg" : ""}>{fmt(total)}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
