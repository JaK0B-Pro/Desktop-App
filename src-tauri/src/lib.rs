mod admin;
mod excel;
mod ledger;
mod models;
mod suggest;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use ledger::Res;
use models::*;

pub struct AppState {
    db: Mutex<Connection>,
    /// The logged-in user (one session per running app).
    session: Mutex<Option<i64>>,
    /// Set when the startup integrity check found a problem.
    db_warning: Option<String>,
}

fn lock_db(state: &AppState) -> Res<std::sync::MutexGuard<'_, Connection>> {
    state.db.lock().map_err(|_| "Database is busy".to_string())
}

/// Runs `f` for the logged-in user if their role allows it (`viewer` < `user` < `admin`).
/// The user is re-read on every call, so a disabled account or a changed role applies at once.
fn authed<T>(state: &State<AppState>, role: &str, f: impl FnOnce(&mut Connection, &User) -> Res<T>) -> Res<T> {
    let uid = state.session.lock().map_err(|_| "ERR:auth")?.ok_or("ERR:auth")?;
    let mut conn = lock_db(state)?;
    let user = admin::get_user(&conn, uid).map_err(|_| "ERR:auth")?;
    if !user.active {
        return Err("ERR:auth".into());
    }
    admin::require(&user, role)?;
    f(&mut conn, &user)
}

/// Folder used for exports and manual backups: Documents/AccountBook, or the app data folder.
fn output_dir(app: &AppHandle) -> Res<PathBuf> {
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?
        .join("AccountBook");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Daily automatic backup into `<app data>/backups`, keeping the 30 most recent daily copies.
/// Safety copies taken before an upgrade or an update (`pre-…`) are never removed.
fn auto_backup(conn: &Connection, dir: &Path) -> Res<()> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let daily = || -> Res<Vec<PathBuf>> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension().is_some_and(|x| x == "db")
                    && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("auto-"))
            })
            .collect();
        files.sort();
        Ok(files)
    };
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    if !daily()?.iter().any(|p| p.to_string_lossy().contains(&format!("auto-{today}"))) {
        ledger::backup_to(conn, &dir.join(format!("auto-{}.db", stamp())))?;
    }
    let mut files = daily()?;
    while files.len() > 30 {
        let _ = std::fs::remove_file(files.remove(0));
    }
    Ok(())
}

// --- session ----------------------------------------------------------------

#[tauri::command(async)]
fn auth_status(state: State<AppState>) -> Res<AuthStatus> {
    let uid = *state.session.lock().map_err(|_| "ERR:auth")?;
    let conn = lock_db(&state)?;
    Ok(AuthStatus {
        needs_setup: admin::user_count(&conn)? == 0,
        user: uid.and_then(|id| admin::get_user(&conn, id).ok()).filter(|u| u.active),
        db_warning: state.db_warning.clone(),
    })
}

#[tauri::command(async)]
fn setup_admin(state: State<AppState>, username: String, full_name: Option<String>, password: String) -> Res<User> {
    let user = admin::setup_admin(&*lock_db(&state)?, &username, full_name, &password)?;
    *state.session.lock().map_err(|_| "ERR:auth")? = Some(user.id);
    Ok(user)
}

#[tauri::command(async)]
fn login(state: State<AppState>, username: String, password: String) -> Res<User> {
    let user = admin::login(&*lock_db(&state)?, &username, &password)?;
    *state.session.lock().map_err(|_| "ERR:auth")? = Some(user.id);
    Ok(user)
}

#[tauri::command(async)]
fn logout(state: State<AppState>) -> Res<()> {
    *state.session.lock().map_err(|_| "ERR:auth")? = None;
    Ok(())
}

#[tauri::command(async)]
fn change_password(state: State<AppState>, old_password: String, new_password: String) -> Res<()> {
    authed(&state, "viewer", |c, u| admin::change_password(c, u, &old_password, &new_password))
}

/// Settings readable before login (login screen: language and company name).
#[tauri::command(async)]
fn get_public_settings(state: State<AppState>) -> Res<HashMap<String, String>> {
    let all = ledger::get_settings(&*lock_db(&state)?)?;
    Ok(all
        .into_iter()
        .filter(|(k, _)| matches!(k.as_str(), "language" | "company_name" | "company_activity" | "company_address" | "company_phone"))
        .collect())
}

// --- users --------------------------------------------------------------------

#[tauri::command(async)]
fn list_users(state: State<AppState>) -> Res<Vec<User>> {
    authed(&state, "admin", |c, _| admin::list_users(c))
}

#[tauri::command(async)]
fn save_user(state: State<AppState>, input: UserInput) -> Res<User> {
    authed(&state, "admin", |c, _| admin::save_user(c, &input))
}

