//! Database layer: schema, accounts, parties, transactions, learning and reports.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::admin;
use crate::models::*;
use crate::suggest;

pub type Res<T> = Result<T, String>;

pub(crate) fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

pub const ACCOUNT_KINDS: &[&str] = &["cash", "bank", "project", "other"];
pub const PARTY_KINDS: &[&str] = &["supplier", "client", "person", "employee", "other"];
pub const TX_KINDS: &[&str] = &["income", "expense", "transfer", "purchase", "sale"];
pub const TX_STATUSES: &[&str] = &["ok", "pending"];

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

/// Schema changes after the first version, applied once in order (tracked by `PRAGMA user_version`).
const MIGRATIONS: &[&str] = &[
    // v1: chantiers, family, status and cheque details.
    r#"
    CREATE TABLE IF NOT EXISTS chantiers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        client TEXT,
        notes TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    ALTER TABLE transactions ADD COLUMN chantier_id INTEGER REFERENCES chantiers(id);
    ALTER TABLE transactions ADD COLUMN family TEXT;
    ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
    ALTER TABLE transactions ADD COLUMN cheque_no TEXT;
    ALTER TABLE transactions ADD COLUMN cheque_crossed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE transactions ADD COLUMN cheque_payee TEXT;
    ALTER TABLE transaction_lines ADD COLUMN chantier_id INTEGER REFERENCES chantiers(id);
    CREATE INDEX IF NOT EXISTS idx_lines_chantier ON transaction_lines(chantier_id);
    ALTER TABLE label_memory ADD COLUMN last_chantier_id INTEGER;
    ALTER TABLE label_memory ADD COLUMN last_family TEXT;
    "#,
    // v2: users, fiscal years (exercices), change history and performance indexes.
    r#"
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        full_name TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS exercises (
        year INTEGER PRIMARY KEY,
        closed INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT,
        closed_by TEXT,
        created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO exercises (year, created_at)
        SELECT DISTINCT CAST(substr(date, 1, 4) AS INTEGER), datetime('now') FROM transactions;
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        summary TEXT NOT NULL,
        before TEXT,
        after TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
    CREATE INDEX IF NOT EXISTS idx_tx_kind_date ON transactions(kind, date);
    CREATE INDEX IF NOT EXISTS idx_tx_chantier ON transactions(chantier_id);
    CREATE INDEX IF NOT EXISTS idx_lines_chantier_tx ON transaction_lines(chantier_id, transaction_id, amount);
    CREATE INDEX IF NOT EXISTS idx_lines_account_amount ON transaction_lines(account_id, amount);
    "#,
];

/// `label_context.kind` value used to count uses of a label per chantier (`party_id` holds the chantier id).
const CHANTIER_CTX: &str = "#chantier";

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
    // WAL + synchronous=NORMAL: every commit is durable against app crashes and fast;
    // a large page cache and memory-mapped reads keep big years snappy.
    conn.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; \
         PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456; \
         PRAGMA busy_timeout = 5000;",
    )
    .map_err(e)?;
    conn.execute_batch(SCHEMA).map_err(e)?;
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(e)?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        if let Err(err) = conn.execute_batch(&format!("BEGIN; {sql} PRAGMA user_version = {}; COMMIT;", i + 1)) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(format!("Database migration {} failed: {err}", i + 1));
        }
    }
    // First run: a default cash box and default settings.
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
        .map_err(e)?;
    let seeded = get_setting(conn, "seeded")?.is_some();
    if count == 0 && !seeded {
        conn.execute(
            "INSERT INTO accounts (name, kind, opening_balance, color, created_at) VALUES ('Caisse', 'cash', 0, '#16a34a', ?1)",
            params![now_str()],
        )
        .map_err(e)?;
    }
    for (k, v) in [
        ("seeded", "1"),
        ("currency_symbol", "DA"),
        ("currency_position", "after"),
        ("currency_name", "dinars"),
        ("currency_subunit", "centimes"),
        ("decimals", "2"),
        ("language", "fr"),
        ("company_name", ""),
        ("company_activity", ""),
        ("cheque_city", ""),
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
// Chantiers
// ---------------------------------------------------------------------------

fn row_to_chantier(r: &Row) -> rusqlite::Result<Chantier> {
    Ok(Chantier {
        id: r.get("id")?,
        name: r.get("name")?,
        client: r.get("client")?,
        notes: r.get("notes")?,
        archived: r.get::<_, i64>("archived")? != 0,
        income: r.get("income")?,
        expense: r.get("expense")?,
        purchases: r.get("purchases")?,
        last_activity: r.get("last_activity")?,
        created_at: r.get("created_at")?,
    })
}

/// Chantier totals, optionally limited to a date range (`?1` = from, `?2` = to, empty = unbounded).
/// Each total is aggregated once per chantier (grouped joins), which stays fast with large years.
const CHANTIER_SELECT: &str = "SELECT c.*, COALESCE(li.income, 0) AS income, COALESCE(li.expense, 0) AS expense, \
    COALESCE(pu.purchases, 0) AS purchases, la.last_activity \
    FROM chantiers c \
    LEFT JOIN (SELECT l.chantier_id AS cid, \
                      SUM(CASE WHEN t.kind = 'income' THEN l.amount ELSE 0 END) AS income, \
                      -SUM(CASE WHEN t.kind = 'expense' THEN l.amount ELSE 0 END) AS expense \
               FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id \
               WHERE l.chantier_id IS NOT NULL AND (?1 = '' OR t.date >= ?1) AND (?2 = '' OR t.date <= ?2) \
               GROUP BY l.chantier_id) li ON li.cid = c.id \
    LEFT JOIN (SELECT chantier_id AS cid, SUM(amount) AS purchases FROM transactions \
               WHERE kind = 'purchase' AND chantier_id IS NOT NULL AND (?1 = '' OR date >= ?1) AND (?2 = '' OR date <= ?2) \
               GROUP BY chantier_id) pu ON pu.cid = c.id \
    LEFT JOIN (SELECT cid, MAX(d) AS last_activity FROM ( \
                   SELECT chantier_id AS cid, MAX(date) AS d FROM transactions WHERE chantier_id IS NOT NULL GROUP BY chantier_id \
                   UNION ALL \
                   SELECT l.chantier_id, MAX(t.date) FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id \
                   WHERE l.chantier_id IS NOT NULL GROUP BY l.chantier_id) GROUP BY cid) la ON la.cid = c.id";

pub fn list_chantiers(conn: &Connection, include_archived: bool) -> Res<Vec<Chantier>> {
    list_chantiers_between(conn, include_archived, "", "")
}

fn list_chantiers_between(conn: &Connection, include_archived: bool, from: &str, to: &str) -> Res<Vec<Chantier>> {
    let sql = format!(
        "{CHANTIER_SELECT} {} ORDER BY c.archived, c.name COLLATE NOCASE",
        if include_archived { "" } else { "WHERE c.archived = 0" }
    );
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt.query_map(params![from, to], row_to_chantier).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_chantier(conn: &Connection, id: i64) -> Res<Chantier> {
    conn.query_row(&format!("{CHANTIER_SELECT} WHERE c.id = ?3"), params!["", "", id], row_to_chantier)
        .optional()
        .map_err(e)?
        .ok_or_else(|| format!("Chantier #{id} not found"))
}

pub fn save_chantier(conn: &Connection, input: &ChantierInput) -> Res<Chantier> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Chantier name is required".into());
    }
    let id = match input.id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE chantiers SET name=?1, client=?2, notes=?3, archived=?4 WHERE id=?5",
                    params![name, input.client, input.notes, input.archived as i64, id],
                )
                .map_err(e)?;
            if n == 0 {
                return Err(format!("Chantier #{id} not found"));
            }
            id
        }
        None => {
            conn.execute(
                "INSERT INTO chantiers (name, client, notes, archived, created_at) VALUES (?1,?2,?3,?4,?5)",
                params![name, input.client, input.notes, input.archived as i64, now_str()],
            )
            .map_err(e)?;
            conn.last_insert_rowid()
        }
    };
    get_chantier(conn, id)
}

