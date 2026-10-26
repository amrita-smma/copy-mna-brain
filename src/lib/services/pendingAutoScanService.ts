import type {
  CompanyRepository,
  InvestmentThesisRepository,
  ScreeningRepository,
  Tables,
} from '@/lib/repositories';
import { UNREVIEWED_STAGE } from '@/lib/constants';
import { FIRST_STAGE_KEY } from '@/lib/pipeline/stages';
import {
  isInScanSelection,
  selectedTrackIdsFor,
  type ScanNowPreview,
  type ScanNowSelection,
} from '@/lib/sourcing/pendingAutomation';
import { persistedTrackIds, resolveTrackIds } from '@/lib/tracks/matchTracks';
import {
  companyScreeningVerdict,
  type ScreeningVerdict,
} from '@/lib/screening/verdict';
import type { AIScreeningService } from './aiScreeningService';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { CompanyRelationshipService } from './companyRelationshipService';
import { CompanyPipelineRequirementsError, type CompanyService } from './companyService';
import type { TrackMatchingService } from './trackMatchingService';
import type { WorkspaceService } from './workspaceService';

export type PendingAutoScanOutcome =
  /** No longer an active Pending Confirmation company — nothing was done. */
  | 'skipped'
  /** No matched (or, with a track selection, no selected) track has screening criteria, so there was nothing to screen. */
  | 'no_screenable_tracks'
  /** Screened; the verdict was inconclusive, or the matching auto promote / auto drop toggle is off. */
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
 * calls {@link processCompany}: generate its Company Card first when it has none, match
 * the company to tracks (when it has none), screen it against each matched
 * track's criteria, then promote it to L0 on an overall `pass` (when the
 * workspace has auto promote on) or drop it on a `fail` (when it has auto drop
 * on).
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
    private readonly companyAnalysisService: CompanyAnalysisService,
    private readonly companyRelationshipService: CompanyRelationshipService,
    private readonly thesisRepo: InvestmentThesisRepository,
  ) {}

  /**
   * A company just landed in Pending Confirmation. Queues its scan when the
   * workspace has auto-scan on; returns whether it did, so a caller with its
   * own screening fallback (Smart Files) can skip that.
   *
   * `triggeredByUserId` — who brought it in (moved it from Market Scanning,
   * uploaded its Smart File) — goes on the scan task, so an auto-promote can
   * default a blank Entered By to them.
   */
  async onCompanyEnteredPending(
    companyId: string,
    triggeredByUserId: string | null = null,
  ): Promise<boolean> {
    return (await this.onCompaniesEnteredPending([companyId], triggeredByUserId)) > 0;
  }

  /**
   * Bulk form of {@link onCompanyEnteredPending} for a stage move that lands
   * several companies in Pending Confirmation at once: one settings read and
   * one enqueue. Returns how many are queued (or already were).
   */
  async onCompaniesEnteredPending(
    companyIds: string[],
    triggeredByUserId: string | null = null,
  ): Promise<number> {
    if (companyIds.length === 0) return 0;
    const { autoScan } = await this.workspaceService.getPendingAutomation(this.workspaceId);
    if (!autoScan) return 0;
    const { queued, alreadyQueued } = await this.aiScreeningService.enqueue(companyIds, {
      mode: 'pending_scan',
      force: false,
      triggeredByUserId,
    });
    return queued.length + alreadyQueued.length;
  }

  /**
   * The Scan now button: queue a screening task for every active Pending
   * Confirmation company, re-screening all of its criteria, whatever the
   * auto-scan toggle says. With a `selection`, only the companies matched to
   * a selected track (and the unmatched ones when it includes them) are
   * queued, and each matched one is screened against the selected tracks it
   * is matched to only — each separately; it passes when any of them passes.
   * Companies already queued or scanning are skipped.
   */
  async scanNow(
    triggeredByUserId: string | null,
    selection: ScanNowSelection | null = null,
  ): Promise<{ queued: number; alreadyQueued: number }> {
    if (!selection) {
      const ids = await this.companyRepo.findActiveIdsByStage(UNREVIEWED_STAGE);
      return this.enqueueScan(ids, triggeredByUserId);
    }
    const { pending } = await this.pendingWithResolvedTracks();
    const inSelection = pending.filter((c) => isInScanSelection(c.trackIds, selection));
    if (inSelection.length === 0) return { queued: 0, alreadyQueued: 0 };
    // Unmatched companies are left out of the map: they are matched during
    // the scan and screened against every track they are matched to.
    const trackIdsByCompany = new Map(
      inSelection
        .filter((c) => c.trackIds.length > 0)
        .map((c) => [c.id, selectedTrackIdsFor(c.trackIds, selection)]),
    );
    return this.enqueueScan(
      inSelection.map((c) => c.id),
      triggeredByUserId,
      trackIdsByCompany,
    );
  }

  private async enqueueScan(
    ids: string[],
    triggeredByUserId: string | null,
    trackIdsByCompany?: ReadonlyMap<string, string[]>,
  ): Promise<{ queued: number; alreadyQueued: number }> {
    const { queued, alreadyQueued } = await this.aiScreeningService.enqueue(ids, {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId,
      ...(trackIdsByCompany && trackIdsByCompany.size > 0 ? { trackIdsByCompany } : {}),
    });
    return { queued: queued.length, alreadyQueued: alreadyQueued.length };
  }

  /**
   * What Scan now could queue right now, for its confirmation dialog: the
   * active Pending Confirmation companies not already queued or scanning,
   * each with the tracks it is matched to and whether it has a Company Card
   * (one without generates it before it is screened, so it takes longer), and
   * the tracks those companies are matched to, for the track selector.
   */
  async previewScanNow(): Promise<ScanNowPreview> {
    const { pending, tracks } = await this.pendingWithResolvedTracks();
    if (pending.length === 0) return { tracks: [], companies: [] };
    const inFlight = await this.aiScreeningService.findInFlightCompanyIds(
      pending.map((c) => c.id),
    );
    const toScan = pending.filter((c) => !inFlight.has(c.id));
    if (toScan.length === 0) return { tracks: [], companies: [] };
    const withCard = await this.companyAnalysisService.findCompanyIdsWithCard(
      toScan.map((c) => c.id),
    );
    const usedTrackIds = new Set(toScan.flatMap((c) => c.trackIds));
    return {
      tracks: tracks
        .filter((t) => usedTrackIds.has(t.id))
        .map((t) => ({ id: t.id, title: t.title?.trim() || 'Untitled track' })),
      companies: toScan.map((c) => ({ trackIds: c.trackIds, hasCard: withCard.has(c.id) })),
    };
  }

  /**
   * Active Pending Confirmation companies with the tracks they are matched
   * to, resolved exactly as the Pipeline's Track filter does
   * (`resolveTrackIds`): the saved matches that still exist, else the keyword
   * suggestion. A company with neither counts as unmatched. Also returns the
   * workspace's tracks.
   */
  private async pendingWithResolvedTracks(): Promise<{
    pending: Array<{ id: string; trackIds: string[] }>;
    tracks: Tables<'investment_thesis'>[];
  }> {
    const [pending, tracks] = await Promise.all([
      this.companyRepo.findActiveTrackMatchesByStage(UNREVIEWED_STAGE),
      this.thesisRepo.findAll(),
    ]);
    return {
      pending: pending.map((c) => ({
        id: c.id,
        trackIds: [...new Set(resolveTrackIds(c, tracks))],
      })),
      tracks,
    };
  }

  /**
   * Card → match → screen → (optionally) drop/promote one company. Runs inside
   * its AI Workforce task. `triggeredByUserId` is the task's user — who pressed Scan
   * now / Run AI Screening, or who moved the company into Pending Confirmation
   * — and fills a blank Entered By on auto-promote, exactly as a manual
   * promote by that user would.
   *
   * `trackIds` is Scan now's track selection for this company: only those of
   * its tracks are screened, and the verdict is over them alone.
   */
  async processCompany(
    companyId: string,
    opts: { force: boolean; triggeredByUserId?: string | null; trackIds?: string[] | null },
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

    // 0. Company Card — a company that never had one gets it generated first,
    //    inline, so it exists before the company is matched and screened.
    //    Best-effort: a failed generation must not cost the screening.
    await this.ensureCompanyCard(companyId, steps);

    // 1. Match — only when nothing is matched yet (a Smart Files row arrives
    //    with the extraction agent's suggested tracks already persisted).
    const trackIds = opts.trackIds?.length ? opts.trackIds : null;
    if (trackIds) {
      company = await this.saveResolvedTracksIfUnmatched(company, steps, trackIds);
    } else if (!company.matched_track_ids?.length) {
      const matched = await this.trackMatchingService.runSync({ companyId });
      steps.push(`Matched ${matched.matchedTrackIds.length} track(s) via ${matched.via}`);
      company = await this.companyRepo.findById(companyId);
    }

    // 2. Screen each matched (or, with a selection, each selected) track's
    //    criteria — one group per track, judged separately.
    const { groups, screened, tracks, rules } = await this.aiScreeningService.screenMatchedTracks(
      company,
      { force: opts.force, ...(trackIds ? { trackIds } : {}) },
    );
    if (groups.length === 0) {
      steps.push(
        trackIds
          ? 'No selected track the company is matched to has screening criteria; left pending'
          : 'No matched track has screening criteria; left pending',
      );
      return done({ outcome: 'no_screenable_tracks' });
    }
    steps.push(`Screened ${screened} criteria across ${groups.length} track(s)`);

    // 3. Verdict over the current matched tracks' current criteria only, each
    //    track judged by its own rule (must-pass + minimum optional passes).
    const inScope = new Set(
      groups.flatMap((g) => g.criteriaIds.map((c) => `${g.trackId}:${c}`)),
    );
    const rows = (await this.screeningRepo.findByCompanyIds([companyId])).filter((s) =>
      inScope.has(`${s.track_id}:${s.criteria_id}`),
    );
    const verdict = companyScreeningVerdict(rows, rules);
    steps.push(`Verdict: ${verdict}`);

    // 4. Drop / promote — the settings are re-read now, since a scan takes minutes.
    if (verdict !== 'pass' && verdict !== 'fail') {
      steps.push('Inconclusive; left pending');
      return done({ outcome: 'scanned', verdict, screened });
    }
    const { autoPromote, autoDrop } = await this.workspaceService.getPendingAutomation(
      this.workspaceId,
    );
    if (verdict === 'pass' && !autoPromote) {
      steps.push('Passed; auto promote is off, left pending');
      return done({ outcome: 'scanned', verdict, screened });
    }
    if (verdict === 'fail' && !autoDrop) {
      steps.push('Failed; auto drop is off, left pending');
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
          { triggeredByUserId: opts.triggeredByUserId ?? null },
        );
      } catch (err) {
        if (err instanceof CompanyPipelineRequirementsError) {
          steps.push(`Passed screening but required fields are missing; left pending: ${err.message}`);
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

  /**
   * A company Scan now picked by its keyword-suggested tracks (it has no saved
   * match) gets those tracks saved as its match, so the tracks it is screened
   * and promoted on are the ones its Matched Tracks show — as the Pipeline's
   * Track filter already listed it. Leaves a company with a saved match alone.
   */
  private async saveResolvedTracksIfUnmatched(
    company: Company,
    steps: string[],
    selectedTrackIds: readonly string[],
  ): Promise<Company> {
    const tracks = await this.thesisRepo.findAll();
    if (persistedTrackIds(company, tracks).length > 0) return company;
    if (selectedTrackIds.length === 0) return company;
    // Persist only the tracks Scan now selected — what we screen — not every
    // keyword suggestion the company could appear under in the Pipeline filter.
    const matched_track_ids = [...selectedTrackIds];
    await this.companyRepo.update(company.id, { matched_track_ids });
    steps.push(`Saved ${matched_track_ids.length} keyword-matched track(s) as the company's match`);
    return { ...company, matched_track_ids };
  }

  /**
   * Generate the Company Card for a company that has never had one, before
   * it is screened, and link the related companies it surfaces. Leaves an
   * existing card alone (a stage move already refreshes those).
   */
  private async ensureCompanyCard(companyId: string, steps: string[]): Promise<void> {
    try {
      const result = await this.companyAnalysisService.generateNowIfMissing(companyId, {
        source: 'pending_scan',
      });
      if (result.status === 'already_running') {
        steps.push('Company Card generation already in progress');
        return;
      }
      if (result.status !== 'generated') return;
      steps.push('Company Card was missing; generated it before screening');
      try {
        const linked = await this.companyRelationshipService.linkRelatedCompanies(
          result.companyName,
          result.relatedCompanies,
        );
        if (linked.length > 0) steps.push(`Linked related companies: ${linked.join('; ')}`);
      } catch (err) {
        console.error('Error linking related companies during pending scan:', err);
      }
    } catch (err) {
      console.error('Error generating company card during pending scan:', err);
      steps.push(`Could not generate the Company Card: ${(err as Error).message}`);
    }
  }
}
