# Midas data mart (`midas` schema)

A read-only window onto the fund ledger for Star Capital's Midas. Midas's agent
reads it directly from Brain's RDS over the internet, signed in as a Postgres
user that can only log in with an RDS IAM auth token.

## What's in it

The `midas` schema holds one **plain view** per fund-ledger table. Each has the
**same name and columns as the `public.fl_*` table it reads**, minus
`created_by` / `updated_by`, `fl_assets.action_items` and
`fl_valuations.source_record_id`. The views are `fl_investors`,
`fl_funding_sources` (sources of funds), `fl_assets`, `fl_investment_types`,
`fl_funds`, `fl_positions` and `fl_valuations`.

Every view includes only these workspaces: `d201c012-2b04-490d-a236-fbf605bcf333`
(production), `2e42f936-a20e-4d73-96ad-4ad4aab0c266` (staging) and
`00000000-0000-0000-0000-000000000005` (dev). The dev one is the "Used for
Midas" workspace that `scripts/seed.ts` creates (`MIDAS_WORKSPACE_ID`). The
seeder gives it its own copy of the Combined workspace's fund ledger (the same
fixtures under `00000005-…` ids, see `fundSeedIdFor`), so the views have rows
locally after `pnpm db:seed`. `fl_valuations` has no `workspace_id`
of its own, so it is scoped through the asset, fund or position it values.

The data is live: a view is a stored query, so Midas sees every change as soon
as it is committed. Nothing needs refreshing. Midas queries run against the
`fl_*` tables and use their indexes.

Fund-of-funds look-through holdings (`fl_assets_constituents`) are not in the
ledger yet; see `TECH_DEBT.md`.

## Access

Step-by-step provisioning, verification and revocation:
[`docs/runbooks/midas-data-mart/README.md`](../runbooks/midas-data-mart/README.md).
The connection guide and ERD for Star Capital (`.docx`) is in the same folder.


- **Postgres user `midas_reader`**, created by the migration. It is in
  `rds_iam` so it has no password and logs in only with an IAM token, with
  `CONNECT`, `USAGE` on `midas` and `SELECT` on its views. Nothing in `public`
  is granted: a view runs with its owner's privileges, so the reader never needs
  access to the `fl_*` tables.
  - It has `search_path = midas`, read-only transactions, a 60s statement
    timeout and at most 5 connections.
  - The views are `security_barrier`, so a reader can't use a custom function
    to see rows the workspace filter removes.
  - If the migration role lacks CREATEROLE, the migration logs a NOTICE and
    skips creating the user. Then run the `bootstrap_sql` output of
    `terraform/midas_reader` as the master user.
- **IAM user `midas.reader`** exists in each account (created by hand; its
  access key is what Star Capital holds). The Terraform module
  `terraform/midas_reader` gives it one inline policy, `rds-db:connect` on
  `dbuser:<resource-id>/midas_reader`. The user must have no other policies
  or groups; Terraform does not enforce that, so the runbook checks it before
  hand-over.
- To connect with that key, run `aws rds generate-db-auth-token … --username
  midas_reader` and use the token as the password with `sslmode=verify-full`
  and the RDS global CA bundle. The token is valid for 15 minutes, and only
  for opening the connection. AWS guide:
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.Connecting.html
- The RDS security group must allow Star Capital's egress IPs on 5432
  (`rds_public_ingress_cidrs`).

## Changing it

- **Add a column:** `CREATE OR REPLACE VIEW` in a new migration, appending
  the column at the end.
- **Remove or rename a column, or change the workspace list:** drop and
  recreate the view in a new migration.
- **Add a view:** create it with `security_barrier = true`, then
  `GRANT SELECT … TO midas_reader`.
- **Renaming or dropping an `fl_*` column a view uses:** drop or update the
  view in the same migration. Postgres blocks the change while the view
  depends on the column.
