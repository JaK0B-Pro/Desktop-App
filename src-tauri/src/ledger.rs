//! Database layer: schema, accounts, parties, transactions, learning and reports.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;
use crate::suggest;

pub type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

pub const ACCOUNT_KINDS: &[&str] = &["cash", "bank", "project", "other"];
pub const PARTY_KINDS: &[&str] = &["supplier", "client", "person", "employee", "other"];
pub const TX_KINDS: &[&str] = &["income", "expense", "transfer", "purchase", "sale"];

/// Signed effect of a transaction on its party balance (positive = the party owes you more).
pub fn party_effect(kind: &str, total: i64) -> i64 {
    match kind {
        // They paid you: they owe you less (or you now owe them).
        "income" => -total,
        // You paid them: they owe you more (or you owe them less).
        "expense" => total,
        // They gave you goods on credit: you owe them.
        "purchase" => -total,
        // You gave them goods on credit: they owe you.
        "sale" => total,
        _ => 0,
    }
}

const PARTY_EFFECT_SQL: &str = "CASE t.kind WHEN 'income' THEN -t.amount WHEN 'expense' THEN t.amount \
     WHEN 'purchase' THEN -t.amount WHEN 'sale' THEN t.amount ELSE 0 END";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    opening_balance INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    opening_balance INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    party_id INTEGER REFERENCES parties(id),
    amount INTEGER NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_party ON transactions(party_id);
CREATE TABLE IF NOT EXISTS transaction_lines (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_tx ON transaction_lines(transaction_id);
CREATE INDEX IF NOT EXISTS idx_lines_account ON transaction_lines(account_id);
CREATE TABLE IF NOT EXISTS label_memory (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used TEXT NOT NULL,
    last_kind TEXT,
    last_party_id INTEGER,
    last_amount INTEGER,
    avg_amount INTEGER,
    last_from_account_id INTEGER,
    last_lines TEXT
);
CREATE TABLE IF NOT EXISTS label_context (
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    party_id INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, kind, party_id)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub fn now_str() -> String {
    Utc::now().to_rfc3339()
}

/// Open (or create) the database file and run migrations.
pub fn open(path: &Path) -> Res<Connection> {
    let conn = Connection::open(path).map_err(e)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Res<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(e)?;
    conn.execute_batch(SCHEMA).map_err(e)?;
    // First run: a default cash box and default settings.
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
        .map_err(e)?;
    let seeded = get_setting(conn, "seeded")?.is_some();
    if count == 0 && !seeded {
        conn.execute(
            "INSERT INTO accounts (name, kind, opening_balance, color, created_at) VALUES ('Cash', 'cash', 0, '#16a34a', ?1)",
            params![now_str()],
        )
        .map_err(e)?;
    }
    for (k, v) in [
        ("seeded", "1"),
        ("currency_symbol", "$"),
        ("currency_position", "before"),
        ("decimals", "2"),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
            params![k, v],
        )
        .map_err(e)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn get_setting(conn: &Connection, key: &str) -> Res<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(e)
}

pub fn get_settings(conn: &Connection) -> Res<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(e)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Res<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(e)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

fn row_to_account(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get("id")?,
        name: r.get("name")?,
        kind: r.get("kind")?,
        opening_balance: r.get("opening_balance")?,
        color: r.get("color")?,
        notes: r.get("notes")?,
        archived: r.get::<_, i64>("archived")? != 0,
        balance: r.get("balance")?,
        created_at: r.get("created_at")?,
    })
}

const ACCOUNT_SELECT: &str = "SELECT a.*, a.opening_balance + COALESCE((SELECT SUM(l.amount) FROM transaction_lines l WHERE l.account_id = a.id), 0) AS balance FROM accounts a";

pub fn list_accounts(conn: &Connection, include_archived: bool) -> Res<Vec<Account>> {
    let sql = format!(
        "{ACCOUNT_SELECT} {} ORDER BY a.archived, a.name COLLATE NOCASE",
        if include_archived { "" } else { "WHERE a.archived = 0" }
    );
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt.query_map([], row_to_account).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_account(conn: &Connection, id: i64) -> Res<Account> {
    conn.query_row(&format!("{ACCOUNT_SELECT} WHERE a.id = ?1"), [id], row_to_account)
        .optional()
        .map_err(e)?
        .ok_or_else(|| format!("Account #{id} not found"))
}

pub fn save_account(conn: &Connection, input: &AccountInput) -> Res<Account> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Account name is required".into());
    }
    if !ACCOUNT_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("Unknown account type '{}'", input.kind));
    }
    let id = match input.id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE accounts SET name=?1, kind=?2, opening_balance=?3, color=?4, notes=?5, archived=?6 WHERE id=?7",
                    params![name, input.kind, input.opening_balance, input.color, input.notes, input.archived as i64, id],
                )
                .map_err(e)?;
            if n == 0 {
                return Err(format!("Account #{id} not found"));
            }
            id
        }
        None => {
            conn.execute(
                "INSERT INTO accounts (name, kind, opening_balance, color, notes, archived, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![name, input.kind, input.opening_balance, input.color, input.notes, input.archived as i64, now_str()],
            )
            .map_err(e)?;
            conn.last_insert_rowid()
        }
    };
    get_account(conn, id)
}

