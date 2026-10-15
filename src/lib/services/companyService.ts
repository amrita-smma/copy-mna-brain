import type { DealStage } from '@/lib/types';
import type {
  CompanyRepository,
  CompanyFilters,
  CompanyFinancialRepository,
  CompanyFxAdjustmentRepository,
  CompanyLogRepository,
  CompanyScreeningDerivedRepository,
  DealDocumentRepository,
  DealNoteRepository,
  DealLinkRepository,
  FileRepository,
  PipelineStageRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';
import {
  toCompanyDTO,
  splitCompanyDTO,
  type CompanyDTO,
  type CompanyDTOInput,
} from '@/lib/dto/companyDTO';
import type { TrackMatchingService } from './trackMatchingService';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { UserRepository } from '@/lib/repositories';
import { bestFuzzyMatch } from '@/lib/fuzzySearch';
import { getMissingL0Fields, type L0CompanyInput } from '@/lib/companies/l0Requirements';
import { stageMoveDirection, UNREVIEWED_STAGE } from '@/lib/constants';
import {
  BUILTIN_PIPELINE_STAGE_KEYS,
  CAPTAIN_FROM_STAGE_KEY,
  FIRST_STAGE_KEY,
  PRE_PIPELINE_STAGES,
  isInPipelineStage,
  liveStageKeys,
  stageKeysFrom,
  type PipelineStageDef,
} from '@/lib/pipeline/stages';
import { companyDisplayName } from '@/lib/companyDisplay';
import { captureWorkspaceEvent } from '@/lib/posthog-server';

const L0_STAGE: DealStage = FIRST_STAGE_KEY;

/** A stage move or restore targets a stage the workspace has deleted, or never had. */
export class PipelineStageUnavailableError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`Pipeline stage "${stage}" does not exist or has been deleted.`);
    this.name = 'PipelineStageUnavailableError';
    this.stage = stage;
  }
}

/**
 * Restoring a dropped deal whose stage was deleted while it was dropped needs
 * a stage to restore it into; the caller asks the user and retries with one.
 */
export class RestoreStageRequiredError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`The deal's stage "${stage}" has been deleted. Choose a stage to restore it to.`);
    this.name = 'RestoreStageRequiredError';
    this.stage = stage;
  }
}

/** One pipeline stage's headcount, split by deal origin. */
export interface StageCount {
  stage: string;
  count: number;
  inbound: number;
  outbound: number;
}

/**
 * Whether a company counts as inbound for the dashboard's pipeline bar.
 *
 * `source` is authoritative when set. Older rows predate that column, so the
 * free-text `watchlist_status` stands in: "active" or anything containing
 * "inbound" reads as inbound. Everything else — including an unset status —
 * is outbound.
 */
function isInboundCompany(row: {
  source: string | null;
  watchlist_status: string | null;
}): boolean {
  const source = row.source?.toLowerCase();
  if (source === 'inbound') return true;
  if (source === 'outbound') return false;
  const status = row.watchlist_status?.toLowerCase() ?? '';
  return status.includes('inbound') || status === 'active';
}

export interface FinancialUpsertInput {
  fiscal_year: number;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
  // Enterprise value for the year. Set by the AI Workforce's
  // `update_company_details` tool and the Pipeline manual add-company form —
  // the FE financials editor sends revenue/EBITDA only, and an omitted key
  // keeps the stored value.
  ev_usd_mn?: number | null;
}

// Dropped companies stay editable for detail fields (target, financials,
// assignees, etc.) so users can keep records accurate after a drop. Pipeline
// lifecycle moves are still off-limits: promoting a dropped deal or
// re-dropping one fails loud with this error.
export class CompanyL0RequirementsError extends Error {
  readonly missingFields: string[];
  constructor(missingFields: string[]) {
    super(`Cannot promote to L0: missing required fields: ${missingFields.join(', ')}`);
    this.name = 'CompanyL0RequirementsError';
    this.missingFields = missingFields;
  }
}

export class CompanyDroppedError extends Error {
  readonly droppedIds: string[];
  constructor(droppedIds: string[]) {
    const list = droppedIds.join(", ");
    super(
      droppedIds.length === 1
        ? `Company ${list} is dropped and cannot be modified.`
        : `Companies [${list}] are dropped and cannot be modified.`,
    );
    this.name = "CompanyDroppedError";
    this.droppedIds = droppedIds;
  }
}

/**
 * `numerator / denominator` as a stored decimal (EBITDA margin is a ratio, not
 * a percentage — the UI multiplies by 100), or null when either side is
 * missing or the denominator would divide by zero. Values are coerced because
 * a numeric column can surface as a string depending on the driver path.
 */
function ratio(
  numerator: number | string | null | undefined,
  denominator: number | string | null | undefined,
): number | null {
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined) return null;
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

export class CompanyService {
  private pendingArrivalHandler?: (companyId: string) => Promise<unknown>;

