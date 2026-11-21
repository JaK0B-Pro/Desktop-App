//! Excel (.xlsx) exports with a clean layout: enterprise header, title and period, coloured header
//! row, real dates and amounts (formatted in the app currency), totals, frozen header, filter
//! buttons and print setup (landscape, one page wide, header repeated on every page).

use std::collections::HashMap;
use std::path::Path;

use rust_xlsxwriter::{Color, ExcelDateTime, Format, FormatAlign, FormatBorder, Workbook, Worksheet, XlsxError};
use rusqlite::Connection;

use crate::admin;
use crate::ledger::{self, Res};
use crate::models::*;

fn x(err: XlsxError) -> String {
    err.to_string()
}

/// French / English texts of the exports (follows the app language).
struct Tr {
    fr: bool,
}

impl Tr {
    fn s(&self, fr: &'static str, en: &'static str) -> &'static str {
        if self.fr {
            fr
        } else {
            en
        }
    }

    fn kind(&self, k: &str) -> &'static str {
        match (k, self.fr) {
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
    }

    /// Sheet name for each type of entry.
    fn kind_plural(&self, k: &str) -> &'static str {
        match (k, self.fr) {
            ("income", true) => "Versements",
            ("expense", true) => "Dépenses",
            ("transfer", true) => "Virements",
            ("purchase", true) => "Achats à crédit",
            ("sale", true) => "Ventes à crédit",
            ("income", false) => "Deposits",
            ("expense", false) => "Expenses",
            ("transfer", false) => "Transfers",
            ("purchase", false) => "Purchases on credit",
            _ => "Sales on credit",
        }
    }

    fn status(&self, s: &str) -> &'static str {
        match (s, self.fr) {
            ("pending", true) => "En attente",
            ("pending", false) => "Pending",
            _ => "Ok",
        }
    }
}

/// Settings needed by every export.
struct Ctx {
    tr: Tr,
    company: String,
    company_line: String,
    decimals: u32,
    money_format: String,
    symbol: String,
    symbol_before: bool,
}

impl Ctx {
    fn load(conn: &Connection) -> Res<Ctx> {
        let s = ledger::get_settings(conn)?;
        let get = |k: &str| s.get(k).cloned().unwrap_or_default();
        let decimals: u32 = get("decimals").parse().unwrap_or(2).min(3);
        let symbol = get("currency_symbol").replace('"', "");
        let digits = if decimals == 0 { "#,##0".to_string() } else { format!("#,##0.{}", "0".repeat(decimals as usize)) };
        let positive = match (symbol.is_empty(), get("currency_position").as_str()) {
            (true, _) => digits.clone(),
            (false, "before") => format!("\"{symbol} \"{digits}"),
            _ => format!("{digits} \"{symbol}\""),
        };
        Ok(Ctx {
            tr: Tr { fr: get("language") != "en" },
            company: get("company_name"),
            company_line: [get("company_activity"), get("company_address"), get("company_phone")]
                .into_iter()
                .filter(|v| !v.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" — "),
            decimals,
            // Negative amounts in red.
            money_format: format!("{positive};[Red]-{positive}"),
            symbol_before: get("currency_position") == "before",
            symbol,
        })
    }

    fn money(&self, cents: i64) -> f64 {
        cents as f64 / 10f64.powi(self.decimals as i32)
    }

    /// "1,679.50 DA" — same look as the amounts in the app (for text lines).
    fn money_text(&self, cents: i64) -> String {
        let div = 10i64.pow(self.decimals);
        let (whole, frac) = (cents.abs() / div, cents.abs() % div);
        let digits = whole.to_string();
        let mut grouped = String::new();
        for (i, ch) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        let number = if self.decimals == 0 { grouped } else { format!("{grouped}.{frac:0w$}", w = self.decimals as usize) };
        let sign = if cents < 0 { "-" } else { "" };
        match (self.symbol.is_empty(), self.symbol_before) {
            (true, _) => format!("{sign}{number}"),
            (false, true) => format!("{sign}{} {number}", self.symbol),
            (false, false) => format!("{sign}{number} {}", self.symbol),
        }
    }
}

/// What a column holds (decides its format).
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Number,
    Date,
    Money,
}

struct Col {
    title: String,
    width: f64,
    kind: Kind,
}

fn col(title: &str, width: f64, kind: Kind) -> Col {
    Col { title: title.into(), width, kind }
}

enum Cell {
    Text(String),
    Number(i64),
    Date(String),
    Money(i64),
    Empty,
}