/// Deletes an account if it has no transactions; otherwise it is archived.
/// Returns `true` if deleted, `false` if archived.
pub fn delete_account(conn: &Connection, id: i64) -> Res<bool> {
    let used: i64 = conn
        .query_row("SELECT COUNT(*) FROM transaction_lines WHERE account_id = ?1", [id], |r| r.get(0))
        .map_err(e)?;
    if used > 0 {
        conn.execute("UPDATE accounts SET archived = 1 WHERE id = ?1", [id]).map_err(e)?;
        Ok(false)
    } else {
        conn.execute("DELETE FROM accounts WHERE id = ?1", [id]).map_err(e)?;
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

fn row_to_party(r: &Row) -> rusqlite::Result<Party> {
    Ok(Party {
        id: r.get("id")?,
        name: r.get("name")?,
        kind: r.get("kind")?,
        phone: r.get("phone")?,
        notes: r.get("notes")?,
        opening_balance: r.get("opening_balance")?,
        archived: r.get::<_, i64>("archived")? != 0,
        balance: r.get("balance")?,
        last_activity: r.get("last_activity")?,
        created_at: r.get("created_at")?,
    })
}

fn party_select() -> String {
    format!(
        "SELECT p.*, p.opening_balance + COALESCE((SELECT SUM({PARTY_EFFECT_SQL}) FROM transactions t WHERE t.party_id = p.id), 0) AS balance, \
         (SELECT MAX(t.date) FROM transactions t WHERE t.party_id = p.id) AS last_activity FROM parties p"
    )
}

pub fn list_parties(conn: &Connection, include_archived: bool) -> Res<Vec<Party>> {
    let sql = format!(
        "{} {} ORDER BY p.archived, p.name COLLATE NOCASE",
        party_select(),
        if include_archived { "" } else { "WHERE p.archived = 0" }
    );
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt.query_map([], row_to_party).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_party(conn: &Connection, id: i64) -> Res<Party> {
    conn.query_row(&format!("{} WHERE p.id = ?1", party_select()), [id], row_to_party)
        .optional()
        .map_err(e)?
        .ok_or_else(|| format!("Party #{id} not found"))
}

pub fn save_party(conn: &Connection, input: &PartyInput) -> Res<Party> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    if !PARTY_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("Unknown party type '{}'", input.kind));
    }
    let id = match input.id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE parties SET name=?1, kind=?2, phone=?3, notes=?4, opening_balance=?5, archived=?6 WHERE id=?7",
                    params![name, input.kind, input.phone, input.notes, input.opening_balance, input.archived as i64, id],
                )
                .map_err(e)?;
            if n == 0 {
                return Err(format!("Party #{id} not found"));
            }
            id
        }
        None => {
            conn.execute(
                "INSERT INTO parties (name, kind, phone, notes, opening_balance, archived, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![name, input.kind, input.phone, input.notes, input.opening_balance, input.archived as i64, now_str()],
            )
            .map_err(e)?;
            conn.last_insert_rowid()
        }
    };
    get_party(conn, id)
}

/// Deletes a party if it has no transactions; otherwise it is archived.
pub fn delete_party(conn: &Connection, id: i64) -> Res<bool> {
    let used: i64 = conn
        .query_row("SELECT COUNT(*) FROM transactions WHERE party_id = ?1", [id], |r| r.get(0))
        .map_err(e)?;
    if used > 0 {
        conn.execute("UPDATE parties SET archived = 1 WHERE id = ?1", [id]).map_err(e)?;
        Ok(false)
    } else {
        conn.execute("DELETE FROM parties WHERE id = ?1", [id]).map_err(e)?;
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

fn validate_date(d: &str) -> Res<()> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("Invalid date '{d}', expected YYYY-MM-DD"))
}

