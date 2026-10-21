import type {
  AiWorkforceQueueRepository,
  CompanyRepository,
  CriteriaRepository,
  DbClient,
  InvestmentThesisRepository,
  ScreeningRepository,
  Tables,
} from '@/lib/repositories';
import { runAIScreening } from '@/lib/jobs/handlers/aiScreening';
import { AI_SCREENING_AGENT_NAME } from '@/lib/screening/screeningRunGuard';
import {
  buildTrackScreeningGroups,
  type TrackScreeningGroup,
} from '@/lib/tracks/matchTracks';
import { enqueueAgentRun } from '@/lib/workforce';
import {
  companyScreeningVerdict,
  isConfiguredRule,
  optionalPassThresholdPercent,
  tallyScreenings,
  trackPassRule,
  trackScreeningVerdict,
  type ScreeningVerdict,
  type TrackPassRule,
} from '@/lib/screening/verdict';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';
import { UNREVIEWED_STAGE } from '@/lib/constants';
import { SCREENING_PANEL_STAGES } from '@/lib/screening/scope';
import type { ScreeningService } from './screeningService';

/**
 * `agent_name` of the AI Workforce task that screens one company. Kept in sync
 * with the literal in `src/lib/workforce/failScreeningsOnFailure.ts`.
 */
export { AI_SCREENING_AGENT_NAME };

/**
 * - `pending_scan` — the Pending Confirmation auto-scan (Scan now / Auto-scan):
 *   queue the Company Card when none exists, match tracks when none are matched,
 *   screen, then auto promote / auto drop per the workspace toggles
 *   (`PendingAutoScanService.processCompany`).
 * - `tracks` — screen against the company's matched tracks only, no stage
 *   change (Smart Files' fallback for companies outside Pending Confirmation).
 */
export type AIScreeningMode = 'pending_scan' | 'tracks';

export interface EnqueueScreeningOptions {
  mode: AIScreeningMode;
  /** Re-screen criteria that already have a result. */
  force: boolean;
  triggeredByUserId?: string | null;
}

export interface EnqueueScreeningResult {
  /** Companies that got a new task. */
  queued: string[];
  /** Companies skipped because a screening task for them is already queued or running. */
  alreadyQueued: string[];
  /** `tracks` mode only: companies with no matched track carrying criteria — not queued. */
  nothingToScreen: string[];
  /** Per queued company: the screening groups prepared up front (forced runs only). */
  prepared: Map<string, { trackCount: number; screeningCount: number }>;
}

export interface ScreenTracksResult {
  /** Every (track, criterion) the company's matched tracks screen, done or not. */
  groups: TrackScreeningGroup[];
  /** Criteria screened by this call. */
  screened: number;
  tracks: Tables<'investment_thesis'>[];
  /** Each screened track's pass rule (must-pass criteria + minimum optional passes), by track id. */
  rules: Map<string, TrackPassRule>;
}

/** Each track's pass rule, by track id, from the workspace's tracks and criteria. */
export function buildTrackPassRules(
  tracks: Array<Pick<Tables<'investment_thesis'>, 'id' | 'min_optional_criteria_pass'>>,
  criteria: Array<Pick<Tables<'criterias'>, 'id' | 'investment_thesis_id' | 'must_pass'>>,
): Map<string, TrackPassRule> {
  const criteriaByTrack = new Map<string, typeof criteria>();
  for (const c of criteria) {
    const list = criteriaByTrack.get(c.investment_thesis_id);
    if (list) list.push(c);
    else criteriaByTrack.set(c.investment_thesis_id, [c]);
  }
  return new Map(
    tracks.map((t) => [
      t.id,
      trackPassRule(criteriaByTrack.get(t.id) ?? [], t.min_optional_criteria_pass),
    ]),
  );
}

const RESULT_MARK: Record<string, string> = { pass: '✓ pass', fail: '✗ fail', error: '✗ error' };

