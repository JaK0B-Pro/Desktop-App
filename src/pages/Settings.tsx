import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { KIND_LABEL } from "../components/labels";
import { Empty, Field } from "../components/Modal";
import type { Suggestion } from "../types";

export function Settings() {
  const { settings, updateSetting, fmt, toast, fail, confirm, version, refresh } = useApp();
  const [labels, setLabels] = useState<Suggestion[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.listLearnedLabels().then(setLabels).catch(fail);
  }, [version, fail]);

  async function forget(s: Suggestion) {
    if (!(await confirm(`Forget “${s.label}”? It will not be suggested anymore (your transactions are kept).`, "Forget"))) return;
    try {
      await api.forgetLabel(s.key);
      setLabels((l) => l.filter((x) => x.key !== s.key));
    } catch (e) {
      fail(e);
    }
  }

  async function run<T>(fn: () => Promise<T>, msg: (v: T) => string) {
    try {
      toast(msg(await fn()));
    } catch (e) {
      fail(e);
    }
  }

  const shown = labels.filter((l) => !q || l.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
      </header>

      <section className="card">
        <h3>Currency</h3>
        <div className="grid-3">
          <Field label="Symbol" hint="e.g. $, €, DA, DH, ر.س">
            <input
              className="input"
              value={settings.currency_symbol ?? ""}
              onChange={(e) => updateSetting("currency_symbol", e.target.value).catch(fail)}
            />
          </Field>
          <Field label="Position">
            <select
              className="input"
              value={settings.currency_position ?? "before"}
              onChange={(e) => updateSetting("currency_position", e.target.value).catch(fail)}
            >
              <option value="before">Before the amount</option>
              <option value="after">After the amount</option>
            </select>
          </Field>
          <Field label="Decimals" hint="Set this before entering data">
            <select
              className="input"
              value={settings.decimals ?? "2"}
              onChange={async (e) => {
                if (await confirm("Changing decimals re-interprets all stored amounts. Only do this before entering data. Continue?", "Change"))
                  updateSetting("decimals", e.target.value).catch(fail);
              }}
            >
              <option value="0">0 (1234)</option>
              <option value="2">2 (1234.56)</option>
              <option value="3">3 (1234.567)</option>
            </select>
          </Field>
        </div>
        <p className="muted small">Preview: {fmt(123456789)}</p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>Smart labels — what the app has learned</h3>
            <p className="muted small">
              Every label you save is remembered with how often you use it, the beneficiary, the amount and the account
              split. Suggestions get better the more you use the app.
            </p>
          </div>
          <button
            className="btn small"
            onClick={() =>
              run(
                async () => {
                  const n = await api.relearnLabels();
                  await refresh();
                  return n;
                },
                (n) => `Re-learned from ${n} transactions`,
              )
            }
          >
            Re-learn from history
          </button>
        </div>
        <input className="input" placeholder="Filter learned labels…" value={q} onChange={(e) => setQ(e.target.value)} />
        {shown.length === 0 ? (
          <Empty>Nothing learned yet — save a few transactions.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Usually</th>
                <th className="num">Uses</th>
                <th className="num">Avg amount</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.key}>
                  <td className="strong">{s.label}</td>
                  <td>{s.lastKind && <span className={`chip k-${s.lastKind}`}>{KIND_LABEL[s.lastKind]}</span>}</td>
                  <td className="num">{s.uses}</td>
                  <td className="num">{s.avgAmount != null ? fmt(s.avgAmount) : "—"}</td>
                  <td>{s.lastUsed.slice(0, 10)}</td>
                  <td className="actions">
                    <button className="btn small ghost" onClick={() => forget(s)}>
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>Data</h3>
        <p className="muted small">Files are saved in your Documents/AccountBook folder.</p>
        <div className="row">
          <button className="btn" onClick={() => run(api.exportCsv, (p) => `Exported to ${p}`)}>
            Export transactions (CSV / Excel)
          </button>
          <button className="btn" onClick={() => run(api.backupDatabase, (p) => `Backup saved to ${p}`)}>
            Back up database
          </button>
        </div>
      </section>
    </div>
  );
}
