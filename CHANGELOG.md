# Versions

Every delivery is a numbered version. Each version has Windows installers on the GitHub **Releases** page
(built by `.github/workflows/release.yml` when the version number changes), so it can be installed and tested
before going further.
Installing a newer version keeps your data: the database is upgraded automatically.

## 0.4.0 — Virements

- **Virement** button in the top bar: transfer money from one account to another in a few clicks.
- In the transfer window:
  - every account shows its **balance**, and you can create a **new account** directly ("+ Nouveau compte…")
  - **⇅ Inverser** swaps the source and destination
  - a **preview** shows each account's balance before and after, and warns if an account would become negative
  - the label is written for you ("Virement Caisse → Banque BNA") if you leave it empty
- Expenses and deposits also show the account balances and allow creating an account inline.
- Wider account column in the Virements window ("Banque BNA → Caisse").
- The version number is shown under the logo and on the login screen.

## 0.3.0 — Users, exercices, performance

Commit `263e84dca0c99047b0b1f3d194c9d29363e6f2fa`.

- Login screen with users and roles (Administrateur, Saisie, Consultation); the administrator is created on first start.
- Exercices (fiscal years) in the top bar: choose, create, close (*clôture*) and reopen. Entries of a closed year are locked.
- État des comptes: solde initial, entrées, sorties and solde per account and per bénéficiaire.
- Historique: every change recorded with user and time, with open and restore.
- ▾ filters on every column of the journal (bénéficiaires show what they owe), amount and N° ranges.
- Built for 10,000+ entries per year: a full year opens in about 160 ms, and filtering is instant.
- Startup database check and automatic daily backups.

## 0.2.0 — Winalco-style treasury

Commit `f6b68ab110303e1b2df3ab3d25dc513297a8b956`.

- French interface (English available), DA currency.
- Dépenses / Versements / Virements / Crédits windows with a numbered grid and total.
- Chantiers: a deposit split across several accounts keeps the same chantier or gets one per line.
- Famille, État, cheques (number, ordre de, barré), cheque and voucher printing with the amount in words.

## 0.1.0 — First app

Commit `fafb4c7a8735e9afc85883ddfbd588560e068470`.

- Accounts, beneficiaries (who owes whom), deposits split across several accounts, transfers, credit purchases and sales.
- Smart labels that learn from your entries and fill in the form.
- Dashboard, reports, CSV export and backup.
