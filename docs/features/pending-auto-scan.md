# Pending Confirmation auto-scan, auto drop/promote, and Scan now

The Pending Confirmation bucket (companies at `pipeline_stage = 'unreviewed'`)
carries two workspace-wide toggles and a button (`PendingAutomationToggles`), in
two places: the Pending Confirmation card on Sourcing (`/sourcing`), and a bar
above the table on Pipeline while its Pending Confirmation chip is active:

| Control | Effect |
|---|---|
| **Auto-scan** | A company entering Pending Confirmation is matched to tracks (investment theses) and AI-screened against each matched track's criteria. Only companies that arrive after it is switched on — the ones already waiting are left alone (use Scan now for those). |
| **Auto drop / promote** | After a scan: an overall **pass** promotes the company to L0, a **fail** drops it. **Inconclusive** (or no matched track with criteria) leaves it pending for a human. Requires Auto-scan. |
| **Scan now** | Queues every active pending company for a fresh match + screen, re-running criteria that already have a result, whatever Auto-scan says. Auto drop/promote still applies afterwards when it is on. |

Settings live on `workspaces.pending_auto_scan` / `pending_auto_drop_promote`
(`GET/PUT /api/pending-automation`). Scan now is `POST /api/pending-automation/scan`.

## How a scan runs

1. **Queue.** Requests only mark rows: `companies.auto_scan_requested_at`
   (+ `auto_scan_force` for Scan now) via `CompanyRepository.requestAutoScan*`.
   Arrival points: `CompanyService.createFromDTO` for a company created at
   `unreviewed`, and Smart Files' two auto-create paths (which, when Auto-scan
   is on, skip their own suggested-track screening so nothing is screened twice).
2. **Drain.** `/api/cron/pending-auto-scan` (every minute, `vercel.json`) claims
   up to `PENDING_AUTO_SCAN_BATCH_SIZE` rows across workspaces
   (`AutoScanQueueRepository.claim`, `FOR UPDATE SKIP LOCKED`) and starts one
   `pending_auto_scan` job per company. Queuing marks rather than job rows keeps
   a large backlog from tripping the stuck-job sweep while it waits, and keeps
   each job inside one function's time limit.
3. **Process** (`PendingAutoScanService.processCompany`, logged to `job_logs`):
   - skip unless still active in Pending Confirmation;
   - run track matching inline when nothing is matched yet;
   - build per-track groups (`buildTrackScreeningGroups`), drop criteria already
     completed unless forced, `ScreeningService.prepare`, then screen every
     criterion in parallel — each as its own `ai_screening` job row run inline
     (`AIScreeningService.runInline`);
   - compute the verdict over the current matched tracks' current criteria
     (`companyScreeningVerdict`), re-read the toggle, re-check the company is
     still pending, then `promote(…, 'unreviewed', 'L0', …)` or
     `dropDeal(…, 'unreviewed', …)`. A promote blocked by missing L0 fields
     leaves the company pending.

## Verdict rule

`src/lib/screening/verdict.ts`, shared with the AI Screening progress panel.
Per track: **pass** = ≥3 passes and ≤1 fail; **fail** = ≥1 fail otherwise;
else inconclusive (`error` results count as fails). Per company: pass if any
track passes, fail if every track fails, otherwise inconclusive.

## Local development

Vercel crons don't run under `vercel dev`; hit
`GET /api/cron/pending-auto-scan` to drain the queue by hand.