  constructor(
    // First rather than alongside the other scalars at the end: the trailing
    // dependencies are optional, and a required parameter can't follow one.
    private readonly workspaceId: string,
    private readonly companyRepo: CompanyRepository,
    private readonly companyLogRepo: CompanyLogRepository,
    private readonly dealDocRepo: DealDocumentRepository,
    private readonly dealNoteRepo: DealNoteRepository,
    private readonly dealLinkRepo: DealLinkRepository,
    private readonly companyFinancialRepo: CompanyFinancialRepository,
    private readonly companyFxAdjustmentRepo: CompanyFxAdjustmentRepository,
    private readonly companyScreeningDerivedRepo: CompanyScreeningDerivedRepository,
    // Optional: when present, a company entering L0 triggers agent-driven track
    // matching. Left out in contexts that never create/promote (e.g. read-only).
    private readonly trackMatchingService?: TrackMatchingService,
    private readonly userRepo?: UserRepository,
    // Optional: when present, deleting a company also strips its reference out
    // of every file's `matched_companies` array. Left out in contexts that
    // never delete (e.g. the file-ingest-built service).
    private readonly fileRepo?: FileRepository,
    // Optional: when present, a pipeline stage move regenerates the company's
    // AI Company Card so it reflects whatever has landed since it was written.
    // Left out in contexts that never move a company between stages.
    private readonly companyAnalysisService?: CompanyAnalysisService,
    // Optional: the workspace's pipeline stages, for validating stage moves and
    // ordering range rules (Deal Captain from L3 onward). Without it the six
    // original stages are assumed.
    private readonly pipelineStageRepo?: PipelineStageRepository,
  ) {}

  private stagesPromise: Promise<PipelineStageDef[]> | null = null;

  /**
   * The workspace's stages, or the six originals when no stage repository is
   * wired. Read once per service instance — containers are built per request —
   * so a loop of stage moves (bulk triage) does not re-read them per deal.
   */
  private pipelineStages(): Promise<PipelineStageDef[]> {
    this.stagesPromise ??= this.loadPipelineStages().catch((err: unknown) => {
      this.stagesPromise = null;
      throw err;
    });
    return this.stagesPromise;
  }

  private async loadPipelineStages(): Promise<PipelineStageDef[]> {
    if (!this.pipelineStageRepo) {
      return BUILTIN_PIPELINE_STAGE_KEYS.map((key, position) => ({
        key,
        code: key,
        name: key,
        description: '',
        position,
        deleted: false,
      }));
    }
    const rows = await this.pipelineStageRepo.list();
    return rows.map((r) => ({
      key: r.key,
      code: r.code,
      name: r.name,
      description: r.description,
      position: r.position,
      deleted: r.deleted_at !== null,
    }));
  }

  /**
   * Throw unless `stage` is somewhere a deal can be moved to: a live
   * workspace stage or a pre-pipeline bucket. Stops a stale browser tab, a
   * bulk card or an agent from moving a deal into a deleted stage.
   */
  private assertStageAvailable(stages: PipelineStageDef[], stage: string): void {
    if (PRE_PIPELINE_STAGES.has(stage)) return;
    if (!liveStageKeys(stages).includes(stage)) {
      throw new PipelineStageUnavailableError(stage);
    }
  }

  /**
   * The stage check for writes that take a whole row or patch (create, bulk
   * update): only when the payload sets `pipeline_stage`. Since the column is
   * text, the database no longer rejects an unknown stage itself.
   */
  private async assertStageWritable(row: { pipeline_stage?: unknown }): Promise<void> {
    if (typeof row.pipeline_stage !== 'string') return;
    this.assertStageAvailable(await this.pipelineStages(), row.pipeline_stage);
  }

  /**
   * Kick off a Company Card regeneration after a pipeline stage move.
   *
   * A stage move is the point at which the card gets read by a wider audience,
   * so it must reflect the latest information — including anything that only
   * exists in a file uploaded after the card was written. Regeneration keeps
   * the existing row so the run can compare the card's `created_at` against
   * each document's date and let the later-dated source win a conflict.
   *
   * Best-effort and never fatal: the stage move itself has already been
   * committed, and an enqueue failure must not roll it back or 500 the caller.
   * Duplicate suppression lives in `CompanyAnalysisService.regenerate`, which
   * no-ops while a card run for the company is still in flight.
   */
  private async regenerateCompanyCardForStageMove(
    id: string,
    currentStage: string | undefined,
    nextStage: string,
  ): Promise<void> {
    if (!this.companyAnalysisService) return;
    try {
      await this.companyAnalysisService.regenerate(id, {
        reason: CompanyService.stageMoveReason(currentStage, nextStage),
        source: 'stage_move',
      });
    } catch (err) {
      console.error('Error regenerating company card after stage move:', err);
    }
  }

  /**
   * Bulk counterpart of {@link regenerateCompanyCardForStageMove}. Routed
   * through `regenerateMany` so the in-flight check and the company-name lookup
   * are each a single batched query instead of two reads per deal.
   */
  private async regenerateCompanyCardsForBulkStageMove(
    deals: Array<{ id: string; currentStage?: string }>,
    nextStage: string,
  ): Promise<void> {
    if (!this.companyAnalysisService || deals.length === 0) return;
    try {
      await this.companyAnalysisService.regenerateMany(
        deals.map((d) => d.id),
        {
          reasonById: new Map(
            deals.map((d) => [d.id, CompanyService.stageMoveReason(d.currentStage, nextStage)]),
          ),
          source: 'stage_move',
        },
      );
    } catch (err) {
      console.error('Error regenerating company cards after bulk stage move:', err);
    }
  }

