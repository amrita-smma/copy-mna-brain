# Smart Files

Uploaded files are processed by the File Processing Agent (`src/lib/agents/file_processing`), which classifies each document (prospectus, shopping_list, mom, banker_communications, financial_statement, bond_issuance, legal_document, market_study, fund_updates, other) and extracts structured data.

## Categories

`src/lib/smartFilesTabs.ts` is the single source of truth for the Smart Files
categories. Everything downstream derives from it: the `/smart-files/<tab>`
deep-link slugs, the tab bar and its labels, the upload-time classification
dropdown (`SMART_FILES_UPLOAD_CATEGORIES` — every category except
`banker_communications`, which is driven by the CSV/MBOX shape of an email
export rather than picked by a reviewer), the HITL review dialog's
reclassification select, and `FileRepository`'s bucketing
(`DEDICATED_FILE_TYPES`; `other` is the inverse of that set plus NULL
`file_type`). Adding a category means adding it there and to
`FileTypeOverride` + the classifier prompt in
`src/lib/agents/file_processing/index.ts`.

The tab bar **hides categories with zero files** so a workspace isn't cluttered
with buckets it never uses. The active tab and any tab whose count hasn't
loaded yet are always shown, so deep links still render and the bar doesn't
flash on first paint.

## File detail page (deeplink)

Every file has its own page at `/w/<slug>/files/<id>`. It renders exactly what
a row's "View details" dialog shows — preview (with Present / Download) and the
AI structured notes — because both shells render the same
`FileDetailActions` / `FileDetailBody` from `src/components/Files/FileDetail.tsx`.
Change the detail surface there, never in only one shell. The dialog's header
has **Open page** and both have **Copy link**; the page also has a back link to the file's Smart Files tab. The page loads the file via
`FileService.getDetail` (one row + a signed preview URL); an unknown or
other-workspace id renders 404.

## Multi-company auto-ingestion

Deal-target file types — **prospectus** and **shopping_list** — can describe multiple companies. The agent emits a `companies` array (one entry per target, each with identity fields, financials, and FX adjustments; `prospectus_summary` mirrors `companies[0]` for backward compatibility) and `FileService.processUpload` auto-ingests every extracted target directly on upload:

- **HITL review only for pipeline companies** — a target that fuzzy-matches an existing company actively in the L0–L5 pipeline is never auto-modified; the file is set to `awaiting_review` and the user approves the proposed changes through the review dialog (per-field/per-year selection via `FileService.approve`). Everything else is auto-accepted and the file completes immediately.
- **Pre-pipeline matches are auto-enriched** — a target matching an existing company outside the pipeline (`unreviewed`, `market_screening`, `discovered`) is enriched in place with the same defaults the review dialog pre-checks: empty fields are filled and missing fiscal years are added; existing values and years are never overwritten (`auto_enriched_from_file` company log).
- **New targets are auto-created** — they enter the pipeline at the `unreviewed` stage with `entered_by` stamped from the email custodian (MBOX pipeline) or the uploading session user. Duplicates are never re-created; creation runs under a per-name advisory lock so concurrent uploads can't double-insert.
- Analysis + screening jobs are dispatched for each created or auto-enriched company.
- **Note-driven inclusion** — the per-file upload notes can instruct the agent which companies to include or exclude (e.g. "only include Acme and Beta"); excluded companies are omitted from extraction entirely.

Other file types (financial statements, bond issuances, legal documents, MoMs, buyer/sponsor/advisor material) never **auto**-create companies — they describe counterparties or process, not companies on sale (MB-300).

## Creating a company from any file

That auto-ingest guard is about what the classifier does unattended, not a rule
that only deal-target documents can ever mint a company. The matched-company
chip on every Smart Files row carries a **Create new company** action
(`POST /api/smart-files/[id]/create-company` → `FileService.createCompanyFromFile`)
that works for *any* file type:

- The name is whatever the user typed in the chip's search box; with nothing
  typed, the service falls back to the best candidate on the file — an
  extracted deal target, then a financial statement's issuer, then an
  AI-detected name chip that isn't already a pipeline company. Generic document
  headings ("Executive Summary") are rejected, and a file with no usable name
  returns 422 asking the user to type one rather than guessing from the
  filename.
- The company is seeded from the extracted entry that matches that name
  (including its full financial/FX ledger, not just the FY2021–FY2025 the flat
  DTO carries), stamped with the file's `file_type` as `doc_type`, and created
  at the `unreviewed` stage — one click can't satisfy the workspace pipeline required-field set,
  and triage is where a company sourced from a non-target document belongs.
- It **always creates a new company**, even when one with the same or a
  similar name exists — many distinct companies share near-identical names, and
  a reviewer who wants an existing one picks it from the search list instead.
  (Only unattended auto-ingest dedupes by name.) Creation dispatches analysis +
  screening jobs like a HITL approval does.

## Email-ingest notifications

Every **PDF** the MBOX pipeline crawls out of a mailbox and lands in Smart Files
sends an `email_pdf_ingested` email to that mailbox's custodian — the person
whose email was scanned — over the existing `send-email` Vercel Queues topic.
The message names the file, the workspace it was added to, and the metadata
resolved during processing: document type, size, document date, matched
companies, classifier tags, and whether the file needs review. The pipeline also
forwards the source email's `From`, `Subject` and received time (`email_context`
on the `/api/smart-files` POST body) so the custodian can tell at a glance which
message the attachment came from; that context is used only to render the email
and is deliberately never persisted on the `files` row.

Notification rules:

- **Never for mail we sent.** An email whose `From` is on one of our own domains
  (`INTERNAL_MAIL_DOMAINS`) is still ingested into the CRM, but its attachments
  never go to Smart Files, so nothing lands and nothing notifies — whoever else
  is on To/Cc/Bcc.
- **Email-origin PDFs only.** Manual Smart Files uploads never notify (the
  uploader added the file themselves), and non-PDF attachments are out of scope.
- **Skipped for files that never landed** — duplicates, files auto-dropped as
  `other`, and failed processing all return before the notification.
- **One email per ingested PDF.** When a mailbox is watched by several
  workspaces, the primary workspace is named as the destination and the rest are
  listed under "Also added to" rather than sending one email per workspace.
- **Best-effort** — a queue failure is logged and never fails the upload.

## Fund updates extraction (async jobs)

Smart Files fund reporting workbooks and updates (`fund_updates`) are extracted via deterministic parsers (e.g. STARTECH master sheets) or dispatched as background jobs (`jobs.type = fund_update_extraction`). Async jobs return HTTP 202 and the client polls until extraction reaches `awaiting_review` or `failed`. Both upload (`/api/smart-files`) and reprocess (`/api/smart-files/[id]/reprocess`) routes configure `export const maxDuration = 600` to match the 10-minute extraction job timeout.
