# Pending Confirmation auto-scan, auto promote / auto drop, and Scan now

The Pending Confirmation bucket (companies at `pipeline_stage = 'unreviewed'`)
carries three workspace-wide toggles and a button (`PendingAutomationToggles`), in
two places: the Pending Confirmation card on Sourcing (`/sourcing`), and a bar
above the table on Pipeline while its Pending Confirmation chip is active:

| Control | Effect |
|---|---|
| **Auto-scan** | A company entering Pending Confirmation is matched to tracks (investment theses) and AI-screened against each matched track's criteria. Only companies that arrive after it is switched on — the ones already waiting are left alone (use Scan now for those). |
| **Auto promote** | After a scan: an overall **pass** promotes the company to L0. Off → a pass is left pending. Requires Auto-scan. |
| **Auto drop** | After a scan: an overall **fail** drops the company. Off → a fail is left pending. Requires Auto-scan. |
| **Scan now** | Queues a screening task for every active pending company — a fresh match + screen, re-running criteria that already have a result — whatever Auto-scan says. Companies already queued or scanning are skipped. Auto promote / auto drop still apply afterwards when they are on. |

**Inconclusive** (or no matched track with criteria) always leaves the company
pending for a human. Every scan also makes sure the company has a **Company
Card**: one that has never had a completed card gets a generation queued (see
step 2 below).

Settings live on `workspaces.pending_auto_scan` / `pending_auto_promote` /
`pending_auto_drop` (`GET/PUT /api/pending-automation`, body
`{ autoScan, autoPromote, autoDrop }`). Scan now is
`POST /api/pending-automation/scan`.

## AI screening runs on the AI Workforce

Every AI screening — Scan now, Auto-scan, **Run AI Screening** on a Pending
Confirmation row (`POST /api/ai-screening`, the same forced scan as Scan now for
one company; refused with 409 for any other stage), and Smart Files' fallback
screening — is an
`ai_screening` AI Workforce task, **one per company**
(`AIScreeningService.enqueue`). It appears in AI Workforce titled
"AI Screening: <company>", where it can be followed, retried or cancelled.
Results still land on `screenings` rows, which the Pipeline page's AI Screening
tab reads.

1. **Enqueue.** `AIScreeningService.enqueue` skips companies that already have
   a non-terminal `ai_screening` task (`findActiveCompanyIds`), then calls
   `enqueueAgentRun` per company (`triggerSource: 'api'`, `trigger_meta`
   `{ company_id, mode, force }`). A forced run (Scan now, Run AI Screening,
   Smart Files) resets the company's screening rows to `pending` first, so the
   Pipeline tab shows it in progress while the task waits its turn. Arrival
   points for Auto-scan: `CompanyService.createFromDTO` for a company created
   at `unreviewed`; a stage move *into* `unreviewed` from another stage —
   `promote` (Market Scanning's "Add to Pending Confirmation"), `promoteMany`,
   and the Current Stage dropdown (`updateFromDTO`); and Smart Files' two
   auto-create paths (which, when Auto-scan is on, skip their own screening so
   nothing is screened twice). All go through
   `PendingAutoScanService.onCompaniesEnteredPending` (one settings read, one
   enqueue per batch).
2. **Run.** The Workforce queue runs one task at a time across all workspaces,
   so a large Scan now works through companies one by one, interleaved with
   other Workforce tasks. The task's instruction tells the agent to call the
   `run_ai_screening` tool once with `mode`:
   - `pending_scan` → `PendingAutoScanService.processCompany`: skip unless
     still active in Pending Confirmation; queue the Company Card when the
     company has no completed card and no card run in flight
     (`CompanyAnalysisService.generateIfMissing` — a separate `company_card`
     Workforce task, best-effort, never blocks the scan); match tracks inline when nothing is
     matched; screen; compute the verdict over the current matched tracks'
     current criteria (`companyScreeningVerdict`); re-read the toggles and
     re-check the company is still pending; then `promote(…, 'unreviewed',
     'L0', …)` on a pass when Auto promote is on, or `dropDeal(…,
     'unreviewed', …)` on a fail when Auto drop is on. A promote blocked by missing
     L0 fields leaves the company pending. A blank **Entered By** does not
     block it: the promote defaults it to the task's user
     (`triggered_by_user_id`) — whoever pressed Scan now / Run AI Screening,
     or, for an Auto-scan arrival, whoever moved the company in (Market
     Scanning, bulk move, Current Stage dropdown) or whose Smart File created
     it. An existing Entered By is never overwritten.

     The task runs on the general Workforce agent, which also holds
     `promote_to_l0` and `drop_company`. Those tools refuse inside an
     `ai_screening` task (`runAgent` puts the row's `agent_name` on the tool
     config; `src/lib/screening/screeningRunGuard.ts`), so the toggles cannot
     be bypassed by the model promoting or dropping a company the scan left
     pending.
   - `tracks` → `AIScreeningService.screenCompanyTracks`: screen the matched
     tracks only and report each track's verdict; never moves the deal (Smart
     Files' fallback for a company outside Pending Confirmation).

   Both screen through `AIScreeningService.screenMatchedTracks`: every
   criterion at once via `runAIScreening`, without a `jobs` row. Without
   `force`, criteria that already have a completed result are skipped.
3. **Clean up.** When an `ai_screening` task fails, is cancelled or reaped, or
   finishes without running the tool, `failScreeningsIfStillPending` fails the
   company's screenings still at `pending` (wired next to
   `failAiOpinionIfStillProcessing` in `runAgent`, the reaper and the cancel
   route).

## Pipeline → AI Screening panel

`ScreeningProgressPanel` on the Pipeline page lists screenings for active
companies in **Pending Confirmation and L0** (`GET /api/screenings?inScreening=true`,
stage list in `src/lib/screening/scope.ts`), each tagged with its stage. Its
promote button moves a Pending Confirmation company to L0, and an L0 deal to the
stage after L0.

Each company also shows its newest `ai_screening` task — Queued, Running, Done,
Failed… — as a **View task** link to `/ai-workforce/tasks/<runId>`. A company
whose task is queued but hasn't written screening rows yet (an Auto-scan
arrival) sits under "Queued in AI Workforce". The task status comes from its own
live stream, `GET /api/ai-screening/tasks/stream`
(`AIScreeningService.listCompanyTasks` → one `DISTINCT ON` query,
`idx_ai_workforce_queue_ai_screening_company`), because a task queuing or
starting doesn't touch its screening rows. Pipeline holds the one subscription
and feeds both the panel and the row "AI Screening Running" spinners from it.

Clicking a card opens the company dialog on its **Pre-pipeline Filters** tab —
the screening results per track (formerly "L1 Filters").

## Verdict rule

`src/lib/screening/verdict.ts`, shared with the AI Screening progress panel.
Each track is judged by its own pass rule — must-pass criteria plus a minimum
number of optional criteria (see [track-screening-rule.md](track-screening-rule.md));
a track with neither configured keeps the default: **pass** = ≥3 passes and
≤1 fail, **fail** = ≥1 fail otherwise, else inconclusive (`error` results
count as fails). Per company: pass if any track passes, fail if every track
fails, otherwise inconclusive.

## Local development

Tasks start as soon as they are queued (`enqueueAgentRun` ticks the
dispatcher), so screening works under `vercel dev` without a cron.