/// Deletes a chantier if nothing references it; otherwise it is archived.
pub fn delete_chantier(conn: &Connection, id: i64) -> Res<bool> {
    let used: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM transactions WHERE chantier_id = ?1) + \
                    (SELECT COUNT(*) FROM transaction_lines WHERE chantier_id = ?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(e)?;
    if used > 0 {
        conn.execute("UPDATE chantiers SET archived = 1 WHERE id = ?1", [id]).map_err(e)?;
        Ok(false)
    } else {
        conn.execute("DELETE FROM chantiers WHERE id = ?1", [id]).map_err(e)?;
        Ok(true)
    }
}

/// Statement of a chantier: every transaction touching it, with the signed amount
/// attributed to the chantier and a running cash balance "received - spent" (newest first).
/// Credit purchases/sales are listed with their amount but do not move the balance: they are
/// settled later by expenses/incomes, which would otherwise be counted twice.
pub fn chantier_statement(conn: &Connection, chantier_id: i64) -> Res<(Chantier, Vec<Transaction>)> {
    let chantier = get_chantier(conn, chantier_id)?;
    let mut txs = query_transactions(conn, &TxFilter { chantier_id: Some(chantier_id), ..Default::default() }, true)?;
    let mut bal = 0;
    for t in txs.iter_mut() {
        let eff: i64 = match t.kind.as_str() {
            "income" | "expense" => t.lines.iter().filter(|l| l.chantier_id == Some(chantier_id)).map(|l| l.amount).sum(),
            "purchase" => -t.amount,
            "sale" => t.amount,
            _ => 0,
        };
        if t.kind == "income" || t.kind == "expense" {
            bal += eff;
        }
        t.effect = Some(eff);
        t.running_balance = Some(bal);
    }
    txs.reverse();
    Ok((chantier, txs))
}

// ---------------------------------------------------------------------------
// Families, fiscal years, cheques
// ---------------------------------------------------------------------------

