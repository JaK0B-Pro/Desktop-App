import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AccountInput,
  Dashboard,
  Party,
  PartyInput,
  Report,
  Settings,
  Suggestion,
  SuggestQuery,
  Transaction,
  TxFilter,
  TxInput,
} from "./types";

/** Thin typed wrappers over the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),

  listAccounts: (includeArchived = false) => invoke<Account[]>("list_accounts", { includeArchived }),
  saveAccount: (input: AccountInput) => invoke<Account>("save_account", { input }),
  deleteAccount: (id: number) => invoke<boolean>("delete_account", { id }),
  accountStatement: (id: number) => invoke<[Account, Transaction[]]>("account_statement", { id }),

  listParties: (includeArchived = false) => invoke<Party[]>("list_parties", { includeArchived }),
  saveParty: (input: PartyInput) => invoke<Party>("save_party", { input }),
  deleteParty: (id: number) => invoke<boolean>("delete_party", { id }),
  partyStatement: (id: number) => invoke<[Party, Transaction[]]>("party_statement", { id }),

  listTransactions: (filter: TxFilter) => invoke<Transaction[]>("list_transactions", { filter }),
  saveTransaction: (input: TxInput) => invoke<Transaction>("save_transaction", { input }),
  deleteTransaction: (id: number) => invoke<void>("delete_transaction", { id }),

  suggestLabels: (query: SuggestQuery) => invoke<Suggestion[]>("suggest_labels", { query }),
  listLearnedLabels: () => invoke<Suggestion[]>("list_learned_labels"),
  forgetLabel: (key: string) => invoke<void>("forget_label", { key }),
  relearnLabels: () => invoke<number>("relearn_labels"),

  getDashboard: () => invoke<Dashboard>("get_dashboard"),
  getReport: (from: string, to: string) => invoke<Report>("get_report", { from, to }),
  exportCsv: () => invoke<string>("export_csv"),
  backupDatabase: () => invoke<string>("backup_database"),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
