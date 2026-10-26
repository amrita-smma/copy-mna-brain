# Provisioning Midas data mart access

How to give Star Capital's Midas read access to the `midas` data mart: the
Postgres user, the IAM role it assumes, the network path, and the hand-over.
How the mart itself works is in
[`docs/features/midas-data-mart.md`](../../features/midas-data-mart.md).
The connection guide and ERD to send Star Capital is
[`Midas_Data_Mart_ERD_and_Connection_Guide.docx`](Midas_Data_Mart_ERD_and_Connection_Guide.docx)
in this folder.

Do every step on **staging** first, check it end to end, then repeat on
**production**. Only the Terraform workspace and the values you hand over
differ.

## What you are provisioning

| Piece | Where it comes from | Who creates it |
|---|---|---|
| `midas` schema + views | `drizzle/migrations/20261026000003_midas_data_mart.sql` | `pnpm db:migrate` (deploy) |
| Postgres user `midas_reader` (IAM login only, read-only, `midas` schema only) | same migration, or `terraform output -raw midas_reader_bootstrap_sql` | migration, or you as RDS master |
| IAM role `mna-<env>-midas-rds-reader` (`rds-db:connect` as `midas_reader` only) | `terraform/rds/midas_iam_role.tf` | `terraform apply` (step 4) |
| Network access to RDS on 5432 | `rds_public_ingress_cidrs` in `terraform/rds` | `terraform apply` (step 4) |
| External ID (shared secret) | `openssl rand -hex 32` | you (step 2) |

Midas never receives a password or an access key from us. Their own AWS
identity assumes our role and signs a 15-minute database token with it.

## Prerequisites

- PR with the Midas migration merged and deployed, and migrations run on the
  target environment.
- AWS credentials for the Brain account with rights to apply `terraform/rds`
  (the `mna_devops` group or the admin SSO role) and to read SSM
  `/mna/<env>/rds/master-password`.
- `terraform`, `aws` CLI v2, `psql`, and the RDS CA bundle:
  ```bash
  curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
  ```

## 1. Collect inputs from Star Capital

Ask Star Capital for:

1. **The IAM principal ARN(s)** that will connect, for example
   `arn:aws:iam::<their-account-id>:role/midas-agent`. Prefer a dedicated role
   over an account root ARN (`arn:aws:iam::<id>:root`). The root ARN lets any
   identity in their account that they allow assume our role.
2. **Their static egress IPs** (one `/32` per address), if we restrict RDS
   ingress. Today `rds_public_ingress_cidrs` defaults to `0.0.0.0/0`, and IAM
   auth plus TLS is the control. Narrowing it is recommended but must include
   every other client (Vercel static IPs, engineers).

## 2. Generate the External ID

```bash
openssl rand -hex 32
```

Store it in the team password manager under "Midas External ID (<env>)". Send
it to Star Capital through the password manager's share link or another
secure channel, never in Slack, email or a ticket. It is required in their
`AssumeRole` call and protects against the confused-deputy problem.

## 3. Check the migration created `midas_reader`

The migration creates the user only if the role running migrations has
`CREATEROLE`. Otherwise it logs `NOTICE: midas: cannot CREATE ROLE …` and
skips. Check as the RDS master user:

```bash
cd terraform/rds
make init-staging            # or init-production
export RDSHOST=$(terraform output -raw db_endpoint)
export PGPASSWORD=$(aws ssm get-parameter --name /mna/staging/rds/master-password \
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
same psql session (`\i` reads it from a file):

```bash
terraform output -raw midas_reader_bootstrap_sql > /tmp/midas_bootstrap.sql
```

```sql
\i /tmp/midas_bootstrap.sql
```

Then delete `/tmp/midas_bootstrap.sql` and run the checks again.

## 4. Create the IAM role (Terraform)

```bash
cd terraform/rds
cp midas.tfvars.example midas.tfvars   # gitignored, never commit it
# edit midas.tfvars: midas_trusted_principal_arns, midas_external_id,
# and optionally rds_public_ingress_cidrs
make init-staging                      # or init-production
terraform plan  -var-file=midas.tfvars
```

The plan should only **create** `aws_iam_role.midas_rds_reader[0]` and
`aws_iam_role_policy.midas_rds_db_connect[0]`, plus a security-group change if
you set `rds_public_ingress_cidrs`. Stop if it wants to replace or modify
`aws_db_instance.mna`. Then:

```bash
terraform apply -var-file=midas.tfvars
terraform output midas_rds_reader_role_arn
terraform output midas_generate_db_auth_token_cli
```

Keep `midas.tfvars` with the other per-environment Terraform secrets. Every
later `terraform apply` in `terraform/rds` needs the same `-var-file`.
Without it, Terraform sees an empty principal list and **destroys the role**.

## 5. Verify before handing over

**IAM: the role can connect as `midas_reader` and as nobody else.**

```bash
ROLE_ARN=$(terraform output -raw midas_rds_reader_role_arn)
RESOURCE_ID=$(aws rds describe-db-instances \
  --db-instance-identifier $(terraform output -raw db_identifier) \
  --query 'DBInstances[0].DbiResourceId' --output text)
