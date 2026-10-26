# CRM data pipeline

The Google Vault MBOX archive + parse pipeline and the CRM ingest pipeline (enrichment, employer/correspondent resolution, analytics marts) live in the `analytics` Postgres schema and are documented in [`data-pipeline/README.md`](../../data-pipeline/README.md).

The app (`public` schema) overlays per-workspace human curation on top of the shared rows via `employer_workspace_effective` and `correspondent_workspace_effective` (see `crm-per-workspace-editing.md`); the global `employer_effective` / `correspondent_effective` views are the shared rows only. Cross-schema dependency is one-directional: `analytics` reads `public` effective views; nothing in `public` depends on `analytics`.

## Editing a CRM contact (banker)

Each correspondent carries a banker profile — `title`, `type`, plus `department`, `specialization`, `seniority`, `coverage_region`, `linkedin_url` and `bio`. Every one of these exists twice: a machine column on `correspondents` and a per-workspace human-overlay column on `correspondent_curation`, COALESCEd by the `correspondent_workspace_effective` view.

Which one a write lands in depends on whether the contact already exists:

- **Editing** an existing contact (`src/views/crm/EditContactDialog.tsx` → `PATCH /api/crm/correspondents/:id` → `CRMService.updateContact`) only ever writes this workspace's `correspondent_curation` row, so a later ETL re-ingest can't overwrite the edit. `email` is the exception — it is the natural key for the `(employer_id, email)` upsert and stays machine-owned on the base table.
- **Creating** a contact (`AddContactDialog` → `POST /api/crm/employers/:id/contacts` → `CRMService.createContact`) writes the base row directly with `origin = 'manual'`, which the ETL never touches. There is no machine value to overlay yet. If the email collides with an existing correspondent the call degrades to an edit, and the profile fields go to the overlay instead.

Ingest writes only the base row, and only the fields an email signature can state: `title`, `phone`, `specialization` (Industry Focus) and `coverage_region` (Area Focus). The extraction LLM reads them from the candidate's signature/context — a focus only when the title states it ("MD, Industrials Group" → `Industrials`; "Head of M&A, Southeast Asia" → `Southeast Asia`), never from an office address or the email's subject matter. `CorrespondentRepository.upsertBatch` fills each with `COALESCE(incoming, stored)`, so a later email can update it but a silent one never blanks it, and an `origin = 'manual'` row is never touched. The other profile columns (`department`, `seniority`, `linkedin_url`, `bio`) are not in its `ON CONFLICT` set. Curation overlays always win on read, so ingest cannot clobber a human or Get Full Profile edit; a focus filled by ingest does count as present, so Get Full Profile replaces it only when it names the field in `overwrite`.

The route narrows the request body with `pickEditableContactFields` (`src/lib/services/crmService.ts`) before it reaches `CRMService.updateContact`, so a client can never set `employer_id`, `origin`, `source` or `is_primary` by naming them in the payload. A field sent as `null` (or a blank string, which the editor normalizes to `null`) clears the overlay, letting the machine value show through again.

## Contact and firm names

A contact name is **address-like** when it is empty after trimming, contains `@`, or equals the contact's email (case-insensitive) — `isAddressLikeName` in `src/lib/crm/contactName.ts`.

- **Within one ingest batch** (`collectCorrespondentCandidates` in `data-pipeline/src/handlers/emailProcessCrm.ts`) each address gets one row. Its name candidates are the LLM-extracted person name and, when the address is the sender, the `From` display name; the raw address is the last resort. Across sightings a real name beats an address-like one and the first real name is kept (`pickBetterContactName`); title, phone, specialization and coverage_region keep the first non-null value.
- **Across batches** `CorrespondentRepository.upsertBatch` never replaces a stored real name with an address-like incoming one. A real incoming name replaces an address-like stored name. `origin = 'manual'` rows are never rewritten, and `correspondent_curation` overlays are never written by ingest.
- **Names from the address**: after the upsert, a contact whose stored name is still address-like gets a name spelled out of a person-shaped address. For example, `matthieu.simoncini@` becomes "Matthieu Simoncini". This uses `nameFromEmailLocalPart`, and `CorrespondentRepository.fillAddressLikeNames` writes it in one statement. Shared mailboxes (`proposal@`, `deal.team@`) and manual rows are skipped. Because the name is only written over an address, a real name seen later replaces it through the rule above. App migration `20261026000001_derive_contact_names_from_email` applied the same rule once to existing rows.
- **Repair**: pipeline migration `20261017000000_repair_correspondent_address_names` sets the name of every non-manual contact whose name is address-like to the most recent real `From` display name that address sent in `analytics.emails`.

A **new employer** (a domain with no `employer_domains` row) is named, in order: the curated `employer_overrides.employer_name` for the domain; the company the LLM extraction most often attributes to people at that domain in the batch (`LlmPerson.company`, ties to the first seen); the capitalised first domain label (`gs.com` → `Gs`). When that name normalizes to an existing employer, the domain links to the existing row and the employer is not renamed. Existing employers are never renamed by ingest. Excluded, internal and personal-provider domains never become employers.

## Firm industry

A firm's Industry column is `COALESCE(employer_curation.industry, employers.industry)`. A workspace's own edit always wins. The machine value is filled two ways:

- **At creation**: a new employer gets the curated `employer_overrides.industry` of the first of its domains that has one (`upsertEphemeralCrmBatch`).
- **Hourly classifier**: `/api/cron/crm-firm-industry` runs `FirmIndustryService.classifyUnlabelledFirms` in every workspace. That claims up to `FIRM_INDUSTRY_PER_SWEEP` firms, newest first, that have a contact visible in the workspace, no machine industry, no workspace-typed industry, and no attempt in the last `FIRM_INDUSTRY_RETRY_DAYS`. Claiming stamps `employers.industry_classified_at` (`FOR UPDATE SKIP LOCKED`), so overlapping sweeps and other workspaces skip the firm. One `firm_industry_classification` job then labels them with Haiku, 20 firms per call (`src/lib/jobs/handlers/firmIndustryClassification.ts`).

The model sees the firm's machine name and its `employer_domains`. It also sees up to six of the contacts visible in the sweeping workspace, with title / `specialization` / `bio` read from `correspondent_workspace_effective`, so a Get Full Profile bio counts. It also uses what it knows about well-known firms and domains. It never sees email notes: they are private to the people on the email, and the label is shared across workspaces. It must pick from the closed `FIRM_INDUSTRIES` list (`src/lib/crm/firmIndustry.ts`) or return null. The list is closed because the column sorts and filters on the lower-cased value. `EmployerRepository.fillIndustries` writes only where `employers.industry` is still NULL. A firm the model answers null for keeps its claim stamp and is retried after the window. When a model call fails, its firms' claims are released (`releaseIndustryClaims`), so the next sweep retries them.

## Re-extracting already-ingested mail

To run a date range through the current extraction again, invoke
`vault-archive-start` with a `rewind` payload. Steps and behaviour:
[Re-extracting a date range](../../data-pipeline/README.md#re-extracting-a-date-range).
