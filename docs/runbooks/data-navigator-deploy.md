# Deploying the Data Navigator (RSS news lake)

Runbook for taking the `data-navigator` branch from code-complete to live.
Nothing in this subsystem has ever been `apply`'d — treat the first staging
run as a real deployment, not a re-deploy.

The feature ships **dark**: `DATA_NAVIGATOR_ENABLED` has `defaultEnabled:
false` in `src/lib/features/catalog.ts`, so merging and deploying the app is
safe on its own. The nav entry only appears once a superadmin turns the toggle
on for a workspace (step 9).

Run every step against **staging** first, verify, then repeat for
**production**. The only differences are the Terraform workspace, the Vercel
environment, and the `--base` URL.

---

## What gets deployed

| Piece | Where it lives | How it deploys |
| --- | --- | --- |
| `rss` schema (feeds, items, item_chunks, ingest_runs) | `data-pipeline/migrations/20260902000000_rss_schema.sql` | `pnpm db:migrate` (step 3) |
| Bronze archive bucket `mna-<env>-rss-lake` | `terraform/s3-rss` | `terraform apply` (step 4) |
| `rss-poll` / `rss-enrich` Lambdas, schedules, DLQs, alarms, S3 + Bedrock IAM | `data-pipeline/terraform/pipeline-compute` | `terraform apply` (step 5) |
| Lambda **code** after the first apply | `data-pipeline/src/lambda/rss*.ts` | `.github/workflows/pipeline-lambda.yml` (step 6) |
| API routes, service, `/data-navigator` page | `src/**` | Vercel (step 2) |
| Feed catalog rows (256 distinct feeds) | `data-pipeline/fixtures/rss-feeds.csv` | `pnpm rss:import-feeds` (step 8) |

---

## Step 0 — Prerequisites

Have all of these before you start; three of them are manual AWS steps that
Terraform does **not** do for you.

1. **Tooling:** Node 24 (see `.nvmrc`), `pnpm`, `terraform >= 1.3`, `aws` CLI authenticated
   against the target account (staging and production are separate accounts —
   the Makefiles derive the state bucket from `aws sts get-caller-identity`).

2. **Bedrock model access.** Enable `amazon.titan-embed-text-v2:0` in the
   Bedrock console **in `ap-southeast-2` (Sydney)**. Every Bedrock call is
   cross-region by necessity: Bedrock is not offered in `ap-southeast-3`
   (Jakarta), where the pipeline Lambdas run, and Titan Embed v2 is not
   offered in `ap-southeast-1` (Singapore) either — so do not "optimise" the
   region to the nearer one. That is why `src/lib/bedrock.ts` reads
   `BEDROCK_REGION` (default `ap-southeast-2`) and deliberately never falls
   back to `AWS_REGION`. Without model access, embedding fails and
   `rss.item_chunks` stays empty.

   ```bash
   # Confirm access is live (should print the model summary, not AccessDenied):
   aws bedrock get-foundation-model \
     --region ap-southeast-2 \
     --model-identifier amazon.titan-embed-text-v2:0
   ```

3. **`ANTHROPIC_API_KEY` in SSM.** The relevance classifier calls Haiku via
   `process.env.ANTHROPIC_API_KEY`, loaded from
   `/mna/<env>/pipeline/ANTHROPIC_API_KEY`. Terraform only declares the
   parameter shell with a `PLACEHOLDER` value and `ignore_changes = [value]`,
   so verify it holds a real key:

   ```bash
   aws ssm get-parameter --name "/mna/<env>/pipeline/ANTHROPIC_API_KEY" \
     --with-decryption --query 'Parameter.Value' --output text | head -c 12
   ```

   If it still says `PLACEHOLDER`, set it:

   ```bash
   aws ssm put-parameter --name "/mna/<env>/pipeline/ANTHROPIC_API_KEY" \
     --type SecureString --value "sk-ant-..." --overwrite
   ```

