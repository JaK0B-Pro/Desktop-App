import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { T } from "../i18n";
import type { AuditEntry, Transaction } from "../types";

const at = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const formatAt = at;

/** Human-readable list of what changed between two versions of an entry. */
export function diffTx(t: T, fmt: (c: number) => string, a?: Transaction, b?: Transaction): string[] {
  if (!a || !b) return [];
  const out: string[] = [];
  const cmp = (
    field: string,
    x: unknown,
    y: unknown,
    show: (v: unknown) => string = (v) => (v == null || v === "" ? "—" : String(v)),
  ) => {
    if ((x ?? null) !== (y ?? null)) out.push(t("hist.changed", { field, from: show(x), to: show(y) }));
  };
  const d = (v: unknown) => (typeof v === "string" ? v.split("-").reverse().join("/") : "—");
  const accounts = (x: Transaction) => x.lines.map((l) => `${l.accountName} ${fmt(Math.abs(l.amount))}`).join(", ");
  cmp(t("col.date"), a.date, b.date, d);
  cmp(t("col.type"), t(`kind.${a.kind}`), t(`kind.${b.kind}`));
  cmp(t("col.label"), a.label, b.label);
  cmp(t("col.amount"), a.amount, b.amount, (v) => fmt(Number(v)));
  cmp(t("col.account"), accounts(a), accounts(b));
  cmp(t("col.chantier"), a.chantierName, b.chantierName);
  cmp(t("col.party"), a.partyName, b.partyName);
  cmp(t("col.family"), a.family, b.family);
  cmp(t("col.status"), t(`status.${a.status}`), t(`status.${b.status}`));
  cmp(t("form.chequeNo"), a.chequeNo, b.chequeNo);
  cmp(t("c.notes"), a.notes, b.notes);
  return out;
}

/** History of one entry, shown inside the edit window. */
export function TxHistory({ id }: { id: number }) {
  const { t, fmt, fail, txChange } = useApp();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.listAudit({ entityId: id, limit: 100 }).then(setRows).catch(fail);
  }, [id, txChange.seq, fail]);
  if (!rows.length) return null;
  return (
    <div className="tx-history">
      <button type="button" className="link small" onClick={() => setOpen((o) => !o)}>
        🕘 {t("hist.show", { n: rows.length })} {open ? "▴" : "▾"}
      </button>
      {open && (
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              <span className={`chip act-${r.action}`}>{t(`hist.act.${r.action}`)}</span> {at(r.at)} ·{" "}
              <strong>{r.username ?? "—"}</strong>
              {diffTx(t, fmt, r.before, r.after).map((c) => (
                <div key={c} className="muted small">
                  {c}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
