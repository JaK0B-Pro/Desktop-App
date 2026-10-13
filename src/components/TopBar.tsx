import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Field, Modal } from "./Modal";

const frDate = (d: string) => d.split("-").reverse().join("/");

/**
 * Enterprise header + fiscal years as a bookshelf: each exercise is a book, the selected one is
 * pulled out. "+" adds the next year; the lock closes ("clôture") or reopens the selected year.
 */
export function TopBar() {
  const {
    settings,
    exercises,
    exercise,
    setExercise,
    range,
    t,
    fmt,
    isAdmin,
    canEdit,
    confirm,
    toast,
    fail,
    reloadAll,
    navigate,
    route,
    user,
    logout,
    openTx,
  } = useApp();
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pwd, setPwd] = useState(false);
  const current = exercises.find((x) => x.year === exercise);
  const nextYear = Math.max(new Date().getFullYear(), ...exercises.map((x) => x.year)) + 1;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  async function toggleClosed() {
    if (!current) return;
    const closing = !current.closed;
    const ok = await confirm(
      t(closing ? "ex.closeConfirm" : "ex.reopenConfirm", { year: current.year }),
      t(closing ? "ex.close" : "ex.reopen", { year: current.year }),
    );
    if (!ok) return;
    try {
      await api.setExerciseClosed(current.year, closing);
      await reloadAll();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <header className="topbar">
      <div className="company">
        <strong>{settings.company_name || "AccountBook"}</strong>
        <span>{[settings.company_activity, settings.company_address].filter(Boolean).join(" — ")}</span>
      </div>

      <div className="shelf" aria-label={t("ex.title")}>
        {exercises
          .slice()
          .sort((a, b) => a.year - b.year)
          .slice(-6)
          .map((x) => (
            <button
              key={x.year}
              className={`book ${x.year === exercise ? "on" : ""} ${x.closed ? "closed" : ""}`}
              onClick={() => setExercise(x.year)}
              title={`${x.year} — ${x.closed ? t("ex.closed") : t("ex.open")} · ${t("ex.entries", { n: x.count })}\n${t(
                "ex.balance",
                {
                  in: fmt(x.income),
                  out: fmt(x.expense),
                },
              )}`}
            >
              <span className="book-year">{x.year}</span>
              <span className="book-meta">{x.closed ? "🔒" : t("ex.short", { n: x.count.toLocaleString("fr-FR") })}</span>
            </button>
          ))}
        {canEdit && (
          <button className="book add" title={t("ex.new")} onClick={() => setAdding(true)}>
            +
          </button>
        )}
        <div className="shelf-range">
          <span>
            {t("app.from")} <b>{frDate(range.from)}</b>
          </span>
          <span>
            {t("app.to")} <b>{frDate(range.to)}</b>
          </span>
        </div>
        {isAdmin && current && (
          <button
            className={`btn small ${current.closed ? "" : "ghost"}`}
            onClick={toggleClosed}
            title={current.closed ? t("ex.reopen", { year: exercise }) : t("ex.close", { year: exercise })}
          >
            {current.closed ? "🔓" : "🔒"}
          </button>
        )}
      </div>

      <div className="top-actions">
        {canEdit && (
          <button className="btn small" disabled={current?.closed} onClick={() => openTx({ kind: "transfer" })}>
            ⇄ {t("tr.quick")}
          </button>
        )}
        <button className={`btn small ${route.page === "etat" ? "primary" : ""}`} onClick={() => navigate({ page: "etat" })}>
          ⚖ {t("nav.etat")}
        </button>
        <button
          className={`btn small ${route.page === "history" ? "primary" : ""}`}
          onClick={() => navigate({ page: "history" })}
        >
          🕘 {t("nav.history")}
        </button>
        <div className="user-menu" ref={menuRef}>
          <button className="btn small ghost" onClick={() => setMenu((m) => !m)}>
            👤 {user.fullName || user.username} ▾
          </button>
          {menu && (
            <div className="menu">
              <div className="menu-head">
                <strong>{user.fullName || user.username}</strong>
                <span className="muted small">{t(`usr.role.${user.role}`)}</span>
              </div>
              <button
                onClick={() => {
                  setMenu(false);
                  setPwd(true);
                }}
              >
                🔑 {t("auth.changePassword")}
              </button>
              <button onClick={logout}>⎋ {t("auth.logout")}</button>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <NewExercise
          initial={nextYear}
          onClose={() => setAdding(false)}
          onCreated={async (y) => {
            toast(t("ex.created", { year: y }));
            await reloadAll();
            setExercise(y);
          }}
        />
      )}
      {pwd && <ChangePassword onClose={() => setPwd(false)} />}
    </header>
  );
}

function NewExercise({ initial, onClose, onCreated }: { initial: number; onClose: () => void; onCreated: (y: number) => void }) {
  const { t, fail } = useApp();
  const [year, setYear] = useState(String(initial));
  return (
    <Modal title={t("ex.new")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.createExercise(Number(year));
            onClose();
            onCreated(Number(year));
          } catch (err) {
            fail(err);
          }
        }}
      >
        <Field label={t("ex.newPrompt")}>
          <input className="input" type="number" autoFocus value={year} onChange={(e) => setYear(e.target.value)} />
        </Field>
        <p className="muted small">
          {t("app.from")} 01/01/{year} {t("app.to")} 31/12/{year}
        </p>
        <footer className="form-actions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button className="btn primary">{t("c.save")}</button>
        </footer>
      </form>
    </Modal>
  );
}

export function ChangePassword({ onClose }: { onClose: () => void }) {
  const { t, fail, toast } = useApp();
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  return (
    <Modal title={t("auth.changePassword")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw !== pw2) return fail(t("auth.mismatch"));
          try {
            await api.changePassword(old, pw);
            toast(t("auth.passwordChanged"));
            onClose();
          } catch (err) {
            fail(err);
          }
        }}
      >
        <Field label={t("auth.oldPassword")}>
          <input className="input" type="password" autoFocus value={old} onChange={(e) => setOld(e.target.value)} />
        </Field>
        <Field label={t("auth.newPassword")}>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label={t("auth.password2")}>
          <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        <footer className="form-actions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button className="btn primary">{t("c.save")}</button>
        </footer>
      </form>
    </Modal>
  );
}