4. **`ADMIN_SECRET`** for the target environment — needed by the feed import in
   step 8, which calls the `X-Api-Secret`-gated `/api/auth/rss-feeds/import`.

5. **DB access** with rights to `CREATE EXTENSION` and `CREATE SCHEMA` (see
   step 3), plus network reachability to the RDS instance from wherever you run
   `pnpm db:migrate`.

---

## Step 1 — Merge the branch

```bash
git checkout main && git pull
git merge --no-ff data-navigator   # or merge the PR
```

Before merging, if `main` has gained pipeline migrations since this branch was
cut, renumber ours so lexical order still equals apply order:

Run the `/migration-rebase data-pipeline/migrations` skill, which renumbers
this branch's migrations to sort after everything on `main` and regenerates the
journal. If you renumber by hand, follow it with `pnpm db:journal` — Drizzle
silently ignores `.sql` files missing from `meta/_journal.json`, and that file
is fully derived from filenames, never hand-edited.

`20260902000000_rss_schema.sql` is dated 2026-09-02, so anything merged to
`main` after that date needs this check.

---

## Step 2 — Deploy the app (Vercel)

Pushing to `main` triggers the normal Vercel production deploy. Two optional
env vars, both of which have working defaults in `src/lib/bedrock.ts` — set
them only if you need to override:

| Var | Default | Notes |
| --- | --- | --- |
| `BEDROCK_REGION` | `ap-southeast-2` | Must be a region where Titan v2 is enabled |
| `BEDROCK_EMBEDDING_MODEL` | `amazon.titan-embed-text-v2:0` | Must emit 1024 dims to match `rss.item_chunks.embedding vector(1024)` |

Do **not** set `DATA_NAVIGATOR_ENABLED` as an env var — it is a runtime
per-workspace toggle (step 9). At this point the code is live and inert.

---

## Step 3 — Apply the database migration

```bash
# with .env.local pointed at the target environment's DB
pnpm db:migrate
```

`scripts/migrate.ts` applies `drizzle/migrations` (schema `drizzle`) then
`data-pipeline/migrations` (schema `drizzle_pipeline`). Expect
`✓ pipeline migrations applied`.

Two things in this migration deserve attention:

- It runs `CREATE EXTENSION IF NOT EXISTS vector` and `pg_trgm`. On RDS the
  migrating role needs `rds_superuser` (or the extensions must already exist).
  If it fails with a permissions error, create them once as the master user and
  re-run — the migration is `IF NOT EXISTS` throughout and is safe to retry.
- It builds an HNSW index on an empty table, which is instant now. Do not defer
  it — building it later against a populated table is a long, blocking
  operation.

Verify:

```sql
\dx                                        -- vector, pg_trgm present
\dt rss.*                                  -- feeds, items, item_chunks, ingest_runs
SELECT count(*) FROM rss.feeds;            -- 0 for now
```

---

## Step 4 — Apply `terraform/s3-rss` (bronze bucket)

**This must go before `pipeline-compute`**, which reads its remote state at
`env:/<workspace>/mna/s3-rss` for the bucket name and ARN. Applying them in
the wrong order fails with an unreadable-remote-state error.

```bash
cd terraform/s3-rss
make init-staging          # or: make init-production
terraform plan
terraform apply
```

Creates `mna-<env>-rss-lake`: AES256 SSE, all public access blocked, no
versioning (objects are immutable, one NDJSON file per run), and a lifecycle
rule aborting incomplete multipart uploads after 7 days. Bronze is the replay
log and is retained indefinitely by design.

```bash
terraform output bucket_id   # → mna-<env>-rss-lake
```

---

## Step 5 — Apply `data-pipeline/terraform/pipeline-compute`

The Lambda module reads its zips off local disk
(`filename = "${path.root}/../../dist/${each.key}.zip"` and
`filebase64sha256(...)`), so **build first or the apply fails**:

