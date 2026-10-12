import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { Suggestion, TxKind } from "../types";
import { kindLabel } from "./labels";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Called when the user picks a learned label: the form can auto-fill from it. */
  onPick: (s: Suggestion) => void;
  kind: TxKind;
  partyId: number | null;
  chantierId: number | null;
  autoFocus?: boolean;
}

/**
 * Smart label field. Suggestions come from everything you typed before and are ranked by
 * text match (prefix, words, typos, fuzzy), how often and how recently you used them, and
 * whether you used them with the same type and beneficiary.
 *
 * Keys: ↑/↓ to move, Enter to pick, Tab or → to accept the grey inline completion, Esc to close.
 */
export function LabelInput({ value, onChange, onPick, kind, partyId, chantierId, autoFocus }: Props) {
  const { fmt, parties, chantiers, t } = useApp();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) return;
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const res = await api.suggestLabels({ query: value, kind, partyId, chantierId, limit: 8 });
        if (id === reqId.current) {
          setItems(res);
          setActive(0);
        }
      } catch {
        /* suggestions are best-effort */
      }
    }, 60);
    return () => clearTimeout(t);
  }, [value, kind, partyId, chantierId, open]);

  const top = items[0];
  const ghost =
    open && value && top && top.label.toLowerCase().startsWith(value.toLowerCase()) && top.label.length > value.length
      ? value + top.label.slice(value.length)
      : "";

  function pick(s: Suggestion) {
    onChange(s.label);
    onPick(s);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && items[active]) {
      e.preventDefault();
      pick(items[active]);
    } else if ((e.key === "Tab" || (e.key === "ArrowRight" && atEnd())) && ghost && top) {
      e.preventDefault();
      pick(top);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  function atEnd() {
    const el = inputRef.current;
    return !!el && el.selectionStart === el.value.length;
  }

  const partyName = (id: number | null) => (id == null ? null : parties.find((p) => p.id === id)?.name ?? null);
  const chantierName = (id: number | null) => (id == null ? null : chantiers.find((c) => c.id === id)?.name ?? null);
  const visible = open && items.length > 0 && !(items.length === 1 && items[0].label === value);

  return (
    <div className="label-input">
      <div className="completion-wrap">
        <input
          ref={inputRef}
          className="input"
          value={value}
          autoFocus={autoFocus}
          placeholder={t("form.labelPh")}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          // An empty field shows your frequent labels; a filled one (editing) waits for typing.
          onFocus={() => !value && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {ghost && (
          <div className="completion" aria-hidden>
            <span className="completion-typed">{value}</span>
            {ghost.slice(value.length)}
            <kbd>Tab</kbd>
          </div>
        )}
      </div>
      {visible && (
        <ul className="suggestions" role="listbox">
          <li className="suggestions-head">
            {value ? t("sug.title") : t("sug.frequent")} <span>{t("sug.keys")}</span>
          </li>
          {items.map((s, i) => (
            <li
              key={s.key}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <div className="s-main">
                <Highlight text={s.label} query={value} />
                <span className="s-meta">
                  {s.lastKind && <span className={`chip k-${s.lastKind}`}>{kindLabel(t, s.lastKind)}</span>}
                  {s.lastFamily && <span className="chip">{s.lastFamily}</span>}
                  {chantierName(s.lastChantierId) && <span className="chip ch">🏗 {chantierName(s.lastChantierId)}</span>}
                  {partyName(s.lastPartyId) && <span className="chip">{partyName(s.lastPartyId)}</span>}
                </span>
              </div>
              <div className="s-side">
                {s.lastAmount != null && <span className="s-amount">{fmt(s.lastAmount)}</span>}
                <span className="s-uses">{t("sug.used", { n: s.uses })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </span>
  );
}