impl Cell {
    fn text(s: impl Into<String>) -> Cell {
        let s = s.into();
        if s.is_empty() {
            Cell::Empty
        } else {
            Cell::Text(s)
        }
    }
}

struct Styles {
    company: Format,
    title: Format,
    subtitle: Format,
    header: Format,
    header_num: Format,
    text: Format,
    number: Format,
    date: Format,
    money: Format,
    total_label: Format,
    total_money: Format,
    total_blank: Format,
    note: Format,
}

impl Styles {
    fn new(ctx: &Ctx) -> Styles {
        let border = Color::RGB(0xC9D3E3);
        let cell = || Format::new().set_border(FormatBorder::Thin).set_border_color(border).set_font_size(10);
        let header = Format::new()
            .set_bold()
            .set_font_size(10)
            .set_font_color(Color::RGB(0x1E3A6B))
            .set_background_color(Color::RGB(0xDBE7FB))
            .set_border(FormatBorder::Thin)
            .set_border_color(border)
            .set_text_wrap();
        let total = || {
            Format::new()
                .set_bold()
                .set_font_size(10)
                .set_background_color(Color::RGB(0xF0F3F8))
                .set_border_top(FormatBorder::Medium)
                .set_border_bottom(FormatBorder::Thin)
                .set_border_color(border)
        };
        Styles {
            company: Format::new().set_bold().set_font_size(14),
            title: Format::new().set_bold().set_font_size(12).set_font_color(Color::RGB(0x2563EB)),
            subtitle: Format::new().set_italic().set_font_size(10).set_font_color(Color::RGB(0x5B6575)),
            header_num: header.clone().set_align(FormatAlign::Right),
            header,
            text: cell(),
            number: cell().set_align(FormatAlign::Right).set_font_color(Color::RGB(0x6B7280)),
            date: cell().set_num_format("dd/mm/yyyy").set_align(FormatAlign::Left),
            money: cell().set_num_format(&ctx.money_format),
            total_label: total(),
            total_money: total().set_num_format(&ctx.money_format),
            total_blank: total(),
            note: Format::new().set_font_size(9).set_font_color(Color::RGB(0x6B7280)),
        }
    }
}

/// A sheet: header lines, then a table with optional opening line and totals row.
struct Table {
    sheet: String,
    title: String,
    subtitle: Vec<String>,
    cols: Vec<Col>,
    /// A line before the data (e.g. "Solde au 01/01/2026" with the opening balance).
    opening: Option<Vec<Cell>>,
    rows: Vec<Vec<Cell>>,
    totals: Option<Vec<Cell>>,
    footer: Vec<String>,
}

/// Excel forbids some characters in sheet names and limits them to 31 characters.
fn sheet_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if "[]:*?/\\".contains(c) { '-' } else { c }).collect();
    let clean = clean.trim().trim_matches('\'');
    let clean = if clean.is_empty() { "Feuille" } else { clean };
    clean.chars().take(31).collect()
}

fn date_value(iso: &str) -> Option<ExcelDateTime> {
    let mut p = iso.split('-').map(|v| v.parse::<u32>().ok());
    match (p.next().flatten(), p.next().flatten(), p.next().flatten()) {
        (Some(y), Some(m), Some(d)) => ExcelDateTime::from_ymd(y as u16, m as u8, d as u8).ok(),
        _ => None,
    }
}

fn write_cell(ws: &mut Worksheet, row: u32, c: u16, cell: &Cell, st: &Styles, ctx: &Ctx, total: bool) -> Res<()> {
    let text_fmt = if total { &st.total_label } else { &st.text };
    match cell {
        Cell::Text(s) => ws.write_string_with_format(row, c, s, text_fmt).map_err(x)?,
        Cell::Number(n) => ws.write_number_with_format(row, c, *n as f64, if total { &st.total_label } else { &st.number }).map_err(x)?,
        Cell::Date(d) => match date_value(d) {
            Some(v) => ws.write_datetime_with_format(row, c, v, &st.date).map_err(x)?,
            None => ws.write_string_with_format(row, c, d, text_fmt).map_err(x)?,
        },
        Cell::Money(v) => ws
            .write_number_with_format(row, c, ctx.money(*v), if total { &st.total_money } else { &st.money })
            .map_err(x)?,
        Cell::Empty => ws.write_blank(row, c, if total { &st.total_blank } else { &st.text }).map_err(x)?,
    };
    Ok(())
}

