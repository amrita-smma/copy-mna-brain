# Provisioning Midas data mart access

How to give Star Capital's Midas read access to the `midas` data mart: the
Postgres user, the IAM user it authenticates as, the network path, and the
hand-over. How the mart itself works is in
[`docs/features/midas-data-mart.md`](../../features/midas-data-mart.md).
The connection guide and ERD to send Star Capital is
[`Midas_Data_Mart_ERD_and_Connection_Guide.docx`](Midas_Data_Mart_ERD_and_Connection_Guide.docx)
in this folder.

Do every step on **staging** first, check it end to end, then repeat on
**production**. Only the AWS account, the Terraform workspace and the values
you hand over differ. The commands below read the environment from `ENV` and
the AWS profile from `AWS_PROFILE`:

```bash
export ENV=staging AWS_PROFILE=mna-staging        # then: ENV=production AWS_PROFILE=mna-prod
```

## What you are provisioning

| Piece | Where it comes from | Who creates it |
|---|---|---|
| `midas` schema + views | `drizzle/migrations/20261026000003_midas_data_mart.sql` | `pnpm db:migrate` (step 1) |
| Postgres user `midas_reader` (IAM login only, read-only, `midas` schema only) | same migration, or `terraform output -raw bootstrap_sql` in `terraform/midas_reader` | migration, or you as RDS master (step 3) |
| IAM user `midas.reader` and its access key | created by hand in each account (exists in staging and production) | done |
| Inline policy on `midas.reader`: `rds-db:connect` as `midas_reader` only | `terraform/midas_reader` | `terraform apply` (step 2) |
| Network access to RDS on 5432 | `rds_public_ingress_cidrs` in `terraform/rds` | `terraform apply` there, only if narrowing |

Star Capital gets an access key for `midas.reader`, never a database
password. With it they sign a 15-minute database token for each connection.
Its only permission is `rds-db:connect` as `midas_reader`, so a leaked key
reaches the read-only mart and nothing else in AWS. That holds only while
`midas.reader` has no other policies or groups: Terraform does not enforce it,
so run the step 4 IAM checks before every hand-over.

Terraform reads `midas.reader` but does not manage it or its keys. Create,
rotate and delete keys in IAM directly.

## Prerequisites

- The PR with the Midas migration merged and deployed.
- AWS credentials for the Brain account with rights to apply Terraform (the
  `mna_devops` group or the admin SSO role) and to read SSM
  `/mna/<env>/rds/master-password`.
- `terraform`, `aws` CLI v2, `psql`, and the RDS CA bundle:
  ```bash
  curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  ```
- The RDS instance exists and has IAM DB auth on (`terraform/rds`; already
  true for staging and production).

## 1. Apply the migration

```bash
# with .env.local pointed at the target environment's database
pnpm db:migrate
```

This creates the `midas` schema, its seven views and, if the migrating role
has `CREATEROLE`, the `midas_reader` user. If it doesn't, it logs
`NOTICE: midas: cannot CREATE ROLE …` and step 3 creates the user instead.
The NOTICE names the old `midas_reader_bootstrap_sql` output of
`terraform/rds`; that output is now `bootstrap_sql` in `terraform/midas_reader`.

## 2. Grant `midas.reader` database access (Terraform)

```bash
cd terraform/midas_reader
make init-$ENV
terraform plan               # 1 to add: aws_iam_user_policy.midas_rds_db_connect
terraform apply
```

The first apply adds that one policy and must not change or destroy
anything else; later plans show no changes. There is no tfvars file:
everything the module needs is committed or read from AWS.

## 3. Check the database user `midas_reader`

Connect as the RDS master user:

```bash
cd terraform/rds
make init-$ENV
export RDSHOST=$(terraform output -raw db_endpoint)
export PGPASSWORD=$(aws ssm get-parameter --name /mna/$ENV/rds/master-password \
  --with-decryption --query Parameter.Value --output text)
psql "host=$RDSHOST port=5432 dbname=mna user=$(terraform output -raw db_username) \
      sslmode=verify-full sslrootcert=global-bundle.pem"
```

```sql
-- the schema and its views exist
SELECT table_name FROM information_schema.views WHERE table_schema = 'midas';

-- the user exists, can log in, and is IAM-only
SELECT r.rolname, r.rolcanlogin, r.rolconnlimit, r.rolconfig,
       pg_has_role(r.rolname, 'rds_iam', 'member') AS iam_only
FROM pg_roles r WHERE r.rolname = 'midas_reader';
```

You should see seven views. `midas_reader` should have `rolcanlogin = t`,
`iam_only = t`, a connection limit of 5, and a `rolconfig` that includes
`search_path=midas` and `default_transaction_read_only=on`.

If the row is missing or `iam_only` is false, run the bootstrap SQL in the
same psql session:

```bash
(cd terraform/midas_reader && terraform output -raw bootstrap_sql) > /tmp/midas_bootstrap.sql
```

```sql
\i /tmp/midas_bootstrap.sql
```

Then delete `/tmp/midas_bootstrap.sql` and run the checks again.

## 4. Verify

