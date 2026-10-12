import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import { formatMoney, moneyFormat, type MoneyFormat } from "./money";
import type { Account, Party, Settings, TxInput } from "./types";

export type Page = "dashboard" | "transactions" | "accounts" | "parties" | "reports" | "settings";

export interface Route {
  page: Page;
  accountId?: number;
  partyId?: number;
}

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}

interface AppCtx {
  settings: Settings;
  money: MoneyFormat;
  fmt: (cents: number, opts?: { sign?: boolean }) => string;
  accounts: Account[];
  parties: Party[];
  /** Incremented after every data change so pages can reload. */
  version: number;
  refresh: () => Promise<void>;
  updateSetting: (key: string, value: string) => Promise<void>;
  route: Route;
  navigate: (r: Route) => void;
  toast: (text: string, kind?: "ok" | "error") => void;
  fail: (e: unknown) => void;
  /** In-app confirmation dialog. */
  confirm: (text: string, action?: string) => Promise<boolean>;
  /** Opens the global transaction editor, optionally pre-filled. */
  openTx: (initial?: Partial<TxInput>) => void;
  txDraft: Partial<TxInput> | null;
  closeTx: () => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [version, setVersion] = useState(0);
  const [route, setRoute] = useState<Route>({ page: "dashboard" });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [txDraft, setTxDraft] = useState<Partial<TxInput> | null>(null);
  const [ask, setAsk] = useState<{ text: string; action: string; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback(
    (text: string, action = "Delete") => new Promise<boolean>((resolve) => setAsk({ text, action, resolve })),
    [],
  );
  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };

  const toast = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);
  const fail = useCallback((e: unknown) => toast(errorText(e), "error"), [toast]);

  const refresh = useCallback(async () => {
    try {
      const [s, a, p] = await Promise.all([api.getSettings(), api.listAccounts(true), api.listParties(true)]);
      setSettings(s);
      setAccounts(a);
      setParties(p);
      setVersion((v) => v + 1);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateSetting = useCallback(
    async (key: string, value: string) => {
      await api.setSetting(key, value);
      setSettings((s) => ({ ...s, [key]: value }));
    },
    [],
  );

  const money = useMemo(() => moneyFormat(settings), [settings]);

  const value: AppCtx = {
    settings,
    money,
    fmt: (c, o) => formatMoney(c, money, o),
    accounts,
    parties,
    version,
    refresh,
    updateSetting,
    route,
    navigate: setRoute,
    toast,
    fail,
    confirm,
    openTx: (initial) => setTxDraft(initial ?? {}),
    txDraft,
    closeTx: () => setTxDraft(null),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {ask && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
          <div className="modal confirm" role="alertdialog">
            <div className="modal-body">
              <p>{ask.text}</p>
              <div className="form-actions end">
                <button className="btn ghost" onClick={() => answer(false)}>
                  Cancel
                </button>
                <button className="btn danger" autoFocus onClick={() => answer(true)}>
                  {ask.action}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
