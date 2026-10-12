# Filling a CRM contact from the web (`@crm_contact`)

Every contact row in the CRM has a ✨ button next to the person's name. Pressing
it queues an AI Workforce run that searches the public web for that person,
confirms it found the right one, and writes what it can prove into the contact's
empty profile fields.

It exists because most correspondents arrive from the mailbox ingest, which only
ever knows a name and an email address — the title, desk, coverage region and
LinkedIn URL are all blank until somebody fills them in by hand.

## What happens when you press it

1. `POST /api/crm/correspondents/:id/enrich` → `CrmContactEnrichmentService`
   puts a row on `ai_workforce_queue` with `agent_name = 'crm_contact'` and
   `trigger_meta.correspondent_id`.
2. The workforce dispatcher claims it. `src/lib/workforce/runAgent.ts` sees that
   agent name and builds **@crm_contact's** graph rather than the general
   workforce one.
3. The agent calls `get_crm_contact` to see what is missing, searches, and
   calls `update_crm_contact` once with everything it can evidence.
4. The button polls `GET /api/crm/correspondents/:id/enrich` and refreshes the
   card when the run succeeds.

Because the run is a normal Workforce row, you can close the CRM page and watch
it from `/ai-workforce` instead — with the trace panel, cancellation and retries
every other task gets. Reopening the CRM card mid-run shows the spinner again
rather than offering to start a second run.

That resumed state comes from **one** request, not one per row. Opening the
contacts tab calls `GET /api/crm/employers/:id/contact-enrichment`, which
returns every contact's latest run keyed by correspondent id (a single
`DISTINCT ON` behind `findLatestByCorrespondentIds`), and each button is handed
its own as a prop. A button that is actually watching a run then polls the
per-contact endpoint on its own. A GET per rendered contact would be the
client-side fan-out `CLAUDE.md` bans.

## The agent

`src/lib/agents/crm_contact/` — separate from the analysis agent, on the shared
runtime (`buildAgentGraph` → `createAgent`, streaming, checkpointed).

Five tools: `get_crm_contact`, `update_crm_contact`, Anthropic's hosted
`web_search` / `web_fetch`, `valyu_search` and `narrate_step`. No pipeline
tools, no email, no insights — a run can read one contact and write that
contact's overlay, and nothing else. That bounded blast radius is why the button
needs no approval step.

## What it may write, and where

Writes go to **`correspondent_curation`** — the human/agent override table —
through `CRMService.updateContact`, never to the ingest-owned `correspondents`
row. Reads come back merged through the `correspondent_effective` view, so the
next MBOX re-ingest cannot clobber what the agent found. This is the same
overlay the Edit-contact dialog writes to.

Writable: `title`, `phone`, `type`, `department`, `specialization`,
`seniority`, `coverage_region`, `linkedin_url`, `bio`.

**Not** writable — enforced in the tool schema, not just the prompt:

- `name` — renaming is how a confident-but-wrong match becomes invisible.
- `email` — the natural key behind the `(employer_id, email)` ingest upsert, and
  the one editable field that lives on the base table. A guessed address there
  would split the person's email history in two.

## Guards

- **Fill, don't flatten.** A field that already holds an effective value is
  skipped. The agent can override a specific field only by naming it in
  `overwrite`, and is told to do so only against the firm's own current page.
- **No source, no write.** `update_crm_contact` requires a `sources` array; a
  value the agent cannot attribute never reaches the database.
- **Identity before anything.** The prompt's weight is on confirming the person
  is the one at this firm, and on leaving a field blank rather than guessing.
  Sources are reported in the run's final message, not stored on the row.
- **One run per contact.** An in-flight run is returned as-is rather than
  stacked, backed by a per-minute `idempotency_key` for concurrent requests.

## Files

| | |
|---|---|
| Agent | `src/lib/agents/crm_contact/` |
| Service | `src/lib/services/crmContactEnrichmentService.ts` |
| Route | `src/app/api/crm/correspondents/[id]/enrich/route.ts` |
| Batched status | `src/app/api/crm/employers/[id]/contact-enrichment/route.ts` |
| Button | `src/views/crm/FillContactButton.tsx` (rendered by `EmployerCard.tsx`) |
| Workforce routing | `src/lib/workforce/runAgent.ts` (`isCrmContactAgent`) |