/** A company's newest AI screening task, as the Pipeline AI Screening panel shows it. */
export interface ScreeningTaskStatus {
  companyId: string;
  companyName: string;
  /** `unreviewed` (Pending Confirmation) or `L0`. */
  pipelineStage: string | null;
  /** The AI Workforce run — links to `/ai-workforce/tasks/<runId>`. */
  runId: string;
  status: Tables<'ai_workforce_queue'>['status'];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** Run AI Screening is offered on active Pending Confirmation companies only. */
export class NotPendingConfirmationError extends Error {
  constructor() {
    super('AI screening runs on active companies in Pending Confirmation');
    this.name = 'NotPendingConfirmationError';
  }
}

type Company = Tables<'companies'>;

const displayName = (c: { target?: string | null; project_name?: string | null }) =>
  c.target?.trim() || c.project_name?.trim() || 'Unknown';

/**
 * AI screening runs on the AI Workforce: one `ai_screening` task per company,
 * which calls the `run_ai_screening` tool. That tool screens every criterion
 * of the company's matched tracks in parallel and writes each result to its
 * `screenings` row — what the Pipeline page's AI Screening tab reads.
 */
export class AIScreeningService {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly companyRepo: CompanyRepository,
    private readonly screeningRepo: ScreeningRepository,
    private readonly criteriaRepo: CriteriaRepository,
    private readonly thesisRepo: InvestmentThesisRepository,
    private readonly screeningService: ScreeningService,
    private readonly queueRepo: AiWorkforceQueueRepository,
  ) {}

  /**
   * Put one screening task per company on the AI Workforce queue, skipping
   * companies that already have one queued or running.
   *
   * A forced run resets the company's screening rows to pending up front, so
   * the Pipeline's AI Screening tab shows it in progress while the task waits
   * its turn. A non-forced run prepares nothing here: it only screens
   * criteria without a result, which the task works out when it runs.
   *
   * Reads are batched (names, in-flight tasks, tracks, criteria, companies);
   * the enqueue itself is one insert per company.
   */
  async enqueue(
    companyIds: string[],
    opts: EnqueueScreeningOptions,
  ): Promise<EnqueueScreeningResult> {
    const ids = [...new Set(companyIds)];
    const result: EnqueueScreeningResult = {
      queued: [],
      alreadyQueued: [],
      nothingToScreen: [],
      prepared: new Map(),
    };
    if (ids.length === 0) return result;

    const active = await this.queueRepo.findActiveCompanyIds(AI_SCREENING_AGENT_NAME, ids);
    const toQueue = ids.filter((id) => !active.has(id));
    result.alreadyQueued = ids.filter((id) => active.has(id));
    if (toQueue.length === 0) return result;

    let companies = await this.companyRepo.findByIds(toQueue);

    // A pending scan matches tracks inside the task, so it can't be judged
    // screenable up front; a tracks-only run can.
    if (opts.force || opts.mode === 'tracks') {
      const [tracks, criteria] = await Promise.all([
        this.thesisRepo.findAll(),
        this.criteriaRepo.findAll(),
      ]);
      const groupsByCompany = new Map(
        companies.map((c) => [c.id, buildTrackScreeningGroups(c, tracks, criteria)]),
      );
      if (opts.mode === 'tracks') {
        result.nothingToScreen = companies
          .filter((c) => groupsByCompany.get(c.id)!.length === 0)
          .map((c) => c.id);
        companies = companies.filter((c) => groupsByCompany.get(c.id)!.length > 0);
      }
      const groups = opts.force
        ? companies.flatMap((c) =>
            groupsByCompany.get(c.id)!.map((g) => ({
              companyId: c.id,
              trackId: g.trackId,
              criteriaIds: g.criteriaIds,
            })),
          )
        : [];
      if (groups.length > 0) {
        const entries = await this.screeningService.prepare(groups, opts.triggeredByUserId);
        for (const companyId of new Set(groups.map((g) => g.companyId))) {
          result.prepared.set(companyId, {
            trackCount: groups.filter((g) => g.companyId === companyId).length,
            screeningCount: entries.filter((e) => e.company_id === companyId).length,
          });
        }
      }
    }

    for (const company of companies) {
      try {
        await runWithWorkforceWorkspaceId(this.workspaceId, () =>
          enqueueAgentRun(this.db, this.taskFor(company, opts)),
        );
        result.queued.push(company.id);
      } catch (err) {
        // One company's enqueue failing must not drop the rest of a Scan now.
        console.error(`[aiScreening] failed to queue screening for ${company.id}:`, err);
        if (result.prepared.has(company.id)) {
          await this.screeningRepo
            .markPendingFailedForCompany(company.id, 'AI screening could not be queued')
            .catch(() => undefined);
          result.prepared.delete(company.id);
        }
      }
    }
    return result;
  }

  /** The subset of `companyIds` with a screening task queued or running, in one query. */
  findInFlightCompanyIds(companyIds: string[]): Promise<Set<string>> {
    return this.queueRepo.findActiveCompanyIds(AI_SCREENING_AGENT_NAME, companyIds);
  }

