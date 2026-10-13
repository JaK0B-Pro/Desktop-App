import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApp, type JournalKind, type TxChange } from "../context";
import { FilterButton, RangeFilter, ValueFilter, type FilterOption } from "../components/ColumnFilter";
import { cashSign, chantierNames, toInput, TxGrid, type SortKey } from "../components/TransactionTable";
import { kindLabel, statusLabel } from "../components/labels";
import { printList, printVoucher } from "../print";
import type { Transaction, TxKind, TxStatus } from "../types";

type SetKey = "type" | "month" | "account" | "chantier" | "party" | "family" | "label" | "status";

interface Filters {
  sets: Partial<Record<SetKey, Set<string>>>;
  amount: [number | null, number | null];
  num: [number | null, number | null];
}

const NO_FILTERS: Filters = { sets: {}, amount: [null, null], num: [null, null] };

/** Values of a row for each value filter (a row can have several accounts or chantiers). */
function keysOf(r: Transaction, k: SetKey): string[] {
  switch (k) {
    case "type":
      return [r.kind];
    case "month":
      return [r.date.slice(0, 7)];
    case "account":
      return r.lines.length ? [...new Set(r.lines.map((l) => String(l.accountId)))] : [""];
    case "chantier": {
      const ids = new Set([r.chantierId, ...r.lines.map((l) => l.chantierId)].filter((x): x is number => x != null).map(String));
      return ids.size ? [...ids] : [""];
    }
    case "party":
      return [r.partyId != null ? String(r.partyId) : ""];
    case "family":
      return [r.family ?? ""];
    case "label":
      return [r.label.toLowerCase()];
    case "status":
      return [r.status];
  }
}

const inKind = (kind: JournalKind, k: TxKind) =>
  kind === "all" || (kind === "credit" ? k === "purchase" || k === "sale" : k === kind);

/** Applies a saved/deleted entry to the loaded list (keeps date desc, number desc order). */
function patch(rows: Transaction[], c: TxChange, kind: JournalKind, from: string, to: string): Transaction[] {
  const id = c.saved?.id ?? c.deletedId;
  const out = rows.filter((r) => r.id !== id);
  const s = c.saved;
  if (s && inKind(kind, s.kind) && s.date >= from && s.date <= to) {
    const i = out.findIndex((r) => r.date < s.date || (r.date === s.date && r.id < s.id));
    out.splice(i < 0 ? out.length : i, 0, s);
  }
  return out;
}

