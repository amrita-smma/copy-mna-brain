# Feature documentation

Deep dives on individual features, one file per feature. These were split out of
`README.md`, which had grown to 182KB by collecting every feature write-up in a
single file.

**Looking for orientation rather than a specific feature?** Start at
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) — layers, request path, and where new
code goes. To locate a route, service, repository, agent tool, job handler or
flag, grep [`../architecture/code-map.md`](../architecture/code-map.md).

Adding a feature doc? Add the file here and a line below. Keep feature detail out
of `ARCHITECTURE.md` (it has a size budget) and out of `README.md`.


## Pipeline & deals

- [Smart Files](smart-files.md) — 7KB
- [CRM (Contact Relationship Management)](crm.md) — 1KB
- [CRM data pipeline](crm-data-pipeline.md) — 2KB
- [Pipeline and Sourcing pages (`/pipeline`, `/sourcing`)](pipeline-and-sourcing.md) — 7KB
- [One company-filter vocabulary across the analysis tools](company-filter-vocabulary.md) — 3KB
- [Company Card → PowerPoint (email export)](company-card-powerpoint-export.md) — 3KB
- [Research-summary PDF (email attachment)](research-summary-pdf.md) — 5KB
- [Presentation page (`/presentation`)](presentation-page.md) — 1KB
- [Relationship graph (Neo4j)](relationship-graph.md) — 10KB
- [Data Navigator (RSS news lake)](data-navigator.md) — 9KB

## Copilot & agents

- [Copilot flavors (M&A, Investment, Combined, VC, Minority Stakes, Crowdfunding)](copilot-flavors.md) — 19KB
- [Sector agents (`@minerba`, `@dikti`, `@bangun`)](sector-agents.md) — 882B
- [In-app Copilot chat caching](copilot-chat-caching.md) — 2KB
- [In-app Copilot chat attachments](copilot-chat-attachments.md) — 6KB
- [External Chat API (`/api/v1/chat`)](external-chat-api.md) — 4KB
- [Async jobs](async-jobs.md) — 38KB

## App shell & UI

- [App shell (chat-first landing + center console)](app-shell.md) — 21KB
- [Record-scoped dialogs (`CompanyDetailDialog` and friends)](record-scoped-dialogs.md) — 5KB
- [Live updates (Server-Sent Events)](live-updates-sse.md) — 1KB
- [Workspace table layouts (column order / hidden / groups)](workspace-table-layouts.md) — 3KB
- [In-app feedback (MB-480)](in-app-feedback.md) — 2KB

## Workspaces & auth

- [Google SSO sign-in](google-sso.md) — 6KB
- [Admin routes (`/api/auth`)](admin-routes.md) — 1KB
- [Account invite flow (admin-created users)](account-invite-flow.md) — 2KB
- [User Management (admin portal)](user-management.md) — 2KB
- [Forgot-password flow (AWS SES + Vercel Queues)](forgot-password-flow.md) — 3KB
- [Workspace display currency (USD / IDR / CNY)](workspace-display-currency.md) — 2KB
- [Workspace soft delete (archive / reinstate)](workspace-soft-delete.md) — 3KB
- [Iframe embedding (Brain Launcher)](iframe-embedding.md) — 3KB

## Platform

- [Runtime feature toggles](runtime-feature-toggles.md) — 2KB
- [Product telemetry (PostHog)](product-telemetry.md) — 8KB
- [Langfuse agent tracing](langfuse-tracing.md) — 6KB