fn write_table(wb: &mut Workbook, t: &Table, ctx: &Ctx, st: &Styles) -> Res<()> {
    let ws = wb.add_worksheet();
    ws.set_name(sheet_name(&t.sheet)).map_err(x)?;
    let last_col = (t.cols.len().max(1) - 1) as u16;
    let mut row: u32 = 0;
    if !ctx.company.is_empty() {
        ws.write_string_with_format(row, 0, &ctx.company, &st.company).map_err(x)?;
        row += 1;
    }
    if !ctx.company_line.is_empty() {
        ws.write_string_with_format(row, 0, &ctx.company_line, &st.subtitle).map_err(x)?;
        row += 1;
    }
    row += 1;
    ws.write_string_with_format(row, 0, &t.title, &st.title).map_err(x)?;
    row += 1;
    for s in &t.subtitle {
        ws.write_string_with_format(row, 0, s, &st.subtitle).map_err(x)?;
        row += 1;
    }
    row += 1;

    let header_row = row;
    for (i, c) in t.cols.iter().enumerate() {
        let f = if matches!(c.kind, Kind::Money | Kind::Number) { &st.header_num } else { &st.header };
        ws.write_string_with_format(row, i as u16, &c.title, f).map_err(x)?;
        ws.set_column_width(i as u16, c.width).map_err(x)?;
    }
    ws.set_row_height(row, 30).map_err(x)?;
    row += 1;

    if let Some(open) = &t.opening {
        for (i, cell) in open.iter().enumerate() {
            write_cell(ws, row, i as u16, cell, st, ctx, false)?;
        }
        row += 1;
    }
    for r in &t.rows {
        for (i, cell) in r.iter().enumerate() {
            write_cell(ws, row, i as u16, cell, st, ctx, false)?;
        }
        row += 1;
    }
    let last_data = row.saturating_sub(1).max(header_row);
    if let Some(tot) = &t.totals {
        for (i, cell) in tot.iter().enumerate() {
            write_cell(ws, row, i as u16, cell, st, ctx, true)?;
        }
        row += 1;
    }
    for f in &t.footer {
        row += 1;
        ws.write_string_with_format(row, 0, f, &st.note).map_err(x)?;
    }

    ws.set_freeze_panes(header_row + 1, 0).map_err(x)?;
    ws.autofilter(header_row, 0, last_data, last_col).map_err(x)?;
    ws.set_landscape();
    ws.set_print_fit_to_pages(1, 0);
    ws.set_repeat_rows(header_row, header_row).map_err(x)?;
    ws.set_footer("&L&8&A&R&8Page &P / &N");
    Ok(())
}

fn save(tables: &[Table], ctx: &Ctx, path: &Path) -> Res<()> {
    let mut wb = Workbook::new();
    let st = Styles::new(ctx);
    for t in tables {
        write_table(&mut wb, t, ctx, &st)?;
    }
    wb.save(path).map_err(|e| format!("Excel: {e}"))
}

fn fr_date(iso: &str) -> String {
    let p: Vec<&str> = iso.split('-').collect();
    if p.len() == 3 {
        format!("{}/{}/{}", p[2], p[1], p[0])
    } else {
        iso.to_string()
    }
}

fn period(ctx: &Ctx, from: &str, to: &str) -> String {
    format!("{} {} {} {}", ctx.tr.s("Période du", "Period from"), fr_date(from), ctx.tr.s("au", "to"), fr_date(to))
}

fn generated(ctx: &Ctx) -> String {
    format!(
        "{} {}",
        ctx.tr.s("Édité le", "Generated on"),
        chrono::Local::now().format("%d/%m/%Y %H:%M")
    )
}

/// "Caisse, Banque" or "Banque BNA → Caisse" for transfers.
fn accounts_text(t: &Transaction) -> String {
    if t.kind == "transfer" {
        let side = |pos: bool| {
            t.lines.iter().filter(|l| (l.amount > 0) == pos).map(|l| l.account_name.clone()).collect::<Vec<_>>().join(", ")
        };
        format!("{} → {}", side(false), side(true))
    } else {
        t.lines.iter().map(|l| l.account_name.clone()).collect::<Vec<_>>().join(", ")
    }
}

fn chantiers_text(t: &Transaction) -> String {
    let mut names: Vec<String> = vec![];
    for n in t.chantier_name.iter().chain(t.lines.iter().filter_map(|l| l.chantier_name.as_ref())) {
        if !names.contains(n) {
            names.push(n.clone());
        }
    }
    names.join(", ")
}

