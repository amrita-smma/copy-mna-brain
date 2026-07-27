# Ephemeral email demo fixture

`ephemeral-email-demo.mbox` exercises the 4-step privacy filter + keep paths for the single-pass processor (`processMboxSource`).

Regenerate:

```bash
pnpm --filter data-pipeline exec tsx scripts/generate-ephemeral-demo-mbox.ts
```

## Expected outcomes (18 messages)

| # | Expect | Gate | Scenario |
|---|--------|------|----------|
| 01 | **keep** | — | Inbound term sheet (Goldman → custodian) |
| 02 | **keep** + PDF→AFD | — | CIM PDF attachment |
| 03 | **keep** + XLSX→AFD | — | LBO model (Office bypass) |
| 04 | skip | 01 domain | Personal `gmail.com` |
| 05 | skip | 02 content | Subject contains “salary review” |
| 06 | skip | 03 attachment | `July_2026_payslip.pdf` |
| 07 | skip | 04 noise | Out of office / auto-reply |
| 08 | skip | 04 noise | Newsletter (`List-Unsubscribe`) |
| 09 | skip | 04 noise | Internal-only (Star → Star) |
| 10 | skip | 04 noise | Coffee catch-up (personal, no deal keywords) |
| 11 | **keep** | — | Outbound reply (custodian → banker) |
| 12 | **keep** | — | Inbound reply (response-time thread) |
| 13 | skip | 04 noise | Calendar invite |
| 14 | **keep** | — | Explicit company pitch (related-company signal) |
| 15 | skip | 04 noise | `noreply@` local-part |
| 16 | **keep** + DOCX→AFD | — | SPA markup Word doc |
| 17 | skip | 02 content | HR / PIP subject |
| 18 | **keep** | — | “Lunch” + deal keywords (must not personal-skip) |

Custodian used in headers: **`analyst@starcapital.co.id`**.

## Run locally

The no-S3 cutover processes the fixture directly from disk — no MinIO/S3 upload
and no `mbox_files` row. This mirrors what `vault-archive-poll` does per Vault
entry (spool to `/tmp` → `processMboxSource`).

```bash
# Postgres migrated; ANTHROPIC_API_KEY in .env.local
# Optional: ensure analyst@starcapital.co.id exists with is_email_synced=true
# For attachment (AFD) uploads: INTERNAL_API_URL + ADMIN_SECRET + app server up

# IMPORTANT: pnpm --filter runs with cwd=data-pipeline/, so use fixtures/...
# (not data-pipeline/fixtures/...). Or use an absolute path.

pnpm --filter data-pipeline process-mbox \
  --file fixtures/ephemeral-email-demo.mbox \
  --custodian analyst@starcapital.co.id
```

Expect roughly: `messages_seen=18`, `messages_skipped≈10`, `messages_ingested≈8`, `attachments_uploaded≈3` (PDF/XLSX/DOCX on keep paths; payslip skipped).

Re-running with the same `--source-key` (default `local::<basename>`) is a
no-op once the run has completed — delete the `analytics.email_process_runs`
row for that key to force a full reprocess.