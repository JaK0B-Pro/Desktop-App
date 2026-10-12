import type { Settings } from "./types";

export interface MoneyFormat {
  symbol: string;
  position: "before" | "after";
  decimals: number;
}

export function moneyFormat(s: Settings): MoneyFormat {
  const decimals = Number.parseInt(s.decimals ?? "2", 10);
  return {
    symbol: s.currency_symbol ?? "$",
    position: s.currency_position === "after" ? "after" : "before",
    decimals: Number.isFinite(decimals) && decimals >= 0 && decimals <= 3 ? decimals : 2,
  };
}

/** Formats minor units: 123456 -> "$1,234.56". */
export function formatMoney(cents: number, f: MoneyFormat, opts: { sign?: boolean } = {}): string {
  const value = Math.abs(cents) / 10 ** f.decimals;
  const num = value.toLocaleString("en-US", {
    minimumFractionDigits: f.decimals,
    maximumFractionDigits: f.decimals,
  });
  const body = f.position === "before" ? `${f.symbol}${num}` : `${num} ${f.symbol}`;
  if (cents < 0) return `-${body}`;
  if (opts.sign && cents > 0) return `+${body}`;
  return body;
}

/** Minor units -> plain editable string: 123456 -> "1234.56". */
export function toInput(cents: number | null | undefined, decimals: number): string {
  if (cents == null) return "";
  return String(Number((cents / 10 ** decimals).toFixed(decimals)));
}

/**
 * Parses a user amount into minor units. Accepts thousands separators,
 * comma decimals ("12,5") and simple math ("1200+350", "3*45.5", "(10+5)/3").
 * Returns null when the input is not a valid amount.
 */
export function parseAmount(text: string, decimals: number): number | null {
  let s = text.trim().replace(/\s/g, "");
  if (!s) return null;
  // "1,234.50" -> "1234.50"; "12,5" -> "12.5"
  if (s.includes(".") && s.includes(",")) s = s.replace(/,/g, "");
  else s = s.replace(/,/g, ".");
  if (!/^[0-9+\-*/().]+$/.test(s)) return null;
  const value = evaluate(s);
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10 ** decimals);
}

/** Tiny recursive-descent calculator (no eval). */
function evaluate(src: string): number | null {
  let i = 0;
  const peek = () => src[i];
  function number(): number | null {
    const m = /^\d*\.?\d+|^\d+\.?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number.parseFloat(m[0]);
  }
  function factor(): number | null {
    if (peek() === "-") {
      i++;
      const v = factor();
      return v == null ? null : -v;
    }
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") return null;
      i++;
      return v;
    }
    return number();
  }
  function term(): number | null {
    let v = factor();
    while (v != null && (peek() === "*" || peek() === "/")) {
      const op = src[i++];
      const r = factor();
      if (r == null) return null;
      v = op === "*" ? v * r : r === 0 ? null : v / r;
    }
    return v;
  }
  function expr(): number | null {
    let v = term();
    while (v != null && (peek() === "+" || peek() === "-")) {
      const op = src[i++];
      const r = term();
      if (r == null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  return i === src.length ? v : null;
}

export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
