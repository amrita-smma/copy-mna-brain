# Ephemeral email pipeline

The email pipeline uses two scheduled Lambda functions:

1. `vault-archive-start` creates daily Google Vault exports for synced
   custodians and records them in `analytics.vault_exports`.
2. `vault-archive-poll` polls those exports, streams each ZIP, spools one MBOX
   entry at a time to Lambda `/tmp`, and calls `processMboxSource`.

`processMboxSource` performs privacy filtering, bounded synchronous LLM
extraction, CRM upserts, and approved attachment delivery to Smart Files in one pass.
It stores only CRM facts and a resumable cursor in
`analytics.email_process_runs`.

## Workspace attribution

`analytics.email_workspace` maps each ingested email to a workspace through its
custodian: `emails.custodian_email` → `users` → `user_workspaces`. It joins on
**every** membership, not only `is_email_synced = true` ones, so the marts built
on it (`mart_crm`, `mart_mom`, `mart_topics`) keep reporting email volume, last
contact, response p50, and topic mentions after a member's mailbox sync is
turned off. `is_email_synced` decides only which mailboxes
`vault-archive-start` collects from — it never hides data that was already
collected. Same rule on the app side: the CRM reads in
`src/lib/repositories/{correspondent,employer,employerRelatedCompany,email}Repository.ts`
scope on workspace membership alone (migration
`20260928000000_email_workspace_drop_sync_gate`).

## Retention boundary

- MBOX data is never written to S3.
- Temporary MBOX files are removed from Lambda `/tmp` after each entry.
- Email body text and evidence snippets are not persisted.
- Approved deal attachments may be sent to Smart Files through its presigned upload
  API. Sensitive or unsupported attachments are dropped before upload.

The former durable pipeline and its tables (`mbox_files`, `raw_emails`,
`raw_email_enrichments`, `llm_batches`, `domain_classifications`, and
`email_attachments`) have been removed.

## Local commands

```bash
pnpm --filter data-pipeline process-mbox \
  --file fixtures/ephemeral-email-demo.mbox \
  --custodian analyst@example.com

pnpm --filter data-pipeline invoke vaultArchiveStart '{"count":1}'
pnpm --filter data-pipeline invoke vaultArchivePoll '{}'

pnpm --filter data-pipeline test
pnpm --filter data-pipeline build
```

The local MBOX command uses the same processor as the poll Lambda and requires
database, Anthropic, and Smart Files configuration.

## Runtime configuration

Secrets are loaded from `/mna/<environment>/pipeline` in SSM. The pipeline
requires database connection values, Google Vault service-account credentials,
an Anthropic API key, and Smart Files API credentials. Lambda has no S3 permissions.

`vault-archive-poll` uses expanded ephemeral storage because Vault entries are
temporarily spooled to `/tmp`. A source resumes by its stable
`export_id + ZIP object + entry path` key and is abandoned after its fail budget
is exhausted.

## RSS news lake

Two further scheduled functions, independent of the email pipeline above:

1. `rss-poll` (`rate(30 minutes)`) conditional-GETs every `status = 'active'`
   row in `rss.feeds`, normalizes entries, inserts genuinely-new ones into
   `rss.items`, archives them as NDJSON to `s3://mna-<env>-rss-lake/bronze/`,
   and updates per-feed health — a feed retires to `dead` after 10 consecutive
   failures (`MAX_CONSECUTIVE_FAILURES` in `src/repositories/rssRepository.ts`).
2. `rss-enrich` (`rate(10 minutes)`) drains three queues, run sequentially so a
   thrown error in an earlier stage aborts the invocation (self-healing: the
   next run 10 minutes later resumes where it left off): Haiku relevance
   classification (how many pending items are pulled in per run is capped by
   `RSS_CLASSIFY_LIMIT` — 200 in production, 3 in staging, so the costly
   Haiku/Bedrock stages don't run at production volume on a 10-minute
   schedule; how many of those get *selected* is separately capped by
   `RSS_DAILY_CAP_PER_CATEGORY`, default 25, per category per UTC day),
   full-article extraction for selected items (3 attempts,
   `MAX_CONTENT_ATTEMPTS`), and Bedrock Titan embeddings into
   `rss.item_chunks`.

Unlike the email path, these functions do use S3 — a separate bucket
(`terraform/s3-rss`), with an IAM policy scoped to its `bronze/*` prefix. The
email functions above still make no S3 calls.

Bedrock is not offered in `ap-southeast-3`, where these Lambdas run, so
embedding calls go cross-region via `BEDROCK_REGION` (default
`ap-southeast-2`) — never `AWS_REGION`, which Lambda injects as
`ap-southeast-3` for this deployment.

Local:

```bash
pnpm --filter data-pipeline invoke rssPoll '{}'
pnpm --filter data-pipeline invoke rssEnrich '{}'
```

Both names must be in the `HANDLERS` allowlist in `scripts/invoke-local.ts`
for `invoke <name>` to resolve them (both already are).

**Not yet deployed.** The Terraform for the RSS bronze bucket, the two Lambda
schedules, and the Bedrock IAM policy pass `terraform fmt -check` and
`terraform validate` but have never been `apply`'d to any environment, and no
staging feed import has been run yet. See the root `README.md`'s
[Data Navigator (RSS news lake)](../README.md#data-navigator-rss-news-lake)
section and
`docs/superpowers/specs/2026-09-02-data-navigator-rss-lake-design.md` for the
full design.
