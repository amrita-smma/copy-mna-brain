## data-pipeline package

This package owns the `analytics` Postgres schema — pipeline facts, staging tables, and analytics marts.

### Migrations

Migrations live in `data-pipeline/migrations/` and are applied by `pnpm db:migrate` (runs app migrations first, then pipeline migrations). To rebuild the journal:

```bash
tsx scripts/build-drizzle-journal.ts data-pipeline/migrations
```

### Schema split

- `public` schema — app system-of-record: `employers`, `correspondents`, `users`, `jobs`, overlays (`employer_domains`, `employer_overrides`, `employer_curation`, `correspondent_curation`), effective views, control plane.
- `analytics` schema — pipeline-owned: `mbox_files`, `raw_emails`, `raw_email_enrichments`, `llm_batches`, `domain_classifications`, `emails`, `email_participants`, `email_topics`. Marts: `mart_crm`, `mart_mom`, `mart_topics`.

Cross-schema dependency is one-directional: `analytics` dim views read `public` effective views; nothing in `public` depends on `analytics`.

### Compute (current state)

Handlers live in `data-pipeline/src/handlers/` and the MBOX parser in `data-pipeline/src/mboxParser/`. Lambda entrypoints live in `data-pipeline/src/lambda/`. The Vercel cron routes in `src/app/api/crm/` still call the same handlers via the `data-pipeline` workspace package — they will be removed in the cutover PR.
