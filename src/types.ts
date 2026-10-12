// Mirrors src-tauri/src/models.rs. Money values are integer minor units (cents).

export type AccountKind = "cash" | "bank" | "project" | "other";
export type PartyKind = "supplier" | "client" | "person" | "employee" | "other";
export type TxKind = "income" | "expense" | "transfer" | "purchase" | "sale";
export type TxStatus = "ok" | "pending";

export interface Chantier {
  id: number;
  name: string;
  client: string | null;
  notes: string | null;
  archived: boolean;
  income: number;
  expense: number;
  purchases: number;
  lastActivity: string | null;
  createdAt: string;
}

export interface ChantierInput {
  id?: number | null;
  name: string;
  client?: string | null;
  notes?: string | null;
  archived?: boolean;
}

export interface FamilyCount {
  name: string;
  count: number;
}

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
  /** null = same chantier as the transaction */
  chantierId?: number | null;
}

export interface TxInput {
  id?: number | null;
  date: string;
  kind: TxKind;
  label: string;
  partyId?: number | null;
  chantierId?: number | null;
  family?: string | null;
  status?: TxStatus | null;
  chequeNo?: string | null;
  chequeCrossed?: boolean;
  chequePayee?: string | null;
  fromAccountId?: number | null;
  amount?: number | null;
  lines: LineInput[];
  notes?: string | null;
}

export interface LineView {
  accountId: number;
  accountName: string;
  chantierId: number | null;
  chantierName: string | null;
  amount: number;
}

export interface Transaction {
  id: number;
  date: string;
  kind: TxKind;
  label: string;
  partyId: number | null;
  partyName: string | null;
  chantierId: number | null;
  chantierName: string | null;
  family: string | null;
  status: TxStatus;
  chequeNo: string | null;
  chequeCrossed: boolean;
  chequePayee: string | null;
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
  chantierId?: number | null;
  family?: string | null;
  status?: string | null;
  search?: string | null;
  limit?: number | null;
}

export interface SuggestQuery {
  query: string;
  kind?: TxKind | null;
  partyId?: number | null;
  chantierId?: number | null;
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
  lastChantierId: number | null;
  lastFamily: string | null;
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
  byFamily: LabelTotal[];
  byChantier: Chantier[];
  monthly: MonthPoint[];
}

export type Settings = Record<string, string>;