  private static stageMoveReason(currentStage: string | undefined, nextStage: string): string {
    return currentStage
      ? `stage move ${currentStage} -> ${nextStage}`
      : `stage move to ${nextStage}`;
  }

  findById(id: string) {
    return this.companyRepo.findById(id);
  }

  /**
   * Called when a company is created into Pending Confirmation. Wired by the
   * container to `PendingAutoScanService.onCompanyEnteredPending` (a setter,
   * not a constructor argument: that service depends on this one).
   */
  setPendingArrivalHandler(handler: (companyId: string) => Promise<unknown>) {
    this.pendingArrivalHandler = handler;
  }

  private async notifyPendingArrival(companyId: string): Promise<void> {
    if (!this.pendingArrivalHandler) return;
    try {
      await this.pendingArrivalHandler(companyId);
    } catch (err) {
      console.error('[CompanyService] pending auto-scan request failed:', err);
    }
  }

  /**
   * Fire the agent-driven track-matching job for a company that just entered
   * L0. Awaited so the job row is committed before the request returns (the
   * actual matching still runs after the response via `after()`); a dispatch
   * hiccup is logged but never fails the create/promote.
   */
  private async dispatchTrackMatching(companyId: string): Promise<void> {
    if (!this.trackMatchingService) return;
    try {
      await this.trackMatchingService.dispatch({ companyId });
    } catch (err) {
      console.error('[CompanyService] track-matching dispatch failed:', err);
    }
  }

  findByNameFuzzy(namePart: string) {
    return this.companyRepo.findByNameFuzzy(namePart);
  }

  /** The subset of `ids` belonging to a company in this workspace. */
  findExistingIds(ids: string[]) {
    return this.companyRepo.findExistingIds(ids);
  }

  /**
   * Levenshtein-based fuzzy dedup fallback for ingest. The cheap SQL substring
   * match (`findByNameFuzzy`) only catches names that literally contain one
   * another; this catches spelling variants, typos, and OCR noise (e.g. "Acme
   * Corp" vs "Acme Crop"). Skipped for very short names (< 5 chars), where
   * relative-distance matching is too aggressive and the exact substring gate
   * already suffices. Returns the full matched company row, or null when
   * nothing clears the similarity threshold.
   */
  async findBestFuzzyMatch(
    name: string,
    threshold = 0.3,
  ): Promise<Tables<'companies'> | null> {
    const trimmed = name.trim();
    if (trimmed.length < 5) return null;
    const candidates = await this.companyRepo.findAllIdAndTarget();
    const match = bestFuzzyMatch(trimmed, candidates, threshold);
    if (!match) return null;
    return this.companyRepo.findById(match.id);
  }

  async markPossibleDuplicate(id: string, possibleDuplicateCompanyId: string): Promise<void> {
    await this.companyRepo.update(id, {
      possible_duplicate_company_id: possibleDuplicateCompanyId,
    });
  }

  list(filters: Omit<CompanyFilters, 'id'>) {
    return this.companyRepo.findAll(filters);
  }

  /** Companies with an in-flight AI Opinion run. Backs the companies SSE stream. */
  findProcessingAiOpinions() {
    return this.companyRepo.findProcessingAiOpinions();
  }

  /**
   * Lightweight paginated lookup returning only `id` + `target` for the AI
   * Smart Files "Matched Company" combobox. Supports server-side ILIKE search
   * via `targetSearch` and offset/limit pagination — see
   * `CompanyRepository.findIdAndTargetPage`.
   */
  listIdAndTargetPage(
    filters: Pick<CompanyFilters, 'limit' | 'offset' | 'targetSearch'>,
  ) {
    return this.companyRepo.findIdAndTargetPage(filters);
  }

  count(filters: Pick<CompanyFilters, 'id' | 'stage' | 'stageIn' | 'excludeStage' | 'stageNotNull' | 'excludeDropped' | 'source' | 'createdAfter'>) {
    return this.companyRepo.count(filters);
  }

  /**
   * Per-stage totals with the inbound/outbound split the dashboard's pipeline
   * bar renders.
   *
   * A company counts as inbound when `source` says so; when `source` is unset
   * the `watchlist_status` stands in ("inbound" or "active"), and anything else
   * is outbound. That rule used to live in the Dashboard view, which downloaded
   * every company just to apply it — this computes the same numbers from a
   * single grouped query.
   */
  async countByStage(
    filters: Pick<CompanyFilters, 'id' | 'stage' | 'stageIn' | 'excludeStage' | 'stageNotNull' | 'excludeDropped' | 'createdAfter'> = {},
  ): Promise<StageCount[]> {
    const rows = await this.companyRepo.countByStageAndSource(filters);
    const byStage = new Map<string, StageCount>();
    for (const row of rows) {
      // Mirrors the view's own fallback: a company with no stage was bucketed
      // under L0.
      const stage = row.stage ?? 'L0';
      const entry = byStage.get(stage) ?? { stage, count: 0, inbound: 0, outbound: 0 };
      entry.count += row.count;
      if (isInboundCompany(row)) entry.inbound += row.count;
      else entry.outbound += row.count;
      byStage.set(stage, entry);
    }
    return [...byStage.values()];
  }

