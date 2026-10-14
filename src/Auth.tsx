import { useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "./api";
import { App } from "./App";
import { AppProvider } from "./context";
import { makeT, translateError, type Lang } from "./i18n";
import type { Exercise, Settings, User } from "./types";
import { useAppVersion } from "./version";
import { ThemeSwitch } from "./theme";

function AuthVersion() {
  const v = useAppVersion();
  return v ? <div className="muted small center-text">AccountBook {v}</div> : null;
}

type Step =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "exercise"; user: User }
  | { kind: "app"; user: User; year: number };

const lastExercise = () => {
  try {
    return Number(localStorage.getItem("exercise")) || null;
  } catch {
    return null;
  }
};

/**
 * Entry point: first-start administrator creation, login, then choice of the fiscal year,
 * like opening a "dossier" in a classic accounting program.
 */
export function AuthGate() {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [pub, setPub] = useState<Settings>({});
  const [warning, setWarning] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("fr");
  const t = makeT(lang);

  useEffect(() => {
    Promise.all([api.authStatus(), api.getPublicSettings()])
      .then(([s, p]) => {
        setPub(p);
        setLang(p.language === "en" ? "en" : "fr");
        setWarning(s.dbWarning);
        setStep(s.user ? { kind: "exercise", user: s.user } : s.needsSetup ? { kind: "setup" } : { kind: "login" });
      })
      .catch(() => setStep({ kind: "login" }));
  }, []);

  if (step.kind === "app")
    return (
      <AppProvider
        key={step.user.id}
        user={step.user}
        initialExercise={step.year}
        initialSettings={pub}
        onLogout={() => {
          void api.logout();
          setStep({ kind: "login" });
        }}
      >
        <App />
      </AppProvider>
    );

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="logo">AB</div>
          <div>
            <strong>{pub.company_name || "AccountBook"}</strong>
            <span>{[pub.company_activity, pub.company_address].filter(Boolean).join(" — ") || "Gestion de trésorerie"}</span>
          </div>
        </div>
        {warning && <div className="auth-warning">{t("auth.dbWarning", { w: warning })}</div>}
        {step.kind === "loading" && <p className="muted">{t("c.loading")}</p>}
        {step.kind === "setup" && <SetupForm t={t} onDone={(user) => setStep({ kind: "exercise", user })} />}
        {step.kind === "login" && <LoginForm t={t} onDone={(user) => setStep({ kind: "exercise", user })} />}
        {step.kind === "exercise" && (
          <ExerciseForm
            t={t}
            user={step.user}
            onDone={(year) => setStep({ kind: "app", user: step.user, year })}
            onBack={() => {
              void api.logout();
              setStep({ kind: "login" });
            }}
          />
        )}
        <div className="auth-foot">
          <AuthVersion />
          <ThemeSwitch title={lang === "fr" ? "Mode clair / sombre" : "Light / dark mode"} />
        </div>
        <div className="auth-lang">
          {(["fr", "en"] as Lang[]).map((l) => (
            <button key={l} className={l === lang ? "on" : ""} onClick={() => setLang(l)}>
              {l === "fr" ? "Français" : "English"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type TT = ReturnType<typeof makeT>;

function useSubmit(t: TT) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(translateError(t, errorText(e)));
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

function LoginForm({ t, onDone }: { t: TT; onDone: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { error, busy, run } = useSubmit(t);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onDone(await api.login(username, password)));
  };
  return (
    <form onSubmit={submit} className="auth-form">
      <h2>{t("auth.loginTitle")}</h2>
      <label className="field">
        <span className="field-label">{t("auth.username")}</span>
        <input
          className="input"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
      </label>
      <label className="field">
        <span className="field-label">{t("auth.password")}</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      {error && <div className="auth-error">{error}</div>}
      <button className="btn primary block" disabled={busy || !username || !password}>
        {t("auth.login")}
      </button>
    </form>
  );
}

function SetupForm({ t, onDone }: { t: TT; onDone: (u: User) => void }) {
  const [username, setUsername] = useState("admin");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const { error, setError, busy, run } = useSubmit(t);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== password2) return setError(t("auth.mismatch"));
    void run(async () => onDone(await api.setupAdmin(username, fullName || null, password)));
  };
  return (
    <form onSubmit={submit} className="auth-form">
      <h2>{t("auth.setupTitle")}</h2>
      <p className="muted small">{t("auth.setupHint")}</p>
      <label className="field">
        <span className="field-label">{t("auth.username")}</span>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("auth.fullName")}</span>
        <input className="input" autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("auth.password")}</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <label className="field">
        <span className="field-label">{t("auth.password2")}</span>
        <input
          className="input"
          type="password"
          value={password2}
          onChange={(e) => setPassword2(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      {error && <div className="auth-error">{error}</div>}
      <button className="btn primary block" disabled={busy || !username || !password}>
        {t("auth.create")}
      </button>
    </form>
  );
}

function ExerciseForm({ t, user, onDone, onBack }: { t: TT; user: User; onDone: (y: number) => void; onBack: () => void }) {
  const [list, setList] = useState<Exercise[] | null>(null);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  useEffect(() => {
    api
      .listExercises()
      .then((x) => {
        setList(x);
        const last = lastExercise();
        setYear(last && x.some((e) => e.year === last) ? last : (x[0]?.year ?? new Date().getFullYear()));
      })
      .catch(() => setList([]));
  }, []);
  return (
    <form
      className="auth-form"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(year);
      }}
    >
      <h2>{t("auth.hello", { name: user.fullName || user.username })}</h2>
      <span className="field-label">{t("auth.chooseExercise")}</span>
      <div className="exercise-pick">
        {(list ?? []).map((x) => (
          <button
            type="button"
            key={x.year}
            className={`book ${x.year === year ? "on" : ""} ${x.closed ? "closed" : ""}`}
            onClick={() => setYear(x.year)}
            onDoubleClick={() => onDone(x.year)}
          >
            <span className="book-year">{x.year}</span>
            <span className="book-meta">
              {x.closed ? `🔒 ${t("ex.closed")}` : t("ex.short", { n: x.count.toLocaleString("fr-FR") })}
            </span>
          </button>
        ))}
      </div>
      <button className="btn primary block" autoFocus>
        {t("auth.enter")} — {year}
      </button>
      <button type="button" className="link small center" onClick={onBack}>
        {t("auth.logout")}
      </button>
    </form>
  );
}
