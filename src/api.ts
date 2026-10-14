import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AccountInput,
  AuditEntry,
  AuditFilter,
  AuthStatus,
  BalanceRow,
  Chantier,
  ChantierInput,
  Dashboard,
  Exercise,
  FamilyCount,
  Party,
  PartyInput,
  Report,
  Settings,
  Suggestion,
  SuggestQuery,
  Transaction,
  TxFilter,
  TxInput,
  User,
  UserInput,
} from "./types";

/** Thin typed wrappers over the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  authStatus: () => invoke<AuthStatus>("auth_status"),
  setupAdmin: (username: string, fullName: string | null, password: string) =>
    invoke<User>("setup_admin", { username, fullName, password }),
  login: (username: string, password: string) => invoke<User>("login", { username, password }),
  logout: () => invoke<void>("logout"),
  changePassword: (oldPassword: string, newPassword: string) => invoke<void>("change_password", { oldPassword, newPassword }),
  getPublicSettings: () => invoke<Settings>("get_public_settings"),

  listUsers: () => invoke<User[]>("list_users"),
  saveUser: (input: UserInput) => invoke<User>("save_user", { input }),
  deleteUser: (id: number) => invoke<void>("delete_user", { id }),

  getSettings: () => invoke<Settings>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),

  listExercises: () => invoke<Exercise[]>("list_exercises"),
  createExercise: (year: number) => invoke<void>("create_exercise", { year }),
  setExerciseClosed: (year: number, closed: boolean) => invoke<void>("set_exercise_closed", { year, closed }),

  listAccounts: (includeArchived = false) => invoke<Account[]>("list_accounts", { includeArchived }),
  saveAccount: (input: AccountInput) => invoke<Account>("save_account", { input }),
  deleteAccount: (id: number) => invoke<boolean>("delete_account", { id }),
  accountStatement: (id: number) => invoke<[Account, Transaction[]]>("account_statement", { id }),
  accountsState: (from: string, to: string) => invoke<BalanceRow[]>("accounts_state", { from, to }),
  partiesState: (from: string, to: string) => invoke<BalanceRow[]>("parties_state", { from, to }),

  listParties: (includeArchived = false) => invoke<Party[]>("list_parties", { includeArchived }),
  saveParty: (input: PartyInput) => invoke<Party>("save_party", { input }),
  deleteParty: (id: number) => invoke<boolean>("delete_party", { id }),
  partyStatement: (id: number) => invoke<[Party, Transaction[]]>("party_statement", { id }),

  listChantiers: (includeArchived = false) => invoke<Chantier[]>("list_chantiers", { includeArchived }),
  saveChantier: (input: ChantierInput) => invoke<Chantier>("save_chantier", { input }),
  deleteChantier: (id: number) => invoke<boolean>("delete_chantier", { id }),
  chantierStatement: (id: number) => invoke<[Chantier, Transaction[]]>("chantier_statement", { id }),

  listFamilies: () => invoke<FamilyCount[]>("list_families"),
  nextChequeNo: (accountId: number) => invoke<string | null>("next_cheque_no", { accountId }),

  listTransactions: (filter: TxFilter) => invoke<Transaction[]>("list_transactions", { filter }),
  getTransaction: (id: number) => invoke<Transaction>("get_transaction", { id }),
  saveTransaction: (input: TxInput) => invoke<Transaction>("save_transaction", { input }),
  deleteTransaction: (id: number) => invoke<void>("delete_transaction", { id }),
  restoreTransaction: (auditId: number) => invoke<Transaction>("restore_transaction", { auditId }),
  listAudit: (filter: AuditFilter) => invoke<AuditEntry[]>("list_audit", { filter }),

  suggestLabels: (query: SuggestQuery) => invoke<Suggestion[]>("suggest_labels", { query }),
  listLearnedLabels: () => invoke<Suggestion[]>("list_learned_labels"),
  forgetLabel: (key: string) => invoke<void>("forget_label", { key }),
  relearnLabels: () => invoke<number>("relearn_labels"),

  getDashboard: () => invoke<Dashboard>("get_dashboard"),
  getReport: (from: string, to: string) => invoke<Report>("get_report", { from, to }),
  exportCsv: () => invoke<string>("export_csv"),
  backupDatabase: () => invoke<string>("backup_database"),
  backupBeforeUpdate: () => invoke<string>("backup_before_update"),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