/** One journal window: Dépenses, Versements, Virements, Crédits or everything. */
export function Journal({ kind }: { kind: JournalKind }) {
  const {
    fail,
    accounts,
    parties,
    chantiers,
    openTx,
    range,
    t,
    lang,
    settings,
    money,
    fmt,
    confirm,
    toast,
    notifyDeleted,
    txChange,
    reloadKey,
    canEdit,
    isClosed,
    exercise,
  } = useApp();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<number | null>(null);
  const deferredSearch = useDeferredValue(search);
  const seenChange = useRef(txChange.seq);

  // A new fiscal year resets the period to that year.
  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range]);

  // Load the whole period once; all filtering then happens instantly in memory.
  useEffect(() => {
    if (!from || !to || from > to) return;
    let cancelled = false;
    const started = performance.now();
    const serverKind = kind === "all" || kind === "credit" ? null : kind;
    api
      .listTransactions({ from, to, kind: serverKind })
      .then((r) => {
        if (cancelled) return;
        setRows(kind === "credit" ? r.filter((x) => x.kind === "purchase" || x.kind === "sale") : r);
        setLoadMs(Math.round(performance.now() - started));
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [from, to, kind, reloadKey, fail]);

  // Saves and deletions patch the list in place (no reload of the year).
  useEffect(() => {
    if (txChange.seq === seenChange.current) return;
    seenChange.current = txChange.seq;
    setRows((rs) => patch(rs, txChange, kind, from, to));
  }, [txChange, kind, from, to]);

  // Lower-cased text of each row for the search box (computed once per load).
  const haystack = useMemo(() => {
    const m = new Map<number, string>();
    const div = 10 ** money.decimals;
    for (const r of rows) {
      m.set(
        r.id,
        [
          r.id,
          r.date.split("-").reverse().join("/"),
          r.label,
          r.partyName,
          chantierNames(r),
          r.family,
          r.notes,
          r.chequeNo,
          r.chequePayee,
          r.lines.map((l) => l.accountName).join(" "),
          (r.amount / div).toFixed(money.decimals),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      );
    }
    return m;
  }, [rows, money.decimals]);

  const amountOf = useMemo(() => (kind === "all" ? cashSign : (r: Transaction) => r.amount), [kind]);

  /** Rows passing every filter except `skip` (used to list the choices of one column). */
  const filterRows = useMemo(() => {
    const words = deferredSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (skip?: SetKey | "amount" | "num") =>
      rows.filter((r) => {
        if (words.length) {
          const h = haystack.get(r.id) ?? "";
          if (!words.every((w) => h.includes(w))) return false;
        }
        for (const [k, set] of Object.entries(filters.sets) as [SetKey, Set<string>][]) {
          if (k === skip || !set) continue;
          if (!keysOf(r, k).some((v) => set.has(v))) return false;
        }
        if (skip !== "amount") {
          const [lo, hi] = filters.amount;
          if ((lo != null && r.amount < lo) || (hi != null && r.amount > hi)) return false;
        }
        if (skip !== "num") {
          const [lo, hi] = filters.num;
          if ((lo != null && r.id < lo) || (hi != null && r.id > hi)) return false;
        }
        return true;
      });
  }, [rows, haystack, filters, deferredSearch]);

  const shown = useMemo(() => filterRows(), [filterRows]);
  const current = rows.find((r) => r.id === selected) ?? null;

  const setSet = (k: SetKey, s: Set<string> | null) =>
    setFilters((f) => {
      const sets = { ...f.sets };
      if (s) sets[k] = s;
      else delete sets[k];
      return { ...f, sets };
    });

  // Choices of a column with count, total and (for beneficiaries) their balance.
  function options(k: SetKey): FilterOption[] {
    const base = filterRows(k);
    const map = new Map<string, FilterOption>();
    for (const r of base) {
      for (const key of keysOf(r, k)) {
        let o = map.get(key);
        if (!o) map.set(key, (o = { key, label: optionLabel(k, key, r), count: 0, total: 0 }));
        o.count++;
        o.total += amountOf(r);
      }
    }
    // Keep already selected values visible even if other filters hide them now.
    for (const key of filters.sets[k] ?? [])
      if (!map.has(key)) map.set(key, { key, label: optionLabel(k, key), count: 0, total: 0 });
    const list = [...map.values()];
    if (k === "party")
      for (const o of list) {
        const p = parties.find((x) => String(x.id) === o.key);
        if (p && p.balance !== 0) {
          o.note = p.balance > 0 ? t("pt.balOwesYou", { v: fmt(p.balance) }) : t("pt.balYouOwe", { v: fmt(-p.balance) });
          o.noteClass = p.balance > 0 ? "pos" : "neg";
        }
      }
    return k === "month"
      ? list.sort((a, b) => a.key.localeCompare(b.key))
      : list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function optionLabel(k: SetKey, key: string, r?: Transaction): string {
    if (key === "") return "";
    switch (k) {
      case "type":
        return kindLabel(t, key as TxKind);
      case "status":
        return statusLabel(t, key as TxStatus);
      case "month": {
        const [y, m] = key.split("-").map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { month: "long", year: "numeric" });
      }
      case "account":
        return accounts.find((a) => String(a.id) === key)?.name ?? key;
      case "chantier":
        return chantiers.find((c) => String(c.id) === key)?.name ?? key;
      case "party":
        return parties.find((p) => String(p.id) === key)?.name ?? key;
      case "label":
        return r?.label ?? key;
      default:
        return key;
    }
  }

  const headKey: Partial<Record<SortKey | "type", SetKey>> = {
    date: "month",
    type: "type",
    account: "account",
    chantier: "chantier",
    party: "party",
    family: "family",
    label: "label",
  };

  const headerExtra = (col: SortKey | "type") => {
    if (col === "amount" || col === "num") {
      const [lo, hi] = filters[col];
      return (
        <FilterButton active={lo != null || hi != null}>
          {(close) => (
            <RangeFilter
              min={lo}
              max={hi}
              money={col === "amount"}
              onChange={(a, b) => setFilters((f) => ({ ...f, [col]: [a, b] }))}
              onDone={close}
            />
          )}
        </FilterButton>
      );
    }
    const k = headKey[col];
    if (!k) return null;
    return (
      <FilterButton active={!!filters.sets[k]}>
        {() => <ValueFilter options={options(k)} selected={filters.sets[k] ?? null} onChange={(s) => setSet(k, s)} />}
      </FilterButton>
    );
  };

  // Active filters as removable chips.
  const chips: { label: string; clear: () => void }[] = [];
  for (const [k, set] of Object.entries(filters.sets) as [SetKey, Set<string>][]) {
    const names = [...set].map(
      (v) =>
        optionLabel(
          k,
          v,
          rows.find((r) => keysOf(r, k).includes(v)),
        ) || t("flt.empty"),
    );
    chips.push({
      label: `${colName(k)} : ${names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") : "∅"}`,
      clear: () => setSet(k, null),
    });
  }
  for (const k of ["amount", "num"] as const) {
    const [lo, hi] = filters[k];
    if (lo == null && hi == null) continue;
    const f = (v: number | null) => (v == null ? "…" : k === "amount" ? fmt(v) : String(v));
    chips.push({
      label: `${k === "amount" ? t("col.amount") : t("col.num")} : ${f(lo)} – ${f(hi)}`,
      clear: () => setFilters((x) => ({ ...x, [k]: [null, null] })),
    });
  }
  function colName(k: SetKey) {
    const m: Record<SetKey, string> = {
      type: t("col.type"),
      month: t("col.date"),
      account: t("col.account"),
      chantier: t("col.chantier"),
      party: t("col.party"),
      family: t("col.family"),
      label: t("col.label"),
      status: t("col.status"),
    };
    return m[k];
  }

  const newKind: TxKind = kind === "credit" ? "purchase" : kind === "all" ? "expense" : kind;
  const title = t(`journal.title.${kind}`);
  const pctx = { t, lang, settings, decimals: money.decimals, fmt };
  const locked = isClosed(exercise);

  async function remove() {
    if (!current) return fail(t("journal.selectFirst"));
    if (!(await confirm(t("c.confirmDelete", { name: `${current.id} · ${current.label} (${fmt(current.amount)})` })))) return;
    try {
      await api.deleteTransaction(current.id);
      toast(t("c.deleted"));
      setSelected(null);
      await notifyDeleted(current.id);
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="page journal">
      <div className="window">
        <div className="window-title">
          {title}
          {locked && <span className="locked-badge">🔒 {t("ex.locked", { year: exercise })}</span>}
        </div>
        <div className="toolbar">
          {canEdit && (
            <button className="btn primary" disabled={locked} onClick={() => openTx({ kind: newKind })}>
              {t("c.add")}
            </button>
          )}
          <button className="btn" onClick={() => (current ? openTx(toInput(current)) : fail(t("journal.selectFirst")))}>
            {canEdit ? t("c.edit") : t("hist.open")}
          </button>
          {canEdit && (
            <button className="btn" onClick={remove} disabled={!!current && isClosed(current.date)}>
              {t("c.delete")}
            </button>
          )}
          <button className="btn" onClick={() => printList(pctx, title, from, to, shown, amountOf)}>
            🖨 {t("c.print")}
          </button>
          {current && (
            <button className="btn ghost" onClick={() => printVoucher(pctx, current)} title={t("form.printVoucher")}>
              🧾 N° {current.id}
            </button>
          )}
          <span className="toolbar-sep" />
          <label className="inline-field">
            {t("app.from")}
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inline-field">
            {t("app.to")}
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div className="filters">
          <input
            className="input grow"
            placeholder={`${t("c.search")}  (N°, ${t("col.label").toLowerCase()}, ${t("col.party").toLowerCase()}, ${t("col.chantier").toLowerCase()}, ${t("col.amount").toLowerCase()}…)`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {chips.map((c) => (
            <button key={c.label} className="filter-chip" onClick={c.clear} title={t("flt.clear")}>
              {c.label} ✕
            </button>
          ))}
          {(chips.length > 0 || search) && (
            <button
              className="btn ghost small"
              onClick={() => {
                setFilters(NO_FILTERS);
                setSearch("");
              }}
            >
              {t("flt.clear")}
            </button>
          )}
        </div>
        <TxGrid
          rows={shown}
          amountOf={amountOf}
          showType={kind === "all" || kind === "credit"}
          hide={kind === "transfer" ? ["chantier", "party", "family"] : []}
          selectedId={selected}
          onSelect={setSelected}
          headerExtra={headerExtra}
          footerExtra={
            loadMs != null && (
              <span className="muted small load-time">
                {" "}
                · {t("flt.loaded", { n: rows.length.toLocaleString("fr-FR"), ms: loadMs })}
              </span>
            )
          }
        />
        <p className="muted small hint">{t("journal.hint")}</p>
      </div>
    </div>
  );
}