**IAM: `midas.reader` can connect as `midas_reader` and as nobody else, and
has no other permissions.**

```bash
cd terraform/midas_reader
USER_ARN=$(terraform output -raw iam_user_arn)
DBUSER_ARN=$(terraform output -raw db_connect_arn)    # …:dbuser:<resource-id>/midas_reader

aws iam simulate-principal-policy --policy-source-arn "$USER_ARN" \
  --action-names rds-db:connect --resource-arns "$DBUSER_ARN" \
  --query 'EvaluationResults[0].EvalDecision'      # "allowed"
aws iam simulate-principal-policy --policy-source-arn "$USER_ARN" \
  --action-names rds-db:connect --resource-arns "${DBUSER_ARN%/*}/mna_iam" \
  --query 'EvaluationResults[0].EvalDecision'      # "implicitDeny"
aws iam list-attached-user-policies --user-name midas.reader   # empty
aws iam list-groups-for-user --user-name midas.reader          # empty
aws iam list-user-policies --user-name midas.reader            # only rds-db-connect-midas_reader
```

**Postgres: `midas_reader` sees only the mart.** Run this as the master user:

```sql
SET ROLE midas_reader;
SELECT count(*) FROM midas.fl_funds;            -- works
SELECT count(*) FROM public.fl_funds;           -- ERROR: permission denied
SELECT DISTINCT workspace_id FROM midas.fl_assets;  -- only this env's workspace
RESET ROLE;
```

**A real token login** with the key you are about to hand over (keep it out
of your shell history and profile files):

```bash
export AWS_ACCESS_KEY_ID=<midas.reader key id> AWS_SECRET_ACCESS_KEY=<secret>
unset AWS_PROFILE AWS_SESSION_TOKEN
export PGPASSWORD="$(aws rds generate-db-auth-token --hostname "$RDSHOST" \
  --port 5432 --region ap-southeast-3 --username midas_reader)"
psql "host=$RDSHOST port=5432 dbname=mna user=midas_reader \
      sslmode=verify-full sslrootcert=global-bundle.pem" -c 'SELECT count(*) FROM fl_funds'
```

## 5. Hand over to Star Capital

Send them the `.docx` in this folder, and these values for the environment
(from `terraform output` in `terraform/midas_reader` unless noted):

| Value | Source |
|---|---|
| Access key ID + secret for `midas.reader` | password manager share only, never Slack, email or a ticket |
| Host | `db_host` |
| Port / database | `db_port` / `db_name` |
| Region | `ap-southeast-3` |
| Database user | `db_username` (`midas_reader`) |
| CA bundle | `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` |

If the secret of the existing key is not in the password manager, create a
new key (`aws iam create-access-key --user-name midas.reader`), share that,
and delete the old one. A user can hold at most two keys.

On their side they need:

- **The key stored as a secret** in their runtime (secrets manager or
  environment), not in code.
- **Token-based connections:** each new connection generates a token with
  the key and connects with `sslmode=verify-full`. Sections 6.3–6.5 of the
  guide have psql, Python and Node examples.
- **A small connection pool,** 2–3 connections. `midas_reader` allows 5.

If they connect from fixed IPs and we want to narrow RDS ingress, set
`rds_public_ingress_cidrs` in `terraform/rds` (it defaults to `0.0.0.0/0`,
with IAM auth plus TLS as the control). Include every other client (Vercel
static IPs, engineers), not only Star Capital.

Confirm with them that a test query returns rows. Token generation is local
and is not logged, but every database session shows as `midas_reader` in RDS
logs, and `aws iam get-access-key-last-used` shows when the key was last used.

## Revoking or rotating

- **Revoke now:** deactivate the key
  (`aws iam update-access-key --user-name midas.reader --access-key-id <id> --status Inactive`)
  or run `REVOKE rds_iam FROM midas_reader;` as master. New logins fail
  immediately. Existing sessions end when they disconnect, or terminate them
  with
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'midas_reader';`.
- **Remove access for good:** `terraform destroy` in `terraform/midas_reader`
  removes the policy; delete the user's keys (or the user) in IAM.
- **Rotate the key** (at least every 90 days, and whenever anyone who had it
  leaves): create a second key, share it, wait until
  `get-access-key-last-used` shows Star Capital is off the old one, then
  delete the old key.

## Troubleshooting

| Symptom | Check |
|---|---|
| `PAM authentication failed for user "midas_reader"` | Token generated with `midas.reader`'s key, for this exact host/port/user/region, less than 15 min old; the key is Active; step 2 applied; `pg_has_role('midas_reader','rds_iam','member')` is true |
| Connection timeout | Their egress IP is allowed by the RDS security group (`rds_public_ingress_cidrs` in `terraform/rds`) |
| `permission denied for schema midas` | Bootstrap SQL not run, or the views were recreated without re-running `GRANT SELECT … TO midas_reader` |
| Views return no rows | That environment's workspace has no fund-ledger data yet |
| `terraform plan` fails reading `aws_iam_user` or `aws_db_instance` | `midas.reader` or `mna-<env>-postgres` doesn't exist in this account, or `AWS_PROFILE` and the workspace point at different environments |