fn account_exists(conn: &Connection, id: i64) -> Res<bool> {
    conn.query_row("SELECT 1 FROM accounts WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
        .map_err(e)
}

fn party_exists(conn: &Connection, id: i64) -> Res<bool> {
    conn.query_row("SELECT 1 FROM parties WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
        .map_err(e)
}

/// Validates the input and returns (total, signed lines to store).
fn plan_lines(conn: &Connection, input: &TxInput) -> Res<(i64, Vec<(i64, i64)>)> {
    let kind = input.kind.as_str();
    if !TX_KINDS.contains(&kind) {
        return Err(format!("Unknown transaction type '{kind}'"));
    }
    validate_date(&input.date)?;
    if input.label.trim().is_empty() {
        return Err("Label is required".into());
    }
    if let Some(pid) = input.party_id {
        if !party_exists(conn, pid)? {
            return Err("Selected beneficiary does not exist".into());
        }
    }
    let check_lines = |lines: &[LineInput]| -> Res<i64> {
        if lines.is_empty() {
            return Err("Add at least one account".into());
        }
        let mut total = 0i64;
        for l in lines {
            if l.amount <= 0 {
                return Err("Every account amount must be greater than zero".into());
            }
            if !account_exists(conn, l.account_id)? {
                return Err(format!("Account #{} does not exist", l.account_id));
            }
            total = total.checked_add(l.amount).ok_or("Amount too large")?;
        }
        Ok(total)
    };
    match kind {
        "income" => {
            let total = check_lines(&input.lines)?;
            Ok((total, input.lines.iter().map(|l| (l.account_id, l.amount)).collect()))
        }
        "expense" => {
            let total = check_lines(&input.lines)?;
            Ok((total, input.lines.iter().map(|l| (l.account_id, -l.amount)).collect()))
        }
        "transfer" => {
            if input.party_id.is_some() {
                return Err("A transfer between your own accounts has no beneficiary".into());
            }
            let from = input.from_account_id.ok_or("Choose the source account")?;
            if !account_exists(conn, from)? {
                return Err("Source account does not exist".into());
            }
            if input.lines.iter().any(|l| l.account_id == from) {
                return Err("Cannot transfer an account to itself".into());
            }
            let total = check_lines(&input.lines)?;
            let mut lines = vec![(from, -total)];
            lines.extend(input.lines.iter().map(|l| (l.account_id, l.amount)));
            Ok((total, lines))
        }
        _ => {
            // purchase / sale on credit
            if input.party_id.is_none() {
                return Err("Choose the beneficiary for a credit operation".into());
            }
            let amount = input.amount.unwrap_or(0);
            if amount <= 0 {
                return Err("Amount must be greater than zero".into());
            }
            Ok((amount, vec![]))
        }
    }
}

pub fn save_transaction(conn: &mut Connection, input: &TxInput) -> Res<Transaction> {
    let (total, lines) = plan_lines(conn, input)?;
    let label = input.label.split_whitespace().collect::<Vec<_>>().join(" ");
    let notes = input.notes.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let tx = conn.transaction().map_err(e)?;
    let mut previous_key = None;
    let id = match input.id {
        Some(id) => {
            previous_key = tx
                .query_row("SELECT label FROM transactions WHERE id = ?1", [id], |r| r.get::<_, String>(0))
                .optional()
                .map_err(e)?
                .map(|l| suggest::normalize(&l));
            let n = tx
                .execute(
                    "UPDATE transactions SET date=?1, kind=?2, label=?3, party_id=?4, amount=?5, notes=?6 WHERE id=?7",
                    params![input.date, input.kind, label, input.party_id, total, notes, id],
                )
                .map_err(e)?;
            if n == 0 {
                return Err(format!("Transaction #{id} not found"));
            }
            tx.execute("DELETE FROM transaction_lines WHERE transaction_id = ?1", [id]).map_err(e)?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO transactions (date, kind, label, party_id, amount, notes, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![input.date, input.kind, label, input.party_id, total, notes, now_str()],
            )
            .map_err(e)?;
            tx.last_insert_rowid()
        }
    };
    for (account_id, amount) in &lines {
        tx.execute(
            "INSERT INTO transaction_lines (transaction_id, account_id, amount) VALUES (?1,?2,?3)",
            params![id, account_id, amount],
        )
        .map_err(e)?;
    }
    // Learn from this entry (an edit that keeps the same label does not count as a new use).
    if previous_key.as_deref() != Some(suggest::normalize(&label).as_str()) {
        learn(&tx, &label, input, total, Utc::now())?;
    }
    tx.commit().map_err(e)?;
    get_transaction(conn, id)
}

pub fn delete_transaction(conn: &Connection, id: i64) -> Res<()> {
    conn.execute("DELETE FROM transactions WHERE id = ?1", [id]).map_err(e)?;
    Ok(())
}

fn row_to_tx(r: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get("id")?,
        date: r.get("date")?,
        kind: r.get("kind")?,
        label: r.get("label")?,
        party_id: r.get("party_id")?,
        party_name: r.get("party_name")?,
        amount: r.get("amount")?,
        notes: r.get("notes")?,
        lines: vec![],
        created_at: r.get("created_at")?,
        effect: None,
        running_balance: None,
    })
}

fn load_lines(conn: &Connection, txs: &mut [Transaction]) -> Res<()> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT l.account_id, a.name, l.amount FROM transaction_lines l JOIN accounts a ON a.id = l.account_id \
             WHERE l.transaction_id = ?1 ORDER BY l.id",
        )
        .map_err(e)?;
    for t in txs.iter_mut() {
        let rows = stmt
            .query_map([t.id], |r| {
                Ok(LineView { account_id: r.get(0)?, account_name: r.get(1)?, amount: r.get(2)? })
            })
            .map_err(e)?;
        t.lines = rows.collect::<Result<_, _>>().map_err(e)?;
    }
    Ok(())
}

const TX_SELECT: &str = "SELECT t.*, p.name AS party_name FROM transactions t LEFT JOIN parties p ON p.id = t.party_id";

pub fn get_transaction(conn: &Connection, id: i64) -> Res<Transaction> {
    let mut t = conn
        .query_row(&format!("{TX_SELECT} WHERE t.id = ?1"), [id], row_to_tx)
        .optional()
        .map_err(e)?
        .ok_or_else(|| format!("Transaction #{id} not found"))?;
    load_lines(conn, std::slice::from_mut(&mut t))?;
    Ok(t)
}