```bash
pnpm --filter data-pipeline build      # writes dist/rss-poll.zip, dist/rss-enrich.zip
ls -la data-pipeline/dist/rss-*.zip

cd data-pipeline/terraform/pipeline-compute
make init-staging                      # or: make init-production
terraform plan
```

Read the plan before applying. It should be **additive** — two new functions
and their satellites, two new IAM policies. Expected new resources:

- `aws_lambda_function.pipeline["rss-poll"]` and `["rss-enrich"]`
  → `mna-<env>-pipeline-rss-poll`, `mna-<env>-pipeline-rss-enrich`
- `aws_cloudwatch_event_rule.schedule[...]` — `rate(30 minutes)` for poll,
  `rate(10 minutes)` for enrich
- one SQS DLQ and one CloudWatch error alarm per function
- `aws_iam_policy.rss_bronze_write` — `s3:PutObject` scoped to
  `<rss-lake-arn>/bronze/*`
- `aws_iam_policy.bedrock_invoke` — `bedrock:InvokeModel` scoped to
  `arn:aws:bedrock:ap-southeast-2::foundation-model/amazon.titan-embed-text-v2:0`
- updated env vars on **all four** pipeline functions (the env map is shared):
  `RSS_BRONZE_BUCKET`, `BEDROCK_REGION`, `BEDROCK_EMBEDDING_MODEL`,
  `RSS_DAILY_CAP_PER_CATEGORY`

If the plan proposes destroying or replacing the two `vault-archive-*`
functions, stop and investigate — this change should not touch them beyond the
env-var update. (Note the pipeline-compute README's warning about a legacy
`mna-data-lake-*` bucket destroy; if you hit it, empty that bucket first.)

```bash
terraform apply
```

Both Lambdas share the existing `pipeline_lambda` role, so the email handlers
technically inherit the S3 and Bedrock policies. They never call either — the
"email pipeline touches no S3" guarantee is a property of the code, not of IAM.

---

## Step 6 — Hand code deploys to CI

Terraform sets `ignore_changes = [filename, source_code_hash]`, so after the
first apply, `.github/workflows/pipeline-lambda.yml` owns the Lambda code. It
runs `aws lambda update-function-code` for every zip in `data-pipeline/dist/`,
naming functions `mna-<env>-pipeline-<zip basename>` — which is exactly why
`ENTRIES` in `data-pipeline/scripts/build.ts` maps `rssPoll → rss-poll`.

- **Staging:** automatic on every push to `main` that touches the workflow's
  paths (now including `src/lib/bedrock.ts`).
- **Production:** manual — `workflow_dispatch` with `environment: production`.

```bash
gh workflow run pipeline-lambda.yml -f environment=production
gh run watch
```

Because the functions must already exist for `update-function-code` to
succeed, step 5 is a hard prerequisite for this step in each environment.

---

## Step 7 — Grant the app Bedrock access ⚠️

**This is a known gap in the branch and it is not optional for search.**

`createContainer` builds `new BedrockEmbeddingClient()` inside the Next.js
process, so `/api/data-navigator/search` embeds
the query **from the app**, not from a Lambda. The app's AWS identity is the
`mna-app` IAM user (`terraform/iam/main.tf`), which currently carries only S3,
SES, and RDS policies — no Bedrock.

The failure is silent: `DataNavigatorService.vectorHalf` catches, logs
`[data-navigator] vector search unavailable:`, and returns `[]`, so search
degrades to trigram-only and still returns plausible results. You will not
notice from the UI.

Fix by attaching a `bedrock:InvokeModel` policy to `mna-app`, scoped to the
same model ARN the Lambda policy uses. Add it to `terraform/iam` (preferred, so
it is not console drift) alongside the existing user attachments:

```hcl
resource "aws_iam_policy" "bedrock_invoke_app" {
  name = "mna-app-bedrock-invoke"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel"]
      Resource = "arn:aws:bedrock:ap-southeast-2::foundation-model/amazon.titan-embed-text-v2:0"
    }]
  })
}

resource "aws_iam_user_policy_attachment" "mna_files_user_bedrock_attachment" {
  user       = aws_iam_user.mna_files_user.name
  policy_arn = aws_iam_policy.bedrock_invoke_app.arn
}
```