/// Splits a statement (newest first) into the opening balance at `from` and the rows of the period (oldest first).
fn in_period(mut rows: Vec<Transaction>, opening: i64, from: &str, to: &str) -> (i64, Vec<Transaction>) {
    rows.reverse();
    let before: i64 = rows.iter().filter(|t| t.date.as_str() < from).map(|t| t.effect.unwrap_or(0)).sum();
    let kept = rows.into_iter().filter(|t| t.date.as_str() >= from && t.date.as_str() <= to).collect();
    (opening + before, kept)
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Statement of one account: N°, date, type, label, beneficiary, site, in, out, running balance.
pub fn account_statement(conn: &Connection, id: i64, from: &str, to: &str, path: &Path) -> Res<()> {
    let ctx = Ctx::load(conn)?;
    let tr = &ctx.tr;
    let (account, rows) = ledger::account_statement(conn, id)?;
    let (opening, rows) = in_period(rows, account.opening_balance, from, to);
    let mut balance = opening;
    let (mut total_in, mut total_out) = (0, 0);
    let mut data = vec![];
    for t in &rows {
        let eff = t.effect.unwrap_or(0);
        balance += eff;
        if eff >= 0 {
            total_in += eff;
        } else {
            total_out -= eff;
        }
        data.push(vec![
            Cell::Number(t.num),
            Cell::Date(t.date.clone()),
            Cell::text(tr.kind(&t.kind)),
            Cell::text(&t.label),
            Cell::text(t.party_name.clone().unwrap_or_default()),
            Cell::text(chantiers_text(t)),
            if eff > 0 { Cell::Money(eff) } else { Cell::Empty },
            if eff < 0 { Cell::Money(-eff) } else { Cell::Empty },
            Cell::Money(balance),
        ]);
    }
    let table = Table {
        sheet: account.name.clone(),
        title: format!("{} — {}", tr.s("Relevé du compte", "Account statement"), account.name),
        subtitle: vec![period(&ctx, from, to)],
        cols: vec![
            col(tr.s("N°", "No"), 7.0, Kind::Number),
            col("Date", 11.0, Kind::Date),
            col("Type", 15.0, Kind::Text),
            col(tr.s("Libellé", "Label"), 34.0, Kind::Text),
            col(tr.s("Bénéficiaire", "Beneficiary"), 22.0, Kind::Text),
            col("Chantier", 18.0, Kind::Text),
            col(tr.s("Entrées", "In"), 16.0, Kind::Money),
            col(tr.s("Sorties", "Out"), 16.0, Kind::Money),
            col(tr.s("Solde", "Balance"), 17.0, Kind::Money),
        ],
        opening: Some(vec![
            Cell::Empty,
            Cell::Date(from.to_string()),
            Cell::Empty,
            Cell::text(tr.s("Solde initial", "Opening balance")),
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Money(opening),
        ]),
        rows: data,
        totals: Some(vec![
            Cell::text(tr.s("Total", "Total")),
            Cell::Empty,
            Cell::Empty,
            Cell::text(format!("{} {}", rows.len(), tr.s("opération(s)", "entries"))),
            Cell::Empty,
            Cell::Empty,
            Cell::Money(total_in),
            Cell::Money(total_out),
            Cell::Money(balance),
        ]),
        footer: vec![generated(&ctx)],
    };
    save(&[table], &ctx, path)
}

/// Statement of one beneficiary: what increased and reduced their balance, and who owes whom.
pub fn party_statement(conn: &Connection, id: i64, from: &str, to: &str, path: &Path) -> Res<()> {
    let ctx = Ctx::load(conn)?;
    let tr = &ctx.tr;
    let (party, rows) = ledger::party_statement(conn, id)?;
    let (opening, rows) = in_period(rows, party.opening_balance, from, to);
    let mut balance = opening;
    let (mut debit, mut credit) = (0, 0);
    let mut data = vec![];
    for t in &rows {
        let eff = t.effect.unwrap_or(0);
        balance += eff;
        if eff >= 0 {
            debit += eff;
        } else {
            credit -= eff;
        }
        data.push(vec![
            Cell::Number(t.num),
            Cell::Date(t.date.clone()),
            Cell::text(tr.kind(&t.kind)),
            Cell::text(&t.label),
            Cell::text(accounts_text(t)),
            Cell::text(chantiers_text(t)),
            if eff > 0 { Cell::Money(eff) } else { Cell::Empty },
            if eff < 0 { Cell::Money(-eff) } else { Cell::Empty },
            Cell::Money(balance),
        ]);
    }
    let situation = |b: i64| -> String {
        let amount = ctx.money_text(b.abs());
        match b.signum() {
            1 => format!("{} {} {amount}", party.name, tr.s("vous doit", "owes you")),
            -1 => format!("{} {} {amount}", tr.s("Vous devez à", "You owe"), party.name),
            _ => tr.s("Réglé (solde nul)", "Settled (zero balance)").to_string(),
        }
    };
    let table = Table {
        sheet: party.name.clone(),
        title: format!("{} — {}", tr.s("Relevé du bénéficiaire", "Beneficiary statement"), party.name),
        subtitle: vec![
            period(&ctx, from, to),
            tr.s("Solde positif : il vous doit · Solde négatif : vous lui devez", "Positive balance: they owe you · Negative: you owe them")
                .to_string(),
        ],
        cols: vec![
            col(tr.s("N°", "No"), 7.0, Kind::Number),
            col("Date", 11.0, Kind::Date),
            col("Type", 15.0, Kind::Text),
            col(tr.s("Libellé", "Label"), 34.0, Kind::Text),
            col(tr.s("Compte", "Account"), 20.0, Kind::Text),
            col("Chantier", 18.0, Kind::Text),
            col(tr.s("Payé / vendu à crédit", "Paid / sold on credit"), 17.0, Kind::Money),
            col(tr.s("Reçu / acheté à crédit", "Received / bought on credit"), 17.0, Kind::Money),
            col(tr.s("Solde", "Balance"), 17.0, Kind::Money),
        ],
        opening: Some(vec![
            Cell::Empty,
            Cell::Date(from.to_string()),
            Cell::Empty,
            Cell::text(tr.s("Solde initial", "Opening balance")),
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Money(opening),
        ]),
        rows: data,
        totals: Some(vec![
            Cell::text(tr.s("Total", "Total")),
            Cell::Empty,
            Cell::Empty,
            Cell::text(format!("{} {}", rows.len(), tr.s("opération(s)", "entries"))),
            Cell::Empty,
            Cell::Empty,
            Cell::Money(debit),
            Cell::Money(credit),
            Cell::Money(balance),
        ]),
        footer: vec![format!("{} {} : {}", tr.s("Situation au", "Situation on"), fr_date(to), situation(balance)), generated(&ctx)],
    };
    save(&[table], &ctx, path)
}

/// Statement of one construction site: money received and spent (cash result), credit operations for information.
pub fn chantier_statement(conn: &Connection, id: i64, from: &str, to: &str, path: &Path) -> Res<()> {
    let ctx = Ctx::load(conn)?;
    let tr = &ctx.tr;
    let (chantier, rows) = ledger::chantier_statement(conn, id)?;
    let mut rows = rows;
    rows.reverse();
    let cash = |t: &Transaction| if t.kind == "income" || t.kind == "expense" { t.effect.unwrap_or(0) } else { 0 };
    let opening: i64 = rows.iter().filter(|t| t.date.as_str() < from).map(cash).sum();
    let rows: Vec<Transaction> = rows.into_iter().filter(|t| t.date.as_str() >= from && t.date.as_str() <= to).collect();
    let mut balance = opening;
    let (mut inc, mut out, mut cred) = (0, 0, 0);
    let mut data = vec![];
    for t in &rows {
        let c = cash(t);
        balance += c;
        let credit_amount = if t.kind == "purchase" || t.kind == "sale" { t.amount } else { 0 };
        if c > 0 {
            inc += c;
        } else {
            out -= c;
        }
        cred += credit_amount;
        data.push(vec![
            Cell::Number(t.num),
            Cell::Date(t.date.clone()),
            Cell::text(tr.kind(&t.kind)),
            Cell::text(&t.label),
            Cell::text(accounts_text(t)),
            Cell::text(t.party_name.clone().unwrap_or_default()),
            if c > 0 { Cell::Money(c) } else { Cell::Empty },
            if c < 0 { Cell::Money(-c) } else { Cell::Empty },
            if credit_amount > 0 { Cell::Money(credit_amount) } else { Cell::Empty },
            Cell::Money(balance),
        ]);
    }
    let table = Table {
        sheet: chantier.name.clone(),
        title: format!("{} — {}", tr.s("Relevé du chantier", "Site statement"), chantier.name),
        subtitle: vec![
            period(&ctx, from, to),
            tr.s(
                "Résultat = encaissé − dépensé. Les opérations à crédit sont indiquées pour information.",
                "Result = received − spent. Credit operations are shown for information.",
            )
            .to_string(),
        ],
        cols: vec![
            col(tr.s("N°", "No"), 7.0, Kind::Number),
            col("Date", 11.0, Kind::Date),
            col("Type", 15.0, Kind::Text),
            col(tr.s("Libellé", "Label"), 32.0, Kind::Text),
            col(tr.s("Compte", "Account"), 18.0, Kind::Text),
            col(tr.s("Bénéficiaire", "Beneficiary"), 20.0, Kind::Text),
            col(tr.s("Encaissé", "Received"), 16.0, Kind::Money),
            col(tr.s("Dépensé", "Spent"), 16.0, Kind::Money),
            col(tr.s("À crédit", "On credit"), 16.0, Kind::Money),
            col(tr.s("Résultat", "Result"), 17.0, Kind::Money),
        ],
        opening: Some(vec![
            Cell::Empty,
            Cell::Date(from.to_string()),
            Cell::Empty,
            Cell::text(tr.s("Report", "Brought forward")),
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Empty,
            Cell::Money(opening),
        ]),
        rows: data,
        totals: Some(vec![
            Cell::text(tr.s("Total", "Total")),
            Cell::Empty,
            Cell::Empty,
            Cell::text(format!("{} {}", rows.len(), tr.s("opération(s)", "entries"))),
            Cell::Empty,
            Cell::Empty,
            Cell::Money(inc),
            Cell::Money(out),
            Cell::Money(cred),
            Cell::Money(balance),
        ]),
        footer: vec![generated(&ctx)],
    };
    save(&[table], &ctx, path)
}

/// État des comptes: one sheet for accounts, one for beneficiaries.
pub fn etat(conn: &Connection, from: &str, to: &str, path: &Path) -> Res<()> {
    let ctx = Ctx::load(conn)?;
    let tr = &ctx.tr;
    let account_kind = |k: &str| -> &'static str {
        match k {
            "cash" => tr.s("Caisse", "Cash box"),
            "bank" => tr.s("Banque", "Bank"),
            "project" => tr.s("Projet", "Project"),
            _ => tr.s("Autre", "Other"),
        }
    };
    let party_kind = |k: &str| -> &'static str {
        match k {
            "supplier" => tr.s("Fournisseur", "Supplier"),
            "client" => "Client",
            "person" => tr.s("Personne", "Person"),
            "employee" => tr.s("Employé", "Employee"),
            _ => tr.s("Autre", "Other"),
        }
    };
    let sheet = |title: &str, sheet: &str, rows: Vec<BalanceRow>, kind: &dyn Fn(&str) -> &'static str, cols: [&str; 4], situation: bool| {
        let sum = |f: fn(&BalanceRow) -> i64| rows.iter().map(f).sum::<i64>();
        let mut c = vec![
            col(tr.s("Nom", "Name"), 30.0, Kind::Text),
            col("Type", 14.0, Kind::Text),
            col(cols[0], 17.0, Kind::Money),
            col(cols[1], 17.0, Kind::Money),
            col(cols[2], 17.0, Kind::Money),
            col(cols[3], 17.0, Kind::Money),
        ];
        if situation {
            c.push(col(tr.s("Situation", "Situation"), 18.0, Kind::Text));
        }
        let data = rows
            .iter()
            .map(|r| {
                let mut v = vec![
                    Cell::text(&r.name),
                    Cell::text(kind(&r.kind)),
                    Cell::Money(r.initial),
                    Cell::Money(r.debit),
                    Cell::Money(r.credit),
                    Cell::Money(r.balance),
                ];
                if situation {
                    v.push(Cell::text(match r.balance.signum() {
                        1 => tr.s("Vous doit", "Owes you"),
                        -1 => tr.s("Vous lui devez", "You owe"),
                        _ => tr.s("Réglé", "Settled"),
                    }));
                }
                v
            })
            .collect();
        let mut totals = vec![
            Cell::text(tr.s("Total", "Total")),
            Cell::Empty,
            Cell::Money(sum(|r| r.initial)),
            Cell::Money(sum(|r| r.debit)),
            Cell::Money(sum(|r| r.credit)),
            Cell::Money(sum(|r| r.balance)),
        ];
        if situation {
            totals.push(Cell::Empty);
        }
        Table {
            sheet: sheet.into(),
            title: title.into(),
            subtitle: vec![period(&ctx, from, to)],
            cols: c,
            opening: None,
            rows: data,
            totals: Some(totals),
            footer: vec![generated(&ctx)],
        }
    };
    let accounts = sheet(
        tr.s("État des comptes — Comptes", "Account balances — Accounts"),
        tr.s("Comptes", "Accounts"),
        admin::accounts_state(conn, from, to)?,
        &account_kind,
        [tr.s("Solde initial", "Opening"), tr.s("Entrées", "In"), tr.s("Sorties", "Out"), tr.s("Solde", "Balance")],
        false,
    );
    let parties = sheet(
        tr.s("État des comptes — Bénéficiaires", "Account balances — Beneficiaries"),
        tr.s("Bénéficiaires", "Beneficiaries"),
        admin::parties_state(conn, from, to)?,
        &party_kind,
        [
            tr.s("Solde initial", "Opening"),
            tr.s("Payé / vendu à crédit", "Paid / sold on credit"),
            tr.s("Reçu / acheté à crédit", "Received / bought on credit"),
            tr.s("Solde", "Balance"),
        ],
        true,
    );
    save(&[accounts, parties], &ctx, path)
}

