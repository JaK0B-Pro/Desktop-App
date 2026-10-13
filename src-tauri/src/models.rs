//! Data types shared between the Rust backend and the frontend.
//!
//! All money values are stored and transferred as integer minor units
//! (cents) to avoid floating point rounding errors.

use serde::{Deserialize, Serialize};

/// A place where money lives: a cash box ("caisse"), a bank account or a project budget.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub name: String,
    /// `cash` | `bank` | `project` | `other`
    pub kind: String,
    pub opening_balance: i64,
    pub color: Option<String>,
    pub notes: Option<String>,
    pub archived: bool,
    pub balance: i64,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub id: Option<i64>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub opening_balance: i64,
    pub color: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

/// A supplier, client or person you exchange money or goods with.
///
/// `balance > 0` means the party owes you, `balance < 0` means you owe the party.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub id: i64,
    pub name: String,
    /// `supplier` | `client` | `person` | `employee` | `other`
    pub kind: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
    pub opening_balance: i64,
    pub archived: bool,
    pub balance: i64,
    pub last_activity: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PartyInput {
    pub id: Option<i64>,
    pub name: String,
    pub kind: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub opening_balance: i64,
    #[serde(default)]
    pub archived: bool,
}

/// A construction site / job ("chantier"). Money lines can be attributed to a chantier
/// independently of the account the money comes from or goes to.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chantier {
    pub id: i64,
    pub name: String,
    pub client: Option<String>,
    pub notes: Option<String>,
    pub archived: bool,
    /// Money received for this chantier.
    pub income: i64,
    /// Money spent on this chantier.
    pub expense: i64,
    /// Goods bought on credit for this chantier.
    pub purchases: i64,
    pub last_activity: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChantierInput {
    pub id: Option<i64>,
    pub name: String,
    pub client: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

/// A family (category) with its usage count, for suggestions.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FamilyCount {
    pub name: String,
    pub count: i64,
}

/// One account share of a transaction (always positive in input).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineInput {
    pub account_id: i64,
    pub amount: i64,
    /// Chantier of this line; `None` means "same as the transaction".
    #[serde(default)]
    pub chantier_id: Option<i64>,
}

