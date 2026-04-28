import { deleteFile } from '@/lib/s3';
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

export interface FinancialUpsertInput {
  fiscal_year: number;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
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
  ) {}

  findById(id: string) {
    return this.companyRepo.findById(id);
  }

  list(filters: Omit<CompanyFilters, 'id'>) {
    return this.companyRepo.findAll(filters);
  }

  count(filters: Pick<CompanyFilters, 'id' | 'stage' | 'stageIn' | 'excludeStage' | 'stageNotNull' | 'excludeDropped' | 'createdAfter'>) {
    return this.companyRepo.count(filters);
  }

  findDetails(id: string) {
    return this.companyRepo.findDetails(id);
  }

  // --------- DTO (flat, backward-compatible) read path ---------
  async findByIdDTO(id: string): Promise<CompanyDTO> {
    const [company, financials, fx, screening] = await Promise.all([
      this.companyRepo.findById(id),
      this.companyFinancialRepo.findByCompany(id),
      this.companyFxAdjustmentRepo.findByCompany(id),
      this.companyScreeningDerivedRepo.findByCompany(id),
    ]);
    return toCompanyDTO(company, financials, fx, screening);
  }

  async listDTO(filters: Omit<CompanyFilters, 'id'>): Promise<CompanyDTO[]> {
    const companies = await this.companyRepo.findAll(filters);
    if (companies.length === 0) return [];
    const ids = companies.map((c) => c.id);
    const [financials, fxRows, screeningRows] = await Promise.all([
      this.companyFinancialRepo.findByCompanies(ids),
      this.companyFxAdjustmentRepo.findByCompanies(ids),
      this.companyScreeningDerivedRepo.findByCompanies(ids),
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
    return companies.map((c) =>
      toCompanyDTO(
        c,
        finByCompany.get(c.id) ?? [],
        fxByCompany.get(c.id) ?? [],
        screeningByCompany.get(c.id) ?? null,
      ),
    );
  }

  // --------- DTO (flat) write path: split across tables ---------
  /**
   * Accepts a flat FE payload and writes to companies + child tables. Returns
   * the composed DTO so the FE can round-trip without a refetch.
   */
  async createFromDTO(input: CompanyDTOInput, logAction?: string): Promise<CompanyDTO> {
    const split = splitCompanyDTO(input);
    const inserted = await this.companyRepo.insert(
      split.company as TablesInsert<'companies'>,
    );
    await this.applyChildWrites(inserted.id, split);
    if (logAction) {
      await this.companyLogRepo.insert({ company_id: inserted.id, action: logAction });
    }
    return this.findByIdDTO(inserted.id);
  }

  async updateFromDTO(
    id: string,
    input: CompanyDTOInput,
    logAction?: string,
  ): Promise<CompanyDTO> {
    const split = splitCompanyDTO(input);
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
    const filePaths = await this.dealDocRepo.findFilePathsByDealId(id);
    if (filePaths.length > 0) {
      await Promise.all(filePaths.map((key) => deleteFile(key)));
    }
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
  ) {
    await this.companyRepo.update(id, { pipeline_stage: nextStage as DealStage });
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

  setAssignees(id: string, userIds: string[]) {
    return this.companyRepo.setAssignees(id, userIds);
  }

  async dropDeal(id: string, currentStage: string | undefined, reason?: string) {
    await this.companyRepo.update(id, { status: 'dropped' });
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

  async restoreDeal(id: string, currentStage: string | undefined) {
    await this.companyRepo.update(id, { status: null });
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
}
