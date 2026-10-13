import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/** Fixed row height: lets the grid draw only the visible rows (virtual scrolling). */
const ROW = 34;
const OVERSCAN = 12;

/**
 * Grid of transactions, modelled on a classic treasury journal:
 * N° · Date · Compte · Chantier · Bénéficiaire · Famille · Libellé · Montant, with a total row.
 *
 * Only the rows in view are rendered, so a whole year (10,000+ entries) scrolls smoothly.
 * Keyboard: ↑/↓/PageUp/PageDown/Home/End select, Enter edit, Delete delete. Double-click edits.
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
  headerExtra,
  footerExtra,
  variant,
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
  /** Extra content in a column header (filter buttons). */
  headerExtra?: (key: SortKey | "type") => ReactNode;
  footerExtra?: ReactNode;
  /** Extra class on the table (column layout variants). */
  variant?: string;
}) {
  const { fmt, openTx, notifyDeleted, toast, fail, confirm, t, canEdit, isClosed } = useApp();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [localSel, setLocalSel] = useState<number | null>(null);
  const sel = selectedId !== undefined ? selectedId : localSel;
  const select = (id: number | null) => (onSelect ? onSelect(id) : setLocalSel(id));
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  const amount = useMemo(() => amountOf ?? ((r: Transaction) => (statement ? (r.effect ?? 0) : r.amount)), [amountOf, statement]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const val = (r: Transaction): string | number => {
      switch (sort.key) {
        case "num":
          return r.id;
        case "date":
          return r.date + String(r.id).padStart(10, "0");
        case "account":
          return r.lines
            .map((l) => l.accountName)
            .join(", ")
            .toLowerCase();
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
    const keyed = rows.map((r) => [val(r), r] as const);
    keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = keyed.map((k) => k[1]);
    return sort.desc ? out.reverse() : out;
  }, [rows, sort, amount]);

  // Track the visible window of the scroll area.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(sorted.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const visible = sorted.slice(first, last);

  /** Scrolls so that row `i` is fully visible (works even if it is not rendered yet). */
  function reveal(i: number) {
    const el = scrollRef.current;
    if (!el) return;
    const head = headRef.current?.offsetHeight ?? ROW;
    const top = i * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight - head) el.scrollTop = top + ROW - el.clientHeight + head;
  }

  async function remove(row: Transaction) {
    if (!canEdit || isClosed(row.date)) return;
    if (!(await confirm(t("c.confirmDelete", { name: `${row.id} · ${row.label} (${fmt(row.amount)})` })))) return;
    try {
      await api.deleteTransaction(row.id);
      toast(t("c.deleted"));
      select(null);
      await notifyDeleted(row.id);
    } catch (e) {
      fail(e);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!sorted.length || (e.target as HTMLElement).closest("input, select, .col-filter-pop")) return;
    const i = sorted.findIndex((r) => r.id === sel);
    const page = Math.max(1, Math.floor((view.height - ROW) / ROW));
    const go = (j: number) => {
      e.preventDefault();
      const k = Math.min(Math.max(j, 0), sorted.length - 1);
      select(sorted[k].id);
      reveal(k);
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "PageDown") go(i + page);
    else if (e.key === "PageUp") go(i - page);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(sorted.length - 1);
    else if (e.key === "Enter" && i >= 0) {
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
      <th className={`col-${key} ${cls}`}>
        <span
          className="sortable"
          onClick={() => setSort((s) => (s?.key === key ? (s.desc ? null : { key, desc: true }) : { key, desc: false }))}
        >
          {label}
          {sort?.key === key ? (sort.desc ? " ▼" : " ▲") : ""}
        </span>
        {headerExtra?.(key)}
      </th>
    ) : null;

  const total = useMemo(() => sorted.reduce((s, r) => s + amount(r), 0), [sorted, amount]);
  const accountText = (r: Transaction) =>
    r.kind === "transfer"
      ? `${r.lines
          .filter((l) => l.amount < 0)
          .map((l) => l.accountName)
          .join(", ")} → ${r.lines
          .filter((l) => l.amount > 0)
          .map((l) => l.accountName)
          .join(", ")}`
      : r.lines.map((l) => l.accountName).join(", ");
  const colCount =
    3 +
    (showType ? 1 : 0) +
    (["account", "chantier", "party", "family", "label", "amount"] as SortKey[]).filter(show).length +
    (statement ? 1 : 0);

  return (
    <div className="grid-wrap" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="grid-scroll" ref={scrollRef}>
        <table className={`table grid fixed ${variant ?? ""}`}>
          <thead ref={headRef}>
            <tr>
              <th className="icon-col" />
              {head("num", t("col.num"), "num")}
              {head("date", t("col.date"))}
              {showType && (
                <th className="col-type">
                  {t("col.type")}
                  {headerExtra?.("type")}
                </th>
              )}
              {head("account", t("col.account"))}
              {head("chantier", t("col.chantier"))}
              {head("party", t("col.party"))}
              {head("family", t("col.family"))}
              {head("label", t("col.label"))}
              {head("amount", t("col.amount"), "num")}
              {statement && <th className="num col-balance">{t("col.balance")}</th>}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr className="spacer" style={{ height: first * ROW }}>
                <td colSpan={colCount} />
              </tr>
            )}
            {visible.map((r) => {
              const a = amount(r);
              const locked = isClosed(r.date);
              return (
                <tr
                  key={r.id}
                  className={r.id === sel ? "selected" : ""}
                  onClick={() => select(r.id)}
                  onDoubleClick={() => openTx(toInput(r))}
                >
                  <td
                    className="icon-col"
                    title={statusLabel(t, r.status) + (r.chequeNo ? ` · ${t("col.cheque")} ${r.chequeNo}` : "")}
                  >
                    {locked ? "🔒" : r.status === "pending" ? "⏳" : r.chequeNo ? "🧾" : ""}
                  </td>
                  {show("num") && <td className="num muted">{r.id}</td>}
                  {show("date") && <td className="clip">{r.date.split("-").reverse().join("/")}</td>}
                  {showType && (
                    <td className="clip">
                      <span className={`chip k-${r.kind}`}>{kindLabel(t, r.kind)}</span>
                    </td>
                  )}
                  {show("account") && (
                    <td
                      className="clip"
                      title={r.lines.map((l) => `${l.accountName} ${fmt(l.amount, { sign: true })}`).join("\n")}
                    >
                      {r.lines.length ? accountText(r) : <span className="muted">{t("journal.onCredit")}</span>}
                    </td>
                  )}
                  {show("chantier") && <td className="clip">{chantierNames(r)}</td>}
                  {show("party") && <td className="clip">{r.partyName}</td>}
                  {show("family") && <td className="clip">{r.family}</td>}
                  {show("label") && (
                    <td className="clip label-col" title={r.notes ?? r.label}>
                      {r.label}
                    </td>
                  )}
                  {show("amount") && <td className={`num strong clip ${a < 0 ? "neg" : ""}`}>{fmt(a)}</td>}
                  {statement && (
                    <td className="num clip">
                      {balanceLabel ? balanceLabel(r.runningBalance ?? 0) : fmt(r.runningBalance ?? 0)}
                    </td>
                  )}
                </tr>
              );
            })}
            {last < sorted.length && (
              <tr className="spacer" style={{ height: (sorted.length - last) * ROW }}>
                <td colSpan={colCount} />
              </tr>
            )}
          </tbody>
        </table>
        {sorted.length === 0 && <Empty>{emptyText ?? t("c.empty")}</Empty>}
      </div>
      <div className="grid-foot">
        <span>
          {t("c.count", { n: sorted.length.toLocaleString("fr-FR") })}
          {footerExtra}
        </span>
        {!statement && (
          <span>
            {t("c.total")} <strong className={total < 0 ? "neg" : ""}>{fmt(total)}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
