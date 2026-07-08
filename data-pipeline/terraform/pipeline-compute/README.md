# terraform/pipeline-compute

Provisions all AWS resources for the CRM/Vault pipeline compute layer:

- 7 Lambda functions (4 clean-lift + vaultParse streaming + vaultArchiveStart + vaultArchivePoll)
- EventBridge rules triggering each function on its cron schedule
- SQS DLQ per function (14-day retention)
- CloudWatch Errors alarm per function → SNS (email + optional AWS Chatbot → Slack)
- Security group (private subnets → RDS + HTTPS egress)
- S3 gateway endpoint (S3 traffic stays off NAT)
- Data-lake S3 bucket (`mna-data-lake-<env>`) for mbox archive storage — created by this module
- IAM execution role (RDS IAM auth, data-lake S3 RW, SSM read, DLQ send)
- SSM parameters for pipeline secrets

## Prerequisites

1. VPC and RDS modules applied in the target workspace (S3 module no longer required — data-lake bucket is owned by this module).
2. Lambda bundles built and placed in `dist/`:
   ```bash
   pnpm --filter data-pipeline build   # emits dist/<name>.zip per entrypoint
   ```
3. SSM secrets populated (Terraform creates placeholder values; replace before first run):
   ```bash
   aws ssm put-parameter \
     --name "/mna/<env>/pipeline/ANTHROPIC_API_KEY" \
     --value "<key>" --type SecureString --overwrite
   aws ssm put-parameter \
     --name "/mna/<env>/pipeline/GOOGLE_VAULT_SERVICE_ACCOUNT" \
     --value "$(cat service-account.json)" --type SecureString --overwrite
   ```
4. SNS topic for alarms must already exist — pass its ARN as `alarm_sns_topic_arn`.

## Usage

```bash
# Staging
make init-staging
terraform plan -var="vpc_state_bucket=mna-tfstate-staging-<account>" \
               -var="rds_state_bucket=mna-tfstate-staging-<account>" \
               -var="alarm_sns_topic_arn=arn:aws:sns:ap-southeast-3:<account>:mna-staging-alerts"
terraform apply ...

# Production
make init-production
terraform apply ...
```

## Cutover order (see PLAN-lambda-pipeline.md Step 7)

1. Build Lambda bundles and place in `dist/`
2. `terraform apply` — Lambdas + EventBridge rules go live
3. Verify one stage end-to-end (EventBridge → Lambda → RDS)
4. Verify vault-archive-start → vault-archive-poll → mbox_files round-trip
5. **Only then** — delete the 6 Vercel cron routes and their `vercel.json` lines

## Slack alerting

Alarm state changes reach Slack via AWS Chatbot (`chatbot.tf`), which subscribes to the same `alerts` SNS topic the alarms already publish to (both `alarm_actions` and `ok_actions`, so OK↔ALARM transitions are covered). The channel is resolved per Terraform workspace from `local.workspace_config[*].slack_channel_id`:

- `staging` → `C0BG0HR1KSQ` (`#mna-brain-alerts-staging`)
- `production` → `C0BFWNGM4SW` (`#mna-brain-alerts-production`)

Enabled whenever `slack_team_id` is set (defaults to the `T03MDGSH7QE` workspace). One-time prerequisite: authorize the Slack workspace in the AWS Chatbot console. Set `-var="slack_team_id=null"` to disable Slack and keep email-only alerts.

## Notes

- `/api/cron/dispatch` stays on Vercel (AI-Workforce, not pipeline)
- Secrets are loaded at Lambda runtime via SSM (`SSM_PREFIX` env var) — not injected as plaintext env vars
- `vaultArchivePoll` and `vaultParse` use `lambda_memory_mb_heavy` (default 3008 MB) for streaming throughput
- If a single Vault export ZIP exceeds ~10 GB, escalate `vault-archive-poll` to Fargate (see PLAN-lambda-pipeline.md Fallback note)
