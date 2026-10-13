import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Empty } from "../components/Modal";
import { toInput } from "../components/TransactionTable";
import { diffTx, formatAt } from "../components/TxHistory";
import type { AuditEntry } from "../types";

/** The change log ("historique"): who created, changed or deleted which entry, and when. */
export function History() {
  const { t, fmt, fail, openTx, canEdit, reloadAll, notifySaved, toast, txChange, reloadKey } = useApp();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [onlyTx, setOnlyTx] = useState(true);
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(500);

  useEffect(() => {
    api.listAudit({ limit }).then(setRows).catch(fail);
  }, [limit, txChange.seq, reloadKey, fail]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!onlyTx || r.entity === "transaction") &&
        (!s ||
          `${r.entityId} ${r.username} ${r.summary} ${r.before?.label ?? ""} ${r.after?.label ?? ""}`.toLowerCase().includes(s)),
    );
  }, [rows, onlyTx, q]);

  async function open(r: AuditEntry) {
    if (r.entity !== "transaction" || r.entityId == null) return;
    try {
      openTx(toInput(await api.getTransaction(r.entityId)));
    } catch (e) {
      fail(e);
    }
  }

  async function restore(r: AuditEntry) {
    try {
      const tx = await api.restoreTransaction(r.id);
      toast(t("hist.restored", { n: tx.id }));
      await notifySaved(tx);
      await reloadAll();
    } catch (e) {
      fail(e);
    }
  }

  const describe = (r: AuditEntry) => {
    const tx = r.after ?? r.before;
    if (r.entity === "transaction" && tx)
      return `${tx.date.split("-").reverse().join("/")} · ${t(`kind.${tx.kind}`)} · ${tx.label} · ${fmt(tx.amount)}`;
    return r.summary;
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>🕘 {t("hist.title")}</h1>
          <p className="muted">{t("hist.subtitle")}</p>
        </div>
      </header>
      <div className="filters">
        <input className="input grow" placeholder={t("c.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyTx} onChange={(e) => setOnlyTx(e.target.checked)} /> {t("hist.onlyTx")}
        </label>
      </div>
      <section className="card flush">
        {shown.length === 0 ? (
          <Empty>{t("hist.none")}</Empty>
        ) : (
          <table className="table grid history">
            <thead>
              <tr>
                <th>{t("hist.at")}</th>
                <th>{t("hist.user")}</th>
                <th>{t("hist.action")}</th>
                <th className="num">{t("col.num")}</th>
                <th>{t("hist.details")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onDoubleClick={() => r.exists && open(r)}>
                  <td className="nowrap">{formatAt(r.at)}</td>
                  <td>{r.username ?? "—"}</td>
                  <td>
                    <span className={`chip act-${r.action}`}>{t(`hist.act.${r.action}`)}</span>
                  </td>
                  <td className="num muted">{r.entity === "transaction" ? r.entityId : ""}</td>
                  <td>
                    <div>{describe(r)}</div>
                    {diffTx(t, fmt, r.before, r.after).map((c) => (
                      <div key={c} className="muted small">
                        {c}
                      </div>
                    ))}
                  </td>
                  <td className="actions">
                    {r.entity === "transaction" && r.exists && (
                      <button className="btn small" onClick={() => open(r)}>
                        {t("hist.open")}
                      </button>
                    )}
                    {r.entity === "transaction" && r.action === "delete" && !r.exists && canEdit && (
                      <button className="btn small" onClick={() => restore(r)}>
                        ↺ {t("hist.restore")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {rows.length >= limit && (
        <button className="btn ghost" onClick={() => setLimit((l) => l + 1000)}>
          …
        </button>
      )}
    </div>
  );
}
