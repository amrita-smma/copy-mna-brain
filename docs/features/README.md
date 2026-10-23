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
- [Fund Management page (search, Action Items, delete asset, fund-update upload)](fund-management.md) — 3KB
- [CRM (Contact Relationship Management)](crm.md) — 1KB
- [CRM data pipeline](crm-data-pipeline.md) — 2KB
- [CRM banker insights (per-person emails, related companies, deal links, scorecard, flagged Bankers view, contact panel and Conversation modal, Brain Bots tools, Ask Brain suggested questions)](crm-banker-insights.md) — 31KB
- [CRM banker matching ("which banker can help me close this deal?")](crm-banker-matching.md) — 8KB
- [Filling a CRM contact (`@crm_contact`): email context + web](crm-contact-fill.md) — 4KB
- [CRM editing, per workspace (shared firms/contacts, per-workspace edits, PIC, team, tags, audited notes)](crm-per-workspace-editing.md) — 4KB
- [CRM contacts: email-keyed merge and CSV/Excel import](crm-contact-merge-and-import.md) — 4KB
- [Company contact details (partnership contacts in the CRM via `@crm_contact`)](company-contacts.md) — 3KB
- [Pipeline and Sourcing pages (`/pipeline`, `/sourcing`)](pipeline-and-sourcing.md) — 7KB
- [Pending Confirmation auto-scan, auto promote / auto drop, Scan now; AI screening on the AI Workforce](pending-auto-scan.md) — 5KB
- [Deal Sponsor auto-assignment for companies detected in an email](deal-sponsor-auto-assign.md) — 4KB
- [Track screening pass rule: must-pass criteria + minimum optional criteria; used by AI Screening, auto promote / auto drop and the AI Opinion](track-screening-rule.md) — 3KB
- [Company detail tabs (page + pipeline dialog)](company-detail-tabs.md) — 4KB
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
- [Copilot bots (one permanent thread per bot, every skill, set up through the chat, persona, history search, @mentions with reply-back between bots, live presence over Redis + SSE, routines, task log, verdict-first replies, dated citations, option cards, avatar)](copilot-bots.md) — 19KB
- [In-app Copilot chat attachments](copilot-chat-attachments.md) — 6KB
- [CoPilot memory (mem0, pgvector)](copilot-memory.md) — 20KB
- [External Chat API (`/api/v1/chat`)](external-chat-api.md) — 4KB
- [Async jobs](async-jobs.md) — 38KB
- [AI Workforce: stage moves, company chips, failure signals](ai-workforce-stages-and-signals.md) — 4KB
- [Insight generation: always on the AI Workforce, emailed when ready](insight-generation.md) — 2KB

## App shell & UI

- [App shell (chat-first landing + center console)](app-shell.md) — 21KB
- [Personal tasks (to-dos with reminders)](personal-tasks.md) — 2KB
- [Record-scoped dialogs (`CompanyDetailDialog` and friends)](record-scoped-dialogs.md) — 5KB
- [Live updates (Server-Sent Events)](live-updates-sse.md) — 1KB
- [Workspace table layouts (column order / hidden / groups)](workspace-table-layouts.md) — 3KB
- [In-app feedback (MB-480)](in-app-feedback.md) — 2KB

## Workspaces & auth

- [Google SSO sign-in](google-sso.md) — 6KB
- [Admin routes (`/api/auth`)](admin-routes.md) — 1KB
- [Account invite flow (admin-created users)](account-invite-flow.md) — 2KB
- [User Management (admin portal)](user-management.md) — 4KB
- [Forgot-password flow (AWS SES + Vercel Queues)](forgot-password-flow.md) — 3KB
- [Workspace display currency (USD / IDR / CNY)](workspace-display-currency.md) — 2KB
- [Workspace soft delete (archive / reinstate)](workspace-soft-delete.md) — 3KB
- [Iframe embedding (Brain Launcher)](iframe-embedding.md) — 3KB

## Platform

- [Runtime feature toggles](runtime-feature-toggles.md) — 2KB
- [Product telemetry (PostHog)](product-telemetry.md) — 8KB
- [Langfuse agent tracing](langfuse-tracing.md) — 6KB
