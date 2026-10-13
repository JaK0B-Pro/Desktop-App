//! Users & login, fiscal years ("exercices"), change history and the "état des comptes".
//!
//! Errors meant for the user are returned as `ERR:<code>[:<arg>]` so the UI can translate them.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{Datelike, Local};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::ledger::{e, now_str, Res};
use crate::models::*;

pub const ROLES: &[&str] = &["admin", "user", "viewer"];

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

pub fn hash_password(password: &str) -> Res<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(e)
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

fn row_to_user(r: &Row) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get("id")?,
        username: r.get("username")?,
        full_name: r.get("full_name")?,
        role: r.get("role")?,
        active: r.get::<_, i64>("active")? != 0,
        created_at: r.get("created_at")?,
        last_login: r.get("last_login")?,
    })
}

pub fn user_count(conn: &Connection) -> Res<i64> {
    conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0)).map_err(e)
}

pub fn list_users(conn: &Connection) -> Res<Vec<User>> {
    let mut stmt = conn.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE").map_err(e)?;
    let rows = stmt.query_map([], row_to_user).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_user(conn: &Connection, id: i64) -> Res<User> {
    conn.query_row("SELECT * FROM users WHERE id = ?1", [id], row_to_user)
        .optional()
        .map_err(e)?
        .ok_or_else(|| "ERR:not_found".to_string())
}

fn check_password_strength(password: &str) -> Res<()> {
    if password.chars().count() < 4 {
        return Err("ERR:password_short".into());
    }
    Ok(())
}

fn active_admins(conn: &Connection) -> Res<i64> {
    conn.query_row("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1", [], |r| r.get(0))
        .map_err(e)
}

/// Creates or updates a user (admin only — checked by the caller).
pub fn save_user(conn: &Connection, input: &UserInput) -> Res<User> {
    let username = input.username.trim();
    if username.is_empty() {
        return Err("ERR:username_required".into());
    }
    if !ROLES.contains(&input.role.as_str()) {
        return Err(format!("Unknown role '{}'", input.role));
    }
    let taken: Option<i64> = conn
        .query_row("SELECT id FROM users WHERE username = ?1", [username], |r| r.get(0))
        .optional()
        .map_err(e)?;
    if taken.is_some() && taken != input.id {
        return Err("ERR:username_taken".into());
    }
    let full_name = input.full_name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let id = match input.id {
        Some(id) => {
            let before = get_user(conn, id)?;
            // Never remove the last active administrator.
            let demoted = before.role == "admin" && before.active && (input.role != "admin" || !input.active);
            if demoted && active_admins(conn)? <= 1 {
                return Err("ERR:last_admin".into());
            }
            conn.execute(
                "UPDATE users SET username = ?1, full_name = ?2, role = ?3, active = ?4 WHERE id = ?5",
                params![username, full_name, input.role, input.active as i64, id],
            )
            .map_err(e)?;
            if let Some(pw) = input.password.as_deref().filter(|p| !p.is_empty()) {
                check_password_strength(pw)?;
                conn.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![hash_password(pw)?, id])
                    .map_err(e)?;
            }
            id
        }
        None => {
            let pw = input.password.as_deref().unwrap_or("");
            check_password_strength(pw)?;
            conn.execute(
                "INSERT INTO users (username, full_name, password_hash, role, active, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![username, full_name, hash_password(pw)?, input.role, input.active as i64, now_str()],
            )
            .map_err(e)?;
            conn.last_insert_rowid()
        }
    };
    get_user(conn, id)
}

/// First start: creates the administrator. Refused once any user exists.
pub fn setup_admin(conn: &Connection, username: &str, full_name: Option<String>, password: &str) -> Res<User> {
    if user_count(conn)? > 0 {
        return Err("ERR:forbidden".into());
    }
    save_user(
        conn,
        &UserInput {
            id: None,
            username: username.into(),
            full_name,
            role: "admin".into(),
            active: true,
            password: Some(password.into()),
        },
    )
}

