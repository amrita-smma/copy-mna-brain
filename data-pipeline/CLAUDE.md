## data-pipeline package

This package owns the `analytics` Postgres schema — ephemeral process cursors,
CRM facts, and analytics marts.

### Migrations

Migrations live in `data-pipeline/migrations/` and are applied by `pnpm db:migrate` (runs app migrations first, then pipeline migrations). To rebuild the journal:

```bash
tsx scripts/build-drizzle-journal.ts data-pipeline/migrations
```

### Schema split

- `public` schema — app system-of-record: `employers`, `correspondents`, `users`, `jobs`, overlays (`employer_domains`, `employer_overrides`, `employer_curation`, `correspondent_curation`), effective views, control plane.
- `analytics` schema — pipeline-owned: `vault_exports`,
  `email_process_runs`, `emails`, `email_participants`, `email_topics`,
  `email_notes`, and `email_role_signals`.
  Marts: `mart_crm`, `mart_mom`, `mart_topics`, `mart_contact_interactions`
  (per contact × team member), `mart_contact_email_totals` (per contact; see
  `docs/features/crm-banker-insights.md`).

Cross-schema dependency is one-directional: `analytics` dim views read `public` effective views; nothing in `public` depends on `analytics`.

### Compute (current state)

The only email Lambda entrypoints are `vaultArchiveStart` and
`vaultArchivePoll`. Poll streams one Vault MBOX entry through `/tmp` into
`processMboxSource`; there is no durable MBOX staging path.