#[tauri::command(async)]
fn delete_user(state: State<AppState>, id: i64) -> Res<()> {
    authed(&state, "admin", |c, u| admin::delete_user(c, id, u))
}

// --- settings -----------------------------------------------------------------

#[tauri::command(async)]
fn get_settings(state: State<AppState>) -> Res<HashMap<String, String>> {
    authed(&state, "viewer", |c, _| ledger::get_settings(c))
}

#[tauri::command(async)]
fn set_setting(state: State<AppState>, key: String, value: String) -> Res<()> {
    authed(&state, "admin", |c, _| ledger::set_setting(c, &key, &value))
}

// --- fiscal years -------------------------------------------------------------

#[tauri::command(async)]
fn list_exercises(state: State<AppState>) -> Res<Vec<Exercise>> {
    authed(&state, "viewer", |c, _| admin::list_exercises(c))
}

#[tauri::command(async)]
fn create_exercise(state: State<AppState>, year: i32) -> Res<()> {
    authed(&state, "user", |c, _| admin::create_exercise(c, year))
}

#[tauri::command(async)]
fn set_exercise_closed(state: State<AppState>, year: i32, closed: bool) -> Res<()> {
    authed(&state, "admin", |c, u| admin::set_exercise_closed(c, year, closed, u))
}

// --- accounts -----------------------------------------------------------------

