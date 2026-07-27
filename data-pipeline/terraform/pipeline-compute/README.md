# terraform/pipeline-compute

This stack provisions the ephemeral Vault email pipeline:

- `vault-archive-start` and `vault-archive-poll`;
- one EventBridge schedule, DLQ, and CloudWatch alarm per function;
- private-subnet access to RDS and HTTPS;
- RDS IAM authentication and SSM secret access;
- SNS/Slack alerting.

The Lambda role intentionally has no S3 permissions. Vault ZIPs are downloaded
over HTTPS and each MBOX entry exists only in `vault-archive-poll` `/tmp` while
it is processed.

## Build and validate

```bash
pnpm --filter data-pipeline build
terraform init
terraform validate
terraform plan
```

Populate the SSM secrets under `/mna/<environment>/pipeline` before the first
run, including `ANTHROPIC_API_KEY`, `GOOGLE_VAULT_SERVICE_ACCOUNT`, and the AFD
API credentials.

`vault-archive-poll` uses the heavy-memory tier and 4096 MB of ephemeral
storage. If a single MBOX entry can exceed that limit, move entry processing to
a larger ephemeral runtime rather than restoring durable MBOX storage.
