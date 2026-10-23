# terraform/pipeline-compute

This stack provisions the ephemeral Vault email pipeline:

- `vault-archive-start` and `vault-archive-poll`;
- one EventBridge schedule, DLQ, and CloudWatch Errors alarm per function;
- a "Vault export stuck" alarm (`alarms.tf`);
- private-subnet access to RDS and HTTPS;
- RDS IAM authentication and SSM secret access;
- SNS/Slack alerting.

## Alarms

Both go to the `alerts` SNS topic (email + Slack), on ALARM and on OK.

| Alarm | Fires when | Catches |
|---|---|---|
| `<prefix>-<function>-errors` | Errors in 3 of the last 4 quarter-hours (`error_alarm` in `lambda_configs`; `vault-archive-start` runs daily, so any failure in the hour) | A function failing repeatedly, including out-of-memory kills and timeouts. A one-off failure the next run recovers from stays quiet |
| `<prefix>-vault-export-stuck` | The oldest export still exporting/processing has been in flight for over 6 hours, for 2 hours running | Mail not reaching the CRM for any reason: a crash loop, Vault, Anthropic |

`vault-archive-poll` publishes the stuck alarm's metric on every run as an
embedded-metric-format log line (namespace `MNA/Pipeline`, dimension
`Environment`). Until the first run after a deploy there is no data, which
shows as INSUFFICIENT_DATA rather than an alert.

The Lambda role intentionally has no S3 permissions. Vault ZIPs are downloaded
over HTTPS and each MBOX entry exists only in `vault-archive-poll` `/tmp` while
it is processed. There is no pipeline data-lake bucket in this stack (legacy
`mna-data-lake-*` is removed on apply). App Smart Files objects live in `mna-app-data-*`.

If `terraform apply` fails destroying a non-empty `mna-data-lake-*` bucket,
empty it first (including versions), then re-apply — or temporarily set
`force_destroy = true` on the bucket in a prior apply before removing the
resource.

## Build and validate

```bash
pnpm --filter data-pipeline build
terraform init
terraform validate
terraform plan
```

Populate the SSM secrets under `/mna/<environment>/pipeline` before the first
run, including `ANTHROPIC_API_KEY`, `GOOGLE_VAULT_SERVICE_ACCOUNT`, and the Smart Files
API credentials.

`vault-archive-poll` uses the heavy-memory tier and 4096 MB of ephemeral
storage. If a single MBOX entry can exceed that limit, move entry processing to
a larger ephemeral runtime rather than restoring durable MBOX storage.
