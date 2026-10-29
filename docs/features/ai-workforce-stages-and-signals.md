# AI Workforce: stage moves, company chips, failure signals

How a Workforce task moves companies between stages, links the companies it
touches, and tells its owner when it fails or is busy.

## Stage moves: `lookup_pipeline_stage` + `move_stage`

The workforce agent has no hardcoded "promote to L0 / L1" tools. It walks the
workspace's **stage ladder** — Pending Confirmation (`unreviewed`), then the
live pipeline stages in position order — one step at a time.

- `lookup_pipeline_stage(company_name)` reports the company's current stage
  key, the full ladder, the previous and next stage, and which moves need
  approval. The agent must call it first.
- `move_stage(company_name, from_stage, to_stage, reason, note?, …L0 fields)`
  refuses unless `from_stage` still equals the company's stage (so a stale
  lookup can't move it) and `to_stage` is the previous or next rung. A company
  in an intake bucket (`market_screening`, `discovered`) or with no stage may
  enter at Pending Confirmation or straight at L0, with any missing L0 entry
  fields passed in the same call.
- Ladder, neighbours and the approval rule are pure helpers in
  `src/lib/pipeline/stageMoves.ts`, shared by both tools so "next" in the
  lookup is exactly what the move accepts.

**Approval.** Moves among the intake buckets, Pending Confirmation and L0 run
unattended; any move into or out of a stage after L0 pauses for a human.
`humanInTheLoopMiddleware` can only gate a tool name as a whole, so
`move_stage` is *not* in `WORKFORCE_HITL_INTERRUPT_ON`: it calls LangGraph's
`interrupt()` itself with the same HITLRequest shape (`actionRequests`) and
reads the same resume value (`{ decisions: [...] }`). `runAgent`, the decision
route, the trace's intervention card and the approval email treat it like a
middleware pause. On resume the tool re-runs from the top, so everything
before the interrupt is read-only; the interrupt sits outside the tool's
`try` so the pause reaches the graph rather than becoming a tool error.

## "Open <company>" chips in the trace

Company-returning tools (`query_companies`, `get_company_details`, the two
stage tools) append the hidden id↔name manifest from
`src/lib/navigation/companyMentions.ts`. `buildTrace` collects every manifest
seen so far in the run and, per step, chips the companies whose names appear in
that step's title, overview, prose or tool args — the copilot's matcher, so a
50-row query only chips what the step actually names. The manifest is stripped
from the rendered tool output. `TraceLine` renders the chips under the step's
card (`CompanyChip`, telemetry source `workforce_trace`).

## Failure emails

Every way a run fails on its own emails its owner (the triggerer, or a cron
run's routine creator): agent errors and publish refusals via `markFailedStep`,
a run that died before its first step loaded (`markFailedPreload`), and the
stuck-run reaper (`reapStuckRuns`), the last two through
`src/lib/workforce/notifyFailure.ts`. These failure emails ignore the Task
Notifications toggle; a user's own cancellation stays behind it.

## Workforce nav badges

`GET /api/workforce-queue/summary` (`AiWorkforceService.getNavSummary`, one
aggregate query, workspace-wide) feeds the sidebar's AI Workforce item. The
chips are derived in `src/components/layout/navBadges.ts`:

- **red cross + count** — the workspace's recent failures: `failed` /
  `timed_out` runs, not cancellations, that finished
  (`COALESCE(ended_at, created_at)`) in the last 24 hours. Every one of them is
  in the rail's History, so the chip and the page always agree;
- **yellow chip with a blinking dot + count** — the queue: pending +
  resume-ready + running. Hidden when the queue is empty.

On the collapsed icon rail the item gets one corner dot instead (red if
anything failed, otherwise yellow), blinking while the queue has work.

The sidebar polls the summary every 5 seconds and on window focus; a failure
drops off the red count once it is more than 24 hours old. Opening a task no
longer changes the count (`failure_seen_at` is unused — see `TECH_DEBT.md`).

## The rail: live sections and History

`GET /api/workforce-queue` returns only the workspace's unfinished runs
(`AiWorkforceService.listActiveQueue`) — Needs action, In progress and Queued.
Finished runs are the **History** group, paged from
`GET /api/workforce-queue/history?cursor=&q=&limit=` (`listHistory`): newest
finished first, keyset-paged on `(COALESCE(ended_at, created_at), id)` with an
opaque `next_cursor`, backed by `idx_ai_workforce_queue_workspace_finished`.
History is not limited to today. `WorkforceTasks` loads the next page when a
sentinel at the end of the list scrolls into view, and its search box queries
the server (title, or instruction for untitled runs) rather than filtering what
is loaded. Live events and the fallback poll re-read only History's first
page and keep older pages already scrolled in beneath it. A routine's "N runs
total" comes from `run_count` on `GET /api/routines`, one grouped count.
