mod ledger;
mod models;
mod suggest;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use ledger::Res;
use models::*;

pub struct AppState {
    db: Mutex<Connection>,
}

fn with_db<T>(state: &State<AppState>, f: impl FnOnce(&mut Connection) -> Res<T>) -> Res<T> {
    let mut conn = state.db.lock().map_err(|_| "Database is busy".to_string())?;
    f(&mut conn)
}

/// Folder used for exports and backups: the user's Documents folder, or the app data folder.
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

// --- settings ---------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Res<HashMap<String, String>> {
    with_db(&state, |c| ledger::get_settings(c))
}

#[tauri::command]
fn set_setting(state: State<AppState>, key: String, value: String) -> Res<()> {
    with_db(&state, |c| ledger::set_setting(c, &key, &value))
}

// --- accounts ---------------------------------------------------------------

#[tauri::command]
fn list_accounts(state: State<AppState>, include_archived: Option<bool>) -> Res<Vec<Account>> {
    with_db(&state, |c| ledger::list_accounts(c, include_archived.unwrap_or(false)))
}

#[tauri::command]
fn save_account(state: State<AppState>, input: AccountInput) -> Res<Account> {
    with_db(&state, |c| ledger::save_account(c, &input))
}

#[tauri::command]
fn delete_account(state: State<AppState>, id: i64) -> Res<bool> {
    with_db(&state, |c| ledger::delete_account(c, id))
}

#[tauri::command]
fn account_statement(state: State<AppState>, id: i64) -> Res<(Account, Vec<Transaction>)> {
    with_db(&state, |c| ledger::account_statement(c, id))
}

// --- parties ----------------------------------------------------------------

#[tauri::command]
fn list_parties(state: State<AppState>, include_archived: Option<bool>) -> Res<Vec<Party>> {
    with_db(&state, |c| ledger::list_parties(c, include_archived.unwrap_or(false)))
}

#[tauri::command]
fn save_party(state: State<AppState>, input: PartyInput) -> Res<Party> {
    with_db(&state, |c| ledger::save_party(c, &input))
}

#[tauri::command]
fn delete_party(state: State<AppState>, id: i64) -> Res<bool> {
    with_db(&state, |c| ledger::delete_party(c, id))
}

#[tauri::command]
fn party_statement(state: State<AppState>, id: i64) -> Res<(Party, Vec<Transaction>)> {
    with_db(&state, |c| ledger::party_statement(c, id))
}

// --- transactions -----------------------------------------------------------

#[tauri::command]
fn list_transactions(state: State<AppState>, filter: TxFilter) -> Res<Vec<Transaction>> {
    with_db(&state, |c| ledger::list_transactions(c, &filter))
}

#[tauri::command]
fn save_transaction(state: State<AppState>, input: TxInput) -> Res<Transaction> {
    with_db(&state, |c| ledger::save_transaction(c, &input))
}

#[tauri::command]
fn delete_transaction(state: State<AppState>, id: i64) -> Res<()> {
    with_db(&state, |c| ledger::delete_transaction(c, id))
}

// --- smart labels -----------------------------------------------------------

#[tauri::command]
fn suggest_labels(state: State<AppState>, query: SuggestQuery) -> Res<Vec<Suggestion>> {
    with_db(&state, |c| ledger::suggest_labels(c, &query))
}

#[tauri::command]
fn list_learned_labels(state: State<AppState>) -> Res<Vec<Suggestion>> {
    with_db(&state, |c| ledger::list_learned_labels(c))
}

#[tauri::command]
fn forget_label(state: State<AppState>, key: String) -> Res<()> {
    with_db(&state, |c| ledger::forget_label(c, &key))
}

#[tauri::command]
fn relearn_labels(state: State<AppState>) -> Res<usize> {
    with_db(&state, ledger::relearn_all)
}

// --- dashboard, reports, export --------------------------------------------

#[tauri::command]
fn get_dashboard(state: State<AppState>) -> Res<Dashboard> {
    with_db(&state, |c| ledger::dashboard(c))
}

#[tauri::command]
fn get_report(state: State<AppState>, from: String, to: String) -> Res<Report> {
    with_db(&state, |c| ledger::report(c, &from, &to))
}

#[tauri::command]
fn export_csv(app: AppHandle, state: State<AppState>) -> Res<String> {
    let csv = with_db(&state, |c| ledger::export_csv(c))?;
    let path = output_dir(&app)?.join(format!("transactions-{}.csv", stamp()));
    // BOM so spreadsheet apps detect UTF-8 (Arabic/French labels).
    std::fs::write(&path, format!("\u{feff}{csv}")).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn backup_database(app: AppHandle, state: State<AppState>) -> Res<String> {
    let path = output_dir(&app)?.join(format!("accountbook-backup-{}.db", stamp()));
    with_db(&state, |c| ledger::backup_to(c, &path))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = ledger::open(&dir.join("accountbook.db"))?;
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_setting,
            list_accounts,
            save_account,
            delete_account,
            account_statement,
            list_parties,
            save_party,
            delete_party,
            party_statement,
            list_transactions,
            save_transaction,
            delete_transaction,
            suggest_labels,
            list_learned_labels,
            forget_label,
            relearn_labels,
            get_dashboard,
            get_report,
            export_csv,
            backup_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AccountBook");
}
