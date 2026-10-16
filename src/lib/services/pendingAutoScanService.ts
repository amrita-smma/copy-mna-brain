import type { CompanyRepository, ScreeningRepository, Tables } from '@/lib/repositories';
import { UNREVIEWED_STAGE } from '@/lib/constants';
import { FIRST_STAGE_KEY } from '@/lib/pipeline/stages';
import {
  companyScreeningVerdict,
  type ScreeningVerdict,
} from '@/lib/screening/verdict';
import type { AIScreeningService } from './aiScreeningService';
import { CompanyL0RequirementsError, type CompanyService } from './companyService';
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
  /** What the scan did, step by step — the `run_ai_screening` tool reports it. */
  steps: string[];
}

type Company = Tables<'companies'>;

const isActivePending = (c: Company | null): c is Company =>
  !!c && c.pipeline_stage === UNREVIEWED_STAGE && c.status === 'active';

/**
 * Sourcing → Pending Confirmation automation.
 *
 * Every scan is an `ai_screening` AI Workforce task, one per company
 * (`AIScreeningService.enqueue`), so it shows up — and can be followed,
 * retried or cancelled — in AI Workforce. The task's `run_ai_screening` tool
 * calls {@link processCompany}: match the company to tracks (when it has
 * none), screen it against each matched track's criteria, then — when the
 * workspace has auto drop/promote on — promote it to L0 on an overall `pass`
 * or drop it on a `fail`.
 */
export class PendingAutoScanService {
  constructor(
    private readonly workspaceId: string,
    private readonly companyRepo: CompanyRepository,
    private readonly screeningRepo: ScreeningRepository,
    private readonly workspaceService: WorkspaceService,
    private readonly companyService: CompanyService,
    private readonly aiScreeningService: AIScreeningService,
    private readonly trackMatchingService: TrackMatchingService,
  ) {}

  /**
   * A company just landed in Pending Confirmation. Queues its scan when the
   * workspace has auto-scan on; returns whether it did, so a caller with its
   * own screening fallback (Smart Files) can skip that.
   */
  async onCompanyEnteredPending(companyId: string): Promise<boolean> {
    const { autoScan } = await this.workspaceService.getPendingAutomation(this.workspaceId);
    if (!autoScan) return false;
    const { queued, alreadyQueued } = await this.aiScreeningService.enqueue([companyId], {
      mode: 'pending_scan',
      force: false,
    });
    return queued.length + alreadyQueued.length > 0;
  }

  /**
   * The Scan now button: queue a screening task for every active Pending
   * Confirmation company, re-screening all of its criteria, whatever the
   * auto-scan toggle says. Companies already queued or scanning are skipped.
   */
  async scanNow(
    triggeredByUserId: string | null,
  ): Promise<{ queued: number; alreadyQueued: number }> {
    const ids = await this.companyRepo.findActiveIdsByStage(UNREVIEWED_STAGE);
    const { queued, alreadyQueued } = await this.aiScreeningService.enqueue(ids, {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId,
    });
    return { queued: queued.length, alreadyQueued: alreadyQueued.length };
  }

  /** Match → screen → (optionally) drop/promote one company. Runs inside its AI Workforce task. */
  async processCompany(
    companyId: string,
    opts: { force: boolean },
  ): Promise<PendingAutoScanResult> {
    const steps: string[] = [];
    const done = (r: Omit<PendingAutoScanResult, 'companyId' | 'steps'>): PendingAutoScanResult => ({
      companyId,
      ...r,
      steps,
    });

    let company = await this.companyRepo.findByIdOrNull(companyId);
    if (!isActivePending(company)) {
      steps.push('Skipped: no longer an active Pending Confirmation company');
      return done({ outcome: 'skipped' });
    }

    // 1. Match — only when nothing is matched yet (a Smart Files row arrives
    //    with the extraction agent's suggested tracks already persisted).
    if (!company.matched_track_ids?.length) {
      const matched = await this.trackMatchingService.runSync({ companyId });
      steps.push(`Matched ${matched.matchedTrackIds.length} track(s) via ${matched.via}`);
      company = await this.companyRepo.findById(companyId);
    }

    // 2. Screen each matched track's criteria.
    const { groups, screened, tracks } = await this.aiScreeningService.screenMatchedTracks(
      company,
      { force: opts.force },
    );
    if (groups.length === 0) {
      steps.push('No matched track has screening criteria; left pending');
      return done({ outcome: 'no_screenable_tracks' });
    }
    steps.push(`Screened ${screened} criteria across ${groups.length} track(s)`);

    // 3. Verdict over the current matched tracks' current criteria only.
    const inScope = new Set(
      groups.flatMap((g) => g.criteriaIds.map((c) => `${g.trackId}:${c}`)),
    );
    const rows = (await this.screeningRepo.findByCompanyIds([companyId])).filter((s) =>
      inScope.has(`${s.track_id}:${s.criteria_id}`),
    );
    const verdict = companyScreeningVerdict(rows);
    steps.push(`Verdict: ${verdict}`);

    // 4. Drop / promote — the setting is re-read now, since a scan takes minutes.
    const { autoDropPromote } = await this.workspaceService.getPendingAutomation(
      this.workspaceId,
    );
    if (!autoDropPromote || (verdict !== 'pass' && verdict !== 'fail')) {
      steps.push(
        autoDropPromote ? 'Inconclusive; left pending' : 'Auto drop / promote is off; left pending',
      );
      return done({ outcome: 'scanned', verdict, screened });
    }

    // A human may have triaged it while it was being screened.
    const current = await this.companyRepo.findByIdOrNull(companyId);
    if (!isActivePending(current)) {
      steps.push('Skipped drop/promote: company was moved while screening');
      return done({ outcome: 'skipped', verdict, screened });
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
          steps.push(`Passed screening but L0 requirements are missing; left pending: ${err.message}`);
          return done({ outcome: 'promote_blocked', verdict, screened, detail: err.message });
        }
        throw err;
      }
      steps.push('Promoted to L0');
      return done({ outcome: 'promoted', verdict, screened });
    }

    await this.companyService.dropDeal(
      companyId,
      UNREVIEWED_STAGE,
      `Auto-dropped: failed AI screening (${trackNames})`,
    );
    steps.push('Dropped');
    return done({ outcome: 'dropped', verdict, screened });
  }
}
