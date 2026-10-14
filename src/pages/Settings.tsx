import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { kindLabel } from "../components/labels";
import { ChangePassword } from "../components/TopBar";
import { Users } from "../components/Users";
import { Empty, Field } from "../components/Modal";
import { printCheque } from "../print";
import { today } from "../money";
import type { Suggestion } from "../types";

export function Settings() {
  const { settings, updateSetting, fmt, toast, fail, confirm, version, refresh, t, lang, money, isAdmin, canEdit, user } =
    useApp();
  const [pwd, setPwd] = useState(false);
  const [labels, setLabels] = useState<Suggestion[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.listLearnedLabels().then(setLabels).catch(fail);
  }, [version, fail]);

  const text = (key: string, label: string, hint?: string, type = "text") => (
    <Field label={label} hint={hint}>
      <input
        className="input"
        type={type}
        value={settings[key] ?? ""}
        disabled={!isAdmin}
        onChange={(e) => updateSetting(key, e.target.value).catch(fail)}
      />
    </Field>
  );

  async function forget(s: Suggestion) {
    if (!(await confirm(t("set.forgetConfirm", { label: s.label }), t("c.forget")))) return;
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
        <h1>{t("nav.settings")}</h1>
      </header>

      {!isAdmin && <p className="muted small">🔒 {t("set.adminOnly")}</p>}
      <section className="card company-card">
        <h3>🏢 {t("set.company")}</h3>
        <div className="grid-3">
          {text("company_name", t("set.companyName"))}
          {text("company_activity", t("set.companyActivity"))}
          {text("company_address", t("set.companyAddress"))}
          {text("company_phone", t("set.companyPhone"))}
          {text("company_email", t("set.companyEmail"))}
          {text("company_id", t("set.companyId"))}
          <Field label={t("set.language")}>
            <select
              className="input"
              disabled={!isAdmin}
              value={lang}
              onChange={(e) => updateSetting("language", e.target.value).catch(fail)}
            >
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>{t("set.myAccount")}</h3>
            <p className="muted small">
              {user.fullName || user.username} · {t(`usr.role.${user.role}`)}
            </p>
          </div>
          <button className="btn small" onClick={() => setPwd(true)}>
            🔑 {t("auth.changePassword")}
          </button>
        </div>
      </section>
      {pwd && <ChangePassword onClose={() => setPwd(false)} />}

      <section className="card">
        <h3>{t("set.currency")}</h3>
        <div className="grid-3">
          {text("currency_symbol", t("set.symbol"), t("set.symbolHint"))}
          <Field label={t("set.position")}>
            <select
              className="input"
              value={settings.currency_position ?? "after"}
              disabled={!isAdmin}
              onChange={(e) => updateSetting("currency_position", e.target.value).catch(fail)}
            >
              <option value="before">{t("set.before")}</option>
              <option value="after">{t("set.after")}</option>
            </select>
          </Field>
          <Field label={t("set.decimals")} hint={t("set.decimalsHint")}>
            <select
              className="input"
              value={settings.decimals ?? "2"}
              disabled={!isAdmin}
              onChange={async (e) => {
                const v = e.target.value;
                if (await confirm(t("set.decimalsConfirm"), t("c.change"))) updateSetting("decimals", v).catch(fail);
              }}
            >
              <option value="0">0 (1234)</option>
              <option value="2">2 (1234.56)</option>
              <option value="3">3 (1234.567)</option>
            </select>
          </Field>
          {text("currency_name", t("set.currencyName"))}
          {text("currency_subunit", t("set.currencySub"))}
        </div>
        <p className="muted small">{t("set.preview", { v: fmt(123456789) })}</p>
      </section>

      <section className="card">
        <h3>{t("set.cheque")}</h3>
        <p className="muted small">{t("set.chequeHint")}</p>
        <div className="grid-3">
          {text("cheque_city", t("set.chequeCity"))}
          {text("cheque_offset_x", t("set.chequeOffsetX"), undefined, "number")}
          {text("cheque_offset_y", t("set.chequeOffsetY"), undefined, "number")}
        </div>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.cheque_vertical === "1"}
              disabled={!isAdmin}
              onChange={(e) => updateSetting("cheque_vertical", e.target.checked ? "1" : "0").catch(fail)}
            />{" "}
            {t("set.chequeVertical")}
          </label>
          <button
            className="btn"
            onClick={() =>
              printCheque(
                { t, lang, settings, decimals: money.decimals, fmt },
                { amount: 828850, payee: "SARL EXEMPLE", date: today(), crossed: true },
              )
            }
          >
            🖨 {t("set.chequeTest")}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>{t("set.smart")}</h3>
            <p className="muted small">{t("set.smartHint")}</p>
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
                (n) => t("set.relearned", { n }),
              )
            }
          >
            {t("set.relearn")}
          </button>
        </div>
        <input className="input" placeholder={t("set.filterLearned")} value={q} onChange={(e) => setQ(e.target.value)} />
        {shown.length === 0 ? (
          <Empty>{t("set.nothingLearned")}</Empty>
        ) : (
          <table className="table grid">
            <thead>
              <tr>
                <th>{t("col.label")}</th>
                <th>{t("set.usually")}</th>
                <th>{t("col.family")}</th>
                <th className="num">{t("set.uses")}</th>
                <th className="num">{t("set.avg")}</th>
                <th>{t("set.lastUsed")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.key}>
                  <td className="strong">{s.label}</td>
                  <td>{s.lastKind && <span className={`chip k-${s.lastKind}`}>{kindLabel(t, s.lastKind)}</span>}</td>
                  <td>{s.lastFamily}</td>
                  <td className="num">{s.uses}</td>
                  <td className="num">{s.avgAmount != null ? fmt(s.avgAmount) : "—"}</td>
                  <td>{s.lastUsed.slice(0, 10).split("-").reverse().join("/")}</td>
                  <td className="actions">
                    <button className="btn small ghost" onClick={() => forget(s)}>
                      {t("c.forget")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {isAdmin && <Users />}

      <section className="card">
        <h3>{t("set.data")}</h3>
        <p className="muted small">{t("set.dataHint")}</p>
        <div className="row">
          <button className="btn" onClick={() => run(api.exportCsv, (p) => t("set.exported", { p }))}>
            {t("set.export")}
          </button>
          <button className="btn" disabled={!canEdit} onClick={() => run(api.backupDatabase, (p) => t("set.backedUp", { p }))}>
            {t("set.backup")}
          </button>
        </div>
      </section>
    </div>
  );
}
