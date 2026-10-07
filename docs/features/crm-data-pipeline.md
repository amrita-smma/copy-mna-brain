# CRM data pipeline

The Google Vault MBOX archive + parse pipeline and the CRM ingest pipeline (enrichment, employer/correspondent resolution, analytics marts) live in the `analytics` Postgres schema and are documented in [`data-pipeline/README.md`](../../data-pipeline/README.md).

The app (`public` schema) overlays human curation on top of `analytics` mart data via `employer_effective` and `correspondent_effective` views. Cross-schema dependency is one-directional: `analytics` reads `public` effective views; nothing in `public` depends on `analytics`.

## Editing a CRM contact (banker)

Each correspondent carries a banker profile — `title`, `type`, plus `department`, `specialization`, `seniority`, `coverage_region`, `linkedin_url` and `bio`. Every one of these exists twice: a machine column on `correspondents` and a human-overlay column on `correspondent_curation`, COALESCEd by the `correspondent_effective` view.

Which one a write lands in depends on whether the contact already exists:

- **Editing** an existing contact (`src/views/crm/EditContactDialog.tsx` → `PATCH /api/crm/correspondents/:id` → `CRMService.updateContact`) only ever writes `correspondent_curation`, so a later ETL re-ingest can't overwrite the edit. `email` is the exception — it is the natural key for the `(employer_id, email)` upsert and stays machine-owned on the base table.
- **Creating** a contact (`AddContactDialog` → `POST /api/crm/employers/:id/contacts` → `CRMService.createContact`) writes the base row directly with `origin = 'manual'`, which the ETL never touches. There is no machine value to overlay yet. If the email collides with an existing correspondent the call degrades to an edit, and the profile fields go to the overlay instead.

`CorrespondentRepository.upsertBatch` (the ingest path) does not list any profile column in its `ON CONFLICT` set, so ingest can neither populate nor clobber them.

The route narrows the request body with `pickEditableContactFields` (`src/lib/services/crmService.ts`) before it reaches `CRMService.updateContact`, so a client can never set `employer_id`, `origin`, `source` or `is_primary` by naming them in the payload. A field sent as `null` (or a blank string, which the editor normalizes to `null`) clears the overlay, letting the machine value show through again.