Then `cd terraform/iam && make init-<env> && terraform apply`. Verify in step 10
that hits come back with `matchedBy: "vector"` or `"both"`.

---

## Step 8 — Import the feed catalog

Hosts are the deployed app URLs from `.env.example`
(`STAGING_BASE_URL` / `PRODUCTION_BASE_URL`):

| Env | `--base` |
| --- | --- |
| local | `http://localhost:3000` (the default — omit `--base`) |
| staging | `https://mna-stg.sqe.co.id` |
| production | `https://mna.sqe.co.id` |

```bash
# staging
ADMIN_SECRET="$(aws ssm get-parameter \
  --name /mna/staging/pipeline/ADMIN_SECRET \
  --with-decryption --query Parameter.Value --output text)" \
  pnpm rss:import-feeds --base https://mna-stg.sqe.co.id

# production
ADMIN_SECRET="$(aws ssm get-parameter \
  --name /mna/production/pipeline/ADMIN_SECRET \
  --with-decryption --query Parameter.Value --output text)" \
  pnpm rss:import-feeds --base https://mna.sqe.co.id

# local (secret and everything else read from .env.local)
pnpm rss:import-feeds
```

Setting `ADMIN_SECRET` inline is deliberate: the script calls `dotenv`'s
`config()` on `.env.local` then `.env`, and dotenv never overwrites a variable
that is already set — so the inline value wins over whatever local secret those
files hold. Omit it against a remote host and you will send your local secret
and get a 401 from the middleware.

Expect **`✓ imported 256 feeds`**, not 263 — the CSV has 263 rows but only 256
distinct `feed_url`s, and the upsert is keyed on `feed_url`. Rows whose CSV
`status` column is `DEAD`/`ERROR` (a PoC validation verdict, not our lifecycle
value) land as `status = 'dead'` so they are on record but never polled.

The endpoint is idempotent — re-running refreshes editorial columns and leaves
poller health state alone.

```sql
SELECT status, count(*) FROM rss.feeds GROUP BY status;
SELECT category, count(*) FROM rss.feeds WHERE status = 'active' GROUP BY category;
```

Locally, `pnpm db:seed` already seeds a small feed fixture — no import needed
for dev.

---

## Step 9 — Trigger the first runs manually

Don't wait on the schedule; you want the first invocations under observation.

```bash
ENV=staging
aws lambda invoke --function-name mna-$ENV-pipeline-rss-poll \
  --payload '{}' --cli-binary-format raw-in-base64-out /dev/stdout

# give it a minute, then:
aws lambda invoke --function-name mna-$ENV-pipeline-rss-enrich \
  --payload '{}' --cli-binary-format raw-in-base64-out /dev/stdout
```

`rss-enrich` drains three queues sequentially — classify → fetch content →
embed — and an error in an earlier stage aborts the invocation on purpose; the
next run 10 minutes later resumes where it stopped. So run it two or three
times before judging it stuck.

Watch the run log and the bucket:

```sql
SELECT kind, started_at, finished_at, stats, error
FROM rss.ingest_runs ORDER BY started_at DESC LIMIT 10;

SELECT relevance, content_status, count(*) FROM rss.items
GROUP BY 1, 2 ORDER BY 1, 2;

SELECT count(*) FROM rss.item_chunks;   -- >0 proves Bedrock works end to end
```

```bash
aws s3 ls "s3://mna-$ENV-rss-lake/bronze/" --recursive | tail
aws logs tail "/aws/lambda/mna-$ENV-pipeline-rss-enrich" --since 30m
```

Expect roughly 25 selected items per category per UTC day
(`RSS_DAILY_CAP_PER_CATEGORY`, 5 categories → ~125/day ceiling). Feeds retire
themselves to `dead` after 10 consecutive failures — some attrition on the
first few polls is normal, the PoC found ~35% of a raw catalog already rotten:

