# data-pipeline

Pipeline operational notes for the CRM ingest pipeline (Google Vault → `analytics` schema).

Migrations live in `data-pipeline/migrations/` and target the `analytics` Postgres schema.
Compute (`handlers/`, `mboxParser/`) currently runs on Vercel; an AWS migration is a deferred follow-up PR.

---

## Google Vault MBOX pipeline

Two decoupled stages backed by their own job types:

1. **Archive** — `vault_archive` job downloads Vault MBOX files, gzips them,
   uploads to MinIO/S3 `mbox-archive` bucket, and records rows in `analytics.mbox_files`.
2. **Parse** — `vault_parse` job drains `analytics.mbox_files WHERE parse_status='pending'`,
   streams each MBOX from S3, parses MIME, and inserts into `analytics.raw_emails` with
   `Message-ID`-based dedup. CRM ingestion (employer/correspondent matching) is
   a separate downstream step that reads from `analytics.raw_emails`.

### Archive endpoints

1. `POST /api/crm/vault-archive` body `{ year, month }` — archives one calendar
   month (UTC-bounded, end-exclusive). Idempotent: refuses if a `completed`,
   `pending`, or `running` `vault_archive` job already exists for the same
   `(year, month, mode: 'monthly')`. Allows retry of `failed` jobs.
2. `POST /api/crm/vault-archive/walk` body `{ count?: 1..3 }` — picks the oldest
   `count` months between `VAULT_BACKFILL_FLOOR` and the previous calendar
   month that don't have a satisfactory job, and dispatches them. Returns 204
   if nothing is pending. Intended for cron-driven backfill.

### Parse endpoint

`POST /api/crm/vault-parse` body `{ fileIds?, limit?, force? }`:

- No body, or `{ limit: 50 }` — drain up to 50 pending `mbox_files` rows.
- `{ fileIds: [...] }` — parse those specific files (up to 100 IDs per call).
- `{ force: true }` — bypass the `parse_status='pending'` claim guard. Useful
  for explicit re-parse after a parser fix.

The handler walks files sequentially: claim via `markParsing` (conditional
UPDATE — `null` return means another worker beat us, skip), size guard (250MB
compressed cap, larger files marked `failed`), download from S3, gunzip,
`parseMboxContent`, synthesize `sha256:<hex>` Message-IDs for messages with no
header, batch-insert into `analytics.raw_emails` (chunks of 1000) with
`ON CONFLICT (message_id) DO NOTHING`, then `markParsed` (or `markFailed` on
exception — one bad file never aborts the whole job).

### Tables

- **analytics.mbox_files** — one row per MBOX file in S3. `parse_status` ∈
  {`pending`, `parsing`, `parsed`, `failed`}; `raw_email_count` filled on success.