/// Transaction kinds:
/// * `income`   – money comes in, split over one or more accounts (deposit).
/// * `expense`  – money goes out of one or more accounts.
/// * `transfer` – money moves from `from_account_id` to one or more accounts.
/// * `purchase` – a party gave you goods/services on credit (you owe them). No money moves.
/// * `sale`     – you gave a party goods/services on credit (they owe you). No money moves.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TxInput {
    pub id: Option<i64>,
    pub date: String,
    pub kind: String,
    pub label: String,
    pub party_id: Option<i64>,
    /// Default chantier for all lines.
    pub chantier_id: Option<i64>,
    pub family: Option<String>,
    /// `ok` | `pending`
    pub status: Option<String>,
    pub cheque_no: Option<String>,
    #[serde(default)]
    pub cheque_crossed: bool,
    pub cheque_payee: Option<String>,
    pub from_account_id: Option<i64>,
    /// Only used by `purchase` and `sale`.
    pub amount: Option<i64>,
    #[serde(default)]
    pub lines: Vec<LineInput>,
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineView {
    pub account_id: i64,
    pub account_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chantier_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chantier_name: Option<String>,
    /// Signed: positive = money into the account.
    pub amount: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: i64,
    pub date: String,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub party_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chantier_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chantier_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cheque_no: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cheque_crossed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cheque_payee: Option<String>,
    /// Total, always positive.
    pub amount: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub lines: Vec<LineView>,
    /// Not sent to the UI (keeps large lists light).
    #[serde(default, skip_serializing)]
    pub created_at: String,
    /// Signed effect on the statement subject (account or party), when listing a statement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<i64>,
    /// Balance after this transaction, when listing a statement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_balance: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TxFilter {
    pub from: Option<String>,
    pub to: Option<String>,
    pub kind: Option<String>,
    pub account_id: Option<i64>,
    pub party_id: Option<i64>,
    pub chantier_id: Option<i64>,
    pub family: Option<String>,
    pub status: Option<String>,
    pub search: Option<String>,
    pub min_amount: Option<i64>,
    pub max_amount: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SuggestQuery {
    #[serde(default)]
    pub query: String,
    pub kind: Option<String>,
    pub party_id: Option<i64>,
    pub chantier_id: Option<i64>,
    pub limit: Option<usize>,
}

/// A label suggestion together with everything the app learned about it,
/// so the form can auto-fill party, amount and the account split.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub label: String,
    pub key: String,
    pub uses: i64,
    pub last_used: String,
    pub last_kind: Option<String>,
    pub last_party_id: Option<i64>,
    pub last_amount: Option<i64>,
    pub avg_amount: Option<i64>,
    pub last_from_account_id: Option<i64>,
    pub last_chantier_id: Option<i64>,
    pub last_family: Option<String>,
    pub last_lines: Vec<LineInput>,
    pub score: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthPoint {
    pub month: String,
    pub income: i64,
    pub expense: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabelTotal {
    pub label: String,
    pub kind: String,
    pub total: i64,
    pub count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub total_funds: i64,
    pub receivables: i64,
    pub payables: i64,
    pub month_income: i64,
    pub month_expense: i64,
    pub accounts: Vec<Account>,
    pub top_debtors: Vec<Party>,
    pub top_creditors: Vec<Party>,
    pub monthly: Vec<MonthPoint>,
    pub recent: Vec<Transaction>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub income: i64,
    pub expense: i64,
    pub purchases: i64,
    pub sales: i64,
    pub by_label: Vec<LabelTotal>,
    /// Totals per family (label field holds the family name).
    pub by_family: Vec<LabelTotal>,
    pub by_chantier: Vec<Chantier>,
    pub monthly: Vec<MonthPoint>,
}

// ---------------------------------------------------------------------------
// Users, fiscal years, history, account states
// ---------------------------------------------------------------------------

/// `admin` (everything), `user` (data entry), `viewer` (read only).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: i64,
    pub username: String,
    pub full_name: Option<String>,
    pub role: String,
    pub active: bool,
    pub created_at: String,
    pub last_login: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserInput {
    pub id: Option<i64>,
    pub username: String,
    pub full_name: Option<String>,
    pub role: String,
    #[serde(default = "yes")]
    pub active: bool,
    /// Required for a new user; when editing, `None` keeps the current password.
    pub password: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    /// No user exists yet: the first screen creates the administrator.
    pub needs_setup: bool,
    pub user: Option<User>,
    /// Problem found by the startup database check, if any.
    pub db_warning: Option<String>,
}

/// A fiscal year ("exercice"), from 1 January to 31 December.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Exercise {
    pub year: i32,
    pub closed: bool,
    pub closed_at: Option<String>,
    pub closed_by: Option<String>,
    pub count: i64,
    pub income: i64,
    pub expense: i64,
}

/// One entry of the change history.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub at: String,
    pub username: Option<String>,
    /// `create` | `update` | `delete` | `restore` | `close` | `reopen` | `login`
    pub action: String,
    /// `transaction` | `exercise` | `user`
    pub entity: String,
    pub entity_id: Option<i64>,
    pub summary: String,
    /// The transaction before the change (JSON), for updates and deletions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Transaction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Transaction>,
    /// The transaction still exists (can be opened).
    pub exists: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilter {
    pub entity_id: Option<i64>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
}

/// One line of the "état des comptes": opening balance, money in, money out and balance over a period.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRow {
    pub id: i64,
    pub name: String,
    pub kind: String,
    /// Balance on the first day of the period.
    pub initial: i64,
    /// For accounts: money in. For beneficiaries: what increased their debt (you paid them, sales).
    pub debit: i64,
    /// For accounts: money out. For beneficiaries: what reduced it (they paid you, purchases).
    pub credit: i64,
    pub balance: i64,
}