```sql
SELECT source_name, consecutive_failures, last_success_at
FROM rss.feeds WHERE consecutive_failures > 0
ORDER BY consecutive_failures DESC LIMIT 20;
```

---

## Step 10 — Enable the toggle and verify

Only now turn the feature on. As a superadmin, go to `/admin-portal` →
workspace configuration → **Features** → enable **Data Navigator** for the
target workspace. This writes a `feature_flags` row for that workspace only.

Verify:

1. **Nav + page** — `/w/<slug>/data-navigator` shows the master-detail list,
   newest first; category/source/region filters populate from
   `/api/data-navigator/filters`; clicking an item renders the preview.
2. **Search returns vector hits** — the proof that step 7 worked:

   ```bash
   curl -s "https://mna-stg.sqe.co.id/api/data-navigator/search?q=series+B+funding" \
     -H "Cookie: <session>" | jq '.data[] | {title, matchedBy, score}'
   ```

   All-`"text"` `matchedBy` values mean the app cannot reach Bedrock — go back
   to step 7 and check the app logs for
   `[data-navigator] vector search unavailable`.
3. **Agent news research** — the `search_news` agent tool has been removed;
   the Copilot answers recent-news questions with `web_search` on the open
   web. The lake is reachable only through the Data Navigator page and
   `/api/data-navigator/search`.
4. **E2E** — `pnpm test:e2e:staging e2e/data-navigator.spec.ts` (or
   `test:e2e:production`); the spec is written to tolerate data churn.
5. **Alarms** — confirm `mna-<env>-pipeline-rss-poll-errors` and
   `-rss-enrich-errors` exist and route to the SNS/Slack alerts topic, and that
   both DLQs are empty.

---

## Step 11 — Repeat for production

Steps 3 → 10 again with the production workspace/account: `pnpm db:migrate`
against the prod DB, `make init-production` in both Terraform modules,
`gh workflow run pipeline-lambda.yml -f environment=production`,
`pnpm rss:import-feeds --base https://mna.sqe.co.id`, then enable the toggle per
workspace. Confirm Bedrock model access is enabled in the **production**
account too — it is account-scoped, so staging's approval does not carry over.

---

## Rollback

Ordered least to most invasive; the first one covers almost every case.

1. **Hide the feature** — turn off **Data Navigator** in `/admin-portal`.
   Instant, per workspace, no deploy. The page and nav entry disappear;
   ingestion keeps running.
2. **Stop ingestion, keep data** — disable the schedules:

   ```bash
   aws events disable-rule --name mna-<env>-pipeline-rss-poll
   aws events disable-rule --name mna-<env>-pipeline-rss-enrich
   ```

   Or pause feeds at the data layer: `UPDATE rss.feeds SET status = 'paused';`.
   Both survive a Lambda code redeploy; a `terraform apply` will re-enable the
   EventBridge rules, so prefer the SQL route if the pause needs to hold.
3. **Stop spending on LLM calls** — set `RSS_DAILY_CAP_PER_CATEGORY` to `0` via
   the `rss_daily_cap_per_category` variable and re-apply, or edit the env var
   directly on the two functions for an immediate stop.
4. **Remove the compute** — delete the `rss-poll` / `rss-enrich` entries from
   `local.lambda_configs` in `pipeline-compute/main.tf` and apply. Leave the
   `rss` schema and the bronze bucket in place; they are the replayable record
   and cost almost nothing.
5. **Full teardown** (only if the feature is abandoned) — `terraform destroy`
   in `terraform/s3-rss` **after** removing the `pipeline-compute` remote-state
   dependency, then a new migration dropping `schema rss`. Never edit
   `20260902000000_rss_schema.sql` — it has been applied.

Do not roll back the app deploy to undo this feature. The toggle already makes
it invisible, and reverting drops unrelated changes shipped in the same release.
