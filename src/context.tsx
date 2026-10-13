import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import { makeT, translateError, type Lang, type T } from "./i18n";
import { formatMoney, moneyFormat, type MoneyFormat } from "./money";
import type { Account, Chantier, Exercise, FamilyCount, Party, Settings, Transaction, TxInput, User } from "./types";

export type JournalKind = "all" | "income" | "expense" | "transfer" | "credit";
export type Page = "dashboard" | "journal" | "accounts" | "chantiers" | "parties" | "reports" | "settings" | "etat" | "history";

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

/** The last saved or deleted entry: open journals patch their rows instead of reloading the year. */
export interface TxChange {
  seq: number;
  saved?: Transaction;
  deletedId?: number;
}

interface AppCtx {
  user: User;
  isAdmin: boolean;
  canEdit: boolean;
  logout: () => void;
  settings: Settings;
  lang: Lang;
  t: T;
  money: MoneyFormat;
  fmt: (cents: number, opts?: { sign?: boolean }) => string;
  accounts: Account[];
  parties: Party[];
  chantiers: Chantier[];
  families: FamilyCount[];
  exercises: Exercise[];
  /** Selected fiscal year ("exercice") and its date range. */
  exercise: number;
  range: { from: string; to: string };
  setExercise: (year: number) => void;
  /** True when the year of `date` (or the selected exercise) is closed. */
  isClosed: (dateOrYear?: string | number) => boolean;
  /** Incremented after every refresh of the shared lists. */
  version: number;
  /** Incremented when every open list must reload from the database (restore, exercise changes…). */
  reloadKey: number;
  txChange: TxChange;
  refresh: () => Promise<void>;
  reloadAll: () => Promise<void>;
  notifySaved: (tx: Transaction) => Promise<void>;
  notifyDeleted: (id: number) => Promise<void>;
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

export function AppProvider({
  user,
  initialExercise,
  initialSettings,
  onLogout,
  children,
}: {
  user: User;
  initialExercise: number;
  initialSettings: Settings;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [chantiers, setChantiers] = useState<Chantier[]>([]);
  const [families, setFamilies] = useState<FamilyCount[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [exercise, setExerciseState] = useState(initialExercise);
  const [version, setVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [txChange, setTxChange] = useState<TxChange>({ seq: 0 });
  const [route, setRoute] = useState<Route>({ page: "journal", journal: "expense" });
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
  const fail = useCallback(
    (e: unknown) => {
      const msg = errorText(e);
      toast(translateError(t, msg), "error");
      if (msg === "ERR:auth") onLogout();
    },
    [toast, t, onLogout],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, a, p, c, f, x] = await Promise.all([
        api.getSettings(),
        api.listAccounts(true),
        api.listParties(true),
        api.listChantiers(true),
        api.listFamilies(),
        api.listExercises(),
      ]);
      setSettings(s);
      setAccounts(a);
      setParties(p);
      setChantiers(c);
      setFamilies(f);
      setExercises(x);
      setVersion((v) => v + 1);
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const reloadAll = useCallback(async () => {
    setReloadKey((k) => k + 1);
    await refresh();
  }, [refresh]);
  const notifySaved = useCallback(
    async (tx: Transaction) => {
      setTxChange((c) => ({ seq: c.seq + 1, saved: tx }));
      await refresh();
    },
    [refresh],
  );
  const notifyDeleted = useCallback(
    async (id: number) => {
      setTxChange((c) => ({ seq: c.seq + 1, deletedId: id }));
      await refresh();
    },
    [refresh],
  );

  const updateSetting = useCallback(
    async (key: string, value: string) => {
      setSettings((s) => ({ ...s, [key]: value }));
      try {
        await api.setSetting(key, value);
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

  const setExercise = useCallback((y: number) => {
    setExerciseState(y);
    try {
      localStorage.setItem("exercise", String(y));
    } catch {
      /* optional */
    }
  }, []);

  const isClosed = useCallback(
    (d?: string | number) => {
      const y = d == null ? exercise : typeof d === "number" ? d : Number(d.slice(0, 4));
      return exercises.some((x) => x.year === y && x.closed);
    },
    [exercises, exercise],
  );

  const range = useMemo(() => ({ from: `${exercise}-01-01`, to: `${exercise}-12-31` }), [exercise]);
  const money = useMemo(() => moneyFormat(settings), [settings]);
  const openTx = useCallback((initial?: Partial<TxInput>) => setTxDraft(initial ?? {}), []);

  const value: AppCtx = {
    user,
    isAdmin: user.role === "admin",
    canEdit: user.role !== "viewer",
    logout: onLogout,
    settings,
    lang,
    t,
    money,
    fmt: (c, o) => formatMoney(c, money, o),
    accounts,
    parties,
    chantiers,
    families,
    exercises,
    exercise,
    range,
    setExercise,
    isClosed,
    version,
    reloadKey,
    txChange,
    refresh,
    reloadAll,
    notifySaved,
    notifyDeleted,
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
