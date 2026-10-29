# CRM (Contact Relationship Management)

The CRM module manages contacts and their communication history.

## Database Tables

- **contacts** — Stores contact information (name, email, phone, company, title, type)
- **contact_messages** — Stores communication history linked to contacts

## Features

- Contact management (create, update, delete, search)
- Communication history per contact
- Integration with Smart Files for banker communications

## Banker Communications

Smart Files supports a "banker_communications" file type for CSV and MBOX exports (e.g., from Google Vault). When uploaded:

1. The File Processing Agent detects email communications
2. Contacts are automatically created or matched by email
3. Messages are linked to contacts in the CRM

## API Endpoints

The CRM page lists **employers** (firms); a firm's **contacts**
(correspondents) load when its card is expanded. Everything is searched,
filtered, sorted and paged on the server — the page only ever holds one page
of rows.

- `GET /api/crm` — one page of firms: `{ data, total }`. Params: `q`,
  `lastContact`/`customDate`/`clientTodayIso`, `topicId`*, `teamUserId`*,
  `sort`/`dir`, `limit` (≤ 200, default 50), `offset`. With `q`, each row
  carries `matched_contacts` (people whose name/email matched). Runs on every
  debounced keystroke, so it does **not** compute the insights bar.
- `GET /api/crm/insights` — the insights bar (stale firms, flagged records,
  emails today, vault sync). Loaded once on open and after mutations.
- `GET /api/crm/employers/:id` — card detail: primary contact,
  `contact_count`, notes, topics, team, related companies. No contact rows.
- `GET /api/crm/employers/:id/contacts` — one page of the firm's contacts:
  `{ data, total, inferred_focus }`. Params: `q` (name / email — the same
  match as `matched_contacts`), `limit` (≤ 100, default 25), `offset`.
  `is_primary` marks the firm-wide primary, whatever the page. While a list
  search is active the card passes `q` to show only the matches; "Show all"
  drops it.
- `GET /api/crm/employers/:id/contact-enrichment?contactId=…` — latest
  @crm_contact run for the contact ids on the current page (1–200 required).

## Search performance

- Firm search matches the firm name, this workspace's curated name, a domain,
  or a person this workspace can see by overlay-aware name or email, via an
  uncorrelated `id IN (… UNION …)`. Each branch is served by a trigram GIN
  index (`20261029000001_crm_search_trigram_indexes.sql`); the person branch
  finds candidates through the indexed base columns, then re-checks
  `correspondent_workspace_effective` so matches equal what the card shows.
- Workspace visibility is the same shape: one `UNION` of the four
  workspace-scoped relationships, not per-row `EXISTS` probes.
- KPIs and the curated name/industry come from `LEFT JOIN`s on
  `analytics.mart_crm` and `employer_curation`, each on its unique
  `(workspace_id, employer_id)` key; sorting uses the same joined columns.
- The UI debounces search (250 ms), resets to page 1 on a new term, and aborts
  superseded requests so a slow earlier response never overwrites a newer one.