const KINDS: [&str; 5] = ["expense", "income", "transfer", "purchase", "sale"];

/// Entries grouped by type, one sheet per type (each with its own numbering), in date order.
pub fn entries(conn: &Connection, txs: Vec<Transaction>, title: &str, from: &str, to: &str, path: &Path) -> Res<()> {
    let ctx = Ctx::load(conn)?;
    let tr = &ctx.tr;
    let mut by_kind: HashMap<&str, Vec<Transaction>> = HashMap::new();
    for t in txs {
        let k = KINDS.iter().find(|k| **k == t.kind).copied().unwrap_or("expense");
        by_kind.entry(k).or_default().push(t);
    }
    let mut tables = vec![];
    for kind in KINDS {
        let Some(mut list) = by_kind.remove(kind) else { continue };
        list.sort_by(|a, b| (a.date.as_str(), a.num).cmp(&(b.date.as_str(), b.num)));
        let total: i64 = list.iter().map(|t| t.amount).sum();
        let rows = list
            .iter()
            .map(|t| {
                vec![
                    Cell::Number(t.num),
                    Cell::Date(t.date.clone()),
                    Cell::text(if t.lines.is_empty() { tr.s("à crédit", "on credit").to_string() } else { accounts_text(t) }),
                    Cell::text(chantiers_text(t)),
                    Cell::text(t.party_name.clone().unwrap_or_default()),
                    Cell::text(t.family.clone().unwrap_or_default()),
                    Cell::text(&t.label),
                    Cell::Money(t.amount),
                    Cell::text(tr.status(&t.status)),
                    Cell::text(t.cheque_no.clone().unwrap_or_default()),
                    Cell::text(t.notes.clone().unwrap_or_default()),
                ]
            })
            .collect::<Vec<_>>();
        tables.push(Table {
            sheet: tr.kind_plural(kind).to_string(),
            // "Dépenses" from the Dépenses window; "Opérations — Dépenses" in a full export.
            title: if title == tr.kind_plural(kind) { title.to_string() } else { format!("{} — {}", title, tr.kind_plural(kind)) },
            subtitle: vec![period(&ctx, from, to)],
            cols: vec![
                col(tr.s("N°", "No"), 7.0, Kind::Number),
                col("Date", 11.0, Kind::Date),
                col(tr.s("Compte", "Account"), 20.0, Kind::Text),
                col("Chantier", 18.0, Kind::Text),
                col(tr.s("Bénéficiaire", "Beneficiary"), 22.0, Kind::Text),
                col(tr.s("Famille", "Family"), 14.0, Kind::Text),
                col(tr.s("Libellé", "Label"), 34.0, Kind::Text),
                col(tr.s("Montant", "Amount"), 17.0, Kind::Money),
                col(tr.s("État", "Status"), 10.0, Kind::Text),
                col(tr.s("Chèque N°", "Cheque No"), 12.0, Kind::Text),
                col("Notes", 24.0, Kind::Text),
            ],
            opening: None,
            totals: Some(vec![
                Cell::text(tr.s("Total", "Total")),
                Cell::Empty,
                Cell::Empty,
                Cell::Empty,
                Cell::Empty,
                Cell::Empty,
                Cell::text(format!("{} {}", rows.len(), tr.s("opération(s)", "entries"))),
                Cell::Money(total),
                Cell::Empty,
                Cell::Empty,
                Cell::Empty,
            ]),
            rows,
            footer: vec![generated(&ctx)],
        });
    }
    if tables.is_empty() {
        return Err("ERR:nothing_to_export".into());
    }
    save(&tables, &ctx, path)
}