pub fn delete_user(conn: &Connection, id: i64, current: &User) -> Res<()> {
    if id == current.id {
        return Err("ERR:delete_self".into());
    }
    let u = get_user(conn, id)?;
    if u.role == "admin" && u.active && active_admins(conn)? <= 1 {
        return Err("ERR:last_admin".into());
    }
    conn.execute("DELETE FROM users WHERE id = ?1", [id]).map_err(e)?;
    Ok(())
}

/// Checks the credentials; returns the user or `ERR:login` (same error for unknown user and wrong password).
pub fn login(conn: &Connection, username: &str, password: &str) -> Res<User> {
    let found: Option<(i64, String, bool)> = conn
        .query_row(
            "SELECT id, password_hash, active FROM users WHERE username = ?1",
            [username.trim()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
        )
        .optional()
        .map_err(e)?;
    match found {
        Some((id, hash, active)) if verify_password(password, &hash) => {
            if !active {
                return Err("ERR:inactive".into());
            }
            conn.execute("UPDATE users SET last_login = ?1 WHERE id = ?2", params![now_str(), id]).map_err(e)?;
            let user = get_user(conn, id)?;
            audit(conn, Some(&user), "login", "user", Some(id), &user.username, None, None)?;
            Ok(user)
        }
        _ => {
            // Slow down password guessing.
            std::thread::sleep(std::time::Duration::from_millis(400));
            Err("ERR:login".into())
        }
    }
}

pub fn change_password(conn: &Connection, user: &User, old: &str, new: &str) -> Res<()> {
    let hash: String = conn
        .query_row("SELECT password_hash FROM users WHERE id = ?1", [user.id], |r| r.get(0))
        .map_err(e)?;
    if !verify_password(old, &hash) {
        return Err("ERR:wrong_password".into());
    }
    check_password_strength(new)?;
    conn.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![hash_password(new)?, user.id])
        .map_err(e)?;
    Ok(())
}

/// Role check: `user` can enter data, `admin` can do everything, `viewer` only reads.
pub fn require(user: &User, role: &str) -> Res<()> {
    let ok = match role {
        "admin" => user.role == "admin",
        "user" => user.role == "admin" || user.role == "user",
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err("ERR:forbidden".into())
    }
}

// ---------------------------------------------------------------------------
// Fiscal years
// ---------------------------------------------------------------------------

pub fn year_of(date: &str) -> i32 {
    date.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0)
}

pub fn is_closed(conn: &Connection, year: i32) -> Res<bool> {
    conn.query_row("SELECT closed FROM exercises WHERE year = ?1", [year], |r| r.get::<_, i64>(0))
        .optional()
        .map(|o| o == Some(1))
        .map_err(e)
}

/// Fails with `ERR:closed:<year>` when the date belongs to a closed fiscal year.
pub fn ensure_open(conn: &Connection, date: &str) -> Res<()> {
    let year = year_of(date);
    if is_closed(conn, year)? {
        return Err(format!("ERR:closed:{year}"));
    }
    Ok(())
}

/// Makes sure the fiscal year of `date` exists (entries can be typed into a new year directly).
pub fn ensure_exercise(conn: &Connection, year: i32) -> Res<()> {
    conn.execute("INSERT OR IGNORE INTO exercises (year, created_at) VALUES (?1, ?2)", params![year, now_str()])
        .map_err(e)?;
    Ok(())
}

