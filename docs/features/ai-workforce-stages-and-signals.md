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
aggregate query) feeds the sidebar's AI Workforce item:

- **red** — the caller's unseen failures: `failed` / `timed_out` runs they own,
  not cancellations, with `failure_seen_at` NULL;
- **amber** — the workspace queue: pending + resume-ready + running;
- **blinking amber dot** — shown while the queue is non-empty.

Opening a failed task (`GET /api/workforce-queue/[id]`) stamps
`failure_seen_at` when the viewer owns it, and `TaskCanvas` refetches the badge.
The migration that added the column marked every earlier failure as seen.