/// Loads the given entries (the list shown in a window, after its filters).
pub fn load_entries(conn: &Connection, ids: &[i64]) -> Res<Vec<Transaction>> {
    ids.iter().map(|id| ledger::get_transaction(conn, *id)).collect()
}

/// A file name safe on Windows: "Relevé Caisse 2026.xlsx".
pub fn file_name(parts: &[&str]) -> String {
    let joined = parts.iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    let clean: String = joined.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '-' } else { c }).collect();
    format!("{}.xlsx", clean.trim())
}

#[cfg(test)]
#[allow(clippy::inconsistent_digit_grouping)]
mod tests {
    use super::*;
    use crate::ledger::{init, save_transaction};

    fn sample() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        ledger::set_setting(&c, "company_name", "ETCE Test").unwrap();
        let cash = ledger::list_accounts(&c, false).unwrap()[0].id;
        let p = ledger::save_party(&c, &PartyInput { name: "Fournisseur/A".into(), kind: "supplier".into(), ..Default::default() })
            .unwrap()
            .id;
        let ch = ledger::save_chantier(&c, &ChantierInput { name: "200 LOGTS".into(), ..Default::default() }).unwrap().id;
        for (date, kind, amount) in [("2025-12-30", "income", 1_000_00), ("2026-01-05", "income", 500_00), ("2026-02-01", "expense", 120_50)] {
            save_transaction(
                &mut c,
                &TxInput {
                    date: date.into(),
                    kind: kind.into(),
                    label: "Ligne \"test\"".into(),
                    party_id: Some(p),
                    chantier_id: Some(ch),
                    lines: vec![LineInput { account_id: cash, amount, chantier_id: None }],
                    ..Default::default()
                },
            )
            .unwrap();
        }
        save_transaction(
            &mut c,
            &TxInput {
                date: "2026-03-01".into(),
                kind: "purchase".into(),
                label: "Facture".into(),
                party_id: Some(p),
                chantier_id: Some(ch),
                amount: Some(300_00),
                ..Default::default()
            },
        )
        .unwrap();
        c
    }

    /// Every export writes a readable .xlsx (a zip with the expected sheets).
    #[test]
    fn all_exports_write_files() {
        let c = sample();
        let dir = std::env::temp_dir().join(format!("ab-xlsx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cash = ledger::list_accounts(&c, false).unwrap()[0].id;
        let party = ledger::list_parties(&c, false).unwrap()[0].id;
        let ch = ledger::list_chantiers(&c, false).unwrap()[0].id;
        let (from, to) = ("2026-01-01", "2026-12-31");
        account_statement(&c, cash, from, to, &dir.join("a.xlsx")).unwrap();
        party_statement(&c, party, from, to, &dir.join("p.xlsx")).unwrap();
        chantier_statement(&c, ch, from, to, &dir.join("c.xlsx")).unwrap();
        etat(&c, from, to, &dir.join("e.xlsx")).unwrap();
        let all = ledger::list_transactions(&c, &TxFilter { from: Some(from.into()), to: Some(to.into()), ..Default::default() }).unwrap();
        entries(&c, all, "Journal", from, to, &dir.join("j.xlsx")).unwrap();
        for f in ["a", "p", "c", "e", "j"] {
            let bytes = std::fs::read(dir.join(format!("{f}.xlsx"))).unwrap();
            assert_eq!(&bytes[..2], b"PK", "{f}.xlsx is a zip");
        }
        // Opening balance of the period comes from 2025.
        let (_, rows) = ledger::account_statement(&c, cash).unwrap();
        let (opening, kept) = in_period(rows, 0, from, to);
        assert_eq!(opening, 1_000_00);
        assert_eq!(kept.len(), 2);
        if std::env::var("KEEP_XLSX").is_err() {
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(sheet_name("Fournisseur/A [x]"), "Fournisseur-A -x-");
        assert_eq!(sheet_name(&"x".repeat(40)).len(), 31);
        assert_eq!(file_name(&["Relevé", "A/B:C", "2026"]), "Relevé A-B-C 2026.xlsx");
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        let ctx = Ctx::load(&c).unwrap();
        assert_eq!(ctx.money_text(167_950), "1,679.50 DA");
        assert_eq!(ctx.money_text(-123_456_789_00), "-123,456,789.00 DA");
    }
}
