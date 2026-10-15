import type {
  CompanyRepository,
  CriteriaRepository,
  InvestmentThesisRepository,
  JobRepository,
  ScreeningRepository,
  Tables,
} from '@/lib/repositories';
import { UNREVIEWED_STAGE } from '@/lib/constants';
import { FIRST_STAGE_KEY } from '@/lib/pipeline/stages';
import { buildTrackScreeningGroups } from '@/lib/tracks/matchTracks';
import {
  companyScreeningVerdict,
  type ScreeningVerdict,
} from '@/lib/screening/verdict';
import {
  PENDING_AUTO_SCAN_TIMEOUT_SECONDS,
  runPendingAutoScan,
  type PendingAutoScanPayload,
} from '@/lib/jobs/handlers/pendingAutoScan';
import type { AIScreeningService } from './aiScreeningService';
import { CompanyL0RequirementsError, type CompanyService } from './companyService';
import type { JobDispatcher } from './jobDispatcher';
import type { ScreeningService } from './screeningService';
import type { TrackMatchingService } from './trackMatchingService';
import type { WorkspaceService } from './workspaceService';

export type PendingAutoScanOutcome =
  /** No longer an active Pending Confirmation company — nothing was done. */
  | 'skipped'
  /** No matched track has screening criteria, so there was nothing to screen. */
  | 'no_screenable_tracks'
  /** Screened; auto drop/promote is off or the verdict was inconclusive. */
  | 'scanned'
  | 'promoted'
  | 'dropped'
  /** Passed screening but is missing fields L0 requires; left pending. */
  | 'promote_blocked';

export interface PendingAutoScanResult {
  companyId: string;
  outcome: PendingAutoScanOutcome;
  verdict?: ScreeningVerdict | 'pending';
  screened?: number;
  detail?: string;
}

type Company = Tables<'companies'>;

const isActivePending = (c: Company | null): c is Company =>
  !!c && c.pipeline_stage === UNREVIEWED_STAGE && c.status === 'active';

/**
 * Sourcing → Pending Confirmation automation.
 *
 * Requests only mark companies (`companies.auto_scan_requested_at`); the
 * per-minute `/api/cron/pending-auto-scan` drain claims a few at a time and
 * runs one `pending_auto_scan` job per company, so a large backlog never
 * outlives a function's time limit or trips the stuck-job sweep while queued.
 *
 * Per company: match it to tracks (when it has none), screen it against each
 * matched track's criteria, then — when the workspace has auto drop/promote on
 * — promote it to L0 on an overall `pass` or drop it on a `fail`.
 */
export class PendingAutoScanService {
  constructor(
    private readonly workspaceId: string,
    private readonly companyRepo: CompanyRepository,
    private readonly screeningRepo: ScreeningRepository,
    private readonly criteriaRepo: CriteriaRepository,
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly jobRepo: JobRepository,
    private readonly workspaceService: WorkspaceService,
    private readonly companyService: CompanyService,
    private readonly screeningService: ScreeningService,
    private readonly aiScreeningService: AIScreeningService,
    private readonly trackMatchingService: TrackMatchingService,
    private readonly jobDispatcher: JobDispatcher,
  ) {}

  /**
   * A company just landed in Pending Confirmation. Queues its scan when the
   * workspace has auto-scan on; returns whether it did, so a caller with its
   * own screening fallback (Smart Files) can skip that.
   */
  async onCompanyEnteredPending(companyId: string): Promise<boolean> {
    const { autoScan } = await this.workspaceService.getPendingAutomation(this.workspaceId);
    if (!autoScan) return false;
    return (await this.companyRepo.requestAutoScan([companyId], false)) > 0;
  }

  /**
   * The Scan now button: queue every active Pending Confirmation company and
   * re-screen all of its criteria, whatever the auto-scan toggle says.
   */
  scanNow(): Promise<number> {
    return this.companyRepo.requestAutoScanForPending(true);
  }

  /** Put a company back on the queue after claim cleared its mark but dispatch failed. */
  requeueScan(companyId: string, force: boolean): Promise<number> {
    return this.companyRepo.requestAutoScan([companyId], force);
  }

  /** Start one claimed company's scan as a background `pending_auto_scan` job. */
  dispatchScan(companyId: string, force: boolean): Promise<{ jobId: string }> {
    const payload: PendingAutoScanPayload = {
      companyId,
      force,
      workspaceId: this.workspaceId,
    };
    return this.jobDispatcher.dispatch({
      type: 'pending_auto_scan',
      payload: payload as unknown as Record<string, unknown>,
      timeoutSeconds: PENDING_AUTO_SCAN_TIMEOUT_SECONDS,
      work: ({ db, job }) => runPendingAutoScan(payload, { db, job }),
    });
  }

