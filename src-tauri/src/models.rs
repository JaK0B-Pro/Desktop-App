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
    pub chantier_id: Option<i64>,
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
    pub party_id: Option<i64>,
    pub party_name: Option<String>,
    pub chantier_id: Option<i64>,
    pub chantier_name: Option<String>,
    pub family: Option<String>,
    pub status: String,
    pub cheque_no: Option<String>,
    pub cheque_crossed: bool,
    pub cheque_payee: Option<String>,
    /// Total, always positive.
    pub amount: i64,
    pub notes: Option<String>,
    pub lines: Vec<LineView>,
    pub created_at: String,
    /// Signed effect on the statement subject (account or party), when listing a statement.
    pub effect: Option<i64>,
    /// Balance after this transaction, when listing a statement.
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
