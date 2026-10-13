import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../context";
import { AmountInput } from "./AmountInput";

export interface FilterOption {
  key: string;
  label: string;
  count: number;
  total: number;
  /** Extra information shown on the right (e.g. what a beneficiary owes). */
  note?: string;
  noteClass?: string;
}

/** The ▾ button in a column header; highlighted when the column is filtered. */
export function FilterButton({ active, children }: { active: boolean; children: (close: () => void) => React.ReactNode }) {
  const { t } = useApp();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        type="button"
        className={`col-filter-btn ${active ? "on" : ""}`}
        title={t("flt.filter")}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        ▾
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          {children(() => setAnchor(null))}
        </Popover>
      )}
    </>
  );
}

function Popover({ anchor, onClose, children }: { anchor: DOMRect; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });

  // Keep the popover inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - h - 8)),
    });
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="col-filter-pop" style={pos} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * Excel-like value filter: search, tick the values to keep. Each value shows how many entries
 * and how much money it represents in the current list.
 */
export function ValueFilter({
  options,
  selected,
  onChange,
}: {
  options: FilterOption[];
  /** `null` = no filter (everything shown). */
  selected: Set<string> | null;
  onChange: (s: Set<string> | null) => void;
}) {
  const { t, fmt } = useApp();
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.label.toLowerCase().includes(s)) : options;
  }, [options, q]);
  const isOn = (k: string) => selected == null || selected.has(k);
  const toggle = (k: string) => {
    const next = new Set(selected ?? options.map((o) => o.key));
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange(next.size === options.length ? null : next);
  };
  // Typing then Enter keeps only the matching values.
  const keepShown = () => onChange(new Set(shown.map((o) => o.key)));

  return (
    <div className="value-filter">
      <input
        className="input"
        autoFocus
        placeholder={t("flt.searchValues")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && keepShown()}
      />
      <div className="vf-actions">
        <button type="button" className="link small" onClick={() => onChange(null)}>
          {t("flt.selectAll")}
        </button>
        <button type="button" className="link small" onClick={() => onChange(new Set())}>
          {t("flt.selectNone")}
        </button>
        {q && (
          <button type="button" className="link small" onClick={keepShown}>
            = « {q} »
          </button>
        )}
      </div>
      <ul className="vf-list">
        {shown.map((o) => (
          <li key={o.key}>
            <label>
              <input type="checkbox" checked={isOn(o.key)} onChange={() => toggle(o.key)} />
              <span className="vf-label">{o.label || <i className="muted">{t("flt.empty")}</i>}</span>
              <span className="vf-count">{o.count}</span>
              <span className="vf-total">{fmt(o.total)}</span>
            </label>
            {o.note && <div className={`vf-note ${o.noteClass ?? ""}`}>{o.note}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Min / max filter for amounts (money) or numbers (N°). */
export function RangeFilter({
  min,
  max,
  money,
  onChange,
  onDone,
}: {
  min: number | null;
  max: number | null;
  money?: boolean;
  onChange: (min: number | null, max: number | null) => void;
  onDone: () => void;
}) {
  const { t } = useApp();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return (
    <form
      className="range-filter"
      onSubmit={(e) => {
        e.preventDefault();
        onDone();
      }}
    >
      <label className="field">
        <span className="field-label">{t("flt.min")}</span>
        {money ? (
          <AmountInput value={min} onChange={(v) => onChange(v, max)} autoFocus />
        ) : (
          <input
            className="input num"
            type="number"
            autoFocus
            value={min ?? ""}
            onChange={(e) => onChange(num(e.target.value), max)}
          />
        )}
      </label>
      <label className="field">
        <span className="field-label">{t("flt.max")}</span>
        {money ? (
          <AmountInput value={max} onChange={(v) => onChange(min, v)} />
        ) : (
          <input className="input num" type="number" value={max ?? ""} onChange={(e) => onChange(min, num(e.target.value))} />
        )}
      </label>
      <div className="vf-actions">
        <button type="button" className="link small" onClick={() => onChange(null, null)}>
          {t("flt.clear")}
        </button>
        <button className="btn small primary">{t("flt.apply")}</button>
      </div>
    </form>
  );
}