  /** Match → screen → (optionally) drop/promote one company. Runs inside its job. */
  async processCompany(
    companyId: string,
    opts: { force: boolean; jobId?: string },
  ): Promise<PendingAutoScanResult> {
    const log = (message: string, metadata?: Record<string, unknown>) =>
      opts.jobId
        ? this.jobRepo
            .appendLog(opts.jobId, { message, metadata })
            .catch((err) => console.error('[pendingAutoScan] failed to write job log:', err))
        : Promise.resolve();

    let company = await this.companyRepo.findByIdOrNull(companyId);
    if (!isActivePending(company)) {
      await log('Skipped: no longer an active Pending Confirmation company');
      return { companyId, outcome: 'skipped' };
    }

    // 1. Match — only when nothing is matched yet (a Smart Files row arrives
    //    with the extraction agent's suggested tracks already persisted).
    if (!company.matched_track_ids?.length) {
      const matched = await this.trackMatchingService.runSync({ companyId });
      await log('Matched tracks', { trackIds: matched.matchedTrackIds, via: matched.via });
      company = await this.companyRepo.findById(companyId);
    }

    // 2. Screen each matched track's criteria. Tracks + criteria are one read
    //    each, whatever the number of tracks.
    const [tracks, criteria] = await Promise.all([
      this.thesisRepo.findAll(),
      this.criteriaRepo.findAll(),
    ]);
    const groups = buildTrackScreeningGroups(company, tracks, criteria);
    if (groups.length === 0) {
      await log('No matched track has screening criteria; leaving pending');
      return { companyId, outcome: 'no_screenable_tracks' };
    }
    const inScope = new Set(
      groups.flatMap((g) => g.criteriaIds.map((c) => `${g.trackId}:${c}`)),
    );

    let toRun = groups;
    if (!opts.force) {
      const existing = await this.screeningRepo.findByCompanyIds([companyId]);
      const done = new Set(
        existing
          .filter((s) => s.state === 'completed')
          .map((s) => `${s.track_id}:${s.criteria_id}`),
      );
      toRun = groups
        .map((g) => ({
          ...g,
          criteriaIds: g.criteriaIds.filter((c) => !done.has(`${g.trackId}:${c}`)),
        }))
        .filter((g) => g.criteriaIds.length > 0);
    }

    let screened = 0;
    if (toRun.length > 0) {
      const entries = await this.screeningService.prepare(
        toRun.map((g) => ({ companyId, trackId: g.trackId, criteriaIds: g.criteriaIds })),
      );
      const promptById = new Map(criteria.map((c) => [c.id, c.prompt]));
      const name = company.target?.trim() || company.project_name?.trim() || 'Unknown';
      await log('Screening started', { criteria: entries.length, tracks: toRun.length });
      // Every criterion at once, as the manual Run AI Screening does; each is
      // its own `ai_screening` job row and writes its own screening row.
      await Promise.all(
        entries.map((entry) =>
          this.aiScreeningService
            .runInline({
              companyId,
              criteriaId: entry.criteria_id,
              criteriaPrompt: promptById.get(entry.criteria_id) ?? '',
              screeningId: entry.id,
              company: { id: companyId, name },
            })
            .catch((err) =>
              log('Criterion screening failed to start', {
                criteriaId: entry.criteria_id,
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
        ),
      );
      screened = entries.length;
    }

    // 3. Verdict over the current matched tracks' current criteria only.
    const rows = (await this.screeningRepo.findByCompanyIds([companyId])).filter((s) =>
      inScope.has(`${s.track_id}:${s.criteria_id}`),
    );
    const verdict = companyScreeningVerdict(rows);
    await log('Screening finished', { verdict, screened });

    // 4. Drop / promote — the setting is re-read now, since a scan takes minutes.
    const { autoDropPromote } = await this.workspaceService.getPendingAutomation(
      this.workspaceId,
    );
    if (!autoDropPromote || (verdict !== 'pass' && verdict !== 'fail')) {
      return { companyId, outcome: 'scanned', verdict, screened };
    }

    // A human may have triaged it while it was being screened.
    const current = await this.companyRepo.findByIdOrNull(companyId);
    if (!isActivePending(current)) {
      await log('Skipped drop/promote: company was moved while screening');
      return { companyId, outcome: 'skipped', verdict, screened };
    }

    const trackNames = tracks
      .filter((t) => groups.some((g) => g.trackId === t.id))
      .map((t) => t.title?.trim() || 'Untitled track')
      .join(', ');

    if (verdict === 'pass') {
      try {
        await this.companyService.promote(
          companyId,
          UNREVIEWED_STAGE,
          FIRST_STAGE_KEY,
          undefined,
          undefined,
          undefined,
          undefined,
          `Auto-promoted: passed AI screening (${trackNames})`,
        );
      } catch (err) {
        if (err instanceof CompanyL0RequirementsError) {
          await log('Passed screening but L0 requirements are missing; left pending', {
            error: err.message,
          });
          return {
            companyId,
            outcome: 'promote_blocked',
            verdict,
            screened,
            detail: err.message,
          };
        }
        throw err;
      }
      await log('Promoted to L0');
      return { companyId, outcome: 'promoted', verdict, screened };
    }

    await this.companyService.dropDeal(
      companyId,
      UNREVIEWED_STAGE,
      `Auto-dropped: failed AI screening (${trackNames})`,
    );
    await log('Dropped');
    return { companyId, outcome: 'dropped', verdict, screened };
  }
}