pub fn list_exercises(conn: &Connection) -> Res<Vec<Exercise>> {
    ensure_exercise(conn, Local::now().year())?;
    // Every year that has entries is an exercise (e.g. data imported or typed before the year was created).
    conn.execute(
        "INSERT OR IGNORE INTO exercises (year, created_at) \
         SELECT DISTINCT CAST(substr(date, 1, 4) AS INTEGER), ?1 FROM transactions",
        [now_str()],
    )
    .map_err(e)?;
    let mut stmt = conn
        .prepare(
            "SELECT x.year, x.closed, x.closed_at, x.closed_by, \
                    COUNT(t.id), \
                    COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount END), 0), \
                    COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount END), 0) \
             FROM exercises x LEFT JOIN transactions t \
               ON t.date >= printf('%04d-01-01', x.year) AND t.date <= printf('%04d-12-31', x.year) \
             GROUP BY x.year ORDER BY x.year DESC",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Exercise {
                year: r.get(0)?,
                closed: r.get::<_, i64>(1)? != 0,
                closed_at: r.get(2)?,
                closed_by: r.get(3)?,
                count: r.get(4)?,
                income: r.get(5)?,
                expense: r.get(6)?,
            })
        })
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn create_exercise(conn: &Connection, year: i32) -> Res<()> {
    if !(1900..=2200).contains(&year) {
        return Err(format!("Invalid year {year}"));
    }
    let n = conn
        .execute("INSERT OR IGNORE INTO exercises (year, created_at) VALUES (?1, ?2)", params![year, now_str()])
        .map_err(e)?;
    if n == 0 {
        return Err(format!("ERR:exercise_exists:{year}"));
    }
    Ok(())
}

/// Closes ("clôture") or reopens a fiscal year. Entries of a closed year are locked.
pub fn set_exercise_closed(conn: &Connection, year: i32, closed: bool, user: &User) -> Res<()> {
    ensure_exercise(conn, year)?;
    conn.execute(
        "UPDATE exercises SET closed = ?1, closed_at = ?2, closed_by = ?3 WHERE year = ?4",
        params![
            closed as i64,
            closed.then(now_str),
            closed.then(|| user.full_name.clone().unwrap_or_else(|| user.username.clone())),
            year
        ],
    )
    .map_err(e)?;
    audit(conn, Some(user), if closed { "close" } else { "reopen" }, "exercise", Some(year as i64), &year.to_string(), None, None)
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn audit(
    conn: &Connection,
    user: Option<&User>,
    action: &str,
    entity: &str,
    entity_id: Option<i64>,
    summary: &str,
    before: Option<&Transaction>,
    after: Option<&Transaction>,
) -> Res<()> {
    let json = |t: Option<&Transaction>| t.map(serde_json::to_string).transpose();
    conn.execute(
        "INSERT INTO audit_log (at, user_id, username, action, entity, entity_id, summary, before, after) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            now_str(),
            user.map(|u| u.id),
            user.map(|u| u.full_name.clone().unwrap_or_else(|| u.username.clone())),
            action,
            entity,
            entity_id,
            summary,
            json(before).map_err(e)?,
            json(after).map_err(e)?,
        ],
    )
    .map_err(e)?;
    Ok(())
}