DBUSER_ARN="arn:aws:rds-db:ap-southeast-3:$(aws sts get-caller-identity --query Account --output text):dbuser:$RESOURCE_ID"

aws iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
  --action-names rds-db:connect --resource-arns "$DBUSER_ARN/midas_reader" \
  --query 'EvaluationResults[0].EvalDecision'      # "allowed"
aws iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
  --action-names rds-db:connect --resource-arns "$DBUSER_ARN/mna_iam" \
  --query 'EvaluationResults[0].EvalDecision'      # "implicitDeny"
aws iam get-role --role-name "${ROLE_ARN##*/}" \
  --query 'Role.AssumeRolePolicyDocument'          # only Star Capital's ARN(s) + ExternalId
```

**Postgres: `midas_reader` sees only the mart.** Run this as the master user:

```sql
SET ROLE midas_reader;
SELECT count(*) FROM midas.fl_funds;            -- works
SELECT count(*) FROM public.fl_funds;           -- ERROR: permission denied
SELECT DISTINCT workspace_id FROM midas.fl_assets;  -- only this env's workspace
RESET ROLE;
```

**Optional: a real token login from our side.** The trust policy only admits
Star Capital, so to test with a real token, temporarily add your own role's
ARN to `midas_trusted_principal_arns`. Apply, then:

```bash
aws sts assume-role --role-arn "$ROLE_ARN" --role-session-name midas-check \
  --external-id "<external-id>"
# export the three returned credentials, then:
export PGPASSWORD="$(aws rds generate-db-auth-token --hostname $RDSHOST \
  --port 5432 --region ap-southeast-3 --username midas_reader)"
psql "host=$RDSHOST port=5432 dbname=mna user=midas_reader \
      sslmode=verify-full sslrootcert=global-bundle.pem" -c 'SELECT count(*) FROM fl_funds'
```

Remove your ARN and apply again afterwards.

## 6. Hand over to Star Capital

Send them the `.docx` in this folder, and these values for the environment:

| Value | Source |
|---|---|
| Role ARN | `terraform output -raw midas_rds_reader_role_arn` |
| External ID | password manager share (step 2) |
| Host | `terraform output -raw db_endpoint` |
| Port / database | `5432` / `mna` |
| Region | `ap-southeast-3` |
| Database user | `midas_reader` |
| CA bundle | `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` |

On their side they need:

- **An identity policy** that lets their principal call `sts:AssumeRole` on
  our role ARN. Section 6.1 of the guide has the JSON.
- **Token-based connections:** each new connection generates a token with
  the assumed-role credentials and connects with `sslmode=verify-full`.
  Sections 6.3–6.5 have psql, Python and Node examples.
- **A small connection pool,** 2–3 connections. `midas_reader` allows 5.

Confirm with them that a test query returns rows. Their `AssumeRole` call
shows in our CloudTrail under the session name they choose.

## Revoking or rotating

- **Revoke now:** run `REVOKE rds_iam FROM midas_reader;` as master. New
  logins fail immediately. Existing sessions end when they disconnect, or
  terminate them with
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'midas_reader';`.
- **Remove access for good:** empty `midas_trusted_principal_arns` and apply.
  This deletes the role.
- **Rotate the External ID:** generate a new one, update `midas.tfvars`,
  apply, and share it with Star Capital. Their next `AssumeRole` must use it.
- **Change their principal:** edit `midas_trusted_principal_arns` and apply.

## Troubleshooting

| Symptom | Check |
|---|---|
| `AccessDenied` on `sts:AssumeRole` | Their ARN is in the trust policy (`aws iam get-role`); the External ID matches; their identity policy allows `sts:AssumeRole` on our role |
| `PAM authentication failed for user "midas_reader"` | Token generated with the assumed-role credentials, for this exact host/port/user/region, less than 15 min old; `pg_has_role('midas_reader','rds_iam','member')` is true |
| Connection timeout | Their egress IP is allowed by the RDS security group (`rds_public_ingress_cidrs`) |
| `permission denied for schema midas` | Bootstrap SQL not run, or the views were recreated without re-running `GRANT SELECT … TO midas_reader` |
| Views return no rows | That environment's workspace has no fund-ledger data yet |