  /**
   * Distinct banker names for the creatable "Banker / Source" combobox —
   * see `CompanyRepository.findBankerNames`.
   */
  listBankerNames() {
    return this.companyRepo.findBankerNames();
  }

  findDetails(id: string) {
    return this.companyRepo.findDetails(id);
  }

  // --------- DTO (flat, backward-compatible) read path ---------
  async findByIdDTO(id: string): Promise<CompanyDTO> {
    const [company, financials, fx, screening, assignees] = await Promise.all([
      this.companyRepo.findById(id),
      this.companyFinancialRepo.findByCompany(id),
      this.companyFxAdjustmentRepo.findByCompany(id),
      this.companyScreeningDerivedRepo.findByCompany(id),
      this.companyRepo.findAssignees(id),
    ]);
    const userNameById = await this.resolveUserNames([
      company.entered_by,
      company.deal_sponsor,
      company.deal_captain,
    ]);
    const nameOf = (id: string | null) => (id ? (userNameById.get(id) ?? null) : null);
    return toCompanyDTO(
      company,
      financials,
      fx,
      screening,
      assignees,
      nameOf(company.entered_by),
      nameOf(company.deal_sponsor),
      nameOf(company.deal_captain),
    );
  }

  async listDTO(filters: Omit<CompanyFilters, 'id'>): Promise<CompanyDTO[]> {
    const companies = await this.companyRepo.findAll(filters);
    if (companies.length === 0) return [];
    const ids = companies.map((c) => c.id);
    const referencedUserIds = [
      ...new Set(
        companies
          .flatMap((c) => [c.entered_by, c.deal_sponsor, c.deal_captain])
          .filter((v): v is string => !!v),
      ),
    ];
    const [financials, fxRows, screeningRows, assigneeRows, referencedUsers] = await Promise.all([
      this.companyFinancialRepo.findByCompanies(ids),
      this.companyFxAdjustmentRepo.findByCompanies(ids),
      this.companyScreeningDerivedRepo.findByCompanies(ids),
      this.companyRepo.findAssigneesByCompanies(ids),
      referencedUserIds.length > 0 && this.userRepo
        ? this.userRepo.findByIds(referencedUserIds)
        : Promise.resolve([]),
    ]);
    const finByCompany = new Map<string, Tables<'company_financials'>[]>();
    for (const f of financials) {
      const arr = finByCompany.get(f.company_id) ?? [];
      arr.push(f);
      finByCompany.set(f.company_id, arr);
    }
    const fxByCompany = new Map<string, Tables<'company_fx_adjustments'>[]>();
    for (const f of fxRows) {
      const arr = fxByCompany.get(f.company_id) ?? [];
      arr.push(f);
      fxByCompany.set(f.company_id, arr);
    }
    const screeningByCompany = new Map<string, Tables<'company_screening_derived'>>();
    for (const s of screeningRows) screeningByCompany.set(s.company_id, s);
    const assigneesByCompany = new Map<
      string,
      Array<Pick<Tables<'users'>, 'id' | 'name' | 'email' | 'role'>>
    >();
    for (const row of assigneeRows) {
      const { company_id, ...user } = row;
      const arr = assigneesByCompany.get(company_id) ?? [];
      arr.push(user);
      assigneesByCompany.set(company_id, arr);
    }
    const userNameById = new Map(referencedUsers.map((u) => [u.id, u.name]));
    const nameOf = (id: string | null) => (id ? (userNameById.get(id) ?? null) : null);
    return companies.map((c) =>
      toCompanyDTO(
        c,
        finByCompany.get(c.id) ?? [],
        fxByCompany.get(c.id) ?? [],
        screeningByCompany.get(c.id) ?? null,
        assigneesByCompany.get(c.id) ?? [],
        nameOf(c.entered_by),
        nameOf(c.deal_sponsor),
        nameOf(c.deal_captain),
      ),
    );
  }