/// Lists transactions newest first. `ascending` is used internally for statements.
fn query_transactions(conn: &Connection, f: &TxFilter, ascending: bool) -> Res<Vec<Transaction>> {
    let mut sql = format!("{TX_SELECT} WHERE 1=1");
    let mut args: Vec<rusqlite::types::Value> = vec![];
    if let Some(from) = f.from.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND t.date >= ?");
        args.push(from.clone().into());
    }
    if let Some(to) = f.to.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND t.date <= ?");
        args.push(to.clone().into());
    }
    if let Some(kind) = f.kind.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND t.kind = ?");
        args.push(kind.clone().into());
    }
    if let Some(aid) = f.account_id {
        sql.push_str(" AND t.id IN (SELECT transaction_id FROM transaction_lines WHERE account_id = ?)");
        args.push(aid.into());
    }
    if let Some(pid) = f.party_id {
        sql.push_str(" AND t.party_id = ?");
        args.push(pid.into());
    }
    if let Some(s) = f.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sql.push_str(" AND (t.label LIKE ? OR t.notes LIKE ? OR p.name LIKE ?)");
        let like = format!("%{s}%");
        args.extend([like.clone().into(), like.clone().into(), like.into()]);
    }
    if ascending {
        sql.push_str(" ORDER BY t.date ASC, t.id ASC");
    } else {
        sql.push_str(" ORDER BY t.date DESC, t.id DESC");
    }
    if let Some(limit) = f.limit {
        sql.push_str(&format!(" LIMIT {}", limit.max(0)));
    }
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), row_to_tx)
        .map_err(e)?;
    let mut txs: Vec<Transaction> = rows.collect::<Result<_, _>>().map_err(e)?;
    load_lines(conn, &mut txs)?;
    Ok(txs)
}

pub fn list_transactions(conn: &Connection, f: &TxFilter) -> Res<Vec<Transaction>> {
    query_transactions(conn, f, false)
}

/// Statement of a party with running balance (newest first).
pub fn party_statement(conn: &Connection, party_id: i64) -> Res<(Party, Vec<Transaction>)> {
    let party = get_party(conn, party_id)?;
    let mut txs = query_transactions(conn, &TxFilter { party_id: Some(party_id), ..Default::default() }, true)?;
    let mut bal = party.opening_balance;
    for t in txs.iter_mut() {
        let eff = party_effect(&t.kind, t.amount);
        bal += eff;
        t.effect = Some(eff);
        t.running_balance = Some(bal);
    }
    txs.reverse();
    Ok((party, txs))
}

/// Statement of an account with running balance (newest first).
pub fn account_statement(conn: &Connection, account_id: i64) -> Res<(Account, Vec<Transaction>)> {
    let account = get_account(conn, account_id)?;
    let mut txs = query_transactions(conn, &TxFilter { account_id: Some(account_id), ..Default::default() }, true)?;
    let mut bal = account.opening_balance;
    for t in txs.iter_mut() {
        let eff: i64 = t.lines.iter().filter(|l| l.account_id == account_id).map(|l| l.amount).sum();
        bal += eff;
        t.effect = Some(eff);
        t.running_balance = Some(bal);
    }
    txs.reverse();
    Ok((account, txs))
}

// ---------------------------------------------------------------------------
// Learning & suggestions
// ---------------------------------------------------------------------------