  /**
   * A Pending Confirmation company's Run AI Screening action: queue the same
   * forced scan Scan now runs, for one company — match tracks when none are
   * matched, screen, then auto drop/promote when the workspace has it on.
   * Throws {@link NotPendingConfirmationError} for any other company.
   */
  async enqueueForCompany(
    companyId: string,
    triggeredByUserId: string | null,
  ): Promise<{ alreadyQueued: boolean; trackCount: number; screeningCount: number }> {
    const company = await this.companyRepo.findByIdOrNull(companyId);
    if (!company || company.pipeline_stage !== UNREVIEWED_STAGE || company.status !== 'active') {
      throw new NotPendingConfirmationError();
    }
    const result = await this.enqueue([companyId], {
      mode: 'pending_scan',
      force: true,
      triggeredByUserId,
    });
    const prepared = result.prepared.get(companyId);
    return {
      alreadyQueued: result.alreadyQueued.includes(companyId),
      trackCount: prepared?.trackCount ?? 0,
      screeningCount: prepared?.screeningCount ?? 0,
    };
  }

  /**
   * Screen a company against its matched tracks' criteria: every criterion at
   * once, each writing its own `screenings` row. Without `force`, criteria
   * that already have a completed result are left alone. Runs inside the
   * `ai_screening` task (the `run_ai_screening` tool).
   */
  async screenMatchedTracks(
    company: Company,
    opts: { force: boolean },
  ): Promise<ScreenTracksResult> {
    const [tracks, criteria] = await Promise.all([
      this.thesisRepo.findAll(),
      this.criteriaRepo.findAll(),
    ]);
    const groups = buildTrackScreeningGroups(company, tracks, criteria);
    const rules = buildTrackPassRules(tracks, criteria);
    if (groups.length === 0) return { groups, screened: 0, tracks, rules };

    let toRun = groups;
    if (!opts.force) {
      const existing = await this.screeningRepo.findByCompanyIds([company.id]);
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
    if (toRun.length === 0) return { groups, screened: 0, tracks, rules };

    const entries = await this.screeningService.prepare(
      toRun.map((g) => ({ companyId: company.id, trackId: g.trackId, criteriaIds: g.criteriaIds })),
    );
    const promptById = new Map(criteria.map((c) => [c.id, c.prompt]));
    const name = displayName(company);
    // runAIScreening never throws without first writing an error result to
    // the screening row, so one failed criterion doesn't sink the others.
    await Promise.allSettled(
      entries.map((entry) =>
        runAIScreening(
          {
            companyId: company.id,
            criteriaId: entry.criteria_id,
            criteriaPrompt: promptById.get(entry.criteria_id) ?? '',
            screeningId: entry.id,
            company: { id: company.id, name },
          },
          { db: this.db, workspaceId: this.workspaceId },
        ),
      ),
    );
    return { groups, screened: entries.length, tracks, rules };
  }

  /**
   * The `tracks`-mode task: screen one company's matched tracks and report
   * each track's verdict from the rows just written. Never moves the deal.
   */
  async screenCompanyTracks(
    companyId: string,
    opts: { force: boolean },
  ): Promise<{
    screened: number;
    tracks: Array<{ trackId: string; title: string; verdict: ScreeningVerdict | 'pending' }>;
  }> {
    const company = await this.companyRepo.findById(companyId);
    const { groups, screened, tracks, rules } = await this.screenMatchedTracks(company, opts);
    if (groups.length === 0) return { screened, tracks: [] };
    const rows = await this.screeningRepo.findByCompanyIds([companyId]);
    return {
      screened,
      tracks: groups.map((g) => {
        const groupRows = rows.filter(
          (r) => r.track_id === g.trackId && g.criteriaIds.includes(r.criteria_id),
        );
        return {
          trackId: g.trackId,
          title: tracks.find((t) => t.id === g.trackId)?.title?.trim() || 'Untitled track',
          verdict:
            tallyScreenings(groupRows).pending > 0
              ? 'pending'
              : trackScreeningVerdict(groupRows, rules.get(g.trackId)),
        };
      }),
    };
  }

  /**
   * The company's AI Screening results as a prompt block for the AI Opinion:
   * per matched track, its verdict under the track's pass rule, the must-pass
   * criteria and how the optional criteria fared against the minimum. `null`
   * when the company has no screening results on a current matched track.
   * Four reads, whatever the number of tracks or criteria.
   */
  async summarizeForOpinion(company: Company): Promise<string | null> {
    const [tracks, criteria, rows] = await Promise.all([
      this.thesisRepo.findAll(),
      this.criteriaRepo.findAll(),
      this.screeningRepo.findByCompanyIds([company.id]),
    ]);
    const groups = buildTrackScreeningGroups(company, tracks, criteria);
    if (groups.length === 0 || rows.length === 0) return null;

    const rules = buildTrackPassRules(tracks, criteria);
    const criterionById = new Map(criteria.map((c) => [c.id, c]));
    const scoped: typeof rows = [];
    const lines: string[] = [];

    for (const g of groups) {
      const groupRows = rows.filter(
        (r) => r.track_id === g.trackId && g.criteriaIds.includes(r.criteria_id),
      );
      if (groupRows.length === 0) continue;
      scoped.push(...groupRows);

      const title = tracks.find((t) => t.id === g.trackId)?.title?.trim() || 'Untitled track';
      const rule = rules.get(g.trackId);
      const tally = tallyScreenings(groupRows);
      const verdict =
        tally.pending > 0 ? 'pending' : trackScreeningVerdict(groupRows, rule);
      lines.push(`- Track "${title}": ${verdict.toUpperCase()}`);

      if (!isConfiguredRule(rule)) {
        lines.push(
          `  - Rule: at least 3 criteria pass and at most 1 fails. ` +
            `${tally.passed} passed, ${tally.failed} failed, ${tally.inconclusive} inconclusive, ` +
            `${tally.pending} pending of ${tally.total}.`,
        );
        continue;
      }

      const must = groupRows.filter((r) => rule.mustPassCriteriaIds.has(r.criteria_id));
      const optional = groupRows.filter((r) => !rule.mustPassCriteriaIds.has(r.criteria_id));
      const describe = (r: (typeof rows)[number]) =>
        `${criterionById.get(r.criteria_id)?.name ?? 'Unnamed criterion'} ` +
        `(${r.state === 'pending' ? 'pending' : r.state === 'failed' ? '✗ fail' : (RESULT_MARK[r.result ?? ''] ?? r.result ?? 'no result')})`;
      if (must.length > 0) {
        lines.push(`  - Must-pass (every one is required): ${must.map(describe).join('; ')}`);
      }
      const optionalTally = tallyScreenings(optional);
      const min = Math.min(rule.minOptionalPass ?? 0, optional.length);
      lines.push(
        `  - Optional: ${optionalTally.passed} of ${optional.length} passed; at least ${min} ` +
          `required (${optionalPassThresholdPercent(rule.minOptionalPass, optional.length)}%).` +
          (optional.length > 0 ? ` ${optional.map(describe).join('; ')}` : ''),
      );
    }
    if (lines.length === 0) return null;

    const overall = companyScreeningVerdict(scoped, rules);
    return `Overall AI Screening verdict: ${overall.toUpperCase()} (passes when any matched track passes).\n${lines.join('\n')}`;
  }

  /**
   * The newest screening task of every active Pending Confirmation and L0
   * company, in one query — what the Pipeline's AI Screening panel shows
   * beside each company, with a link to the task in AI Workforce.
   */
  async listCompanyTasks(): Promise<ScreeningTaskStatus[]> {
    const rows = await this.queueRepo.findLatestPerCompanyAtStages(
      AI_SCREENING_AGENT_NAME,
      SCREENING_PANEL_STAGES,
    );
    return rows.map(({ run, company }) => ({
      companyId: company.id,
      companyName: displayName(company),
      pipelineStage: company.pipeline_stage,
      runId: run.id,
      status: run.status,
      createdAt: run.created_at,
      startedAt: run.started_at,
      endedAt: run.ended_at,
    }));
  }

  private taskFor(company: Company, opts: EnqueueScreeningOptions) {
    const name = displayName(company);
    const scope =
      opts.mode === 'pending_scan'
        ? 'It first generates the Company Card if the company has none, matches the company to tracks if ' +
          "it has none, screens it against each matched track's criteria, and promotes it to L0 on " +
          'a pass (when the workspace has auto promote on) or drops it on a fail (when it has auto ' +
          'drop on).'
        : "It screens the company against each matched track's criteria. It does not move the deal.";
    const instruction =
      `Run AI screening for "${name}" (company_id: ${company.id}). ` +
      `Call the run_ai_screening tool exactly once with company_id "${company.id}", ` +
      `mode "${opts.mode}" and force ${opts.force}. ${scope} ` +
      'After it returns, report the verdict per track and what happened to the company in one or ' +
      'two sentences. Do not re-screen, edit, promote or drop the company yourself — if the ' +
      'tool left it pending (for example because auto promote or auto drop is off), it stays pending.';
    return {
      agentName: AI_SCREENING_AGENT_NAME,
      triggerSource: 'api' as const,
      triggerMeta: { company_id: company.id, mode: opts.mode, force: opts.force },
      input: {
        title: `AI Screening: ${name}`,
        instruction,
        prompt: instruction,
        company_id: company.id,
      },
      triggeredByUserId: opts.triggeredByUserId ?? null,
    };
  }
}
