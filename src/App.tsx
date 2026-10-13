import { useEffect } from "react";
import { useApp, type JournalKind, type Page } from "./context";
import type { TKey } from "./i18n";
import { TopBar } from "./components/TopBar";
import { TransactionForm } from "./components/TransactionForm";
import { Etat } from "./pages/Etat";
import { History } from "./pages/History";
import { Accounts } from "./pages/Accounts";
import { Chantiers } from "./pages/Chantiers";
import { Dashboard } from "./pages/Dashboard";
import { Journal } from "./pages/Journal";
import { Parties } from "./pages/Parties";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";

type NavItem = { page: Page; journal?: JournalKind; icon: string; label: TKey };

const NAV: (NavItem | "sep")[] = [
  { page: "dashboard", icon: "▦", label: "nav.dashboard" },
  "sep",
  { page: "journal", journal: "expense", icon: "↑", label: "nav.expense" },
  { page: "journal", journal: "income", icon: "↓", label: "nav.income" },
  { page: "journal", journal: "transfer", icon: "⇄", label: "nav.transfer" },
  { page: "journal", journal: "credit", icon: "⧗", label: "nav.credit" },
  { page: "journal", journal: "all", icon: "≡", label: "nav.all" },
  "sep",
  { page: "accounts", icon: "◫", label: "nav.accounts" },
  { page: "chantiers", icon: "⌂", label: "nav.chantiers" },
  { page: "parties", icon: "☺", label: "nav.parties" },
  { page: "etat", icon: "⚖", label: "nav.etat" },
  { page: "reports", icon: "▤", label: "nav.reports" },
  { page: "history", icon: "🕘", label: "nav.history" },
  { page: "settings", icon: "⚙", label: "nav.settings" },
];

export function App() {
  const { route, navigate, openTx, txDraft, closeTx, fmt, accounts, t, canEdit } = useApp();

  // Ctrl/Cmd+N: new entry from anywhere (same type as the open journal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (canEdit && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const j = route.page === "journal" ? route.journal : undefined;
        openTx({ kind: j === "income" || j === "transfer" ? j : j === "credit" ? "purchase" : "expense" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTx, route, canEdit]);

  const total = accounts.filter((a) => !a.archived).reduce((s, a) => s + a.balance, 0);
  const isOn = (n: NavItem) => route.page === n.page && (n.page !== "journal" || route.journal === n.journal);

  return (
    <div className="app">
      <TopBar />
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">AB</div>
          <div>
            <strong>AccountBook</strong>
            <small>{fmt(total)}</small>
          </div>
        </div>
        {canEdit && (
          <button className="btn primary block" onClick={() => openTx()}>
            + {t("nav.new")} <kbd>Ctrl N</kbd>
          </button>
        )}
        <nav>
          {NAV.map((n, i) =>
            n === "sep" ? (
              <hr key={i} />
            ) : (
              <button
                key={n.label}
                className={`nav-item ${isOn(n) ? "on" : ""}`}
                onClick={() => navigate({ page: n.page, journal: n.journal })}
              >
                <span className="nav-icon">{n.icon}</span>
                {t(n.label)}
              </button>
            ),
          )}
        </nav>
      </aside>
      <main className="content">
        {route.page === "dashboard" && <Dashboard />}
        {route.page === "journal" && <Journal key={route.journal} kind={route.journal ?? "all"} />}
        {route.page === "accounts" && <Accounts />}
        {route.page === "chantiers" && <Chantiers />}
        {route.page === "parties" && <Parties />}
        {route.page === "reports" && <Reports />}
        {route.page === "settings" && <Settings />}
        {route.page === "etat" && <Etat />}
        {route.page === "history" && <History />}
      </main>
      {txDraft && <TransactionForm key={JSON.stringify(txDraft)} initial={txDraft} onClose={closeTx} />}
    </div>
  );
}
