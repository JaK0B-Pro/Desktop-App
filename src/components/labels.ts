import type { AccountKind, PartyKind, TxKind } from "../types";

export const KIND_LABEL: Record<TxKind, string> = {
  income: "Deposit",
  expense: "Expense",
  transfer: "Transfer",
  purchase: "Purchase on credit",
  sale: "Sale on credit",
};

export const KIND_HELP: Record<TxKind, string> = {
  income: "Money comes in. Split it across several accounts (cash, bank, projects…).",
  expense: "Money goes out of one or more accounts. Pick a beneficiary to track what they owe.",
  transfer: "Move money between your own accounts.",
  purchase: "A supplier/person gave you goods or services and you will pay later — you owe them.",
  sale: "You gave goods or services and they will pay later — they owe you.",
};

export const TX_KINDS: TxKind[] = ["income", "expense", "transfer", "purchase", "sale"];

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  cash: "Cash box",
  bank: "Bank",
  project: "Project",
  other: "Other",
};

export const PARTY_KIND_LABEL: Record<PartyKind, string> = {
  supplier: "Supplier",
  client: "Client",
  person: "Person",
  employee: "Employee",
  other: "Other",
};

export const ACCOUNT_COLORS = ["#16a34a", "#2563eb", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#ca8a04", "#64748b"];