pub fn list_audit(conn: &Connection, f: &AuditFilter) -> Res<Vec<AuditEntry>> {
    let mut sql = String::from(
        "SELECT a.id, a.at, a.username, a.action, a.entity, a.entity_id, a.summary, a.before, a.after, \
                (a.entity = 'transaction' AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = a.entity_id)) \
         FROM audit_log a WHERE 1 = 1",
    );
    let mut args: Vec<rusqlite::types::Value> = vec![];
    if let Some(id) = f.entity_id {
        sql.push_str(" AND a.entity = 'transaction' AND a.entity_id = ?");
        args.push(id.into());
    }
    if let Some(from) = f.from.as_ref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND a.at >= ?");
        args.push(from.clone().into());
    }
    if let Some(to) = f.to.as_ref().filter(|s| !s.is_empty()) {
        // Inclusive end day.
        sql.push_str(" AND a.at < date(?, '+1 day')");
        args.push(to.clone().into());
    }
    sql.push_str(&format!(" ORDER BY a.id DESC LIMIT {}", f.limit.unwrap_or(500).clamp(1, 20_000)));
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |r| {
            let parse = |s: Option<String>| s.and_then(|j| serde_json::from_str::<Transaction>(&j).ok());
            Ok(AuditEntry {
                id: r.get(0)?,
                at: r.get(1)?,
                username: r.get(2)?,
                action: r.get(3)?,
                entity: r.get(4)?,
                entity_id: r.get(5)?,
                summary: r.get(6)?,
                before: parse(r.get(7)?),
                after: parse(r.get(8)?),
                exists: r.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

/// The "before" snapshot of a history entry (to restore a deleted transaction).
pub fn audit_before(conn: &Connection, audit_id: i64) -> Res<Transaction> {
    let json: Option<String> = conn
        .query_row("SELECT before FROM audit_log WHERE id = ?1", [audit_id], |r| r.get(0))
        .optional()
        .map_err(e)?
        .flatten();
    json.and_then(|j| serde_json::from_str(&j).ok())
        .ok_or_else(|| "ERR:not_found".to_string())
}

// ---------------------------------------------------------------------------
// État des comptes
// ---------------------------------------------------------------------------

/// Accounts: opening balance at `from`, money in and out during the period, and balance at `to`.
pub fn accounts_state(conn: &Connection, from: &str, to: &str) -> Res<Vec<BalanceRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.name, a.kind, \
                    a.opening_balance + COALESCE(SUM(CASE WHEN t.date < ?1 THEN l.amount END), 0), \
                    COALESCE(SUM(CASE WHEN t.date >= ?1 AND t.date <= ?2 AND l.amount > 0 THEN l.amount END), 0), \
                    COALESCE(-SUM(CASE WHEN t.date >= ?1 AND t.date <= ?2 AND l.amount < 0 THEN l.amount END), 0) \
             FROM accounts a \
             LEFT JOIN transaction_lines l ON l.account_id = a.id \
             LEFT JOIN transactions t ON t.id = l.transaction_id \
             GROUP BY a.id HAVING a.archived = 0 OR COUNT(l.id) > 0 \
             ORDER BY a.name COLLATE NOCASE",
        )
        .map_err(e)?;
    let rows = stmt.query_map(params![from, to], balance_row).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

/// Beneficiaries: what they owed at `from`, what increased it (you paid them, sales on credit),
/// what reduced it (they paid you, purchases on credit) and the balance at `to` (+ = they owe you).
pub fn parties_state(conn: &Connection, from: &str, to: &str) -> Res<Vec<BalanceRow>> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, p.kind, \
                    p.opening_balance + COALESCE(SUM(CASE WHEN t.date < ?1 THEN \
                        CASE WHEN t.kind IN ('expense', 'sale') THEN t.amount ELSE -t.amount END END), 0), \
                    COALESCE(SUM(CASE WHEN t.date >= ?1 AND t.date <= ?2 AND t.kind IN ('expense', 'sale') THEN t.amount END), 0), \
                    COALESCE(SUM(CASE WHEN t.date >= ?1 AND t.date <= ?2 AND t.kind IN ('income', 'purchase') THEN t.amount END), 0) \
             FROM parties p \
             LEFT JOIN transactions t ON t.party_id = p.id AND t.kind != 'transfer' \
             GROUP BY p.id HAVING p.archived = 0 OR COUNT(t.id) > 0 \
             ORDER BY p.name COLLATE NOCASE",
        )
        .map_err(e)?;
    let rows = stmt.query_map(params![from, to], balance_row).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

fn balance_row(r: &Row) -> rusqlite::Result<BalanceRow> {
    let initial: i64 = r.get(3)?;
    let debit: i64 = r.get(4)?;
    let credit: i64 = r.get(5)?;
    Ok(BalanceRow {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        initial,
        debit,
        credit,
        balance: initial + debit - credit,
    })
}

#[cfg(test)]
#[allow(clippy::inconsistent_digit_grouping)]
mod tests {
    use super::*;
    use crate::ledger::{self, init};

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn expense(c: &mut Connection, date: &str, amount: i64, user: Option<&User>) -> Transaction {
        let cash = ledger::list_accounts(c, false).unwrap()[0].id;
        ledger::save_transaction_by(
            c,
            &TxInput {
                date: date.into(),
                kind: "expense".into(),
                label: "Gasoil".into(),
                lines: vec![LineInput { account_id: cash, amount, chantier_id: None }],
                ..Default::default()
            },
            user,
        )
        .unwrap()
    }

    #[test]
    fn users_login_and_roles() {
        let c = db();
        assert_eq!(user_count(&c).unwrap(), 0);
        let admin = setup_admin(&c, "Admin", Some("Yazid".into()), "secret1").unwrap();
        assert_eq!(admin.role, "admin");
        // Setup only works once.
        assert!(setup_admin(&c, "other", None, "secret1").is_err());
        assert_eq!(login(&c, "admin", "secret1").unwrap().id, admin.id); // case-insensitive username
        assert_eq!(login(&c, "admin", "wrong").unwrap_err(), "ERR:login");
        assert_eq!(login(&c, "nobody", "x").unwrap_err(), "ERR:login");

        let clerk = save_user(
            &c,
            &UserInput { username: "saisie".into(), role: "user".into(), active: true, password: Some("1234".into()), ..Default::default() },
        )
        .unwrap();
        assert!(require(&clerk, "user").is_ok());
        assert_eq!(require(&clerk, "admin").unwrap_err(), "ERR:forbidden");
        assert!(save_user(&c, &UserInput { username: "SAISIE".into(), role: "user".into(), password: Some("1234".into()), ..Default::default() })
            .is_err());
        assert_eq!(
            save_user(&c, &UserInput { username: "x".into(), role: "user".into(), password: Some("12".into()), ..Default::default() })
                .unwrap_err(),
            "ERR:password_short"
        );

        // The last admin cannot be demoted, disabled or deleted; nobody can delete themselves.
        let demote = UserInput { id: Some(admin.id), username: "admin".into(), role: "user".into(), active: true, ..Default::default() };
        assert_eq!(save_user(&c, &demote).unwrap_err(), "ERR:last_admin");
        assert_eq!(delete_user(&c, admin.id, &admin).unwrap_err(), "ERR:delete_self");
        assert_eq!(delete_user(&c, admin.id, &clerk).unwrap_err(), "ERR:last_admin");

        // Disabled users cannot log in; passwords can be changed.
        save_user(&c, &UserInput { id: Some(clerk.id), username: "saisie".into(), role: "user".into(), active: false, ..Default::default() })
            .unwrap();
        assert_eq!(login(&c, "saisie", "1234").unwrap_err(), "ERR:inactive");
        change_password(&c, &admin, "secret1", "secret2").unwrap();
        assert!(login(&c, "admin", "secret2").is_ok());
        assert_eq!(change_password(&c, &admin, "bad", "secret3").unwrap_err(), "ERR:wrong_password");
    }

    #[test]
    fn closed_exercise_locks_entries() {
        let mut c = db();
        let admin = setup_admin(&c, "admin", None, "secret").unwrap();
        let t = expense(&mut c, "2025-03-01", 100, Some(&admin));
        expense(&mut c, "2026-01-05", 50, Some(&admin));
        let years: Vec<i32> = list_exercises(&c).unwrap().iter().map(|x| x.year).collect();
        assert!(years.contains(&2025) && years.contains(&2026));
        assert_eq!(list_exercises(&c).unwrap().iter().find(|x| x.year == 2025).unwrap().expense, 100);

        set_exercise_closed(&c, 2025, true, &admin).unwrap();
        assert!(list_exercises(&c).unwrap().iter().find(|x| x.year == 2025).unwrap().closed);
        // No new entry, edit or delete in a closed year — and no moving an entry into it.
        let cash = ledger::list_accounts(&c, false).unwrap()[0].id;
        let mut input = TxInput {
            id: Some(t.id),
            date: "2025-03-01".into(),
            kind: "expense".into(),
            label: "Edit".into(),
            lines: vec![LineInput { account_id: cash, amount: 1, chantier_id: None }],
            ..Default::default()
        };
        assert_eq!(ledger::save_transaction(&mut c, &input).unwrap_err(), "ERR:closed:2025");
        input.date = "2026-02-01".into();
        assert_eq!(ledger::save_transaction(&mut c, &input).unwrap_err(), "ERR:closed:2025");
        assert_eq!(ledger::delete_transaction(&mut c, t.id).unwrap_err(), "ERR:closed:2025");
        set_exercise_closed(&c, 2025, false, &admin).unwrap();
        ledger::delete_transaction(&mut c, t.id).unwrap();

        assert!(create_exercise(&c, 2027).is_ok());
        assert_eq!(create_exercise(&c, 2027).unwrap_err(), "ERR:exercise_exists:2027");
    }

    #[test]
    fn history_records_and_restores() {
        let mut c = db();
        let admin = setup_admin(&c, "admin", Some("Yazid".into()), "secret").unwrap();
        let t = expense(&mut c, "2026-03-01", 100, Some(&admin));
        let mut edit = crate::ledger::tests_support::to_input(&t);
        edit.label = "Gasoil camion".into();
        ledger::save_transaction_by(&mut c, &edit, Some(&admin)).unwrap();
        ledger::delete_transaction_by(&mut c, t.id, Some(&admin)).unwrap();

        let log = list_audit(&c, &AuditFilter { entity_id: Some(t.id), ..Default::default() }).unwrap();
        let actions: Vec<&str> = log.iter().map(|a| a.action.as_str()).collect();
        assert_eq!(actions, ["delete", "update", "create"]);
        assert_eq!(log[0].username.as_deref(), Some("Yazid"));
        assert_eq!(log[1].before.as_ref().unwrap().label, "Gasoil");
        assert_eq!(log[1].after.as_ref().unwrap().label, "Gasoil camion");
        assert!(!log[0].exists);

        // Restore brings it back with its original number.
        let restored = ledger::restore_transaction(&mut c, log[0].id, Some(&admin)).unwrap();
        assert_eq!(restored.id, t.id);
        assert_eq!(restored.label, "Gasoil camion");
        assert_eq!(restored.amount, 100);
        // Restoring twice fails: the number is taken.
        assert_eq!(ledger::restore_transaction(&mut c, log[0].id, Some(&admin)).unwrap_err(), "ERR:number_taken");
    }

    #[test]
    fn etat_des_comptes() {
        let mut c = db();
        let cash = ledger::list_accounts(&c, false).unwrap()[0].id;
        ledger::save_account(&c, &AccountInput { id: Some(cash), name: "Caisse".into(), kind: "cash".into(), opening_balance: 1_000, ..Default::default() })
            .unwrap();
        expense(&mut c, "2025-06-01", 200, None); // before the period
        let deposit = |c: &mut Connection, date: &str, amount: i64, party: Option<i64>| {
            ledger::save_transaction(
                c,
                &TxInput {
                    date: date.into(),
                    kind: "income".into(),
                    label: "Versement".into(),
                    party_id: party,
                    lines: vec![LineInput { account_id: cash, amount, chantier_id: None }],
                    ..Default::default()
                },
            )
            .unwrap();
        };
        deposit(&mut c, "2026-02-01", 5_000, None);
        expense(&mut c, "2026-03-01", 300, None);
        deposit(&mut c, "2027-01-01", 7, None); // after the period
        let rows = accounts_state(&c, "2026-01-01", "2026-12-31").unwrap();
        let caisse = rows.iter().find(|r| r.id == cash).unwrap();
        assert_eq!((caisse.initial, caisse.debit, caisse.credit, caisse.balance), (800, 5_000, 300, 5_500));

        let p = ledger::save_party(&c, &PartyInput { name: "Fournisseur".into(), kind: "supplier".into(), ..Default::default() }).unwrap().id;
        ledger::save_transaction(
            &mut c,
            &TxInput { date: "2026-04-01".into(), kind: "purchase".into(), label: "Facture".into(), party_id: Some(p), amount: Some(900), ..Default::default() },
        )
        .unwrap();
        deposit(&mut c, "2026-05-01", 100, Some(p));
        let rows = parties_state(&c, "2026-01-01", "2026-12-31").unwrap();
        let f = rows.iter().find(|r| r.id == p).unwrap();
        assert_eq!((f.initial, f.debit, f.credit, f.balance), (0, 0, 1_000, -1_000));
    }
}
