import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import { makeT, type Lang, type T } from "./i18n";
import { formatMoney, moneyFormat, type MoneyFormat } from "./money";
import type { Account, Chantier, FamilyCount, Party, Settings, TxInput } from "./types";

export type JournalKind = "all" | "income" | "expense" | "transfer" | "credit";
export type Page = "dashboard" | "journal" | "accounts" | "chantiers" | "parties" | "reports" | "settings";

export interface Route {
  page: Page;
  journal?: JournalKind;
  accountId?: number;
  partyId?: number;
  chantierId?: number;
}

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}

interface AppCtx {
  settings: Settings;
  lang: Lang;
  t: T;
  money: MoneyFormat;
  fmt: (cents: number, opts?: { sign?: boolean }) => string;
  accounts: Account[];
  parties: Party[];
  chantiers: Chantier[];
  families: FamilyCount[];
  years: number[];
  /** Selected fiscal year ("exercice") and its date range. */
  exercise: number;
  range: { from: string; to: string };
  setExercise: (year: number) => void;
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
  const [chantiers, setChantiers] = useState<Chantier[]>([]);
  const [families, setFamilies] = useState<FamilyCount[]>([]);
  const [years, setYears] = useState<number[]>([new Date().getFullYear()]);
  const [version, setVersion] = useState(0);
  const [route, setRoute] = useState<Route>({ page: "dashboard" });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [txDraft, setTxDraft] = useState<Partial<TxInput> | null>(null);
  const [ask, setAsk] = useState<{ text: string; action: string; resolve: (ok: boolean) => void } | null>(null);

  const lang: Lang = settings.language === "en" ? "en" : "fr";
  const t = useMemo(() => makeT(lang), [lang]);

  const confirm = useCallback(
    (text: string, action?: string) => new Promise<boolean>((resolve) => setAsk({ text, action: action ?? "", resolve })),
    [],
  );
  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };

  const toast = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);
  const fail = useCallback((e: unknown) => toast(errorText(e), "error"), [toast]);

  const refresh = useCallback(async () => {
    try {
      const [s, a, p, c, f, y] = await Promise.all([
        api.getSettings(),
        api.listAccounts(true),
        api.listParties(true),
        api.listChantiers(true),
        api.listFamilies(),
        api.listYears(),
      ]);
      setSettings(s);
      setAccounts(a);
      setParties(p);
      setChantiers(c);
      setFamilies(f);
      setYears(y);
      setVersion((v) => v + 1);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the document language in sync (dates, spell-check, screen readers).
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const updateSetting = useCallback(async (key: string, value: string) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await api.setSetting(key, value);
  }, []);

  const exercise = Number.parseInt(settings.exercise ?? "", 10) || new Date().getFullYear();
  const range = useMemo(() => ({ from: `${exercise}-01-01`, to: `${exercise}-12-31` }), [exercise]);
  const money = useMemo(() => moneyFormat(settings), [settings]);
  const openTx = useCallback((initial?: Partial<TxInput>) => setTxDraft(initial ?? {}), []);

  const value: AppCtx = {
    settings,
    lang,
    t,
    money,
    fmt: (c, o) => formatMoney(c, money, o),
    accounts,
    parties,
    chantiers,
    families,
    years: years.includes(exercise) ? years : [exercise, ...years].sort((a, b) => b - a),
    exercise,
    range,
    setExercise: (y) => void updateSetting("exercise", String(y)).catch(fail),
    version,
    refresh,
    updateSetting,
    route,
    navigate: setRoute,
    toast,
    fail,
    confirm,
    openTx,
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
                  {t("c.cancel")}
                </button>
                <button className="btn danger" autoFocus onClick={() => answer(true)}>
                  {ask.action || t("c.delete")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