- **analytics.raw_emails** — neutral parsed-message storage. Columns: `file_id` (FK),
  `custodian_email` (denormalized), `message_id` (partial unique WHERE NOT NULL),
  `from_address`, `from_display_name`, `to_addresses` (jsonb array),
  `cc_addresses`, `subject`, `body_text`, `sent_at`, `has_attachments`,
  `in_reply_to`, `references`, `gmail_thread_id` (Gmail's `X-Gm-Thrid`),
  `raw_headers` (jsonb for debugging).

### Env vars

- `GOOGLE_VAULT_SERVICE_ACCOUNT` — base64-encoded service account JSON (archive only).
- `GOOGLE_VAULT_IMPERSONATE` — Workspace user to impersonate (default `crm.vault@starcapital.co.id`).
- `VAULT_BACKFILL_FLOOR` — earliest month `/walk` will attempt. Format `YYYY-MM`.
  Default `2026-01`.
- `AWS_S3_MBOX_BUCKET` — bucket for MBOX archives (default `mbox-archive`).
  Created automatically by `minio-init` in `docker-compose.yml`.

### Operational notes

- A `vault_parse` job that dies mid-file leaves the `mbox_files` row stuck in
  `parse_status='parsing'`. The `jobs`-table sweeper does not touch this — it
  only marks the parent job `timed_out`. Recovery is either:
  - `POST /api/crm/vault-parse { fileIds: [...], force: true }` — bypasses the
    claim guard.
  - `UPDATE analytics.mbox_files SET parse_status='pending' WHERE parse_status='parsing' AND updated_at < now() - interval '1 hour'` — reset the row, next normal POST will pick it up.
- `synthesizeMessageId` hashes `from|date|subject|body[:512]`. Two templated
  notification emails with identical first 512 chars of body will collide and
  dedupe to one row. Acceptable trade-off for `noreply@` traffic.

### Deferred to follow-up PRs

- **Live mode**: a separate sliding-window archive job for the current month,
  fired by a 6-hour Vercel cron. On month rollover, `/walk` picks up the
  just-closed month with a canonical monthly archive.
- **Streaming gunzip** for MBOX files > 250MB compressed.
- **Multi-worker parse parallelism** via `pg_try_advisory_xact_lock`. Single
  worker today; the conditional UPDATE in `markParsing` is enough.
- **Stuck-`parsing` sweeper**: an automated version of the recovery above
  triggered on the existing 24h cleanup window.
- The existing `/api/crm/vault-export` endpoint and `vault_export` job type
  stay in place until live mode lands.

---

## CRM ingest pipeline (raw_emails → employers / correspondents / emails / topics)

Reads `analytics.raw_emails` (vault-parse output), enriches via Anthropic, and populates the CRM
tables (`public.employers`, `public.correspondents`, `analytics.emails`, `analytics.email_participants`,
`public.topics`, `analytics.email_topics`). Uses `src/lib/services/mboxParser/` via scheduled jobs.

### Four jobs, one job-driven stage per concern

| Job | Drains | Cron | Purpose |
|---|---|---|---|
| `crm_llm_submit` | `raw_emails.llm_status='pending'` | `:30 hourly` | Runs `shouldSkip()` to filter out newsletters / auto-replies / calendar invites / personal-or-1-1 catch-ups (marks `ingest_status='filtered'`, `llm_status='not_needed'`). For the rest: runs `processEmail()` to extract candidates; for rows that need LLM, builds an Anthropic batch and inserts an `llm_batches` row. Rows the LLM later flags `is_personal` are dropped to `ingest_status='filtered'` too (never ingested as evidence). |
| `crm_llm_fetch` | `llm_batches.status='in_progress'` | every 5 min | Polls each in-flight batch; when ended, streams results and writes topics + people to `raw_email_enrichments`. Rows the LLM flagged `is_personal` are marked `ingest_status='filtered'` instead of enriched. |
| `crm_domain_classify` | unknown sender domains | `:45 hourly` | One Haiku call per ~30 domains for industry classification; writes `domain_classifications`. |
| `crm_ingest` | `raw_emails.ingest_status='pending' AND llm_status IN ('enriched','not_needed')` | `:50 hourly` | Single transaction populating all CRM tables from enriched `raw_emails`. |

### Tables

- **`analytics.raw_emails`** — new state columns `llm_status` (pending → in_batch → enriched | not_needed | failed), `ingest_status` (pending → ingested | failed), `llm_enriched_at`, `ingested_at`.
- **`analytics.raw_email_enrichments`** — extract output (`candidates`, `domain_tag`, `needs_llm`, `body_snippet`) plus LLM output (`topics`, `people`).
- **`analytics.llm_batches`** — Anthropic Messages-Batches tracker: `anthropic_batch_id`, `status`, `custom_id_map`, model, submit/fetch job refs.
- **`analytics.domain_classifications`** — `{ domain → { name, industry, confidence, source } }`. Replaces `scripts/domains_enriched.json`.
- **`analytics.emails`** — gains `in_reply_to` (RFC In-Reply-To header, copied from `raw_emails` at ingest). Powers the per-firm response-time metric (see below).

### Per-firm response time (p50)

The CRM "Banker Relationships" list shows each firm's **median response time** — how long, typically, between an inbound email from the firm and our next outbound reply. Computed via `mart_crm` (see `data-pipeline/migrations/20260606010002_analytics_marts.sql`):

- Pairs a reply to its parent via `reply.in_reply_to = parent.message_id`. The parent is the inbound email, whose `employer_id` **is** the firm, so the gap attributes to the firm with no recipient lookup. (Note `emails.employer_id` follows the *sender*, so outbound replies are attributed to our own org — pairing on the parent sidesteps that.)
- Keeps inbound-parent → outbound-reply pairs only; caps gaps at 30 days so one stale thread can't skew the median.
- The UI (`EmployerCard`) renders `formatResponseP50(seconds)` plus the pair count (e.g. "3 days · 8 pairs"), and shows "—" when there are no answered exchanges. The pair count is surfaced so low-sample medians read as low-confidence.

Values populate as `raw_emails` flow through `crm_ingest`; rows ingested before this column existed show no value until re-ingested.

### Endpoints

All four take POST or GET (cron-friendly), validated against `CRON_SECRET` when set:

- `POST /api/crm/crm-llm-submit { rawEmailIds?, limit?, mode?, model? }` — `mode='batch'` (default) or `'sync'`.
- `POST /api/crm/crm-llm-fetch` — no body.
- `POST /api/crm/crm-domain-classify { limit?, chunkSize?, force?, model? }`.
- `POST /api/crm/crm-ingest { rawEmailIds?, limit? }`.

### Reused config

- **`public.employer_overrides` table** — curated domain → employer name, `internal`, `excluded`, and optional `industry`. Editable in-app; always wins over LLM-classified industry. Seeded from the former `scripts/domains.json` at MB-205 cutover.

### Env vars

- `ANTHROPIC_API_KEY` — required by `crm_llm_submit`, `crm_llm_fetch`, `crm_domain_classify`.
- `CRON_SECRET` — when set, all cron-driven routes (PR #1 `/vault-archive/walk`, PR #2 `/vault-parse`, all four CRM endpoints) require `Authorization: Bearer $CRON_SECRET`. Vercel Cron sends this header automatically; manual `curl` needs `-H 'Authorization: Bearer …'`.

### Operational notes

- **Filtering** — auto-replies / newsletters / calendar invites / personal-or-1-1
  catch-ups are dropped at `crm_llm_submit` time via `shouldSkip` from
  `src/lib/services/mboxParser/filter.ts`. Filtered rows get
  `ingest_status='filtered'` and `llm_status='not_needed'` and never reach the CRM
  tables. Watch for `[crm-llm-submit] filter <id>: <reason>` log lines. The
  `personal` heuristic is conservative (subject-only, and never fires when deal
  language is present); content-level personal emails that slip past it are caught
  by the LLM's `is_personal` flag during enrichment and dropped to
  `ingest_status='filtered'` so they're never ingested as evidence.
- **Stuck `in_batch` rows** — if `crm_llm_fetch` dies mid-stream, raw_emails stay `llm_status='in_batch'`. Recovery: `UPDATE analytics.raw_emails SET llm_status='pending' WHERE llm_status='in_batch' AND ...` and the next submit picks them up again. Anthropic batches persist for 29 days, so the `llm_batches` row itself can also be marked failed and the rows re-queued.
- **Cost** — `crm_llm_submit` in batch mode (~$1.50/1K emails); `crm_domain_classify` is essentially free (~$0.01/run); `crm_llm_fetch` and `crm_ingest` are free.
- **Sync mode** — `crm_llm_submit { mode: 'sync' }` skips the batch path and writes enrichment directly. Useful for spot-checks and dev. ~2x cost; one `messages.create` per row.

### Deferred from PR #3

- **CRM UI** for the new state columns (`llm_status`, `ingest_status` exposed read-only on raw_emails — no UI surface yet).
- **Re-ingest tooling** beyond `force: true` payload overrides.
- **Backfill of pre-PR-#2 emails** — only ingests `raw_emails` produced by `vault_parse`.
