import { useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { AccountKind, PartyKind } from "../types";
import { ACCOUNT_KINDS, accountKindLabel, PARTY_KINDS, partyKindLabel } from "./labels";

/** Beneficiary picker showing each balance, with inline creation. */
export function PartySelect({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { parties, refresh, fail, fmt, t } = useApp();
  const [draft, setDraft] = useState<{ name: string; kind: PartyKind } | null>(null);

  async function create() {
    if (!draft?.name.trim()) return;
    try {
      const p = await api.saveParty({ name: draft.name, kind: draft.kind, openingBalance: 0 });
      await refresh();
      onChange(p.id);
      setDraft(null);
    } catch (e) {
      fail(e);
    }
  }

  if (draft)
    return (
      <div className="row nowrap-row">
        <input
          className="input"
          autoFocus
          placeholder={t("c.name")}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        <select
          className="input narrow"
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as PartyKind })}
        >
          {PARTY_KINDS.map((k) => (
            <option key={k} value={k}>
              {partyKindLabel(t, k)}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={create}>
          {t("c.add")}
        </button>
        <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
          {t("c.cancel")}
        </button>
      </div>
    );

  const balance = (b: number) =>
    b > 0 ? t("pt.balOwesYou", { v: fmt(b) }) : b < 0 ? t("pt.balYouOwe", { v: fmt(-b) }) : t("pt.balSettled");

  return (
    <select
      className="input"
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === "__new") setDraft({ name: "", kind: "supplier" });
        else onChange(e.target.value ? Number(e.target.value) : null);
      }}
    >
      <option value="">{t("c.none")}</option>
      {parties
        .filter((p) => !p.archived || p.id === value)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({balance(p.balance)})
          </option>
        ))}
      <option value="__new">{t("form.newParty")}</option>
    </select>
  );
}

/** Chantier picker with inline creation. */
export function ChantierSelect({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { chantiers, refresh, fail, t } = useApp();
  const [draft, setDraft] = useState<string | null>(null);

  async function create() {
    if (!draft?.trim()) return;
    try {
      const c = await api.saveChantier({ name: draft });
      await refresh();
      onChange(c.id);
      setDraft(null);
    } catch (e) {
      fail(e);
    }
  }

  if (draft != null)
    return (
      <div className="row nowrap-row">
        <input
          className="input"
          autoFocus
          placeholder={t("c.name")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        <button type="button" className="btn" onClick={create}>
          {t("c.add")}
        </button>
        <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
          {t("c.cancel")}
        </button>
      </div>
    );

  return (
    <select
      className="input"
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === "__new") setDraft("");
        else onChange(e.target.value ? Number(e.target.value) : null);
      }}
    >
      <option value="">{t("c.none")}</option>
      {chantiers
        .filter((c) => !c.archived || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      <option value="__new">{t("form.newChantier")}</option>
    </select>
  );
}

/** Account picker showing each balance, with inline creation of a new account. */
export function AccountSelect({
  value,
  onChange,
  exclude,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** Account hidden from the list (e.g. the source of a transfer). */
  exclude?: number | null;
}) {
  const { accounts, refresh, fail, fmt, t } = useApp();
  const [draft, setDraft] = useState<{ name: string; kind: AccountKind } | null>(null);

  async function create() {
    if (!draft?.name.trim()) return;
    try {
      const a = await api.saveAccount({ name: draft.name, kind: draft.kind, openingBalance: 0 });
      await refresh();
      onChange(a.id);
      setDraft(null);
    } catch (e) {
      fail(e);
    }
  }

  if (draft)
    return (
      <div className="row nowrap-row">
        <input
          className="input"
          autoFocus
          placeholder={t("c.name")}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
        <select
          className="input narrow"
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as AccountKind })}
        >
          {ACCOUNT_KINDS.map((k) => (
            <option key={k} value={k}>
              {accountKindLabel(t, k)}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={create}>
          {t("c.add")}
        </button>
        <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
          ✕
        </button>
      </div>
    );

  return (
    <select
      className="input"
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === "__new") setDraft({ name: "", kind: "cash" });
        else onChange(e.target.value ? Number(e.target.value) : null);
      }}
    >
      <option value="">{t("c.choose")}</option>
      {accounts
        .filter((a) => (!a.archived || a.id === value) && (a.id !== exclude || a.id === value))
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} — {fmt(a.balance)}
          </option>
        ))}
      <option value="__new">{t("form.newAccount")}</option>
    </select>
  );
}
