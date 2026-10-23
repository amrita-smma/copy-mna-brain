# CRM data pipeline

The Google Vault MBOX archive + parse pipeline and the CRM ingest pipeline (enrichment, employer/correspondent resolution, analytics marts) live in the `analytics` Postgres schema and are documented in [`data-pipeline/README.md`](../../data-pipeline/README.md).

The app (`public` schema) overlays per-workspace human curation on top of the shared rows via `employer_workspace_effective` and `correspondent_workspace_effective` (see `crm-per-workspace-editing.md`); the global `employer_effective` / `correspondent_effective` views are the shared rows only. Cross-schema dependency is one-directional: `analytics` reads `public` effective views; nothing in `public` depends on `analytics`.

## Editing a CRM contact (banker)

Each correspondent carries a banker profile — `title`, `type`, plus `department`, `specialization`, `seniority`, `coverage_region`, `linkedin_url` and `bio`. Every one of these exists twice: a machine column on `correspondents` and a per-workspace human-overlay column on `correspondent_curation`, COALESCEd by the `correspondent_workspace_effective` view.

Which one a write lands in depends on whether the contact already exists:

- **Editing** an existing contact (`src/views/crm/EditContactDialog.tsx` → `PATCH /api/crm/correspondents/:id` → `CRMService.updateContact`) only ever writes this workspace's `correspondent_curation` row, so a later ETL re-ingest can't overwrite the edit. `email` is the exception — it is the natural key for the `(employer_id, email)` upsert and stays machine-owned on the base table.
- **Creating** a contact (`AddContactDialog` → `POST /api/crm/employers/:id/contacts` → `CRMService.createContact`) writes the base row directly with `origin = 'manual'`, which the ETL never touches. There is no machine value to overlay yet. If the email collides with an existing correspondent the call degrades to an edit, and the profile fields go to the overlay instead.

`CorrespondentRepository.upsertBatch` (the ingest path) does not list any profile column in its `ON CONFLICT` set, so ingest can neither populate nor clobber them.

The route narrows the request body with `pickEditableContactFields` (`src/lib/services/crmService.ts`) before it reaches `CRMService.updateContact`, so a client can never set `employer_id`, `origin`, `source` or `is_primary` by naming them in the payload. A field sent as `null` (or a blank string, which the editor normalizes to `null`) clears the overlay, letting the machine value show through again.

## Contact and firm names

A contact name is **address-like** when it is empty after trimming, contains `@`, or equals the contact's email (case-insensitive) — `isAddressLikeName` in `src/lib/crm/contactName.ts`.

- **Within one ingest batch** (`collectCorrespondentCandidates` in `data-pipeline/src/handlers/emailProcessCrm.ts`) each address gets one row. Its name candidates are the LLM-extracted person name and, when the address is the sender, the `From` display name; the raw address is the last resort. Across sightings a real name beats an address-like one and the first real name is kept (`pickBetterContactName`); title and phone keep the first non-null value.
- **Across batches** `CorrespondentRepository.upsertBatch` never replaces a stored real name with an address-like incoming one. A real incoming name replaces an address-like stored name. `origin = 'manual'` rows are never rewritten, and `correspondent_curation` overlays are never written by ingest.
- **Repair**: pipeline migration `20261017000000_repair_correspondent_address_names` sets the name of every non-manual contact whose name is address-like to the most recent real `From` display name that address sent in `analytics.emails`.

A **new employer** (a domain with no `employer_domains` row) is named, in order: the curated `employer_overrides.employer_name` for the domain; the company the LLM extraction most often attributes to people at that domain in the batch (`LlmPerson.company`, ties to the first seen); the capitalised first domain label (`gs.com` → `Gs`). When that name normalizes to an existing employer, the domain links to the existing row and the employer is not renamed. Existing employers are never renamed by ingest. Excluded, internal and personal-provider domains never become employers.

## Re-extracting already-ingested mail

To run a date range through the current extraction again, invoke
`vault-archive-start` with a `rewind` payload. Steps and behaviour:
[Re-extracting a date range](../../data-pipeline/README.md#re-extracting-a-date-range).
