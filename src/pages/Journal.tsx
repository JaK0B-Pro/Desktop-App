import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp, type JournalKind } from "../context";
import { cashSign, toInput, TxGrid } from "../components/TransactionTable";
import { kindLabel, STATUSES, statusLabel, TX_KINDS } from "../components/labels";
import { printList, printVoucher } from "../print";
import type { Transaction, TxFilter, TxKind } from "../types";

/** One journal window: Dépenses, Versements, Virements, Crédits or everything. */
export function Journal({ kind }: { kind: JournalKind }) {
  const { version, fail, accounts, parties, chantiers, families, openTx, range, t, lang, settings, money, fmt, confirm, toast, refresh } =
    useApp();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [filter, setFilter] = useState<TxFilter>({});
  const [typeFilter, setTypeFilter] = useState<TxKind | "">("");
  const [rows, setRows] = useState<Transaction[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  // A new fiscal year resets the period to that year.
  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range]);

  useEffect(() => {
    const kindFilter = kind === "all" ? typeFilter || null : kind === "credit" ? typeFilter || null : kind;
    const q: TxFilter = { ...filter, from, to, kind: kindFilter };
    const h = setTimeout(
      () =>
        api
          .listTransactions(q)
          .then((r) => setRows(kind === "credit" ? r.filter((x) => x.kind === "purchase" || x.kind === "sale") : r))
          .catch(fail),
      120,
    );
    return () => clearTimeout(h);
  }, [filter, from, to, kind, typeFilter, version, fail]);

  const set = (patch: Partial<TxFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const amountOf = useMemo(() => (kind === "all" ? cashSign : (r: Transaction) => r.amount), [kind]);
  const current = rows.find((r) => r.id === selected) ?? null;
  const newKind: TxKind = kind === "all" || kind === "credit" ? (kind === "credit" ? "purchase" : "expense") : kind;
  const title = t(`journal.title.${kind}`);
  const hasFilter = Object.values(filter).some((v) => v != null && v !== "") || typeFilter;
  const pctx = { t, lang, settings, decimals: money.decimals, fmt };

  async function remove() {
    if (!current) return fail(t("journal.selectFirst"));
    if (!(await confirm(t("c.confirmDelete", { name: `${current.id} · ${current.label} (${fmt(current.amount)})` })))) return;
    try {
      await api.deleteTransaction(current.id);
      toast(t("c.deleted"));
      setSelected(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="page journal">
      <div className="window">
        <div className="window-title">{title}</div>
        <div className="toolbar">
          <button className="btn primary" onClick={() => openTx({ kind: newKind })}>
            {t("c.add")}
          </button>
          <button className="btn" onClick={() => (current ? openTx(toInput(current)) : fail(t("journal.selectFirst")))}>
            {t("c.edit")}
          </button>
          <button className="btn" onClick={remove}>
            {t("c.delete")}
          </button>
          <button className="btn" onClick={() => printList(pctx, title, from, to, rows, amountOf)}>
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
            placeholder={t("c.search")}
            value={filter.search ?? ""}
            onChange={(e) => set({ search: e.target.value })}
          />
          {(kind === "all" || kind === "credit") && (
            <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TxKind | "")}>
              <option value="">{t("journal.allTypes")}</option>
              {TX_KINDS.filter((k) => kind === "all" || k === "purchase" || k === "sale").map((k) => (
                <option key={k} value={k}>
                  {kindLabel(t, k)}
                </option>
              ))}
            </select>
          )}
          {kind !== "credit" && (
            <select
              className="input"
              value={filter.accountId ?? ""}
              onChange={(e) => set({ accountId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{t("journal.allAccounts")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {kind !== "transfer" && (
            <>
              <select
                className="input"
                value={filter.chantierId ?? ""}
                onChange={(e) => set({ chantierId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{t("journal.allChantiers")}</option>
                {chantiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={filter.partyId ?? ""}
                onChange={(e) => set({ partyId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">{t("journal.allParties")}</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select className="input" value={filter.family ?? ""} onChange={(e) => set({ family: e.target.value || null })}>
                <option value="">{t("journal.allFamilies")}</option>
                {families.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <select className="input" value={filter.status ?? ""} onChange={(e) => set({ status: e.target.value || null })}>
            <option value="">{t("journal.allStatus")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(t, s)}
              </option>
            ))}
          </select>
          {hasFilter && (
            <button
              className="btn ghost"
              onClick={() => {
                setFilter({});
                setTypeFilter("");
              }}
            >
              ✕
            </button>
          )}
        </div>
        <TxGrid
          rows={rows}
          amountOf={amountOf}
          showType={kind === "all" || kind === "credit"}
          hide={kind === "transfer" ? ["chantier", "party", "family"] : []}
          selectedId={selected}
          onSelect={setSelected}
        />
        <p className="muted small hint">{t("journal.hint")}</p>
      </div>
    </div>
  );
}