fn learn(conn: &Connection, label: &str, input: &TxInput, total: i64, now: DateTime<Utc>) -> Res<()> {
    let key = suggest::normalize(label);
    if key.is_empty() {
        return Ok(());
    }
    let lines_json = serde_json::to_string(&input.lines).map_err(e)?;
    let existing: Option<(i64, Option<i64>)> = conn
        .query_row("SELECT uses, avg_amount FROM label_memory WHERE key = ?1", [&key], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(e)?;
    let (uses, avg) = match existing {
        Some((uses, avg)) => {
            let avg = avg.unwrap_or(total);
            let new_avg = ((avg as i128 * uses as i128 + total as i128) / (uses as i128 + 1)) as i64;
            (uses + 1, new_avg)
        }
        None => (1, total),
    };
    conn.execute(
        "INSERT INTO label_memory (key, label, uses, last_used, last_kind, last_party_id, last_amount, avg_amount, last_from_account_id, last_lines) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) \
         ON CONFLICT(key) DO UPDATE SET label=excluded.label, uses=excluded.uses, last_used=excluded.last_used, last_kind=excluded.last_kind, \
         last_party_id=excluded.last_party_id, last_amount=excluded.last_amount, avg_amount=excluded.avg_amount, \
         last_from_account_id=excluded.last_from_account_id, last_lines=excluded.last_lines",
        params![key, label, uses, now.to_rfc3339(), input.kind, input.party_id, total, avg, input.from_account_id, lines_json],
    )
    .map_err(e)?;
    // Context counters: per kind (party 0) and per kind+party.
    let mut ctx = vec![0i64];
    if let Some(pid) = input.party_id {
        ctx.push(pid);
    }
    for pid in ctx {
        conn.execute(
            "INSERT INTO label_context (key, kind, party_id, uses) VALUES (?1, ?2, ?3, 1) \
             ON CONFLICT(key, kind, party_id) DO UPDATE SET uses = uses + 1",
            params![key, input.kind, pid],
        )
        .map_err(e)?;
    }
    Ok(())
}

fn parse_time(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

pub fn suggest_labels(conn: &Connection, q: &SuggestQuery) -> Res<Vec<Suggestion>> {
    suggest_labels_at(conn, q, Utc::now())
}

pub fn suggest_labels_at(conn: &Connection, q: &SuggestQuery, now: DateTime<Utc>) -> Res<Vec<Suggestion>> {
    let query = suggest::normalize(&q.query);
    let kind = q.kind.clone().unwrap_or_default();
    let party = q.party_id.unwrap_or(-1);
    let mut stmt = conn
        .prepare(
            "SELECT m.key, m.label, m.uses, m.last_used, m.last_kind, m.last_party_id, m.last_amount, m.avg_amount, \
                    m.last_from_account_id, m.last_lines, \
                    COALESCE((SELECT SUM(c.uses) FROM label_context c WHERE c.key = m.key AND c.kind = ?1 AND c.party_id = 0), 0), \
                    COALESCE((SELECT SUM(c.uses) FROM label_context c WHERE c.key = m.key AND c.party_id = ?2), 0) \
             FROM label_memory m",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map(params![kind, party], |r| {
            let last_lines: Option<String> = r.get(9)?;
            Ok((
                Suggestion {
                    key: r.get(0)?,
                    label: r.get(1)?,
                    uses: r.get(2)?,
                    last_used: r.get(3)?,
                    last_kind: r.get(4)?,
                    last_party_id: r.get(5)?,
                    last_amount: r.get(6)?,
                    avg_amount: r.get(7)?,
                    last_from_account_id: r.get(8)?,
                    last_lines: last_lines
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or_default(),
                    score: 0.0,
                },
                r.get::<_, i64>(10)?,
                r.get::<_, i64>(11)?,
            ))
        })
        .map_err(e)?;
    let mut out = vec![];
    for row in rows {
        let (mut s, kind_uses, party_uses) = row.map_err(e)?;
        let cand = suggest::Candidate {
            key: s.key.clone(),
            uses: s.uses,
            last_used: parse_time(&s.last_used),
            kind_uses,
            party_uses,
        };
        if let Some(score) = suggest::score(&query, &cand, now) {
            // Do not suggest exactly what is already typed unless it brings learned data.
            s.score = score;
            out.push(s);
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(q.limit.unwrap_or(8));
    Ok(out)
}

pub fn list_learned_labels(conn: &Connection) -> Res<Vec<Suggestion>> {
    suggest_labels(conn, &SuggestQuery { query: String::new(), kind: None, party_id: None, limit: Some(10_000) })
}

pub fn forget_label(conn: &Connection, key: &str) -> Res<()> {
    conn.execute("DELETE FROM label_memory WHERE key = ?1", [key]).map_err(e)?;
    conn.execute("DELETE FROM label_context WHERE key = ?1", [key]).map_err(e)?;
    Ok(())
}

/// Rebuilds the label memory from the full transaction history.
pub fn relearn_all(conn: &mut Connection) -> Res<usize> {
    let txs = query_transactions(conn, &TxFilter::default(), true)?;
    let tx = conn.transaction().map_err(e)?;
    tx.execute("DELETE FROM label_memory", []).map_err(e)?;
    tx.execute("DELETE FROM label_context", []).map_err(e)?;
    for t in &txs {
        let (from, lines) = split_back(t);
        let input = TxInput {
            id: Some(t.id),
            date: t.date.clone(),
            kind: t.kind.clone(),
            label: t.label.clone(),
            party_id: t.party_id,
            from_account_id: from,
            amount: Some(t.amount),
            lines,
            notes: None,
        };
        learn(&tx, &t.label, &input, t.amount, parse_time(&t.created_at))?;
    }
    tx.commit().map_err(e)?;
    Ok(txs.len())
}

/// Converts stored signed lines back to (from_account, positive input lines).
fn split_back(t: &Transaction) -> (Option<i64>, Vec<LineInput>) {
    match t.kind.as_str() {
        "transfer" => {
            let from = t.lines.iter().find(|l| l.amount < 0).map(|l| l.account_id);
            let lines = t
                .lines
                .iter()
                .filter(|l| l.amount > 0)
                .map(|l| LineInput { account_id: l.account_id, amount: l.amount })
                .collect();
            (from, lines)
        }
        _ => (
            None,
            t.lines.iter().map(|l| LineInput { account_id: l.account_id, amount: l.amount.abs() }).collect(),
        ),
    }
}

// ---------------------------------------------------------------------------
// Dashboard & reports
// ---------------------------------------------------------------------------

fn month_series(conn: &Connection, from: &str, to: &str) -> Res<Vec<MonthPoint>> {
    let mut stmt = conn
        .prepare(
            "SELECT substr(date, 1, 7) AS m, \
                    SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END), \
                    SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END) \
             FROM transactions WHERE date >= ?1 AND date <= ?2 GROUP BY m ORDER BY m",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            Ok(MonthPoint { month: r.get(0)?, income: r.get(1)?, expense: r.get(2)? })
        })
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

/// Fills missing months with zeros between `from` and `to` (inclusive, YYYY-MM).
fn fill_months(points: Vec<MonthPoint>, from: NaiveDate, to: NaiveDate) -> Vec<MonthPoint> {
    let map: HashMap<String, MonthPoint> = points.into_iter().map(|p| (p.month.clone(), p)).collect();
    let mut out = vec![];
    let (mut y, mut m) = (from.year(), from.month());
    while (y, m) <= (to.year(), to.month()) {
        let key = format!("{y:04}-{m:02}");
        out.push(map.get(&key).cloned().unwrap_or(MonthPoint { month: key, income: 0, expense: 0 }));
        if m == 12 {
            y += 1;
            m = 1;
        } else {
            m += 1;
        }
        if out.len() > 240 {
            break;
        }
    }
    out
}

pub fn dashboard(conn: &Connection) -> Res<Dashboard> {
    dashboard_at(conn, Local::now().date_naive())
}

pub fn dashboard_at(conn: &Connection, today: NaiveDate) -> Res<Dashboard> {
    let accounts = list_accounts(conn, false)?;
    let parties = list_parties(conn, false)?;
    let total_funds = accounts.iter().map(|a| a.balance).sum();
    let receivables = parties.iter().filter(|p| p.balance > 0).map(|p| p.balance).sum();
    let payables = parties.iter().filter(|p| p.balance < 0).map(|p| -p.balance).sum();

    let month_start = today.with_day(1).unwrap();
    let year_ago = NaiveDate::from_ymd_opt(
        if month_start.month() == 12 { month_start.year() } else { month_start.year() - 1 },
        if month_start.month() == 12 { 1 } else { month_start.month() + 1 },
        1,
    )
    .unwrap();
    let monthly = fill_months(
        month_series(conn, &year_ago.to_string(), &today.to_string())?,
        year_ago,
        today,
    );
    let this_month = monthly.last().cloned().unwrap_or(MonthPoint { month: String::new(), income: 0, expense: 0 });

    let mut debtors: Vec<Party> = parties.iter().filter(|p| p.balance > 0).cloned().collect();
    debtors.sort_by_key(|p| -p.balance);
    debtors.truncate(5);
    let mut creditors: Vec<Party> = parties.iter().filter(|p| p.balance < 0).cloned().collect();
    creditors.sort_by_key(|p| p.balance);
    creditors.truncate(5);

    let recent = list_transactions(conn, &TxFilter { limit: Some(8), ..Default::default() })?;
    Ok(Dashboard {
        total_funds,
        receivables,
        payables,
        month_income: this_month.income,
        month_expense: this_month.expense,
        accounts,
        top_debtors: debtors,
        top_creditors: creditors,
        monthly,
        recent,
    })
}

pub fn report(conn: &Connection, from: &str, to: &str) -> Res<Report> {
    validate_date(from)?;
    validate_date(to)?;
    let mut stmt = conn
        .prepare(
            "SELECT label, kind, SUM(amount), COUNT(*) FROM transactions \
             WHERE date >= ?1 AND date <= ?2 AND kind != 'transfer' \
             GROUP BY lower(label), kind ORDER BY SUM(amount) DESC",
        )
        .map_err(e)?;
    let by_label: Vec<LabelTotal> = stmt
        .query_map(params![from, to], |r| {
            Ok(LabelTotal { label: r.get(0)?, kind: r.get(1)?, total: r.get(2)?, count: r.get(3)? })
        })
        .map_err(e)?
        .collect::<Result<_, _>>()
        .map_err(e)?;
    let sum = |k: &str| by_label.iter().filter(|l| l.kind == k).map(|l| l.total).sum::<i64>();
    let f = NaiveDate::parse_from_str(from, "%Y-%m-%d").unwrap();
    let t = NaiveDate::parse_from_str(to, "%Y-%m-%d").unwrap();
    Ok(Report {
        income: sum("income"),
        expense: sum("expense"),
        purchases: sum("purchase"),
        sales: sum("sale"),
        monthly: fill_months(month_series(conn, from, to)?, f, t),
        by_label,
    })
}

// ---------------------------------------------------------------------------
// Export / backup
// ---------------------------------------------------------------------------

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// CSV of all transactions (amounts in major units using `decimals`).
pub fn export_csv(conn: &Connection) -> Res<String> {
    let decimals: u32 = get_setting(conn, "decimals")?.and_then(|d| d.parse().ok()).unwrap_or(2);
    let fmt = |v: i64| -> String {
        if decimals == 0 {
            return v.to_string();
        }
        let div = 10i64.pow(decimals);
        let sign = if v < 0 { "-" } else { "" };
        format!("{sign}{}.{:0width$}", v.abs() / div, v.abs() % div, width = decimals as usize)
    };
    let txs = list_transactions(conn, &TxFilter::default())?;
    let mut out = String::from("id,date,type,label,beneficiary,amount,accounts,notes\n");
    for t in txs {
        let accounts = t
            .lines
            .iter()
            .map(|l| format!("{}: {}", l.account_name, fmt(l.amount)))
            .collect::<Vec<_>>()
            .join(" | ");
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{}\n",
            t.id,
            t.date,
            t.kind,
            csv_field(&t.label),
            csv_field(t.party_name.as_deref().unwrap_or("")),
            fmt(t.amount),
            csv_field(&accounts),
            csv_field(t.notes.as_deref().unwrap_or("")),
        ));
    }
    Ok(out)
}

pub fn backup_to(conn: &Connection, path: &Path) -> Res<()> {
    if path.exists() {
        std::fs::remove_file(path).map_err(e)?;
    }
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy()]).map_err(e)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::inconsistent_digit_grouping)] // amounts written as dollars_cents
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn acc(c: &Connection, name: &str, kind: &str) -> i64 {
        save_account(c, &AccountInput { name: name.into(), kind: kind.into(), ..Default::default() })
            .unwrap()
            .id
    }

    fn party(c: &Connection, name: &str) -> i64 {
        save_party(c, &PartyInput { name: name.into(), kind: "supplier".into(), ..Default::default() })
            .unwrap()
            .id
    }

    fn tx(kind: &str, label: &str, lines: Vec<(i64, i64)>) -> TxInput {
        TxInput {
            date: "2026-10-01".into(),
            kind: kind.into(),
            label: label.into(),
            lines: lines.into_iter().map(|(a, m)| LineInput { account_id: a, amount: m }).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn seeds_cash_account() {
        let c = db();
        let accounts = list_accounts(&c, false).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].name, "Cash");
    }

    #[test]
    fn deposit_split_across_accounts() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let project = acc(&c, "Project A", "project");
        let t = save_transaction(&mut c, &tx("income", "Client payment", vec![(cash, 60_00), (project, 40_00)])).unwrap();
        assert_eq!(t.amount, 100_00);
        assert_eq!(t.lines.len(), 2);
        assert_eq!(get_account(&c, cash).unwrap().balance, 60_00);
        assert_eq!(get_account(&c, project).unwrap().balance, 40_00);
    }

    #[test]
    fn party_balances_owe_and_owed() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let sup = party(&c, "Supplier X");
        // Supplier delivers 500 of goods on credit -> I owe 500.
        let mut purchase = tx("purchase", "Cement", vec![]);
        purchase.party_id = Some(sup);
        purchase.amount = Some(500_00);
        save_transaction(&mut c, &purchase).unwrap();
        assert_eq!(get_party(&c, sup).unwrap().balance, -500_00);
        // I pay 300 from cash -> I owe 200.
        let mut pay = tx("expense", "Payment", vec![(cash, 300_00)]);
        pay.party_id = Some(sup);
        save_transaction(&mut c, &pay).unwrap();
        assert_eq!(get_party(&c, sup).unwrap().balance, -200_00);
        assert_eq!(get_account(&c, cash).unwrap().balance, -300_00);
        // Statement running balance, newest first.
        let (_, st) = party_statement(&c, sup).unwrap();
        assert_eq!(st[0].running_balance, Some(-200_00));
        assert_eq!(st[1].running_balance, Some(-500_00));
        let d = dashboard(&c).unwrap();
        assert_eq!(d.payables, 200_00);
        assert_eq!(d.receivables, 0);
    }

    #[test]
    fn transfer_moves_money() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let bank = acc(&c, "Bank", "bank");
        save_transaction(&mut c, &tx("income", "Sales", vec![(cash, 1000)])).unwrap();
        let mut t = tx("transfer", "To bank", vec![(bank, 400)]);
        t.from_account_id = Some(cash);
        save_transaction(&mut c, &t).unwrap();
        assert_eq!(get_account(&c, cash).unwrap().balance, 600);
        assert_eq!(get_account(&c, bank).unwrap().balance, 400);
        // self transfer rejected
        let mut bad = tx("transfer", "x", vec![(cash, 1)]);
        bad.from_account_id = Some(cash);
        assert!(save_transaction(&mut c, &bad).is_err());
    }

    #[test]
    fn edit_and_delete() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let t = save_transaction(&mut c, &tx("expense", "Fuel", vec![(cash, 50)])).unwrap();
        let mut edit = tx("expense", "Fuel", vec![(cash, 70)]);
        edit.id = Some(t.id);
        save_transaction(&mut c, &edit).unwrap();
        assert_eq!(get_account(&c, cash).unwrap().balance, -70);
        // Editing with the same label does not add a learned use.
        assert_eq!(list_learned_labels(&c).unwrap()[0].uses, 1);
        delete_transaction(&c, t.id).unwrap();
        assert_eq!(get_account(&c, cash).unwrap().balance, 0);
        // Account with no tx can be deleted; with tx it is archived.
        assert!(delete_account(&c, cash).unwrap());
    }

    #[test]
    fn validation_errors() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        assert!(save_transaction(&mut c, &tx("income", "", vec![(cash, 1)])).is_err());
        assert!(save_transaction(&mut c, &tx("income", "x", vec![])).is_err());
        assert!(save_transaction(&mut c, &tx("income", "x", vec![(cash, -5)])).is_err());
        assert!(save_transaction(&mut c, &tx("purchase", "x", vec![])).is_err());
        let mut bad_date = tx("income", "x", vec![(cash, 1)]);
        bad_date.date = "01/10/2026".into();
        assert!(save_transaction(&mut c, &bad_date).is_err());
    }

    #[test]
    fn learns_labels_and_context() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let project = acc(&c, "Project", "project");
        let sup = party(&c, "Ali");
        for _ in 0..5 {
            save_transaction(&mut c, &tx("expense", "Fuel truck", vec![(cash, 20_00)])).unwrap();
        }
        save_transaction(&mut c, &tx("expense", "Furniture", vec![(cash, 900_00)])).unwrap();
        let mut d = tx("income", "Fund deposit", vec![(cash, 50_00), (project, 50_00)]);
        d.party_id = Some(sup);
        save_transaction(&mut c, &d).unwrap();

        let s = suggest_labels(&c, &SuggestQuery { query: "fu".into(), kind: Some("expense".into()), ..Default::default() }).unwrap();
        assert_eq!(s[0].label, "Fuel truck");
        assert_eq!(s[0].uses, 5);
        assert_eq!(s[0].last_amount, Some(20_00));

        // Typo tolerant
        let s = suggest_labels(&c, &SuggestQuery { query: "furnitre".into(), ..Default::default() }).unwrap();
        assert_eq!(s[0].label, "Furniture");

        // Context: with the party selected and kind income, the deposit ranks first and remembers the split.
        let s = suggest_labels(
            &c,
            &SuggestQuery { query: "f".into(), kind: Some("income".into()), party_id: Some(sup), limit: None },
        )
        .unwrap();
        assert_eq!(s[0].label, "Fund deposit");
        assert_eq!(s[0].last_lines.len(), 2);
        assert_eq!(s[0].last_party_id, Some(sup));

        forget_label(&c, "furniture").unwrap();
        assert_eq!(list_learned_labels(&c).unwrap().len(), 2);
        assert_eq!(relearn_all(&mut c).unwrap(), 7);
        assert_eq!(list_learned_labels(&c).unwrap().len(), 3);
    }

    #[test]
    fn report_and_csv() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        save_transaction(&mut c, &tx("income", "Sale, \"big\"", vec![(cash, 12345)])).unwrap();
        save_transaction(&mut c, &tx("expense", "Rent", vec![(cash, 5000)])).unwrap();
        let r = report(&c, "2026-01-01", "2026-12-31").unwrap();
        assert_eq!(r.income, 12345);
        assert_eq!(r.expense, 5000);
        assert_eq!(r.monthly.len(), 12);
        let csv = export_csv(&c).unwrap();
        assert!(csv.contains("\"Sale, \"\"big\"\"\""));
        assert!(csv.contains("123.45"));
    }

    #[test]
    fn dashboard_months() {
        let c = db();
        let d = dashboard_at(&c, NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()).unwrap();
        assert_eq!(d.monthly.len(), 12);
        assert_eq!(d.monthly[0].month, "2025-11");
        assert_eq!(d.monthly[11].month, "2026-10");
    }
}

