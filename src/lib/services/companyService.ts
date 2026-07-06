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
import type { UserRepository } from '@/lib/repositories';

const L0_STAGE: DealStage = 'L0';
// Stages above L0. A move into L0 from one of these is a *demotion*, not a fresh
// entry, so it must NOT re-trigger track matching (the company was matched when
// it first entered L0).
const POST_L0_STAGES: ReadonlySet<string> = new Set(['L1', 'L2', 'L3', 'L4', 'L5']);
// Stages inside the active pipeline. Moving a pre-L0 company (market_screening /
// unreviewed / discovered) into any of these is a pipeline entry and must pass
// the same L0 required-field gate as an explicit promote. Exported so file
// ingestion can gate HITL review on it: changes to a company actively in the
// pipeline (L0–L5) require human approval; pre-pipeline companies auto-accept.
export const IN_PIPELINE_STAGES: ReadonlySet<string> = new Set([L0_STAGE, ...POST_L0_STAGES]);

export interface FinancialUpsertInput {
  fiscal_year: number;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
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

export class CompanyService {
  constructor(
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
  ) {}

  findById(id: string) {
    return this.companyRepo.findById(id);
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
   * File Dump "Matched Company" combobox. Supports server-side ILIKE search
   * via `targetSearch` and offset/limit pagination — see
   * `CompanyRepository.findIdAndTargetPage`.
   */
  listIdAndTargetPage(
    filters: Pick<CompanyFilters, 'limit' | 'offset' | 'targetSearch'>,
  ) {
    return this.companyRepo.findIdAndTargetPage(filters);
  }

  count(filters: Pick<CompanyFilters, 'id' | 'stage' | 'stageIn' | 'excludeStage' | 'stageNotNull' | 'excludeDropped' | 'createdAfter'>) {
    return this.companyRepo.count(filters);
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
  async createFromDTO(input: CompanyDTOInput, logAction?: string): Promise<CompanyDTO> {
    this.assertHasCompanyIdentity(input);
    const split = splitCompanyDTO(input);
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
    if (typeof nextStage === 'string' && IN_PIPELINE_STAGES.has(nextStage)) {
      const existing = await this.companyRepo.findById(id);
      const wasPreL0 = !IN_PIPELINE_STAGES.has(existing.pipeline_stage ?? '');
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

  /** Returns the list of missing required fields for L0 entry. Empty = all clear. */
  static checkL0Requirements(company: {
    target?: string | null;
    project_name?: string | null;
    entered_by?: string | null;
    source?: string | null;
    deal_type?: string | null;
    geography?: string | null;
    segment?: string | null;
    banker?: string | null;
    banker_source?: string | null;
  }): string[] {
    const missing: string[] = [];
    const filled = (v: string | null | undefined) => typeof v === 'string' && v.trim().length > 0;
    if (!filled(company.target) && !filled(company.project_name)) missing.push('Company Name / Project Name');
    if (!filled(company.entered_by)) missing.push('Entered By');
    if (!filled(company.source)) missing.push('Deal Type: Inbound/Outbound');
    if (!filled(company.deal_type)) missing.push('Deal Type: Majority/Minority');
    if (!filled(company.geography)) missing.push('Geo');
    if (!filled(company.segment)) missing.push('Sector');
    if (company.source !== 'outbound' && !filled(company.banker) && !filled(company.banker_source)) missing.push('Banker');
    return missing;
  }

  private assertL0Requirements(company: Tables<'companies'>): void {
    const missing = CompanyService.checkL0Requirements(company);
    if (missing.length > 0) throw new CompanyL0RequirementsError(missing);
  }

  private assertHasCompanyIdentity(input: CompanyDTOInput): void {
    const hasTarget = typeof input.target === 'string' && input.target.trim().length > 0;
    const hasProjectName =
      typeof input.project_name === 'string' && input.project_name.trim().length > 0;
    if (!hasTarget && !hasProjectName) {
      throw new Error('Company requires either target or project_name.');
    }
  }

  async create(company: TablesInsert<'companies'>, logAction?: string) {
    const data = await this.companyRepo.insert(company);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: data.id, action: logAction });
    }
    return data;
  }

  async update(id: string, updates: TablesUpdate<'companies'>, logAction?: string) {
    const data = await this.companyRepo.update(id, updates);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: id, action: logAction });
    }
    return data;
  }

  async updateMany(ids: string[], updates: TablesUpdate<'companies'>, logAction?: string) {
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
  ) {
    await this.guardWritable(id);

    // Always fetch upfront — needed for L0 validation and promotionReason append.
    const existing = await this.companyRepo.findById(id);

    const isEnteringL0 = nextStage === L0_STAGE && !POST_L0_STAGES.has(currentStage ?? '');
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
    // Deal Captain is shown from L3 onwards; on entry to L3+ it inherits the
    // Deal Sponsor unless a captain has already been set.
    const entersCaptainStage =
      nextStage === 'L3' || nextStage === 'L4' || nextStage === 'L5';
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
    deals: Array<{ id: string; currentStage?: string }>,
    reason?: string,
  ) {
    if (deals.length === 0) return;
    const ids = deals.map((d) => d.id);
    await this.guardWritableMany(ids);
    const trimmedReason = reason?.trim() || null;
    await this.companyRepo.updateMany(ids, {
      status: 'dropped',
      dropped_reason: trimmedReason,
      dropped_at: new Date().toISOString(),
    });
    await this.companyLogRepo.insertMany(
      deals.map(({ id, currentStage }) => ({
        company_id: id,
        action: currentStage ? `DROPPED_FROM_${currentStage}` : 'DROPPED',
      })),
    );
    if (reason?.trim()) {
      await this.dealNoteRepo.insertMany(
        deals.map(({ id, currentStage }) => ({
          deal_id: id,
          content: reason,
          stage: currentStage || 'L0',
        })),
      );
    }
  }

  async promoteMany(
    deals: Array<{ id: string; currentStage?: string }>,
    nextStage: string,
  ) {
    if (deals.length === 0) return;
    const ids = deals.map((d) => d.id);
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
  }

  async drop(id: string, reason?: string): Promise<void> {
    await this.dropDeal(id, 'L0', reason);
  }

  async countUnreviewed(source?: string): Promise<number> {
    return this.companyRepo.countUnreviewed(source);
  }

  async restoreDeal(id: string, currentStage: string | undefined) {
    await this.companyRepo.update(id, {
      status: 'active',
      dropped_reason: null,
      dropped_at: null,
      // A manual restore cancels any pending scheduled resurface.
      resurface_at: null,
      dropped_by: null,
    });
    await this.companyLogRepo.insert({
      company_id: id,
      action: currentStage ? `RESTORED_TO_${currentStage}` : 'RESTORED',
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
      return {
        fiscal_year: row.fiscal_year,
        revenue_usd_mn:
          row.revenue_usd_mn !== undefined ? row.revenue_usd_mn : (prior?.revenue_usd_mn ?? null),
        ebitda_usd_mn:
          row.ebitda_usd_mn !== undefined ? row.ebitda_usd_mn : (prior?.ebitda_usd_mn ?? null),
        ev_usd_mn: prior?.ev_usd_mn ?? null,
        ebitda_margin: prior?.ebitda_margin ?? null,
        ev_ebitda: prior?.ev_ebitda ?? null,
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
