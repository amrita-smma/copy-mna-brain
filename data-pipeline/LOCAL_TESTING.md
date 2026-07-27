# Local testing

## Process a fixture

```bash
pnpm --filter data-pipeline process-mbox \
  --file fixtures/ephemeral-email-demo.mbox \
  --custodian analyst@example.com
```

The command opens the local file directly and calls `processMboxSource`. It
does not upload MBOX bytes or create a durable staging row.

## Invoke the scheduled handlers

```bash
pnpm --filter data-pipeline invoke vaultArchiveStart '{"count":1}'
pnpm --filter data-pipeline invoke vaultArchivePoll '{}'
```

These commands use local environment values but call the real Google Vault API.
Use a disposable Vault date window and non-production database when testing.

## Verify

```bash
pnpm --filter data-pipeline test
pnpm --filter data-pipeline build
terraform -chdir=data-pipeline/terraform/pipeline-compute validate
```

Expected behavior:

- only `vault-archive-start` and `vault-archive-poll` are built;
- MBOX files exist only under Lambda `/tmp` while an entry is processed;
- `analytics.email_process_runs` advances its cursor on committed batches;
- `analytics.emails.body_text` and evidence `matched_text` remain null;
- completed or terminally abandoned exports close their Vault matter.
