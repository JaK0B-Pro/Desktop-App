import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem("theme");
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** Applies the saved theme before the first render (avoids a flash of the wrong colours). */
export function applySavedTheme() {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
}

/** Current theme: the saved choice, or the Windows setting when none was made. */
export function useTheme(): [Theme, () => void] {
  const system = () => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [theme, setTheme] = useState<Theme>(stored() ?? system());
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () =>
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* the switch still works for this session */
      }
      return next;
    });
  return [theme, toggle];
}

/** Sun / moon switch. */
export function ThemeSwitch({ title }: { title: string }) {
  const [theme, toggle] = useTheme();
  return (
    <button
      className={`theme-switch ${theme}`}
      onClick={toggle}
      title={title}
      aria-label={title}
      role="switch"
      aria-checked={theme === "dark"}
    >
      <span className="knob">{theme === "dark" ? "🌙" : "☀️"}</span>
    </button>
  );
}