/// Families used so far, most used first.
pub fn list_families(conn: &Connection) -> Res<Vec<FamilyCount>> {
    let mut stmt = conn
        .prepare(
            "SELECT family, COUNT(*) AS n FROM transactions WHERE family IS NOT NULL AND family != '' \
             GROUP BY lower(family) ORDER BY n DESC, family COLLATE NOCASE",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| Ok(FamilyCount { name: r.get(0)?, count: r.get(1)? }))
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

/// Suggests the next cheque number for an account: last numeric cheque number used on it + 1.
pub fn next_cheque_no(conn: &Connection, account_id: i64) -> Res<Option<String>> {
    let last: Option<String> = conn
        .query_row(
            "SELECT t.cheque_no FROM transactions t \
             WHERE t.cheque_no IS NOT NULL AND t.cheque_no != '' \
               AND t.id IN (SELECT transaction_id FROM transaction_lines WHERE account_id = ?1) \
             ORDER BY t.date DESC, t.id DESC LIMIT 1",
            [account_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(e)?;
    Ok(last.and_then(|s| increment_number(&s)))
}

/// "0001234" -> "0001235", "CH-099" -> "CH-100". `None` if it does not end with digits.
fn increment_number(s: &str) -> Option<String> {
    let digits: String = s.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    if digits.is_empty() {
        return None;
    }
    let prefix = &s[..s.len() - digits.len()];
    let n: u128 = digits.parse().ok()?;
    Some(format!("{prefix}{:0width$}", n + 1, width = digits.len()))
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
/// A line ready to be stored: (account, signed amount, chantier).
type PlannedLine = (i64, i64, Option<i64>);

fn chantier_exists(conn: &Connection, id: i64) -> Res<bool> {
    conn.query_row("SELECT 1 FROM chantiers WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
        .map_err(e)
}

fn plan_lines(conn: &Connection, input: &TxInput) -> Res<(i64, Vec<PlannedLine>)> {
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
    if let Some(status) = input.status.as_deref() {
        if !TX_STATUSES.contains(&status) {
            return Err(format!("Unknown status '{status}'"));
        }
    }
    for cid in input.chantier_id.iter().chain(input.lines.iter().filter_map(|l| l.chantier_id.as_ref())) {
        if !chantier_exists(conn, *cid)? {
            return Err("Selected chantier does not exist".into());
        }
    }
    // A line without its own chantier uses the transaction's chantier.
    let chantier = |l: &LineInput| l.chantier_id.or(input.chantier_id);
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
            Ok((total, input.lines.iter().map(|l| (l.account_id, l.amount, chantier(l))).collect()))
        }
        "expense" => {
            let total = check_lines(&input.lines)?;
            Ok((total, input.lines.iter().map(|l| (l.account_id, -l.amount, chantier(l))).collect()))
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
            let mut lines = vec![(from, -total, None)];
            lines.extend(input.lines.iter().map(|l| (l.account_id, l.amount, None)));
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

/// Save without a user (tests, imports).
#[cfg_attr(not(test), allow(dead_code))]
pub fn save_transaction(conn: &mut Connection, input: &TxInput) -> Res<Transaction> {
    save_transaction_by(conn, input, None)
}

/// How a save is applied: the normal create/update, or re-inserting a deleted entry with its old number.
#[derive(Clone, Copy, PartialEq)]
enum SaveMode {
    Normal,
    Restore(i64),
}

/// Saves a transaction on behalf of `user`: refuses closed fiscal years, records the change history.
pub fn save_transaction_by(conn: &mut Connection, input: &TxInput, user: Option<&User>) -> Res<Transaction> {
    save_inner(conn, input, user, SaveMode::Normal)
}

fn save_inner(conn: &mut Connection, input: &TxInput, user: Option<&User>, mode: SaveMode) -> Res<Transaction> {
    let (total, lines) = plan_lines(conn, input)?;
    admin::ensure_open(conn, &input.date)?;
    let before = match (mode, input.id) {
        (SaveMode::Normal, Some(id)) => {
            let old = get_transaction(conn, id)?;
            admin::ensure_open(conn, &old.date)?;
            Some(old)
        }
        _ => None,
    };
    let label = input.label.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = |o: &Option<String>| o.as_ref().map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|s| !s.is_empty());
    let notes = input.notes.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let family = clean(&input.family);
    let cheque_no = clean(&input.cheque_no);
    let cheque_payee = clean(&input.cheque_payee);
    let status = input.status.clone().unwrap_or_else(|| "ok".into());
    let chantier_id = if input.kind == "transfer" { None } else { input.chantier_id };
    let tx = conn.transaction().map_err(e)?;
    admin::ensure_exercise(&tx, admin::year_of(&input.date))?;
    let mut previous_key = None;
    let id = match (mode, input.id) {
        (SaveMode::Restore(id), _) => {
            tx.execute(
                "INSERT INTO transactions (id, date, kind, label, party_id, amount, notes, created_at, chantier_id, family, status, \
                 cheque_no, cheque_crossed, cheque_payee) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    id, input.date, input.kind, label, input.party_id, total, notes, now_str(), chantier_id,
                    family, status, cheque_no, input.cheque_crossed as i64, cheque_payee
                ],
            )
            .map_err(|_| "ERR:number_taken".to_string())?;
            id
        }
        (SaveMode::Normal, Some(id)) => {
            previous_key = tx
                .query_row("SELECT label FROM transactions WHERE id = ?1", [id], |r| r.get::<_, String>(0))
                .optional()
                .map_err(e)?
                .map(|l| suggest::normalize(&l));
            let n = tx
                .execute(
                    "UPDATE transactions SET date=?1, kind=?2, label=?3, party_id=?4, amount=?5, notes=?6, chantier_id=?7, \
                     family=?8, status=?9, cheque_no=?10, cheque_crossed=?11, cheque_payee=?12 WHERE id=?13",
                    params![
                        input.date, input.kind, label, input.party_id, total, notes, chantier_id,
                        family, status, cheque_no, input.cheque_crossed as i64, cheque_payee, id
                    ],
                )
                .map_err(e)?;
            if n == 0 {
                return Err(format!("Transaction #{id} not found"));
            }
            tx.execute("DELETE FROM transaction_lines WHERE transaction_id = ?1", [id]).map_err(e)?;
            id
        }
        (SaveMode::Normal, None) => {
            tx.execute(
                "INSERT INTO transactions (date, kind, label, party_id, amount, notes, created_at, chantier_id, family, status, \
                 cheque_no, cheque_crossed, cheque_payee) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    input.date, input.kind, label, input.party_id, total, notes, now_str(), chantier_id,
                    family, status, cheque_no, input.cheque_crossed as i64, cheque_payee
                ],
            )
            .map_err(e)?;
            tx.last_insert_rowid()
        }
    };
    for (account_id, amount, chantier) in &lines {
        tx.execute(
            "INSERT INTO transaction_lines (transaction_id, account_id, amount, chantier_id) VALUES (?1,?2,?3,?4)",
            params![id, account_id, amount, chantier],
        )
        .map_err(e)?;
    }
    // Learn from this entry (an edit that keeps the same label does not count as a new use).
    if previous_key.as_deref() != Some(suggest::normalize(&label).as_str()) {
        learn(&tx, &label, input, total, Utc::now())?;
    }
    let after = get_transaction(&tx, id)?;
    let action = match (mode, &before) {
        (SaveMode::Restore(_), _) => "restore",
        (_, Some(_)) => "update",
        _ => "create",
    };
    admin::audit(&tx, user, action, "transaction", Some(id), &tx_summary(&after), before.as_ref(), Some(&after))?;
    tx.commit().map_err(e)?;
    Ok(after)
}

/// "N° 12 · 2026-09-29 · Ciment · 8288.00" — the one-line description stored in the history.
fn tx_summary(t: &Transaction) -> String {
    format!("{} · {} · {}", t.date, t.label, t.amount)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn delete_transaction(conn: &mut Connection, id: i64) -> Res<()> {
    delete_transaction_by(conn, id, None)
}

pub fn delete_transaction_by(conn: &mut Connection, id: i64, user: Option<&User>) -> Res<()> {
    let before = get_transaction(conn, id)?;
    admin::ensure_open(conn, &before.date)?;
    let tx = conn.transaction().map_err(e)?;
    tx.execute("DELETE FROM transactions WHERE id = ?1", [id]).map_err(e)?;
    admin::audit(&tx, user, "delete", "transaction", Some(id), &tx_summary(&before), Some(&before), None)?;
    tx.commit().map_err(e)?;
    Ok(())
}

/// Re-creates a deleted transaction from its history entry, with its original number.
pub fn restore_transaction(conn: &mut Connection, audit_id: i64, user: Option<&User>) -> Res<Transaction> {
    let snap = admin::audit_before(conn, audit_id)?;
    let (from_account_id, lines) = split_back(&snap);
    let input = TxInput {
        id: None,
        date: snap.date.clone(),
        kind: snap.kind.clone(),
        label: snap.label.clone(),
        party_id: snap.party_id.filter(|p| party_exists(conn, *p).unwrap_or(false)),
        chantier_id: snap.chantier_id.filter(|c| chantier_exists(conn, *c).unwrap_or(false)),
        family: snap.family.clone(),
        status: Some(snap.status.clone()),
        cheque_no: snap.cheque_no.clone(),
        cheque_crossed: snap.cheque_crossed,
        cheque_payee: snap.cheque_payee.clone(),
        from_account_id,
        amount: Some(snap.amount),
        lines,
        notes: snap.notes.clone(),
    };
    save_inner(conn, &input, user, SaveMode::Restore(snap.id))
}

/// Maps a row of `TX_SELECT` (positional columns: faster than lookups by name on big lists).
fn row_to_tx(r: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get(0)?,
        date: r.get(1)?,
        kind: r.get(2)?,
        label: r.get(3)?,
        party_id: r.get(4)?,
        amount: r.get(5)?,
        notes: r.get(6)?,
        created_at: r.get(7)?,
        chantier_id: r.get(8)?,
        family: r.get(9)?,
        status: r.get(10)?,
        cheque_no: r.get(11)?,
        cheque_crossed: r.get::<_, i64>(12)? != 0,
        cheque_payee: r.get(13)?,
        party_name: r.get(14)?,
        chantier_name: r.get(15)?,
        lines: vec![],
        effect: None,
        running_balance: None,
    })
}

/// Loads the account lines of many transactions with one query per 5,000 transactions
/// (instead of one query per transaction).
fn load_lines(conn: &Connection, txs: &mut [Transaction]) -> Res<()> {
    if txs.is_empty() {
        return Ok(());
    }
    let index: HashMap<i64, usize> = txs.iter().enumerate().map(|(i, t)| (t.id, i)).collect();
    let mut stmt = conn
        .prepare_cached(
            "SELECT l.transaction_id, l.account_id, a.name, l.amount, l.chantier_id, c.name FROM transaction_lines l \
             JOIN accounts a ON a.id = l.account_id LEFT JOIN chantiers c ON c.id = l.chantier_id \
             WHERE l.transaction_id IN (SELECT value FROM json_each(?1)) ORDER BY l.id",
        )
        .map_err(e)?;
    let ids: Vec<i64> = txs.iter().map(|t| t.id).collect();
    for chunk in ids.chunks(5_000) {
        let json = serde_json::to_string(chunk).map_err(e)?;
        let mut rows = stmt.query([json]).map_err(e)?;
        while let Some(r) = rows.next().map_err(e)? {
            let tid: i64 = r.get(0).map_err(e)?;
            if let Some(&i) = index.get(&tid) {
                txs[i].lines.push(LineView {
                    account_id: r.get(1).map_err(e)?,
                    account_name: r.get(2).map_err(e)?,
                    amount: r.get(3).map_err(e)?,
                    chantier_id: r.get(4).map_err(e)?,
                    chantier_name: r.get(5).map_err(e)?,
                });
            }
        }
    }
    Ok(())
}

const TX_SELECT: &str = "SELECT t.id, t.date, t.kind, t.label, t.party_id, t.amount, t.notes, t.created_at, t.chantier_id, \
     t.family, t.status, t.cheque_no, t.cheque_crossed, t.cheque_payee, p.name AS party_name, c.name AS chantier_name FROM transactions t \
     LEFT JOIN parties p ON p.id = t.party_id LEFT JOIN chantiers c ON c.id = t.chantier_id";

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
    if let Some(cid) = f.chantier_id {
        sql.push_str(" AND (t.chantier_id = ? OR t.id IN (SELECT transaction_id FROM transaction_lines WHERE chantier_id = ?))");
        args.extend([cid.into(), cid.into()]);
    }
    if let Some(fam) = f.family.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND t.family = ? COLLATE NOCASE");
        args.push(fam.clone().into());
    }
    if let Some(min) = f.min_amount {
        sql.push_str(" AND t.amount >= ?");
        args.push(min.into());
    }
    if let Some(max) = f.max_amount {
        sql.push_str(" AND t.amount <= ?");
        args.push(max.into());
    }
    if let Some(st) = f.status.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND t.status = ?");
        args.push(st.clone().into());
    }
    if let Some(s) = f.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        // Also matches the transaction number ("1257") and amounts typed in major units.
        sql.push_str(
            " AND (t.label LIKE ? OR t.notes LIKE ? OR p.name LIKE ? OR c.name LIKE ? OR t.family LIKE ? \
             OR t.cheque_no LIKE ? OR t.cheque_payee LIKE ? OR CAST(t.id AS TEXT) = ? \
             OR t.id IN (SELECT l.transaction_id FROM transaction_lines l JOIN accounts a ON a.id = l.account_id \
                         LEFT JOIN chantiers lc ON lc.id = l.chantier_id WHERE a.name LIKE ? OR lc.name LIKE ?))",
        );
        let like: rusqlite::types::Value = format!("%{s}%").into();
        for _ in 0..7 {
            args.push(like.clone());
        }
        args.push(s.to_string().into());
        args.push(like.clone());
        args.push(like);
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
    let family = input.family.as_deref().map(str::trim).filter(|f| !f.is_empty());
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
        "INSERT INTO label_memory (key, label, uses, last_used, last_kind, last_party_id, last_amount, avg_amount, \
         last_from_account_id, last_lines, last_chantier_id, last_family) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
         ON CONFLICT(key) DO UPDATE SET label=excluded.label, uses=excluded.uses, last_used=excluded.last_used, last_kind=excluded.last_kind, \
         last_party_id=excluded.last_party_id, last_amount=excluded.last_amount, avg_amount=excluded.avg_amount, \
         last_from_account_id=excluded.last_from_account_id, last_lines=excluded.last_lines, \
         last_chantier_id=excluded.last_chantier_id, last_family=excluded.last_family",
        params![
            key, label, uses, now.to_rfc3339(), input.kind, input.party_id, total, avg, input.from_account_id, lines_json,
            input.chantier_id, family
        ],
    )
    .map_err(e)?;
    if let Some(cid) = input.chantier_id {
        conn.execute(
            "INSERT INTO label_context (key, kind, party_id, uses) VALUES (?1, ?2, ?3, 1) \
             ON CONFLICT(key, kind, party_id) DO UPDATE SET uses = uses + 1",
            params![key, CHANTIER_CTX, cid],
        )
        .map_err(e)?;
    }
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
    let chantier = q.chantier_id.unwrap_or(-1);
    let mut stmt = conn
        .prepare(
            "SELECT m.key, m.label, m.uses, m.last_used, m.last_kind, m.last_party_id, m.last_amount, m.avg_amount, \
                    m.last_from_account_id, m.last_lines, \
                    COALESCE((SELECT SUM(c.uses) FROM label_context c WHERE c.key = m.key AND c.kind = ?1 AND c.party_id = 0), 0), \
                    COALESCE((SELECT SUM(c.uses) FROM label_context c WHERE c.key = m.key AND c.kind != ?3 AND c.party_id = ?2), 0), \
                    COALESCE((SELECT SUM(c.uses) FROM label_context c WHERE c.key = m.key AND c.kind = ?3 AND c.party_id = ?4), 0), \
                    m.last_chantier_id, m.last_family \
             FROM label_memory m",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map(params![kind, party, CHANTIER_CTX, chantier], |r| {
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
                    last_chantier_id: r.get(13)?,
                    last_family: r.get(14)?,
                    last_lines: last_lines
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or_default(),
                    score: 0.0,
                },
                r.get::<_, i64>(10)?,
                r.get::<_, i64>(11)?,
                r.get::<_, i64>(12)?,
            ))
        })
        .map_err(e)?;
    let mut out = vec![];
    for row in rows {
        let (mut s, kind_uses, party_uses, chantier_uses) = row.map_err(e)?;
        let cand = suggest::Candidate {
            key: s.key.clone(),
            uses: s.uses,
            last_used: parse_time(&s.last_used),
            kind_uses,
            party_uses,
            chantier_uses,
        };
        if let Some(score) = suggest::score(&query, &cand, now) {
            s.score = score;
            out.push(s);
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(q.limit.unwrap_or(8));
    Ok(out)
}

pub fn list_learned_labels(conn: &Connection) -> Res<Vec<Suggestion>> {
    suggest_labels(conn, &SuggestQuery { query: String::new(), limit: Some(10_000), ..Default::default() })
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
            chantier_id: t.chantier_id,
            family: t.family.clone(),
            from_account_id: from,
            amount: Some(t.amount),
            lines,
            ..Default::default()
        };
        learn(&tx, &t.label, &input, t.amount, parse_time(&t.created_at))?;
    }
    tx.commit().map_err(e)?;
    Ok(txs.len())
}

