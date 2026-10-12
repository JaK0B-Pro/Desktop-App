import type { T } from "../i18n";
import type { AccountKind, PartyKind, TxKind, TxStatus } from "../types";

export const TX_KINDS: TxKind[] = ["income", "expense", "transfer", "purchase", "sale"];
export const ACCOUNT_KINDS: AccountKind[] = ["cash", "bank", "project", "other"];
export const PARTY_KINDS: PartyKind[] = ["supplier", "client", "person", "employee", "other"];
export const STATUSES: TxStatus[] = ["ok", "pending"];

export const kindLabel = (t: T, k: TxKind) => t(`kind.${k}`);
export const accountKindLabel = (t: T, k: AccountKind) => t(`accountKind.${k}`);
export const partyKindLabel = (t: T, k: PartyKind) => t(`partyKind.${k}`);
export const statusLabel = (t: T, s: TxStatus) => t(`status.${s}`);

export const ACCOUNT_COLORS = ["#16a34a", "#2563eb", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#ca8a04", "#64748b"];
