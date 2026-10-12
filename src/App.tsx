import { useEffect } from "react";
import { useApp, type Page } from "./context";
import { TransactionForm } from "./components/TransactionForm";
import { Accounts } from "./pages/Accounts";
import { Dashboard } from "./pages/Dashboard";
import { Parties } from "./pages/Parties";
import { Reports } from "./pages/Reports";
import { Settings } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";

const NAV: [Page, string, string][] = [
  ["dashboard", "▦", "Dashboard"],
  ["transactions", "≡", "Transactions"],
  ["accounts", "◫", "Accounts"],
  ["parties", "☺", "Beneficiaries"],
  ["reports", "▤", "Reports"],
  ["settings", "⚙", "Settings"],
];

export function App() {
  const { route, navigate, openTx, txDraft, closeTx, fmt, accounts } = useApp();

  // Ctrl/Cmd+N: new transaction from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openTx();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTx]);

  const total = accounts.filter((a) => !a.archived).reduce((s, a) => s + a.balance, 0);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">AB</div>
          <div>
            <strong>AccountBook</strong>
            <small>{fmt(total)}</small>
          </div>
        </div>
        <button className="btn primary block" onClick={() => openTx()}>
          + New <kbd>Ctrl N</kbd>
        </button>
        <nav>
          {NAV.map(([page, icon, label]) => (
            <button
              key={page}
              className={`nav-item ${route.page === page ? "on" : ""}`}
              onClick={() => navigate({ page })}
            >
              <span className="nav-icon">{icon}</span>
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">
        {route.page === "dashboard" && <Dashboard />}
        {route.page === "transactions" && <Transactions />}
        {route.page === "accounts" && <Accounts />}
        {route.page === "parties" && <Parties />}
        {route.page === "reports" && <Reports />}
        {route.page === "settings" && <Settings />}
      </main>
      {txDraft && <TransactionForm key={JSON.stringify(txDraft)} initial={txDraft} onClose={closeTx} />}
    </div>
  );
}