/// Builds a demo database for screenshots: `DEMO_DB=/path/demo.db cargo test demo_db -- --ignored`
#[cfg(test)]
#[allow(clippy::inconsistent_digit_grouping)]
mod demo {
    use super::*;

    #[test]
    #[ignore]
    fn demo_db() {
        let path = std::env::var("DEMO_DB").expect("DEMO_DB");
        let _ = std::fs::remove_file(&path);
        let mut c = open(Path::new(&path)).unwrap();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let mk = |c: &Connection, n: &str, k: &str, col: &str| {
            save_account(c, &AccountInput { name: n.into(), kind: k.into(), color: Some(col.into()), ..Default::default() }).unwrap().id
        };
        let bank = mk(&c, "Bank BNA", "bank", "#2563eb");
        let villa = mk(&c, "Project Villa", "project", "#9333ea");
        let shop = mk(&c, "Project Shop", "project", "#ea580c");
        let p = |c: &Connection, n: &str, k: &str| {
            save_party(c, &PartyInput { name: n.into(), kind: k.into(), ..Default::default() }).unwrap().id
        };
        let cement = p(&c, "Cement Supplier Co.", "supplier");
        let ahmed = p(&c, "Ahmed", "person");
        let client = p(&c, "Client Karim", "client");
        let mut add = |date: &str, kind: &str, label: &str, party: Option<i64>, from: Option<i64>, amount: Option<i64>, lines: Vec<(i64, i64)>| {
            save_transaction(&mut c, &TxInput {
                date: date.into(), kind: kind.into(), label: label.into(), party_id: party, from_account_id: from, amount,
                lines: lines.into_iter().map(|(a, m)| LineInput { account_id: a, amount: m }).collect(),
                ..Default::default()
            }).unwrap();
        };
        let months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
        for (i, m) in months.iter().enumerate() {
            let i = i as i64;
            add(&format!("{m}-01"), "sale", "Villa works invoice", Some(client), None, Some(6200_00 + i * 150_00), vec![]);
            add(&format!("{m}-02"), "income", "Client payment", Some(client), None, None, vec![(cash, 3000_00 + i * 150_00), (villa, 2000_00), (shop, 1000_00)]);
            add(&format!("{m}-05"), "expense", "Fuel truck", None, None, None, vec![(cash, 120_00 + i * 5_00)]);
            add(&format!("{m}-08"), "expense", "Office rent", None, None, None, vec![(bank, 900_00)]);
            add(&format!("{m}-10"), "purchase", "Cement delivery", Some(cement), None, Some(1500_00 + i * 100_00), vec![]);
            add(&format!("{m}-12"), "expense", "Payment to supplier", Some(cement), None, None, vec![(villa, 1200_00)]);
            add(&format!("{m}-15"), "transfer", "Cash to bank", None, Some(cash), None, vec![(bank, 1500_00)]);
            add(&format!("{m}-20"), "expense", "Workers salary", None, None, None, vec![(villa, 700_00), (shop, 300_00)]);
        }
        add("2026-09-25", "expense", "Loan to Ahmed", Some(ahmed), None, None, vec![(cash, 500_00)]);
        add("2026-10-03", "income", "Ahmed repaid part", Some(ahmed), None, None, vec![(cash, 200_00)]);
        add("2026-10-06", "expense", "Fuel generator", None, None, None, vec![(shop, 60_00)]);
        add("2026-10-07", "expense", "Furniture", None, None, None, vec![(shop, 850_00)]);
    }
}
