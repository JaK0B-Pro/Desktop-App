// Mirrors src-tauri/src/models.rs. Money values are integer minor units (cents).

export type AccountKind = "cash" | "bank" | "project" | "other";
export type PartyKind = "supplier" | "client" | "person" | "employee" | "other";
export type TxKind = "income" | "expense" | "transfer" | "purchase" | "sale";

export interface Account {
  id: number;
  name: string;
  kind: AccountKind;
  openingBalance: number;
  color: string | null;
  notes: string | null;
  archived: boolean;
  balance: number;
  createdAt: string;
}

export interface AccountInput {
  id?: number | null;
  name: string;
  kind: AccountKind;
  openingBalance: number;
  color?: string | null;
  notes?: string | null;
  archived?: boolean;
}

export interface Party {
  id: number;
  name: string;
  kind: PartyKind;
  phone: string | null;
  notes: string | null;
  openingBalance: number;
  archived: boolean;
  /** > 0: they owe you, < 0: you owe them */
  balance: number;
  lastActivity: string | null;
  createdAt: string;
}

export interface PartyInput {
  id?: number | null;
  name: string;
  kind: PartyKind;
  phone?: string | null;
  notes?: string | null;
  openingBalance: number;
  archived?: boolean;
}

export interface LineInput {
  accountId: number;
  amount: number;
}

export interface TxInput {
  id?: number | null;
  date: string;
  kind: TxKind;
  label: string;
  partyId?: number | null;
  fromAccountId?: number | null;
  amount?: number | null;
  lines: LineInput[];
  notes?: string | null;
}

export interface LineView {
  accountId: number;
  accountName: string;
  amount: number;
}

export interface Transaction {
  id: number;
  date: string;
  kind: TxKind;
  label: string;
  partyId: number | null;
  partyName: string | null;
  amount: number;
  notes: string | null;
  lines: LineView[];
  createdAt: string;
  effect: number | null;
  runningBalance: number | null;
}

export interface TxFilter {
  from?: string | null;
  to?: string | null;
  kind?: string | null;
  accountId?: number | null;
  partyId?: number | null;
  search?: string | null;
  limit?: number | null;
}

export interface SuggestQuery {
  query: string;
  kind?: TxKind | null;
  partyId?: number | null;
  limit?: number | null;
}

export interface Suggestion {
  label: string;
  key: string;
  uses: number;
  lastUsed: string;
  lastKind: TxKind | null;
  lastPartyId: number | null;
  lastAmount: number | null;
  avgAmount: number | null;
  lastFromAccountId: number | null;
  lastLines: LineInput[];
  score: number;
}

export interface MonthPoint {
  month: string;
  income: number;
  expense: number;
}

export interface LabelTotal {
  label: string;
  kind: TxKind;
  total: number;
  count: number;
}

export interface Dashboard {
  totalFunds: number;
  receivables: number;
  payables: number;
  monthIncome: number;
  monthExpense: number;
  accounts: Account[];
  topDebtors: Party[];
  topCreditors: Party[];
  monthly: MonthPoint[];
  recent: Transaction[];
}

export interface Report {
  income: number;
  expense: number;
  purchases: number;
  sales: number;
  byLabel: LabelTotal[];
  monthly: MonthPoint[];
}

export type Settings = Record<string, string>;