#[cfg(test)]
pub mod tests_support {
    use super::*;
    /// Editable input for a stored transaction (as the UI does).
    pub fn to_input(t: &Transaction) -> TxInput {
        let (from_account_id, lines) = split_back(t);
        TxInput {
            id: Some(t.id),
            date: t.date.clone(),
            kind: t.kind.clone(),
            label: t.label.clone(),
            party_id: t.party_id,
            chantier_id: t.chantier_id,
            family: t.family.clone(),
            status: Some(t.status.clone()),
            from_account_id,
            amount: Some(t.amount),
            lines,
            ..Default::default()
        }
    }
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
                .map(|l| LineInput { account_id: l.account_id, amount: l.amount, chantier_id: None })
                .collect();
            (from, lines)
        }
        _ => (
            None,
            t.lines
                .iter()
                .map(|l| LineInput {
                    account_id: l.account_id,
                    amount: l.amount.abs(),
                    // Only remember a per-line chantier when it differs from the transaction's.
                    chantier_id: l.chantier_id.filter(|c| Some(*c) != t.chantier_id),
                })
                .collect(),
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
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(NULLIF(family, ''), ''), kind, SUM(amount), COUNT(*) FROM transactions \
             WHERE date >= ?1 AND date <= ?2 AND kind != 'transfer' \
             GROUP BY lower(COALESCE(family, '')), kind ORDER BY SUM(amount) DESC",
        )
        .map_err(e)?;
    let by_family: Vec<LabelTotal> = stmt
        .query_map(params![from, to], |r| {
            Ok(LabelTotal { label: r.get(0)?, kind: r.get(1)?, total: r.get(2)?, count: r.get(3)? })
        })
        .map_err(e)?
        .collect::<Result<_, _>>()
        .map_err(e)?;
    let by_chantier = list_chantiers_between(conn, true, from, to)?
        .into_iter()
        .filter(|c| c.income != 0 || c.expense != 0 || c.purchases != 0)
        .collect();
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
        by_family,
        by_chantier,
    })
}

