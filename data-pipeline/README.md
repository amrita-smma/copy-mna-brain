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
