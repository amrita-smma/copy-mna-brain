# CRM contacts: email-keyed merge and CSV/Excel import

Manually-added contacts and contacts discovered in synced email live in the
same `correspondents` table (`origin = 'manual'` vs `'auto'`). **Email is the
join key between them**, so one person shows up as one contact regardless of
which path saw them first.

## Matching rule

- Emails are compared **case-insensitively** and **across employers**
  (`CorrespondentRepository.findByEmails`, backed by
  `idx_correspondent_email_lower`). The employer is not part of the key because
  the two paths can disagree on it: a human picks a firm, while ingest derives
  one from the email domain.
- When several rows share an email, the canonical one is: a row under the
  employer the caller is working in, else the `origin='manual'` row, else the
  oldest.
- New contacts store their email lowercased.

## Where it applies

| Path | Behaviour on an email match |
|---|---|
| Add Contact (`CRMService.createContact`) | Fields go to the curation overlay of the existing contact; the workspace gains a `manual` membership. The UI toasts "merged" when the match sits under another firm. |
| CSV import (`POST /api/crm/contacts/import` → `CRMService.importContacts`) | Same, in batch. Blank cells never clear an existing value (`CorrespondentCurationRepository.fillMany`). |
| Mailbox ingest (`data-pipeline/src/handlers/emailProcessCrm.ts`) | An address already owned by a contact under a *different* employer links to that contact instead of creating one under the domain employer. Same-employer rows go through `upsertBatch`, which never rewrites an `origin='manual'` row's profile. |
| Vault / file-extracted emails (`CRMService.ingestEmails`) | Reuses the existing contact by email. |

## CSV / Excel import

Open **CRM → Import** (first button in the toolbar, next to Add Contact) and
drop a `.csv` or `.xlsx` file onto the drop zone, or browse for one. The file
needs a header row; headers are matched loosely (`fieldForHeader` in
`src/lib/crm/contactImport.ts`). Spreadsheets are read in the browser by
`contactImportExcel.ts`: the first non-empty sheet is used, starting at its
first non-empty row. `exceljs` is loaded only when a spreadsheet is dropped.

- Name, or First name + Last name (required)
- Company / Firm / Account, Email, Phone / Mobile, Title / Designation, Type,
  Department / Division, Specialization / Sector coverage, Seniority, Region /
  Territory, LinkedIn (a hyperlinked cell yields its URL), Bio / Notes
- **Any other column is kept**: its values are appended to Bio as
  `Header: value` lines. The dialog lists these columns before you import.

Rows with an email that matches are **merged**. Rows that don't match are
**created** as `origin='manual'` contacts under their Company. When Company is
blank, the email domain is used. Rows with neither are skipped. Repeated emails
within the file collapse into one contact, and later rows fill in blanks. Rows
without an email can't be matched, so re-importing them creates duplicates.

There is **no file-size row limit**. The browser collapses repeats across the
whole file, then posts it in batches of 500 (`IMPORT_BATCH_SIZE`) with a
progress bar. The route rejects a single request above 1,000 rows
(`MAX_IMPORT_BATCH`), and each batch runs a fixed number of database queries.
If a batch fails, the dialog reports how many contacts were already imported.
Re-running the import is safe for rows with an email, because they merge.