  /**
   * Resolve user-reference columns (entered_by / deal_sponsor / deal_captain)
   * to display names in one batch lookup. Returns an id → name map; ids with
   * no matching user are simply absent.
   */
  private async resolveUserNames(
    userIds: Array<string | null | undefined>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((v): v is string => !!v))];
    if (ids.length === 0 || !this.userRepo) return new Map();
    const users = await this.userRepo.findByIds(ids);
    return new Map(users.map((u) => [u.id, u.name]));
  }

  // --------- DTO (flat) write path: split across tables ---------
  /**
   * Accepts a flat FE payload and writes to companies + child tables. Returns
   * the composed DTO so the FE can round-trip without a refetch.
   */
  async createFromDTO(
    input: CompanyDTOInput,
    logAction?: string,
    opts?: {
      /** The caller fires the Pending Confirmation arrival hook itself, once
       *  the rest of the company (financials, files) is written. */
      deferPendingArrival?: boolean;
    },
  ): Promise<CompanyDTO> {
    this.assertHasCompanyIdentity(input);
    const split = splitCompanyDTO(input);
    await this.assertStageWritable(split.company);
    const inserted = await this.companyRepo.insert(
      split.company as TablesInsert<'companies'>,
    );
    await this.applyChildWrites(inserted.id, split);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: inserted.id, action: logAction });
    }
    if (inserted.pipeline_stage === L0_STAGE) {
      await this.dispatchTrackMatching(inserted.id);
    }
    if (inserted.pipeline_stage === UNREVIEWED_STAGE && !opts?.deferPendingArrival) {
      await this.notifyPendingArrival(inserted.id);
    }
    return this.findByIdDTO(inserted.id);
  }

  async updateFromDTO(
    id: string,
    input: CompanyDTOInput,
    logAction?: string,
  ): Promise<CompanyDTO> {
    const split = splitCompanyDTO(input);

    // Moving a pre-L0 company into the active pipeline (L0+) via the Current
    // Stage dropdown enforces the same required-field gate as an explicit
    // promote, so the detail-edit form can't bypass it. Validate the *merged*
    // record so the user can fill the required fields and change the stage in a
    // single save, and validate *before* any write so a 422 leaves the row
    // untouched.
    const nextStage = split.company.pipeline_stage;
    // Only read the existing row when the payload actually carries a stage —
    // that's the one case where we need the prior stage (for the L0 gate below
    // and to detect a stage move worth regenerating the card for).
    const priorCompany =
      typeof nextStage === 'string' ? (await this.companyRepo.findById(id)) : null;
    if (
      typeof nextStage === 'string' &&
      priorCompany &&
      (priorCompany.pipeline_stage ?? '') !== nextStage
    ) {
      this.assertStageAvailable(await this.pipelineStages(), nextStage);
    }
    if (typeof nextStage === 'string' && isInPipelineStage(nextStage)) {
      const existing = priorCompany!;
      const wasPreL0 = !isInPipelineStage(existing.pipeline_stage);
      if (wasPreL0) {
        this.assertL0Requirements({
          ...existing,
          ...(split.company as Partial<Tables<'companies'>>),
        } as Tables<'companies'>);
      }
    }

    if (Object.keys(split.company).length > 0) {
      await this.companyRepo.update(id, split.company as TablesUpdate<'companies'>);
    }
    await this.applyChildWrites(id, split);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: id, action: logAction });
    }
    // The Current Stage dropdown is a stage move too, so it refreshes the card
    // exactly like an explicit promote. Only when the stage actually changed —
    // a detail-only save that happens to echo the current stage must not
    // re-trigger a run.
    if (
      typeof nextStage === 'string' &&
      priorCompany &&
      (priorCompany.pipeline_stage ?? '') !== nextStage
    ) {
      await this.regenerateCompanyCardForStageMove(
        id,
        priorCompany.pipeline_stage ?? undefined,
        nextStage,
      );
    }
    return this.findByIdDTO(id);
  }

  private async applyChildWrites(
    companyId: string,
    split: ReturnType<typeof splitCompanyDTO>,
  ): Promise<void> {
    // financials: upsert only years the caller touched
    const financialRows = Array.from(split.financialsByYear.values()).filter(
      (r) => Object.keys(r).length > 1, // more than just fiscal_year
    );
    if (financialRows.length > 0) {
      await this.companyFinancialRepo.bulkUpsertForCompany(companyId, financialRows);
    }
    // fx: only if we have a currency (table requires it NOT NULL)
    const fxRowsTouched = Array.from(split.fxByYear.values()).filter(
      (r) => Object.keys(r).length > 2, // more than fiscal_year + currency placeholder
    );
    if (fxRowsTouched.length > 0 && split.fxCurrency) {
      const withCurrency = fxRowsTouched.map((r) => ({ ...r, currency: split.fxCurrency! }));
      await this.companyFxAdjustmentRepo.bulkUpsertForCompany(companyId, withCurrency);
    }
    if (split.hasScreeningFields) {
      await this.companyScreeningDerivedRepo.upsertByCompany({
        company_id: companyId,
        ...split.screening,
      });
    }
  }

  /**
   * Returns the list of missing required fields for L0 entry. Empty = all
   * clear. Delegates to the shared `L0_REQUIRED_FIELDS` definition so the
   * service, the Smart Files approval path, and the review UIs all enforce the
   * same rules — see `@/lib/companies/l0Requirements`.
   */
  static checkL0Requirements(company: L0CompanyInput): string[] {
    return getMissingL0Fields(company);
  }

  private assertL0Requirements(company: Tables<'companies'>): void {
    const missing = CompanyService.checkL0Requirements(company);
    if (missing.length > 0) throw new CompanyL0RequirementsError(missing);
  }

  /**
   * A company must be identifiable by its real name OR its internal project
   * codename — a deal running under a codename legitimately has no target, but
   * a row with neither is unaddressable in every list, picker and export.
   *
   * Structurally typed rather than tied to `CompanyDTOInput` so both write
   * paths (`createFromDTO` and `create`) share the one invariant.
   */
  private assertHasCompanyIdentity(input: {
    target?: string | null;
    project_name?: string | null;
  }): void {
    const hasTarget = typeof input.target === 'string' && input.target.trim().length > 0;
    const hasProjectName =
      typeof input.project_name === 'string' && input.project_name.trim().length > 0;
    if (!hasTarget && !hasProjectName) {
      throw new Error('Company requires either target or project_name.');
    }
  }

  async create(company: TablesInsert<'companies'>, logAction?: string) {
    this.assertHasCompanyIdentity(company);
    await this.assertStageWritable(company);
    const data = await this.companyRepo.insert(company);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: data.id, action: logAction });
    }
    return data;
  }

  async update(id: string, updates: TablesUpdate<'companies'>, logAction?: string) {
    await this.assertStageWritable(updates);
    const data = await this.companyRepo.update(id, updates);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: id, action: logAction });
    }
    return data;
  }

  async updateMany(ids: string[], updates: TablesUpdate<'companies'>, logAction?: string) {
    await this.assertStageWritable(updates);
    const data = await this.companyRepo.updateMany(ids, updates);
    if (logAction) {
      await this.companyLogRepo.insertMany(
        ids.map((company_id) => ({ company_id, action: logAction })),
      );
    }
    return data;
  }

  async delete(id: string) {
    // Deleting a company drops the DB references to its deal documents (via the
    // cascade FK), but intentionally leaves the underlying files in storage —
    // we only lose the loose reference, we don't remove the files themselves.
    // Also drop this company from any file's `matched_companies` so no file
    // keeps a dangling reference to a company that no longer exists.
    await this.fileRepo?.removeMatchedCompany(id);
    await this.companyRepo.delete(id);
  }

  async promote(
    id: string,
    currentStage: string | undefined,
    nextStage: string,
    note?: string,
    linkUrl?: string,
    linkTitle?: string,
    assigneeIds?: string[],
    promotionReason?: string,
    /** Telemetry-only context — see the `captureWorkspaceEvent` call below. */
    opts?: {
      /** Session user behind the move. Absent for agent-tool and bulk-triage
       *  callers, which capture as 'server'. */
      triggeredByUserId?: string | null;
      /** Whether the caller is about to attach a document. The upload happens
       *  after this call returns, so the server can't observe it itself. */
      hasDocument?: boolean;
    },
  ) {
    await this.guardWritable(id);

    const stages = await this.pipelineStages();
    this.assertStageAvailable(stages, nextStage);

    // Always fetch upfront — needed for L0 validation and promotionReason append.
    const existing = await this.companyRepo.findById(id);

    // Coming down to L0 from a later stage is a demotion, not a fresh entry, so
    // it must NOT re-run the entry checks or track matching.
    const isEnteringL0 = nextStage === L0_STAGE && !isInPipelineStage(currentStage);
    if (isEnteringL0) {
      // Hard-block: all required fields must be present before L0 entry.
      this.assertL0Requirements(existing);
      // Ensure a track is assigned: run inline matching if none yet.
      if (!existing.matched_track_ids?.length && this.trackMatchingService) {
        await this.trackMatchingService.runSync({ companyId: id });
      }
    }

    const trimmedPromotionReason = promotionReason?.trim() || null;
    const companyUpdate: TablesUpdate<'companies'> = {
      pipeline_stage: nextStage as DealStage,
    };
    // Deal Captain is shown from L3 onwards — L3 and every stage the workspace
    // orders after it; on entry to one of those it inherits the Deal Sponsor
    // unless a captain has already been set.
    const entersCaptainStage = stageKeysFrom(stages, CAPTAIN_FROM_STAGE_KEY).includes(nextStage);
    if (trimmedPromotionReason || entersCaptainStage) {
      const existing = await this.companyRepo.findById(id);
      if (trimmedPromotionReason) {
        const prior = existing.promoted_reasons?.trim() || '';
        companyUpdate.promoted_reasons = prior
          ? `${prior}\n\n${trimmedPromotionReason}`
          : trimmedPromotionReason;
      }
      if (
        entersCaptainStage &&
        !existing.deal_captain?.trim() &&
        existing.deal_sponsor?.trim()
      ) {
        companyUpdate.deal_captain = existing.deal_sponsor;
      }
    }
    await this.companyRepo.update(id, companyUpdate);
    await this.companyLogRepo.insert({
      company_id: id,
      action: currentStage
        ? `PROMOTED_FROM_${currentStage}_TO_${nextStage}`
        : `PROMOTED_TO_${nextStage}`,
    });
    if (note?.trim()) {
      await this.dealNoteRepo.insert({
        deal_id: id,
        content: note,
        stage: currentStage || 'L0',
      });
    }
    if (linkUrl?.trim()) {
      await this.dealLinkRepo.insert({
        deal_id: id,
        url: linkUrl,
        title: linkTitle || null,
        stage: currentStage || 'L0',
      });
    }
    if (assigneeIds !== undefined) {
      await this.companyRepo.setAssignees(id, assigneeIds);
    }
    await this.regenerateCompanyCardForStageMove(id, currentStage, nextStage);

    // Captured here rather than in `PromoteDialog` so an ad blocker can't drop
    // it, and so stage moves made by the agent tools and bulk triage — which
    // have no browser at all — are counted too.
    const direction = stageMoveDirection(currentStage, nextStage, liveStageKeys(stages));
    captureWorkspaceEvent({
      workspaceId: this.workspaceId,
      distinctId: opts?.triggeredByUserId ?? 'server',
      event: direction === 'demote' ? 'deal_demoted' : 'deal_promoted',
      properties: {
        deal_id: id,
        company_name: companyDisplayName(existing, ''),
        from_stage: currentStage ?? null,
        to_stage: nextStage,
        has_note: Boolean(note?.trim()),
        has_link: Boolean(linkUrl?.trim()),
        has_reason: Boolean(trimmedPromotionReason),
        has_document: Boolean(opts?.hasDocument),
      },
    });
  }

  getAssignees(id: string) {
    return this.companyRepo.findAssignees(id);
  }

  async setAssignees(id: string, userIds: string[]) {
    return this.companyRepo.setAssignees(id, userIds);
  }

  async dropDeal(
    id: string,
    currentStage: string | undefined,
    reason?: string,
    opts?: { resurfaceAt?: string | null; droppedBy?: string | null },
  ) {
    const trimmedReason = reason?.trim() || null;
    const resurfaceAt = opts?.resurfaceAt ?? null;
    if (resurfaceAt) {
      const parsed = new Date(resurfaceAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error('Invalid resurface date');
      }
      if (parsed.getTime() <= Date.now()) {
        throw new Error('Resurface date must be in the future');
      }
    }
    await this.companyRepo.update(id, {
      status: 'dropped',
      dropped_reason: trimmedReason,
      dropped_at: new Date().toISOString(),
      resurface_at: resurfaceAt ? new Date(resurfaceAt).toISOString() : null,
      dropped_by: opts?.droppedBy ?? null,
    });
    await this.companyLogRepo.insert({
      company_id: id,
      action: currentStage ? `DROPPED_FROM_${currentStage}` : 'DROPPED',
    });
    if (reason?.trim()) {
      await this.dealNoteRepo.insert({
        deal_id: id,
        content: reason,
        stage: currentStage || 'L0',
      });
    }
  }

  async dropDealMany(
    deals: Array<{ id: string; currentStage?: string; reason?: string }>,
    reason?: string,
  ) {
    if (deals.length === 0) return;
    const ids = deals.map((d) => d.id);
    const trimmedGlobalReason = reason?.trim() || null;

    const hasDistinctReasons = deals.some((d) => d.reason?.trim());
    const droppedAt = new Date().toISOString();

    if (hasDistinctReasons) {
      await Promise.all(
        deals.map((d) => {
          const r = d.reason?.trim() || trimmedGlobalReason;
          return this.companyRepo.update(d.id, {
            status: 'dropped',
            dropped_reason: r,
            dropped_at: droppedAt,
          });
        })
      );
    } else {
      await this.companyRepo.updateMany(ids, {
        status: 'dropped',
        dropped_reason: trimmedGlobalReason,
        dropped_at: droppedAt,
      });
    }

    await this.companyLogRepo.insertMany(
      deals.map(({ id, currentStage }) => ({
        company_id: id,
        action: currentStage ? `DROPPED_FROM_${currentStage}` : 'DROPPED',
      })),
    );

    const notesToInsert = deals
      .map((d) => {
        const r = d.reason?.trim() || trimmedGlobalReason;
        if (!r) return null;
        return {
          deal_id: d.id,
          content: r,
          stage: d.currentStage || 'L0',
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);

    if (notesToInsert.length > 0) {
      await this.dealNoteRepo.insertMany(notesToInsert);
    }
  }

  async promoteMany(
    deals: Array<{ id: string; currentStage?: string }>,
    nextStage: string,
    /** Session user behind the move, for telemetry attribution — see `promote`. */
    triggeredByUserId?: string | null,
  ) {
    if (deals.length === 0) return;
    const ids = deals.map((d) => d.id);
    const stages = await this.pipelineStages();
    this.assertStageAvailable(stages, nextStage);
    const stageOrder = liveStageKeys(stages);
    await this.guardWritableMany(ids);
    await this.companyRepo.updateMany(ids, {
      pipeline_stage: nextStage as DealStage,
    });
    await this.companyLogRepo.insertMany(
      deals.map(({ id, currentStage }) => ({
        company_id: id,
        action: currentStage
          ? `PROMOTED_FROM_${currentStage}_TO_${nextStage}`
          : `PROMOTED_TO_${nextStage}`,
      })),
    );
    await this.regenerateCompanyCardsForBulkStageMove(deals, nextStage);

    // One event per deal, matching `promote`'s shape, so a bulk move and a
    // single move are counted the same way and a breakdown by stage doesn't
    // silently miss every deal moved from the chat's bulk-promote card.
    for (const { id, currentStage } of deals) {
      captureWorkspaceEvent({
        workspaceId: this.workspaceId,
        distinctId: triggeredByUserId ?? 'server',
        event:
          stageMoveDirection(currentStage, nextStage, stageOrder) === 'demote'
            ? 'deal_demoted'
            : 'deal_promoted',
        properties: {
          deal_id: id,
          from_stage: currentStage ?? null,
          to_stage: nextStage,
          // Distinguishes these from single moves, which carry a company name
          // and note/link/reason flags this path has no equivalent of.
          bulk: true,
          bulk_size: deals.length,
        },
      });
    }
  }

  async drop(id: string, reason?: string): Promise<void> {
    await this.dropDeal(id, 'L0', reason);
  }

  async countUnreviewed(source?: string): Promise<number> {
    return this.companyRepo.countUnreviewed(source);
  }

  /**
   * Bring a dropped deal back into the pipeline. It returns to the stage it
   * was dropped at, unless that stage has since been deleted: then the caller
   * must name a live `targetStage` (the UI asks the user), else
   * `RestoreStageRequiredError`.
   */
  async restoreDeal(id: string, currentStage: string | undefined, targetStage?: string) {
    const stages = await this.pipelineStages();
    let restoreTo = currentStage;
    if (targetStage) {
      this.assertStageAvailable(stages, targetStage);
      restoreTo = targetStage;
    } else if (currentStage && isInPipelineStage(currentStage) && !liveStageKeys(stages).includes(currentStage)) {
      throw new RestoreStageRequiredError(currentStage);
    }
    await this.companyRepo.update(id, {
      status: 'active',
      dropped_reason: null,
      dropped_at: null,
      // A manual restore cancels any pending scheduled resurface.
      resurface_at: null,
      dropped_by: null,
      ...(restoreTo && restoreTo !== currentStage ? { pipeline_stage: restoreTo } : {}),
    });
    await this.companyLogRepo.insert({
      company_id: id,
      action: restoreTo ? `RESTORED_TO_${restoreTo}` : 'RESTORED',
    });
  }

  runL1Filters(id: string) {
    return this.companyRepo.runL1Filters(id);
  }

  async updateFinancials(
    companyId: string,
    rows: FinancialUpsertInput[],
    deletedYears: number[],
    logAction?: string,
  ): Promise<CompanyDTO> {
    const existing = await this.companyFinancialRepo.findByCompany(companyId);
    const existingByYear = new Map(existing.map((r) => [r.fiscal_year, r]));

    const merged = rows.map((row) => {
      const prior = existingByYear.get(row.fiscal_year);
      const revenue =
        row.revenue_usd_mn !== undefined ? row.revenue_usd_mn : (prior?.revenue_usd_mn ?? null);
      const ebitda =
        row.ebitda_usd_mn !== undefined ? row.ebitda_usd_mn : (prior?.ebitda_usd_mn ?? null);
      const ev = row.ev_usd_mn !== undefined ? row.ev_usd_mn : (prior?.ev_usd_mn ?? null);
      // Margin and multiple are pure functions of the figures above, so once
      // one of their OWN inputs is submitted the stored value is stale and
      // must be recomputed (or cleared when an input is missing) rather than
      // carried over — a revenue edit that leaves the old margin in place
      // silently publishes a percentage computed against the previous revenue
      // on the company card and the Excel export.
      //
      // Each ratio is gated on its own inputs, not on "any figure changed":
      // the FE charts PUT a single metric, and treating a revenue-only save as
      // a reason to recompute EV/EBITDA would wipe a multiple that ingest or
      // screening stored for a year with no EV on file.
      // `revenue_cagr_vs_prior` is deliberately NOT touched: it spans two
      // fiscal years and belongs to the screening pipeline that fills it.
      const marginTouched =
        row.revenue_usd_mn !== undefined || row.ebitda_usd_mn !== undefined;
      const multipleTouched =
        row.ev_usd_mn !== undefined || row.ebitda_usd_mn !== undefined;
      return {
        fiscal_year: row.fiscal_year,
        revenue_usd_mn: revenue,
        ebitda_usd_mn: ebitda,
        ev_usd_mn: ev,
        ebitda_margin: marginTouched ? ratio(ebitda, revenue) : (prior?.ebitda_margin ?? null),
        ev_ebitda: multipleTouched ? ratio(ev, ebitda) : (prior?.ev_ebitda ?? null),
        revenue_cagr_vs_prior: prior?.revenue_cagr_vs_prior ?? null,
      };
    });

    if (merged.length > 0) {
      await this.companyFinancialRepo.bulkUpsertForCompany(companyId, merged);
    }
    if (deletedYears.length > 0) {
      await this.companyFinancialRepo.deleteByCompanyAndYears(companyId, deletedYears);
    }
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: companyId, action: logAction });
    }
    return this.findByIdDTO(companyId);
  }

  private async guardWritable(id: string): Promise<void> {
    const company = await this.companyRepo.findById(id);
    if (company.status === 'dropped') {
      throw new CompanyDroppedError([id]);
    }
  }

  private async guardWritableMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const dropped = await this.companyRepo.findDroppedIds(ids);
    if (dropped.length > 0) {
      throw new CompanyDroppedError(dropped);
    }
  }
}