// ---------------------------------------------------------------------------
// Export / backup
// ---------------------------------------------------------------------------

fn csv_field(s: &str) -> String {
    if s.contains([';', ',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// CSV of all transactions, one row per account line, `;`-separated so Excel opens it directly.
/// Headers, type names and the decimal separator follow the `language` setting.
pub fn export_csv(conn: &Connection) -> Res<String> {
    let decimals: u32 = get_setting(conn, "decimals")?.and_then(|d| d.parse().ok()).unwrap_or(2);
    let fr = get_setting(conn, "language")?.as_deref() != Some("en");
    let fmt = |v: i64| -> String {
        if decimals == 0 {
            return v.to_string();
        }
        let div = 10i64.pow(decimals);
        let sign = if v < 0 { "-" } else { "" };
        let sep = if fr { "," } else { "." };
        format!("{sign}{}{sep}{:0width$}", v.abs() / div, v.abs() % div, width = decimals as usize)
    };
    let kind_name = |k: &str| -> &'static str {
        match (k, fr) {
            ("income", true) => "Versement",
            ("expense", true) => "Dépense",
            ("transfer", true) => "Virement",
            ("purchase", true) => "Achat à crédit",
            ("sale", true) => "Vente à crédit",
            ("income", false) => "Deposit",
            ("expense", false) => "Expense",
            ("transfer", false) => "Transfer",
            ("purchase", false) => "Purchase on credit",
            _ => "Sale on credit",
        }
    };
    let header = if fr {
        "N°;Date;Type;Compte;Chantier;Bénéficiaire;Famille;Libellé;Montant;État;Chèque N°;Ordre de;Notes\n"
    } else {
        "No;Date;Type;Account;Chantier;Beneficiary;Family;Label;Amount;Status;Cheque No;Payee;Notes\n"
    };
    let mut out = String::from(header);
    let txs = query_transactions(conn, &TxFilter::default(), true)?;
    for t in txs {
        let rows: Vec<(String, Option<String>, i64)> = if t.lines.is_empty() {
            vec![(String::new(), t.chantier_name.clone(), t.amount)]
        } else {
            t.lines.iter().map(|l| (l.account_name.clone(), l.chantier_name.clone(), l.amount)).collect()
        };
        for (account, chantier, amount) in rows {
            let fields = [
                t.id.to_string(),
                t.date.clone(),
                kind_name(&t.kind).to_string(),
                csv_field(&account),
                csv_field(chantier.as_deref().unwrap_or("")),
                csv_field(t.party_name.as_deref().unwrap_or("")),
                csv_field(t.family.as_deref().unwrap_or("")),
                csv_field(&t.label),
                fmt(amount),
                t.status.clone(),
                csv_field(t.cheque_no.as_deref().unwrap_or("")),
                csv_field(t.cheque_payee.as_deref().unwrap_or("")),
                csv_field(t.notes.as_deref().unwrap_or("")),
            ];
            out.push_str(&fields.join(";"));
            out.push('\n');
        }
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
            lines: lines.into_iter().map(|(a, m)| LineInput { account_id: a, amount: m, chantier_id: None }).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn seeds_cash_account() {
        let c = db();
        let accounts = list_accounts(&c, false).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].name, "Caisse");
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
        delete_transaction(&mut c, t.id).unwrap();
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
            &SuggestQuery { query: "f".into(), kind: Some("income".into()), party_id: Some(sup), ..Default::default() },
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
        assert!(csv.contains(";123,45;"), "{csv}");
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

#[cfg(test)]
#[allow(clippy::inconsistent_digit_grouping)]
mod chantier_tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn chantier(c: &Connection, name: &str) -> i64 {
        save_chantier(c, &ChantierInput { name: name.into(), ..Default::default() }).unwrap().id
    }

    #[test]
    fn deposit_same_or_different_chantier_per_line() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let bank = save_account(&c, &AccountInput { name: "Banque".into(), kind: "bank".into(), ..Default::default() })
            .unwrap()
            .id;
        let a = chantier(&c, "200 OPGI");
        let b = chantier(&c, "136 LOGTS");
        // Same chantier for both accounts (header), second line overrides it.
        let mut t = TxInput {
            date: "2026-09-29".into(),
            kind: "income".into(),
            label: "Versement".into(),
            chantier_id: Some(a),
            lines: vec![
                LineInput { account_id: cash, amount: 100_00, chantier_id: None },
                LineInput { account_id: bank, amount: 50_00, chantier_id: Some(b) },
            ],
            ..Default::default()
        };
        let saved = save_transaction(&mut c, &t).unwrap();
        assert_eq!(saved.lines[0].chantier_name.as_deref(), Some("200 OPGI"));
        assert_eq!(saved.lines[1].chantier_name.as_deref(), Some("136 LOGTS"));
        assert_eq!(saved.status, "ok");

        t.kind = "expense".into();
        t.label = "Ciment".into();
        t.family = Some("  Matériaux ".into());
        t.cheque_no = Some("0001234".into());
        t.cheque_payee = Some("SARL CIMENT".into());
        t.cheque_crossed = true;
        t.status = Some("pending".into());
        t.lines = vec![LineInput { account_id: bank, amount: 30_00, chantier_id: None }];
        let exp = save_transaction(&mut c, &t).unwrap();
        assert_eq!(exp.family.as_deref(), Some("Matériaux"));
        assert!(exp.cheque_crossed);

        // A purchase on credit is listed on the chantier but does not move its cash balance.
        let supplier = save_party(&c, &PartyInput { name: "Fournisseur".into(), kind: "supplier".into(), ..Default::default() })
            .unwrap()
            .id;
        save_transaction(
            &mut c,
            &TxInput {
                date: "2026-09-30".into(),
                kind: "purchase".into(),
                label: "Facture".into(),
                party_id: Some(supplier),
                chantier_id: Some(a),
                amount: Some(20_00),
                ..Default::default()
            },
        )
        .unwrap();

        let ca = get_chantier(&c, a).unwrap();
        assert_eq!((ca.income, ca.expense, ca.purchases), (100_00, 30_00, 20_00));
        let cb = get_chantier(&c, b).unwrap();
        assert_eq!((cb.income, cb.expense), (50_00, 0));

        let (_, st) = chantier_statement(&c, a).unwrap();
        assert_eq!(st.len(), 3);
        assert_eq!(st[0].effect, Some(-20_00));
        assert_eq!(st[0].running_balance, Some(70_00));

        // Filters
        let f = |f: TxFilter| list_transactions(&c, &f).unwrap().len();
        assert_eq!(f(TxFilter { chantier_id: Some(b), ..Default::default() }), 1);
        assert_eq!(f(TxFilter { status: Some("pending".into()), ..Default::default() }), 1);
        assert_eq!(f(TxFilter { search: Some("opgi".into()), ..Default::default() }), 3);
        assert_eq!(f(TxFilter { search: Some("0001234".into()), ..Default::default() }), 1);
        assert_eq!(f(TxFilter { family: Some("matériaux".into()), ..Default::default() }), 1);

        assert_eq!(list_families(&c).unwrap()[0].name, "Matériaux");
        assert_eq!(next_cheque_no(&c, bank).unwrap().as_deref(), Some("0001235"));
        assert_eq!(next_cheque_no(&c, cash).unwrap(), None);

        // The learned label remembers family and chantier.
        let s = suggest_labels(&c, &SuggestQuery { query: "ci".into(), chantier_id: Some(a), ..Default::default() }).unwrap();
        assert_eq!(s[0].last_family.as_deref(), Some("Matériaux"));
        assert_eq!(s[0].last_chantier_id, Some(a));

        // A used chantier is archived, not deleted.
        assert!(!delete_chantier(&c, a).unwrap());
        let unused = chantier(&c, "Unused");
        assert!(delete_chantier(&c, unused).unwrap());
        assert_eq!(report(&c, "2026-01-01", "2026-12-31").unwrap().by_chantier.len(), 2);
    }

    #[test]
    fn chantier_context_ranks_labels() {
        let mut c = db();
        let cash = list_accounts(&c, false).unwrap()[0].id;
        let a = chantier(&c, "A");
        let b = chantier(&c, "B");
        for (label, ch) in [("Sable A", a), ("Sable B", b), ("Sable B", b)] {
            save_transaction(
                &mut c,
                &TxInput {
                    date: "2026-01-01".into(),
                    kind: "expense".into(),
                    label: label.into(),
                    chantier_id: Some(ch),
                    lines: vec![LineInput { account_id: cash, amount: 1, chantier_id: None }],
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let top = |ch| suggest_labels(&c, &SuggestQuery { query: "sab".into(), chantier_id: Some(ch), ..Default::default() }).unwrap()[0]
            .label
            .clone();
        assert_eq!(top(a), "Sable A");
        assert_eq!(top(b), "Sable B");
    }

    #[test]
    fn migrates_a_version_0_database() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute("INSERT INTO accounts (name, kind, created_at) VALUES ('Cash', 'cash', '')", []).unwrap();
        c.execute("INSERT INTO transactions (date, kind, label, amount, created_at) VALUES ('2026-01-01', 'income', 'x', 5, '')", [])
            .unwrap();
        init(&c).unwrap();
        init(&c).unwrap(); // idempotent
        let t = list_transactions(&c, &TxFilter::default()).unwrap();
        assert_eq!(t[0].status, "ok");
    }

    #[test]
    fn increments_cheque_numbers() {
        assert_eq!(increment_number("0099").as_deref(), Some("0100"));
        assert_eq!(increment_number("CH-99").as_deref(), Some("CH-100"));
        assert_eq!(increment_number("abc"), None);
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
        set_setting(&c, "company_name", "ETCE Exemple BTP").unwrap();
        set_setting(&c, "company_activity", "Entreprise de construction — Alger").unwrap();
        set_setting(&c, "cheque_city", "Alger").unwrap();
        let caisse = list_accounts(&c, false).unwrap()[0].id;
        let mk = |c: &Connection, n: &str, k: &str, col: &str| {
            save_account(c, &AccountInput { name: n.into(), kind: k.into(), color: Some(col.into()), ..Default::default() }).unwrap().id
        };
        let bna = mk(&c, "Banque BNA", "bank", "#2563eb");
        let cpa = mk(&c, "Banque CPA", "bank", "#0891b2");
        let caisse2 = mk(&c, "Nouveau caisse", "cash", "#ea580c");
        let ch = |c: &Connection, n: &str, client: &str| {
            save_chantier(c, &ChantierInput { name: n.into(), client: Some(client.into()), ..Default::default() }).unwrap().id
        };
        let opgi = ch(&c, "200 LOGTS OPGI", "OPGI");
        let l136 = ch(&c, "136 LOGTS", "Promotion Sami");
        let lpa = ch(&c, "17 LPA", "AADL");
        let p = |c: &Connection, n: &str, k: &str| {
            save_party(c, &PartyInput { name: n.into(), kind: k.into(), ..Default::default() }).unwrap().id
        };
        let ciment = p(&c, "SARL Ciment Est", "supplier");
        let placo = p(&c, "Salah Placo", "supplier");
        let grue = p(&c, "Kamel Location Grue", "supplier");
        let karim = p(&c, "Karim (chef d'équipe)", "employee");
        let opgi_client = p(&c, "OPGI", "client");
        #[allow(clippy::too_many_arguments)]
        fn add(
            c: &mut Connection, date: &str, kind: &str, label: &str, family: Option<&str>, party: Option<i64>,
            chantier: Option<i64>, from: Option<i64>, amount: Option<i64>, lines: Vec<(i64, i64, Option<i64>)>, cheque: Option<&str>,
        ) {
            save_transaction(c, &TxInput {
                date: date.into(), kind: kind.into(), label: label.into(), family: family.map(Into::into), party_id: party,
                chantier_id: chantier, from_account_id: from, amount, cheque_no: cheque.map(Into::into), cheque_crossed: cheque.is_some(),
                lines: lines.into_iter().map(|(a, m, ch)| LineInput { account_id: a, amount: m, chantier_id: ch }).collect(),
                ..Default::default()
            }).unwrap();
        }
        let months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
        let mut chq = 4100;
        for (i, m) in months.iter().enumerate() {
            let i = i as i64;
            let c = &mut c;
            add(c, &format!("{m}-01"), "sale", "Situation travaux N°", Some("Situations"), Some(opgi_client), Some(opgi), None, Some(4_500_000_00 + i * 50_000_00), vec![], None);
            add(c, &format!("{m}-03"), "income", "Versement client OPGI", Some("Situations"), Some(opgi_client), Some(opgi), None, None,
                vec![(bna, 3_000_000_00, None), (caisse, 800_000_00, Some(l136)), (caisse2, 400_000_00, Some(lpa))], None);
            add(c, &format!("{m}-05"), "purchase", "Ciment CPJ 45 // 200 OPGI", Some("Matériaux"), Some(ciment), Some(opgi), None, Some(1_200_000_00 + i * 20_000_00), vec![], None);
            chq += 1;
            add(c, &format!("{m}-07"), "expense", "Règlement ciment", Some("Matériaux"), Some(ciment), Some(opgi), None, None, vec![(bna, 1_000_000_00, None)], Some(&format!("000{chq}")));
            add(c, &format!("{m}-10"), "expense", "Achat sable 0.40 // 200 OPGI", Some("Matériaux"), None, Some(opgi), None, None, vec![(caisse, 8_288_00 + i * 150_00, None)], None);
            add(c, &format!("{m}-12"), "expense", "Avance personnel", Some("Salaires"), Some(karim), Some(l136), None, None, vec![(caisse2, 20_000_00, None)], None);
            add(c, &format!("{m}-15"), "expense", "Salaire personnel", Some("Salaires"), None, Some(opgi), None, None,
                vec![(caisse, 350_000_00, None), (caisse2, 150_000_00, Some(lpa))], None);
            add(c, &format!("{m}-16"), "purchase", "Facture placo 136 LOGTS", Some("Sous-traitance"), Some(placo), Some(l136), None, Some(40_000_00), vec![], None);
            add(c, &format!("{m}-17"), "purchase", "Facture location grue", Some("Location engins"), Some(grue), Some(opgi), None, Some(200_000_00), vec![], None);
            add(c, &format!("{m}-18"), "expense", "Placo 136 LOGTS", Some("Sous-traitance"), Some(placo), Some(l136), None, None, vec![(caisse, 35_500_00, None)], None);
            add(c, &format!("{m}-20"), "expense", "Location grue à tour", Some("Location engins"), Some(grue), Some(opgi), None, None, vec![(cpa, 200_000_00, None)], None);
            add(c, &format!("{m}-22"), "transfer", "Alimentation caisse", None, None, None, Some(bna), None, vec![(caisse, 400_000_00, None)], None);
            add(c, &format!("{m}-25"), "expense", "Gasoil camion", Some("Transport"), None, Some(lpa), None, None, vec![(caisse2, 6_050_00, None)], None);
        }
        add(&mut c, "2026-09-29", "expense", "Déplacement grue à tour", Some("Location engins"), Some(grue), Some(opgi), None, None, vec![(cpa, 30_000_00, None)], None);
        add(&mut c, "2026-09-29", "income", "Versement associé", Some("Apports"), None, None, None, None, vec![(cpa, 500_000_00, None)], None);
        // Previous fiscal year, closed.
        for m in ["2025-10", "2025-11", "2025-12"] {
            add(&mut c, &format!("{m}-05"), "income", "Versement client OPGI", Some("Situations"), Some(opgi_client), Some(opgi), None, None, vec![(bna, 2_000_000_00, None)], None);
            add(&mut c, &format!("{m}-15"), "expense", "Salaire personnel", Some("Salaires"), None, Some(opgi), None, None, vec![(caisse, 300_000_00, None)], None);
        }
        let admin_user = admin::setup_admin(&c, "admin", Some("Yazid".into()), "admin").unwrap();
        admin::set_exercise_closed(&c, 2025, true, &admin_user).unwrap();
        set_setting(&c, "company_address", "Cité 200 logements, Alger").unwrap();
    }
}

/// Performance benchmark on a large file database:
/// `cargo test --release perf_large -- --ignored --nocapture`
#[cfg(test)]
mod perf {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn perf_large() {
        let path = std::env::temp_dir().join("accountbook-perf.db");
        let _ = std::fs::remove_file(&path);
        let mut c = open(&path).unwrap();
        let accounts: Vec<i64> = (0..6)
            .map(|i| save_account(&c, &AccountInput { name: format!("Compte {i}"), kind: "cash".into(), ..Default::default() }).unwrap().id)
            .collect();
        let chantiers: Vec<i64> = (0..25)
            .map(|i| save_chantier(&c, &ChantierInput { name: format!("Chantier {i}"), ..Default::default() }).unwrap().id)
            .collect();
        let parties: Vec<i64> = (0..300)
            .map(|i| save_party(&c, &PartyInput { name: format!("Bénéficiaire {i}"), kind: "supplier".into(), ..Default::default() }).unwrap().id)
            .collect();
        let labels = ["Achat sable", "Ciment", "Gasoil", "Salaire", "Avance personnel", "Location grue", "Placo", "Fer à béton"];
        let t0 = Instant::now();
        let n = 45_000;
        for i in 0..n {
            let year = 2024 + i / 15_000;
            let day = (i % 15_000) * 365 / 15_000;
            let date = NaiveDate::from_yo_opt(year as i32, (day + 1) as u32).unwrap().to_string();
            let kind = if i % 5 == 0 { "income" } else if i % 11 == 0 { "purchase" } else { "expense" };
            let lines = if kind == "purchase" {
                vec![]
            } else {
                let mut l = vec![LineInput { account_id: accounts[i % 6], amount: 1_000 + (i as i64 * 37) % 900_000, chantier_id: None }];
                if i % 7 == 0 {
                    l.push(LineInput { account_id: accounts[(i + 1) % 6], amount: 5_000, chantier_id: Some(chantiers[(i + 3) % 25]) });
                }
                l
            };
            save_transaction(
                &mut c,
                &TxInput {
                    date,
                    kind: kind.into(),
                    label: format!("{} {}", labels[i % 8], i % 40),
                    party_id: if i % 3 == 0 || kind == "purchase" { Some(parties[i % 300]) } else { None },
                    chantier_id: Some(chantiers[i % 25]),
                    family: Some(["Matériaux", "Salaires", "Transport"][i % 3].into()),
                    amount: Some(50_000),
                    lines,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        println!("insert {n}: {:?} ({:?}/entry)", t0.elapsed(), t0.elapsed() / n as u32);

        let time = |name: &str, f: &mut dyn FnMut() -> usize| {
            let t = Instant::now();
            let k = f();
            println!("{name:<32} {:>8.1} ms  ({k} rows)", t.elapsed().as_secs_f64() * 1000.0);
        };
        let year = TxFilter { from: Some("2025-01-01".into()), to: Some("2025-12-31".into()), ..Default::default() };
        time("list one year", &mut || list_transactions(&c, &year).unwrap().len());
        time("serialize one year (JSON)", &mut || serde_json::to_string(&list_transactions(&c, &year).unwrap()).unwrap().len() / 1024);
        time("list year, expenses only", &mut || {
            list_transactions(&c, &TxFilter { kind: Some("expense".into()), ..year.clone() }).unwrap().len()
        });
        time("list year, search 'grue'", &mut || {
            list_transactions(&c, &TxFilter { search: Some("grue".into()), ..year.clone() }).unwrap().len()
        });
        time("list accounts (balances)", &mut || list_accounts(&c, true).unwrap().len());
        time("list parties (balances)", &mut || list_parties(&c, true).unwrap().len());
        time("list chantiers (totals)", &mut || list_chantiers(&c, true).unwrap().len());
        time("dashboard", &mut || dashboard(&c).unwrap().recent.len());
        time("report one year", &mut || report(&c, "2025-01-01", "2025-12-31").unwrap().by_label.len());
        time("suggest 'gas'", &mut || {
            suggest_labels(&c, &SuggestQuery { query: "gas".into(), ..Default::default() }).unwrap().len()
        });
        time("party statement", &mut || party_statement(&c, parties[0]).unwrap().1.len());
        time("save one transaction", &mut || {
            save_transaction(
                &mut c,
                &TxInput {
                    date: "2025-06-01".into(),
                    kind: "expense".into(),
                    label: "Test".into(),
                    lines: vec![LineInput { account_id: accounts[0], amount: 100, chantier_id: None }],
                    ..Default::default()
                },
            )
            .unwrap();
            1
        });
    }
}

#[cfg(test)]
mod perf_profile {
    use super::*;
    use std::time::Instant;
    /// Splits "list one year" into its steps. Needs the database left by `perf_large`.
    #[test]
    #[ignore]
    fn perf_profile() {
        let c = open(&std::env::temp_dir().join("accountbook-perf.db")).unwrap();
        let f = TxFilter { from: Some("2025-01-01".into()), to: Some("2025-12-31".into()), ..Default::default() };
        for _ in 0..2 {
            let t = Instant::now();
            let mut stmt = c.prepare(&format!("{TX_SELECT} WHERE t.date >= ?1 AND t.date <= ?2 ORDER BY t.date DESC, t.id DESC")).unwrap();
            let mut txs: Vec<Transaction> = stmt.query_map(params![f.from, f.to], row_to_tx).unwrap().map(|r| r.unwrap()).collect();
            let a = t.elapsed();
            load_lines(&c, &mut txs).unwrap();
            let b = t.elapsed();
            let json = serde_json::to_string(&txs).unwrap();
            println!("rows {:?}  lines {:?}  json {:?} ({} KB)", a, b - a, t.elapsed() - b, json.len() / 1024);
        }
    }
}
