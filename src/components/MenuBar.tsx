import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp, type Route } from "../context";
import type { TKey } from "../i18n";
import { useUpdater } from "../updater";
import { ChangePassword, NewExercise } from "./TopBar";
import { Modal } from "./Modal";
import { useAppVersion } from "../version";
import { ThemeSwitch } from "../theme";

type Item =
  | "sep"
  | {
      label: TKey;
      labelVars?: Record<string, string | number>;
      icon?: string;
      shortcut?: string;
      /** Highlighted when this route is open. */
      route?: Route;
      onClick: () => void;
      disabled?: boolean;
      hidden?: boolean;
    };

/**
 * Classic desktop menu bar (Fichier · Opérations · Tiers · États · Outils · Aide): every screen and
 * action of the app is reachable from here. Click a menu to open it; while one is open, hovering
 * another switches to it; Escape or a click outside closes it.
 */
export function MenuBar({ sidebar, toggleSidebar }: { sidebar: boolean; toggleSidebar: () => void }) {
  const app = useApp();
  const {
    t,
    navigate,
    openTx,
    canEdit,
    isAdmin,
    user,
    logout,
    exercises,
    exercise,
    confirm,
    fail,
    reloadAll,
    toast,
    route,
    setExercise,
  } = app;
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"password" | "exercise" | "about" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const updater = useUpdater();
  const current = exercises.find((x) => x.year === exercise);
  const locked = !!current?.closed;

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const go = (r: Route) => () => navigate(r);
  const run = (fn: () => Promise<unknown>, msg: (v: string) => string) => async () => {
    try {
      toast(msg(String(await fn())));
    } catch (e) {
      fail(e);
    }
  };

  async function toggleClosed() {
    if (!current) return;
    const closing = !current.closed;
    if (
      !(await confirm(
        t(closing ? "ex.closeConfirm" : "ex.reopenConfirm", { year: current.year }),
        t(closing ? "ex.close" : "ex.reopen", { year: current.year }),
      ))
    )
      return;
    try {
      await api.setExerciseClosed(current.year, closing);
      await reloadAll();
    } catch (e) {
      fail(e);
    }
  }

  const menus: { id: string; label: TKey; items: Item[] }[] = [
    {
      id: "file",
      label: "menu.file",
      items: [
        { label: "menu.newEntry", icon: "＋", shortcut: "Ctrl+N", onClick: () => openTx(), hidden: !canEdit, disabled: locked },
        "sep",
        { label: "set.export", icon: "⤓", onClick: run(api.exportCsv, (p) => t("set.exported", { p })) },
        { label: "set.backup", icon: "💾", onClick: run(api.backupDatabase, (p) => t("set.backedUp", { p })), hidden: !canEdit },
        "sep",
        { label: "auth.changePassword", icon: "🔑", onClick: () => setDialog("password") },
        { label: "auth.logout", icon: "⎋", onClick: logout },
        { label: "menu.quit", icon: "✕", onClick: () => void quitApp() },
      ],
    },
    {
      id: "ops",
      label: "menu.operations",
      items: [
        {
          label: "nav.expense",
          icon: "↑",
          route: { page: "journal", journal: "expense" },
          onClick: go({ page: "journal", journal: "expense" }),
        },
        {
          label: "nav.income",
          icon: "↓",
          route: { page: "journal", journal: "income" },
          onClick: go({ page: "journal", journal: "income" }),
        },
        {
          label: "nav.transfer",
          icon: "⇄",
          route: { page: "journal", journal: "transfer" },
          onClick: go({ page: "journal", journal: "transfer" }),
        },
        {
          label: "nav.credit",
          icon: "⧗",
          route: { page: "journal", journal: "credit" },
          onClick: go({ page: "journal", journal: "credit" }),
        },
        "sep",
        { label: "menu.newExpense", icon: "＋", onClick: () => openTx({ kind: "expense" }), hidden: !canEdit, disabled: locked },
        { label: "menu.newIncome", icon: "＋", onClick: () => openTx({ kind: "income" }), hidden: !canEdit, disabled: locked },
        { label: "menu.newTransfer", icon: "⇄", onClick: () => openTx({ kind: "transfer" }), hidden: !canEdit, disabled: locked },
      ],
    },
    {
      id: "parties",
      label: "menu.tiers",
      items: [
        { label: "nav.accounts", icon: "◫", route: { page: "accounts" }, onClick: go({ page: "accounts" }) },
        { label: "nav.chantiers", icon: "⌂", route: { page: "chantiers" }, onClick: go({ page: "chantiers" }) },
        { label: "nav.parties", icon: "☺", route: { page: "parties" }, onClick: go({ page: "parties" }) },
      ],
    },
    {
      id: "reports",
      label: "menu.reports",
      items: [
        { label: "nav.dashboard", icon: "▦", route: { page: "dashboard" }, onClick: go({ page: "dashboard" }) },
        { label: "nav.etat", icon: "⚖", route: { page: "etat" }, onClick: go({ page: "etat" }) },
        { label: "nav.reports", icon: "▤", route: { page: "reports" }, onClick: go({ page: "reports" }) },
        { label: "nav.history", icon: "🕘", route: { page: "history" }, onClick: go({ page: "history" }) },
      ],
    },
    {
      id: "tools",
      label: "menu.tools",
      items: [
        { label: "nav.settings", icon: "⚙", route: { page: "settings" }, onClick: go({ page: "settings" }) },
        "sep",
        { label: "ex.new", icon: "📒", onClick: () => setDialog("exercise"), hidden: !canEdit },
        {
          label: locked ? "ex.reopen" : "ex.close",
          labelVars: { year: exercise },
          icon: locked ? "🔓" : "🔒",
          onClick: toggleClosed,
          hidden: !isAdmin,
        },
        "sep",
        { label: sidebar ? "menu.hidePanel" : "menu.showPanel", icon: "☰", onClick: toggleSidebar },
      ],
    },
    {
      id: "help",
      label: "menu.help",
      items: [
        { label: "upd.check", icon: "⟳", onClick: () => void updater.check(true) },
        { label: "menu.about", icon: "ℹ", onClick: () => setDialog("about") },
      ],
    },
  ];

  const isOn = (r?: Route) => !!r && route.page === r.page && (r.page !== "journal" || route.journal === r.journal);
  const nextYear = Math.max(new Date().getFullYear(), ...exercises.map((x) => x.year)) + 1;

  return (
    <div className="menubar" ref={ref}>
      <button
        className={`menu-toggle ${sidebar ? "on" : ""}`}
        title={t(sidebar ? "menu.hidePanel" : "menu.showPanel")}
        onClick={toggleSidebar}
      >
        ☰
      </button>
      {menus.map((m) => (
        <div key={m.id} className="menubar-item">
          <button
            className={`menubar-btn ${open === m.id ? "open" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setOpen(open === m.id ? null : m.id);
            }}
            onMouseEnter={() => open && setOpen(m.id)}
          >
            {t(m.label)}
          </button>
          {open === m.id && (
            <div className="menubar-drop" role="menu">
              {m.items
                .filter((i) => i === "sep" || !i.hidden)
                .map((i, k) =>
                  i === "sep" ? (
                    <hr key={k} />
                  ) : (
                    <button
                      key={k}
                      role="menuitem"
                      disabled={i.disabled}
                      className={isOn(i.route) ? "on" : ""}
                      onClick={() => {
                        setOpen(null);
                        i.onClick();
                      }}
                    >
                      <span className="mi-icon">{i.icon}</span>
                      <span className="mi-label">{t(i.label, i.labelVars)}</span>
                      {i.shortcut && <kbd>{i.shortcut}</kbd>}
                    </button>
                  ),
                )}
            </div>
          )}
        </div>
      ))}
      <span className="menubar-space" />
      {updater.available && (
        <button className="update-pill" onClick={() => updater.open()}>
          ⬆ {t("upd.pill", { v: updater.available })}
        </button>
      )}
      <ThemeSwitch title={t("menu.theme")} />
      <span className="menubar-user" title={t(`usr.role.${user.role}`)}>
        👤 {user.fullName || user.username}
      </span>
      {dialog === "password" && <ChangePassword onClose={() => setDialog(null)} />}
      {dialog === "exercise" && (
        <NewExercise
          initial={nextYear}
          onClose={() => setDialog(null)}
          onCreated={async (y) => {
            toast(t("ex.created", { year: y }));
            await reloadAll();
            setExercise(y);
          }}
        />
      )}
      {dialog === "about" && <About onClose={() => setDialog(null)} />}
      {updater.dialog}
    </div>
  );
}

async function quitApp() {
  try {
    const { exit } = await import("@tauri-apps/plugin-process");
    await exit(0);
  } catch {
    window.close();
  }
}

function About({ onClose }: { onClose: () => void }) {
  const { t, settings } = useApp();
  const version = useAppVersion();
  return (
    <Modal title={t("menu.about")} onClose={onClose}>
      <div className="about">
        <div className="logo big-logo">AB</div>
        <h2>AccountBook</h2>
        <p className="muted">{t("app.version", { v: version ?? "—" })}</p>
        <p>{settings.company_name}</p>
        <p className="muted small">{t("about.data")}</p>
      </div>
    </Modal>
  );
}