#[tauri::command(async)]
fn list_accounts(state: State<AppState>, include_archived: Option<bool>) -> Res<Vec<Account>> {
    authed(&state, "viewer", |c, _| ledger::list_accounts(c, include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
fn save_account(state: State<AppState>, input: AccountInput) -> Res<Account> {
    authed(&state, "user", |c, _| ledger::save_account(c, &input))
}

#[tauri::command(async)]
fn delete_account(state: State<AppState>, id: i64) -> Res<bool> {
    authed(&state, "admin", |c, _| ledger::delete_account(c, id))
}

#[tauri::command(async)]
fn account_statement(state: State<AppState>, id: i64) -> Res<(Account, Vec<Transaction>)> {
    authed(&state, "viewer", |c, _| ledger::account_statement(c, id))
}

#[tauri::command(async)]
fn accounts_state(state: State<AppState>, from: String, to: String) -> Res<Vec<BalanceRow>> {
    authed(&state, "viewer", |c, _| admin::accounts_state(c, &from, &to))
}

#[tauri::command(async)]
fn parties_state(state: State<AppState>, from: String, to: String) -> Res<Vec<BalanceRow>> {
    authed(&state, "viewer", |c, _| admin::parties_state(c, &from, &to))
}

// --- parties --------------------------------------------------------------------

#[tauri::command(async)]
fn list_parties(state: State<AppState>, include_archived: Option<bool>) -> Res<Vec<Party>> {
    authed(&state, "viewer", |c, _| ledger::list_parties(c, include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
fn save_party(state: State<AppState>, input: PartyInput) -> Res<Party> {
    authed(&state, "user", |c, _| ledger::save_party(c, &input))
}

#[tauri::command(async)]
fn delete_party(state: State<AppState>, id: i64) -> Res<bool> {
    authed(&state, "user", |c, _| ledger::delete_party(c, id))
}

#[tauri::command(async)]
fn party_statement(state: State<AppState>, id: i64) -> Res<(Party, Vec<Transaction>)> {
    authed(&state, "viewer", |c, _| ledger::party_statement(c, id))
}

// --- chantiers ------------------------------------------------------------------

#[tauri::command(async)]
fn list_chantiers(state: State<AppState>, include_archived: Option<bool>) -> Res<Vec<Chantier>> {
    authed(&state, "viewer", |c, _| ledger::list_chantiers(c, include_archived.unwrap_or(false)))
}

#[tauri::command(async)]
fn save_chantier(state: State<AppState>, input: ChantierInput) -> Res<Chantier> {
    authed(&state, "user", |c, _| ledger::save_chantier(c, &input))
}

#[tauri::command(async)]
fn delete_chantier(state: State<AppState>, id: i64) -> Res<bool> {
    authed(&state, "user", |c, _| ledger::delete_chantier(c, id))
}

#[tauri::command(async)]
fn chantier_statement(state: State<AppState>, id: i64) -> Res<(Chantier, Vec<Transaction>)> {
    authed(&state, "viewer", |c, _| ledger::chantier_statement(c, id))
}

// --- families, cheques ------------------------------------------------------------

#[tauri::command(async)]
fn list_families(state: State<AppState>) -> Res<Vec<FamilyCount>> {
    authed(&state, "viewer", |c, _| ledger::list_families(c))
}

#[tauri::command(async)]
fn next_cheque_no(state: State<AppState>, account_id: i64) -> Res<Option<String>> {
    authed(&state, "viewer", |c, _| ledger::next_cheque_no(c, account_id))
}

// --- transactions ------------------------------------------------------------------

#[tauri::command(async)]
fn list_transactions(state: State<AppState>, filter: TxFilter) -> Res<Vec<Transaction>> {
    authed(&state, "viewer", |c, _| ledger::list_transactions(c, &filter))
}

#[tauri::command(async)]
fn get_transaction(state: State<AppState>, id: i64) -> Res<Transaction> {
    authed(&state, "viewer", |c, _| ledger::get_transaction(c, id))
}

#[tauri::command(async)]
fn save_transaction(state: State<AppState>, input: TxInput) -> Res<Transaction> {
    authed(&state, "user", |c, u| ledger::save_transaction_by(c, &input, Some(u)))
}

#[tauri::command(async)]
fn delete_transaction(state: State<AppState>, id: i64) -> Res<()> {
    authed(&state, "user", |c, u| ledger::delete_transaction_by(c, id, Some(u)))
}

#[tauri::command(async)]
fn restore_transaction(state: State<AppState>, audit_id: i64) -> Res<Transaction> {
    authed(&state, "user", |c, u| ledger::restore_transaction(c, audit_id, Some(u)))
}

#[tauri::command(async)]
fn list_audit(state: State<AppState>, filter: AuditFilter) -> Res<Vec<AuditEntry>> {
    authed(&state, "viewer", |c, _| admin::list_audit(c, &filter))
}

// --- smart labels -------------------------------------------------------------------

#[tauri::command(async)]
fn suggest_labels(state: State<AppState>, query: SuggestQuery) -> Res<Vec<Suggestion>> {
    authed(&state, "viewer", |c, _| ledger::suggest_labels(c, &query))
}

#[tauri::command(async)]
fn list_learned_labels(state: State<AppState>) -> Res<Vec<Suggestion>> {
    authed(&state, "viewer", |c, _| ledger::list_learned_labels(c))
}

#[tauri::command(async)]
fn forget_label(state: State<AppState>, key: String) -> Res<()> {
    authed(&state, "user", |c, _| ledger::forget_label(c, &key))
}

#[tauri::command(async)]
fn relearn_labels(state: State<AppState>) -> Res<usize> {
    authed(&state, "user", |c, _| ledger::relearn_all(c))
}

// --- dashboard, reports, export -----------------------------------------------------

#[tauri::command(async)]
fn get_dashboard(state: State<AppState>) -> Res<Dashboard> {
    authed(&state, "viewer", |c, _| ledger::dashboard(c))
}

#[tauri::command(async)]
fn get_report(state: State<AppState>, from: String, to: String) -> Res<Report> {
    authed(&state, "viewer", |c, _| ledger::report(c, &from, &to))
}

#[tauri::command(async)]
fn export_csv(app: AppHandle, state: State<AppState>) -> Res<String> {
    let csv = authed(&state, "viewer", |c, _| ledger::export_csv(c))?;
    let path = output_dir(&app)?.join(format!("operations-{}.csv", stamp()));
    // BOM so spreadsheet apps detect UTF-8 (accents).
    std::fs::write(&path, format!("\u{feff}{csv}")).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// --- Excel exports -------------------------------------------------------------

/// Builds an .xlsx in Documents/AccountBook/Excel, opens it (Excel or the default spreadsheet app)
/// and returns its path.
fn excel_export(
    app: &AppHandle,
    state: &State<AppState>,
    name: &[&str],
    build: impl FnOnce(&Connection, &Path) -> Res<()>,
) -> Res<String> {
    let dir = output_dir(app)?.join("Excel");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(excel::file_name(name));
    authed(state, "viewer", |c, _| build(c, &path))
        .map_err(|e| if e.contains("os error 32") || e.contains("Permission denied") { "ERR:file_open".to_string() } else { e })?;
    // Opening is a convenience: the file is saved even if no spreadsheet app is installed.
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
    Ok(path.to_string_lossy().into_owned())
}

fn period_label(from: &str, to: &str) -> String {
    if from.get(..4) == to.get(..4) && from.ends_with("-01-01") && to.ends_with("-12-31") {
        from[..4].to_string()
    } else {
        format!("{from} au {to}")
    }
}

#[tauri::command(async)]
fn export_account_xlsx(app: AppHandle, state: State<AppState>, id: i64, from: String, to: String) -> Res<String> {
    let name = authed(&state, "viewer", |c, _| ledger::get_account(c, id))?.name;
    excel_export(&app, &state, &["Relevé compte", &name, &period_label(&from, &to)], |c, p| {
        excel::account_statement(c, id, &from, &to, p)
    })
}

#[tauri::command(async)]
fn export_party_xlsx(app: AppHandle, state: State<AppState>, id: i64, from: String, to: String) -> Res<String> {
    let name = authed(&state, "viewer", |c, _| ledger::get_party(c, id))?.name;
    excel_export(&app, &state, &["Relevé", &name, &period_label(&from, &to)], |c, p| {
        excel::party_statement(c, id, &from, &to, p)
    })
}

#[tauri::command(async)]
fn export_chantier_xlsx(app: AppHandle, state: State<AppState>, id: i64, from: String, to: String) -> Res<String> {
    let name = authed(&state, "viewer", |c, _| ledger::get_chantier(c, id))?.name;
    excel_export(&app, &state, &["Chantier", &name, &period_label(&from, &to)], |c, p| {
        excel::chantier_statement(c, id, &from, &to, p)
    })
}

#[tauri::command(async)]
fn export_etat_xlsx(app: AppHandle, state: State<AppState>, from: String, to: String) -> Res<String> {
    excel_export(&app, &state, &["Etat des comptes", &period_label(&from, &to)], |c, p| excel::etat(c, &from, &to, p))
}

/// The entries shown in a window (after its filters), one sheet per type.
#[tauri::command(async)]
fn export_entries_xlsx(app: AppHandle, state: State<AppState>, title: String, ids: Vec<i64>, from: String, to: String) -> Res<String> {
    excel_export(&app, &state, &[&title, &period_label(&from, &to)], |c, p| {
        let txs = excel::load_entries(c, &ids)?;
        excel::entries(c, txs, &title, &from, &to, p)
    })
}

/// Every entry of the period, one sheet per type (Dépenses, Versements, Virements, Achats et Ventes à crédit).
#[tauri::command(async)]
fn export_all_xlsx(app: AppHandle, state: State<AppState>, from: String, to: String) -> Res<String> {
    excel_export(&app, &state, &["Opérations", &period_label(&from, &to)], |c, p| {
        let filter = TxFilter { from: Some(from.clone()), to: Some(to.clone()), ..Default::default() };
        let txs = ledger::list_transactions(c, &filter)?;
        let title = if ledger::get_setting(c, "language")?.as_deref() == Some("en") { "Entries" } else { "Opérations" };
        excel::entries(c, txs, title, &from, &to, p)
    })
}

#[tauri::command(async)]
fn backup_database(app: AppHandle, state: State<AppState>) -> Res<String> {
    let path = output_dir(&app)?.join(format!("accountbook-backup-{}.db", stamp()));
    authed(&state, "user", |c, _| ledger::backup_to(c, &path))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Safety copy of the database taken right before an update is installed
/// (kept in `<app data>/backups` next to the daily copies).
#[tauri::command(async)]
fn backup_before_update(app: AppHandle, state: State<AppState>) -> Res<String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("pre-update-{}.db", stamp()));
    authed(&state, "viewer", |c, _| ledger::backup_to(c, &path))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("accountbook.db");
            // Before a new version upgrades the database, keep an exact copy of the old one.
            let old_version = if db_path.exists() { ledger::file_schema_version(&db_path) } else { 0 };
            if db_path.exists() && old_version < ledger::schema_version() {
                let backups = dir.join("backups");
                std::fs::create_dir_all(&backups)?;
                let copy = backups.join(format!("pre-upgrade-v{old_version}-{}.db", stamp()));
                let old = Connection::open(&db_path)?;
                ledger::backup_to(&old, &copy).map_err(|e| format!("Backup before database upgrade failed: {e}"))?;
            }
            let conn = ledger::open(&db_path)?;
            // Startup health check and daily safety copy.
            let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).unwrap_or_else(|e| e.to_string());
            let db_warning = (check != "ok").then_some(check);
            if let Err(err) = auto_backup(&conn, &dir.join("backups")) {
                eprintln!("automatic backup failed: {err}");
            }
            app.manage(AppState { db: Mutex::new(conn), session: Mutex::new(None), db_warning });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            setup_admin,
            login,
            logout,
            change_password,
            get_public_settings,
            list_users,
            save_user,
            delete_user,
            get_settings,
            set_setting,
            list_exercises,
            create_exercise,
            set_exercise_closed,
            list_accounts,
            save_account,
            delete_account,
            account_statement,
            accounts_state,
            parties_state,
            list_parties,
            save_party,
            delete_party,
            party_statement,
            list_chantiers,
            save_chantier,
            delete_chantier,
            chantier_statement,
            list_families,
            next_cheque_no,
            list_transactions,
            get_transaction,
            save_transaction,
            delete_transaction,
            restore_transaction,
            list_audit,
            suggest_labels,
            list_learned_labels,
            forget_label,
            relearn_labels,
            get_dashboard,
            get_report,
            export_csv,
            backup_database,
            backup_before_update,
            export_account_xlsx,
            export_party_xlsx,
            export_chantier_xlsx,
            export_etat_xlsx,
            export_entries_xlsx,
            export_all_xlsx,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AccountBook");
}
