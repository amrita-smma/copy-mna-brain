import { downloadFile, getSignedUrl } from '@/lib/s3';
import { deleteFile } from '@/lib/s3';
import { sql } from 'drizzle-orm';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { processFileContent, type FileTypeOverride } from '@/lib/agents/file_processing';
import { isGenericDocumentPhrase } from '@/lib/agents/file_processing/genericNameDenylist';
import type { CompanyDTOInput } from '@/lib/dto/companyDTO';
import { createNeo4jDriver } from '@/lib/neo4j';
import { CompanyRelationRepository } from '@/lib/repositories/companyRelationRepository';
import {
  CompanyRepository,
  CompanyLogRepository,
  CompanyFinancialRepository,
  CompanyFxAdjustmentRepository,
  CompanyScreeningDerivedRepository,
  DealDocumentRepository,
  DealNoteRepository,
  DealLinkRepository,
  type DbClient,
  type FileRepository,
  type CriteriaRepository,
  type ScreeningRepository,
  type Tables,
  type TablesInsert,
} from '@/lib/repositories';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { AIScreeningService } from './aiScreeningService';
import type { CRMService } from './crmService';
import { CompanyL0RequirementsError, CompanyService } from './companyService';
import type { TrackMatchingService } from './trackMatchingService';

/**
 * File types that describe a deal target (a company/project genuinely offered
 * for sale) and may therefore mint a company row. Only sale-offering documents
 * qualify — financial statements, legal agreements, MoMs, and buyer/sponsor/
 * advisor material describe counterparties or process, NOT companies on sale,
 * and must never auto-create a company. (MB-300)
 */
const DEAL_TARGET_FILE_TYPES = new Set<string>(['prospectus']);

/**
 * `entered_by` value stamped on companies auto-created from banker email
 * attachments (no human enters these). Manual create/upload flows stamp the
 * acting user's name instead.
 */
export const AI_EMAIL_SCANNING_ENTERED_BY = 'AI Email Scanning';

/**
 * The `files` table doesn't persist the original upload content type, so a
 * reprocess reconstructs it from the filename extension. Only PDF detection is
 * behaviourally significant (the agent uploads PDFs via the Files API keyed off
 * `contentType === 'application/pdf'`); everything else is passed to
 * `extractTextFromFile`, which also falls back to the extension.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
};

function guessContentType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** File types that are valid `FileTypeOverride`s the agent accepts as a hint. */
const FILE_TYPE_OVERRIDE_VALUES = new Set<FileTypeOverride>([
  'mom',
  'prospectus',
  'other',
  'shopping_list',
  'market_study',
]);

/**
 * Narrow a stored `file_type` to a `FileTypeOverride` the agent accepts. Types
 * outside the override union (e.g. `financial_statement`, `banker_communications`)
 * return undefined so the agent classifies from content instead.
 */
function asFileTypeOverride(fileType: string | null | undefined): FileTypeOverride | undefined {
  return fileType && FILE_TYPE_OVERRIDE_VALUES.has(fileType as FileTypeOverride)
    ? (fileType as FileTypeOverride)
    : undefined;
}

export interface ApproveFileInput {
  file_type: FileTypeOverride;
  matched_company_id: string | null;
  create_company_from_ai?: boolean;
  /** Per-field selections from HITL dialog — only the fields the user ticked. */
  company_field_updates?: Partial<Pick<Tables<'companies'>,
    | 'target' | 'project_name' | 'segment' | 'segment_related_offerings'
    | 'company_focus' | 'website' | 'watchlist_status' | 'comments'
    | 'ownership' | 'geography' | 'remarks'
  >>;
  /**
   * Fiscal years (and their FX rows) the user ticked for upsert. If
   * undefined or empty, no financial/FX rows are written. Pass the years
   * to apply explicitly so existing rows aren't accidentally overwritten.
   */
  financial_years_to_apply?: number[];
  /** Required L0 fields supplied by the user when creating a company from AI. */
  entered_by?: string | null;
  deal_type?: 'majority' | 'minority' | null;
  banker?: string | null;
}

type ProspectusSummary = {
  company_name?: string | null;
  project_name?: string | null;
  segment?: string | null;
  segment_related_offerings?: string | null;
  company_focus?: string | null;
  website?: string | null;
  watchlist_status?: string | null;
  comments?: string | null;
  ownership?: string | null;
  geography?: string | null;
  remarks?: string | null;
  banker?: string | null;
  financials?: Array<{
    fiscal_year: number;
    revenue_usd_mn: number | null;
    ebitda_usd_mn: number | null;
    ev_usd_mn: number | null;
    ebitda_margin: number | null;
    ev_ebitda: number | null;
    revenue_cagr_vs_prior: number | null;
  }>;
  fx_adjustments?: Array<{
    fiscal_year: number;
    currency: string;
    revenue_local: number | null;
    revenue_local_unit: 'mn' | 'bn' | 'thousands';
    ebitda_local: number | null;
    ebitda_local_unit: 'mn' | 'bn' | 'thousands';
    assumed_forex: number | null;
    forex_change_vs_prior: number | null;
    revenue_cagr_domestic: number | null;
  }>;
};

type FinancialStatementSummary = {
  company_name?: string | null;
  financials?: Array<{
    fiscal_year: number;
    revenue_usd_mn: number | null;
    ebitda_usd_mn: number | null;
    ev_usd_mn: number | null;
    ebitda_margin: number | null;
    ev_ebitda: number | null;
    revenue_cagr_vs_prior: number | null;
  }>;
  fx_adjustments?: unknown[];
};

export class FileService {
  private crmService?: CRMService;

  constructor(
    private readonly db: DbClient,
    private readonly fileRepo: FileRepository,
    private readonly companyAnalysisService: CompanyAnalysisService,
    private readonly aiScreeningService: AIScreeningService,
    private readonly criteriaRepo: CriteriaRepository,
    private readonly screeningRepo: ScreeningRepository,
    private readonly companyFinancialRepo: CompanyFinancialRepository,
    private readonly companyService: CompanyService,
    private readonly companyFxAdjustmentRepo: CompanyFxAdjustmentRepository,
    // Passed to transaction-scoped CompanyService instances so AI File Dump
    // inbound companies entering L0 also trigger agent-driven track matching.
    private readonly trackMatchingService?: TrackMatchingService,
    private readonly userRepo?: import('@/lib/repositories').UserRepository,
  ) {}

  setCRMService(crmService: CRMService) {
    this.crmService = crmService;
  }

  async findAll(fileType?: string) {
    const files = await this.fileRepo.findAll(fileType);
    return Promise.all(
      files.map(async (file) => {
        try {
          const signedUrl = await getSignedUrl(file.file_link);
          return { ...file, signed_url: signedUrl };
        } catch {
          return { ...file, signed_url: null };
        }
      }),
    );
  }

  async processUpload(
    key: string,
    fileName: string,
    contentType: string,
    rawNotes?: string,
    fileTypeOverride?: FileTypeOverride,
    originEmail?: boolean,
    bankerSource?: string,
    /** For the MBOX email pipeline: the custodian's email address. Resolved
     *  to a user UUID via UserRepository.findByEmail. */
    enteredByEmail?: string,
    /** For manual AFD uploads: the authenticated session user's UUID. */
    uploaderUserId?: string | null,
  ) {
    const buffer = await downloadFile(key);
    const fileType = contentType || 'application/octet-stream';

    const initialData = await this.fileRepo.insert({
      file_name: fileName,
      file_link: key,
      processing_status: 'processing',
      file_type: fileTypeOverride ?? 'other',
      origin_email: originEmail ?? false,
    });

    let rawText = '';
    let structuredResult: Awaited<ReturnType<typeof processFileContent>> = null;
    let tags: string[] = [];
    let matched_companies: unknown[] = [];

    try {
      const isPdf = fileType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        rawText = await extractTextFromFile(buffer, fileType, fileName);
      }

      structuredResult = await processFileContent(rawText, buffer, fileType, rawNotes ?? '', fileTypeOverride, fileName);

      if (structuredResult) {
        tags = structuredResult.tags || [];
        matched_companies = structuredResult.matched_companies || [];
      }

      // Only deal-target (sale-offering) files require HITL review (the
      // duplicate-company / financial-enrichment gate from MB-122). MoM,
      // banker_communications, financial statements, legal documents, and
      // other file types auto-complete to match pre-MB-122 behavior — they
      // have no prospectus_summary to diff and no financials to upsert.
      const effectiveFileType = fileTypeOverride ?? structuredResult?.file_type ?? 'other';
      const requiresReview = DEAL_TARGET_FILE_TYPES.has(effectiveFileType);

      // MB-225 connector: auto-create unreviewed pipeline company from email attachments.
      // Only fires when: (a) file came from email pipeline, (b) AFD extracted content,
      // (c) the file is a sale offering describing a deal target. Financial
      // statements, legal docs, and buyer/sponsor/advisor material must NOT
      // auto-create a company — they describe counterparties, not targets. (MB-300)
      if (originEmail && structuredResult && DEAL_TARGET_FILE_TYPES.has(effectiveFileType)) {
        try {
          const summary = (structuredResult as Record<string, unknown>).prospectus_summary as ProspectusSummary | undefined;
          matched_companies = await this.mergeEmailOriginAttachmentCompany({
            matchedCompanies: matched_companies,
            summary,
            parsedNotes: structuredResult as Record<string, unknown>,
            effectiveFileType,
            companySource: 'inbound',
            bankerSource,
            enteredByEmail,
            fileId: initialData.id,
          });
        } catch (err) {
          console.error('[fileService] Failed to merge/create email-origin company:', err);
        }
      }

      // MB-300: financial statements update company_financials for matched existing
      // deal targets but never create new company rows.
      if (originEmail && structuredResult && effectiveFileType === 'financial_statement') {
        try {
          const fss = (structuredResult as Record<string, unknown>).financial_statement_summary as FinancialStatementSummary | undefined;
          await this.mergeFinancialStatementCompanyFinancials({
            matchedCompanies: matched_companies,
            financialStatementSummary: fss,
            fileId: initialData.id,
          });
        } catch (err) {
          console.error('[fileService] Failed to merge financial statement financials:', err);
        }
      }

      await this.fileRepo.updatePartial(initialData.id, {
        raw_notes: rawText,
        file_type: effectiveFileType,
        structured_notes: structuredResult ? JSON.stringify(structuredResult, null, 2) : null,
        tags,
        matched_companies: matched_companies as Tables<'files'>['matched_companies'],
        file_date: structuredResult?.file_date || null,
        processing_status: requiresReview ? 'awaiting_review' : 'completed',
      });
    } catch (processError) {
      console.error('Error during file processing:', processError);
      await this.fileRepo.updatePartial(initialData.id, {
        processing_status: 'failed',
        raw_notes: rawText || 'Extraction failed',
      });
    }

    const updatedData = await this.fileRepo.findById(initialData.id);
    const signedUrl = await getSignedUrl(key);

    if (structuredResult?.file_type === 'banker_communications' && structuredResult?.communications && this.crmService) {
      const communications = structuredResult.communications as Array<{
        from_email: string;
        from_name?: string;
        to_email?: string;
        to_name?: string;
        subject?: string;
        body: string;
        sent_at?: string;
        company?: string;
      }>;

      await this.crmService
        .ingestEmails(
          communications.map((comm) => ({
            from_email: comm.from_email,
            from_name: comm.from_name,
            to_email: comm.to_email,
            to_name: comm.to_name,
            subject: comm.subject,
            body: comm.body,
            sent_at: comm.sent_at,
            direction: 'inbound' as const,
            company: comm.company,
          })),
        )
        .catch((err) => {
          console.error('Error adding communications to CRM:', err);
        });
    }

    return { ...updatedData, signed_url: signedUrl };
  }

  /**
   * Re-run the file-processing agent on an already-uploaded file and refresh
   * its extracted fields in place: `raw_notes`, `structured_notes`, `tags`,
   * `matched_companies`, and `file_date`.
   *
   * This is a pure refresh. Unlike {@link processUpload} it never auto-creates
   * or merges companies, never upserts financials, and never re-ingests banker
   * communications into the CRM — those side effects belong to the upload and
   * approve flows and re-running them would risk duplicating or clobbering
   * already-approved records. The file keeps its existing `file_type` (so it
   * stays in the same tab); prospectus files return to `awaiting_review` so a
   * human re-approves, everything else completes.
   */
  async reprocess(fileId: string) {
    const existing = await this.fileRepo.findById(fileId);
    const key = existing.file_link;
    const fileName = existing.file_name;
    const existingFileType = existing.file_type ?? 'other';

    await this.fileRepo.updatePartial(fileId, { processing_status: 'processing' });

    const buffer = await downloadFile(key);
    const contentType = guessContentType(fileName);
    const override = asFileTypeOverride(existingFileType);

    let rawText = '';
    let structuredResult: Awaited<ReturnType<typeof processFileContent>> = null;
    let tags: string[] = [];
    let matched_companies: unknown[] = [];

    try {
      const isPdf = contentType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        rawText = await extractTextFromFile(buffer, contentType, fileName);
      }

      structuredResult = await processFileContent(rawText, buffer, contentType, '', override, fileName);

      if (structuredResult) {
        tags = structuredResult.tags || [];
        matched_companies = structuredResult.matched_companies || [];
      }

      // Prospectuses re-enter the HITL review gate; everything else completes.
      // file_type is intentionally left untouched so the file stays in its tab.
      const requiresReview = DEAL_TARGET_FILE_TYPES.has(existingFileType);

      await this.fileRepo.updatePartial(fileId, {
        raw_notes: rawText,
        structured_notes: structuredResult ? JSON.stringify(structuredResult, null, 2) : null,
        tags,
        matched_companies: matched_companies as Tables<'files'>['matched_companies'],
        file_date: structuredResult?.file_date || null,
        processing_status: requiresReview ? 'awaiting_review' : 'completed',
      });
    } catch (processError) {
      console.error('Error during file reprocessing:', processError);
      await this.fileRepo.updatePartial(fileId, {
        processing_status: 'failed',
        raw_notes: rawText || 'Extraction failed',
      });
      throw processError;
    }

    const updatedData = await this.fileRepo.findById(fileId);
    const signedUrl = await getSignedUrl(key).catch(() => null);
    return { ...updatedData, signed_url: signedUrl };
  }

  /**
   * Build the diff payload for the HITL review dialog.
   *
   * `companyIdOverride` lets the dialog ask "what would the diff look like
   * against THIS company instead?" without persisting anything yet. Pass:
   *   - `undefined` → fall back to the file's stored matched_companies[0].id
   *   - `null` or `''` → no company; `current` is empty
   *   - a uuid → compare against that company
   */
  async getReviewData(fileId: string, companyIdOverride?: string | null) {
    const file = await this.fileRepo.findById(fileId);
    const parsedNotes = this.parseStructuredNotes(file.structured_notes);
    const summary = parsedNotes?.prospectus_summary as ProspectusSummary | undefined;

    const proposedCompanyId =
      companyIdOverride === undefined
        ? this.pickProposedCompanyId(file.matched_companies)
        : companyIdOverride && companyIdOverride.length > 0
          ? companyIdOverride
          : null;

    let currentCompany: Tables<'companies'> | null = null;
    let currentFinancials: Tables<'company_financials'>[] = [];
    let currentFxAdjustments: Tables<'company_fx_adjustments'>[] = [];

    if (proposedCompanyId) {
      [currentCompany, currentFinancials, currentFxAdjustments] = await Promise.all([
        this.companyService.findById(proposedCompanyId),
        this.companyFinancialRepo.findByCompany(proposedCompanyId),
        this.companyFxAdjustmentRepo.findByCompany(proposedCompanyId),
      ]);
    }

    // TODO: query files WHERE processing_status='awaiting_review' AND id!=fileId
    // AND matched_companies contains proposedCompanyId for conflict detection.
    const conflicts: Tables<'files'>[] = [];

    return {
      file,
      ai: {
        file_type: (parsedNotes?.file_type as string | null) ?? null,
        suggested_company: summary
          ? {
              target: summary.company_name ?? null,
              project_name: summary.project_name ?? null,
              segment: summary.segment ?? null,
              segment_related_offerings: summary.segment_related_offerings ?? null,
              company_focus: summary.company_focus ?? null,
              website: summary.website ?? null,
              watchlist_status: summary.watchlist_status ?? null,
              comments: summary.comments ?? null,
              ownership: summary.ownership ?? null,
              geography: summary.geography ?? null,
              remarks: summary.remarks ?? null,
            }
          : null,
        suggested_banker: summary?.banker?.trim() || null,
        financials: summary?.financials ?? [],
        fx_adjustments: summary?.fx_adjustments ?? [],
      },
      current: {
        company: currentCompany,
        financials: currentFinancials,
        fx_adjustments: currentFxAdjustments,
      },
      conflicts,
    };
  }

  async approve(fileId: string, input: ApproveFileInput, enteredBy?: string | null) {
    const file = await this.fileRepo.findById(fileId);
    const parsedNotes = this.parseStructuredNotes(file.structured_notes);
    const summary = parsedNotes?.prospectus_summary as ProspectusSummary | undefined;

    let companyId: string | null = input.matched_company_id;
    let companyRecord: Tables<'companies'> | null = null;

    if (!companyId && input.create_company_from_ai && summary) {
      const safeTarget = summary.company_name && !isGenericDocumentPhrase(summary.company_name)
        ? summary.company_name : null;
      const safeProjectName = summary.project_name && !isGenericDocumentPhrase(summary.project_name)
        ? summary.project_name : null;
      if (safeTarget || safeProjectName) {
        // Run L0 requirements check via the shared static method — same rules
        // as the triage promote flow. Throws if any required fields are missing.
        const missing = CompanyService.checkL0Requirements({
          target: safeTarget,
          project_name: safeProjectName,
          entered_by: input.entered_by,
          source: 'inbound',
          deal_type: input.deal_type,
          geography: summary.geography,
          segment: summary.segment,
          banker: input.banker,
        });
        if (missing.length > 0) throw new CompanyL0RequirementsError(missing);

        const insertData: TablesInsert<'companies'> = {
          pipeline_stage: 'L0',
          target: safeTarget,
          project_name: safeProjectName,
          thesis_content: null,
          segment: summary.segment ?? null,
          segment_related_offerings: summary.segment_related_offerings ?? null,
          company_focus: summary.company_focus ?? null,
          website: summary.website ?? null,
          watchlist_status: summary.watchlist_status ?? null,
          comments: summary.comments ?? null,
          ownership: summary.ownership ?? null,
          geography: summary.geography ?? null,
          remarks: summary.remarks ?? null,
          source: 'inbound',
          entered_by: input.entered_by ?? null,
          deal_type: input.deal_type ?? null,
          banker: input.banker ?? null,
          matched_track_ids: this.extractSuggestedTrackIds(parsedNotes),
        };
        const created = await this.companyService.createFromDTO(
          insertData as Parameters<typeof this.companyService.createFromDTO>[0],
          `created_from_file:${fileId}`,
        );
        companyId = created.id;
        companyRecord = await this.companyService.findById(companyId);
      }
    } else if (companyId) {
      companyRecord = await this.companyService.findById(companyId);
      const updates = input.company_field_updates ?? {};
      if (Object.keys(updates).length > 0) {
        await this.companyService.updateFromDTO(
          companyId,
          updates,
          `enriched_from_file:${fileId}`,
        );
        companyRecord = await this.companyService.findById(companyId);
      }
    }

    if (input.file_type === 'prospectus' && companyId && summary) {
      const allowedYears = new Set(input.financial_years_to_apply ?? []);
      const financialRows = (summary.financials ?? []).filter(
        (r) =>
          allowedYears.has(r.fiscal_year) &&
          (r.revenue_usd_mn !== null ||
            r.ebitda_usd_mn !== null ||
            r.ev_usd_mn !== null ||
            r.ebitda_margin !== null ||
            r.ev_ebitda !== null ||
            r.revenue_cagr_vs_prior !== null),
      );
      if (financialRows.length > 0) {
        await this.companyFinancialRepo.bulkUpsertForCompany(companyId, financialRows);
      }
      const fxRows = (summary.fx_adjustments ?? []).filter((r) =>
        allowedYears.has(r.fiscal_year),
      );
      if (fxRows.length > 0) {
        await this.companyFxAdjustmentRepo.bulkUpsertForCompany(companyId, fxRows);
      }
    }

    const fileUpdates: Parameters<FileRepository['updatePartial']>[1] = {
      file_type: input.file_type,
      processing_status: 'completed',
    };
    if (companyRecord) {
      const displayName =
        companyRecord.target ?? companyRecord.project_name ?? undefined;
      fileUpdates.matched_companies = [
        {
          id: companyRecord.id,
          target: companyRecord.target ?? undefined,
          name: displayName,
          type: 'company',
          similarity: 1,
        },
      ] as unknown as Tables<'files'>['matched_companies'];
    }

    await this.fileRepo.updatePartial(fileId, fileUpdates);

    if (companyId && companyRecord) {
      await this.companyAnalysisService
        .dispatch({ companyId, source: input.file_type })
        .catch((err) => console.error('Error dispatching company analysis:', err));

      void this.dispatchScreeningJobs(companyId, companyRecord);
    }

    const updated = await this.fileRepo.findById(fileId);
    return { file: updated, company_id: companyId };
  }

  private async dispatchScreeningJobs(companyId: string, company: Tables<'companies'>) {
    try {
      // AI screening runs ONLY against the tracks a company is matched to —
      // each matched track's own criteria (`criterias.investment_thesis_id`),
      // never the full criteria set. Mirrors the manual pipeline flow
      // (`buildTrackScreeningGroups`). A company with no matched tracks (or no
      // criteria on those tracks) screens nothing.
      const matchedTrackIds = new Set(company.matched_track_ids ?? []);
      if (matchedTrackIds.size === 0) return;

      const allCriteria = await this.criteriaRepo.findAll();
      const criteriaList = allCriteria.filter(
        (c) => c.investment_thesis_id !== null && matchedTrackIds.has(c.investment_thesis_id),
      );
      if (criteriaList.length === 0) return;

      const financials = await this.companyFinancialRepo.findByCompany(companyId);
      const byYear = new Map(financials.map((r) => [r.fiscal_year, r]));
      const companyData = {
        id: companyId,
        name: company.target || company.target,
        segment: company.segment,
        geography: company.geography,
        company_focus: company.company_focus,
        ownership: company.ownership,
        website: company.website,
        revenue_2022_usd_mn: byYear.get(2022)?.revenue_usd_mn ?? null,
        revenue_2023_usd_mn: byYear.get(2023)?.revenue_usd_mn ?? null,
        revenue_2024_usd_mn: byYear.get(2024)?.revenue_usd_mn ?? null,
        ebitda_2022_usd_mn: byYear.get(2022)?.ebitda_usd_mn ?? null,
        ebitda_2023_usd_mn: byYear.get(2023)?.ebitda_usd_mn ?? null,
        ebitda_2024_usd_mn: byYear.get(2024)?.ebitda_usd_mn ?? null,
        ev_2024: byYear.get(2024)?.ev_usd_mn ?? null,
      };

      for (const criterion of criteriaList) {
        const screeningEntry = await this.screeningRepo.insert({
          company_id: companyId,
          criteria_id: criterion.id,
          track_id: criterion.investment_thesis_id,
          state: 'pending',
        });

        await this.aiScreeningService.dispatch({
          companyId,
          criteriaId: criterion.id,
          criteriaPrompt: criterion.prompt,
          screeningId: screeningEntry.id,
          company: companyData,
        }).catch(async (err) => {
          console.error(`Error dispatching ai-screening for criterion ${criterion.id}:`, err);
          await this.screeningRepo.update(screeningEntry.id, {
            state: 'failed',
            result: 'error',
            remarks: 'Job dispatch failed',
          });
        });
      }
    } catch (err) {
      console.error('Error in ai-screening flow:', err);
    }
  }

  private buildEmailAttachmentCompanyMergeInput(
    summary: ProspectusSummary | undefined,
    effectiveFileType: string,
    companySource: 'inbound' | 'outbound',
    bankerSource?: string,
  ): CompanyDTOInput {
    const hasOwn = (obj: object, key: string) =>
      Object.prototype.hasOwnProperty.call(obj, key);
    const cleanText = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const input: CompanyDTOInput = {
      source: companySource,
      doc_type: effectiveFileType,
      banker_source: bankerSource ?? null,
    };

    if (summary) {
      const summaryFieldMap: Array<[keyof ProspectusSummary, keyof CompanyDTOInput]> = [
        ['company_name', 'target'],
        ['project_name', 'project_name'],
        ['segment', 'segment'],
        ['segment_related_offerings', 'segment_related_offerings'],
        ['company_focus', 'company_focus'],
        ['website', 'website'],
        ['watchlist_status', 'watchlist_status'],
        ['comments', 'comments'],
        ['ownership', 'ownership'],
        ['geography', 'geography'],
        ['remarks', 'remarks'],
      ];
      for (const [summaryKey, dtoKey] of summaryFieldMap) {
        if (hasOwn(summary, summaryKey)) {
          const cleaned = cleanText(summary[summaryKey]);
          if (cleaned !== undefined) {
            if ((summaryKey === 'company_name' || summaryKey === 'project_name') && isGenericDocumentPhrase(cleaned)) {
              continue;
            }
            input[dtoKey] = cleaned as never;
          }
        }
      }
    }

    // TODO(MB-225): Replace this fixed-year DTO bridge with normalized
    // financial row upserts. `CompanyDTOInput` is currently shaped around
    // legacy flat fields (revenue_2021_usd_mn ... revenue_2025_usd_mn), so
    // email-origin auto-merge can only map the years exposed by that DTO.
    // The cleaner path is accepting `financials` as rows here and letting
    // CompanyService apply them via companyFinancialRepo.bulkUpsertForCompany.
    for (const row of summary?.financials ?? []) {
      if (!row || ![2021, 2022, 2023, 2024, 2025].includes(row.fiscal_year)) {
        continue;
      }
      const year = row.fiscal_year;
      const suffix = `${year}` as '2021' | '2022' | '2023' | '2024' | '2025';
      if (hasOwn(row, 'revenue_usd_mn')) {
        input[`revenue_${suffix}_usd_mn` as keyof CompanyDTOInput] =
          row.revenue_usd_mn as never;
      }
      if (hasOwn(row, 'ebitda_usd_mn')) {
        input[`ebitda_${suffix}_usd_mn` as keyof CompanyDTOInput] =
          row.ebitda_usd_mn as never;
      }
      if (year === 2024) {
        if (hasOwn(row, 'ev_usd_mn')) {
          input.ev_2024 = row.ev_usd_mn;
        }
        if (hasOwn(row, 'ev_ebitda')) {
          input.ev_ebitda_2024 = row.ev_ebitda;
        }
      }
    }

    return input;
  }

  private async mergeEmailOriginAttachmentCompany(opts: {
    matchedCompanies: unknown[];
    summary: ProspectusSummary | undefined;
    parsedNotes?: Record<string, unknown>;
    effectiveFileType: string;
    companySource: 'inbound' | 'outbound';
    bankerSource?: string;
    enteredByEmail?: string;
    fileId: string;
  }): Promise<unknown[]> {
    // Resolve custodian email → user UUID once, outside the per-company lock.
    let resolvedEnteredBy: string | null = null;
    if (opts.enteredByEmail && this.userRepo) {
      const user = await this.userRepo.findByEmail(opts.enteredByEmail);
      resolvedEnteredBy = user?.id ?? null;
    }

    const identityName = this.emailAttachmentCompanyIdentityName(opts.summary);
    return this.withEmailAttachmentCompanyLock(identityName, async (companyService) => {
      const matchedCompany = (opts.matchedCompanies as Array<{ id?: string; type?: string }>)
        .find((m) => m?.id && (m.type === undefined || m.type === 'company'));
      let companyId = matchedCompany?.id ?? null;
      let companyRecord = companyId ? await companyService.findById(companyId) : null;

      if (!companyRecord && identityName) {
        companyRecord = await companyService.findByNameFuzzy(identityName);
        companyId = companyRecord?.id ?? null;
      }

      if (companyRecord && companyId) {
        await companyService.updateFromDTO(
          companyId,
          this.buildEmailAttachmentCompanyMergeInput(
            opts.summary,
            opts.effectiveFileType,
            companyRecord.source ?? opts.companySource,
            opts.bankerSource,
          ),
          `merged_from_email_attachment:${opts.fileId}`,
        );
        const refreshed = await companyService.findById(companyId);
        return [this.companyMatchPayload(refreshed)];
      }

      if (!identityName) {
        console.warn(
          `[fileService] Skipping email-origin company auto-create for file ${opts.fileId}: no company/project name extracted`,
        );
        return opts.matchedCompanies;
      }

      const created = await companyService.createFromDTO({
        pipeline_stage: 'unreviewed',
        status: 'active',
        entered_by: resolvedEnteredBy,
        matched_track_ids: this.extractSuggestedTrackIds(opts.parsedNotes),
        ...this.buildEmailAttachmentCompanyMergeInput(
          opts.summary,
          opts.effectiveFileType,
          opts.companySource,
          opts.bankerSource,
        ),
      }, `auto_created_from_email_attachment:${opts.fileId}`);

      // Write the new company back into matched_companies so approve() takes
      // the update branch rather than creating a duplicate.
      return [this.companyMatchPayload(created)];
    });
  }

  private extractSuggestedTrackIds(parsedNotes: Record<string, unknown> | null | undefined): string[] {
    const ids = (parsedNotes as { suggested_track_ids?: unknown })?.suggested_track_ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  }

  private emailAttachmentCompanyIdentityName(summary: ProspectusSummary | undefined): string | null {
    const companyName = summary?.company_name?.trim();
    if (companyName && !isGenericDocumentPhrase(companyName)) return companyName;
    const projectName = summary?.project_name?.trim();
    return projectName && !isGenericDocumentPhrase(projectName) ? projectName : null;
  }

  private companyMatchPayload(company: Pick<Tables<'companies'>, 'id' | 'target' | 'project_name'>) {
    const displayName = company.target ?? company.project_name ?? undefined;
    return {
      id: company.id,
      target: company.target ?? undefined,
      name: displayName,
      type: 'company',
      similarity: 1,
    };
  }

  private async withEmailAttachmentCompanyLock<T>(
    identityName: string | null,
    fn: (companyService: CompanyService) => Promise<T>,
  ): Promise<T> {
    const transaction = (this.db as unknown as {
      transaction?: <R>(cb: (tx: DbClient & { execute: (query: unknown) => Promise<unknown> }) => Promise<R>) => Promise<R>;
    } | null)?.transaction;
    if (!identityName || !transaction) {
      return fn(this.companyService);
    }

    const lockKey = `email-attachment-company:${identityName.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    return transaction.call(this.db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      return fn(this.buildCompanyService(tx));
    });
  }

  private buildCompanyService(db: DbClient): CompanyService {
    const companyGraphRepo = new CompanyRelationRepository(createNeo4jDriver());
    return new CompanyService(
      new CompanyRepository(db, companyGraphRepo),
      new CompanyLogRepository(db),
      new DealDocumentRepository(db),
      new DealNoteRepository(db),
      new DealLinkRepository(db),
      new CompanyFinancialRepository(db),
      new CompanyFxAdjustmentRepository(db),
      new CompanyScreeningDerivedRepository(db),
      this.trackMatchingService,
    );
  }

  private async mergeFinancialStatementCompanyFinancials(opts: {
    matchedCompanies: unknown[];
    financialStatementSummary: FinancialStatementSummary | undefined;
    fileId: string;
  }): Promise<void> {
    // Resolve company from matched_companies (fuzzy search already ran — use the id).
    const matchedCompany = (opts.matchedCompanies as Array<{ id?: string | null; type?: string }>)
      .find((m) => m?.id && (m.type === undefined || m.type === 'company'));
    let companyId = matchedCompany?.id ?? null;

    // Fallback: fuzzy match by company_name from the financial_statement_summary.
    if (!companyId && opts.financialStatementSummary?.company_name) {
      const found = await this.companyService.findByNameFuzzy(opts.financialStatementSummary.company_name);
      companyId = found?.id ?? null;
    }

    if (!companyId) {
      console.warn(`[fileService] financial_statement ${opts.fileId}: no matching company found, skipping financials upsert`);
      return;
    }

    const rows = (opts.financialStatementSummary?.financials ?? []).filter(
      (r) => r && Number.isInteger(r.fiscal_year) && (
        r.revenue_usd_mn !== null || r.ebitda_usd_mn !== null || r.ev_usd_mn !== null ||
        r.ebitda_margin !== null || r.ev_ebitda !== null || r.revenue_cagr_vs_prior !== null
      ),
    );

    if (rows.length === 0) {
      console.warn(`[fileService] financial_statement ${opts.fileId}: no financial rows extracted for company ${companyId}`);
      return;
    }

    await this.companyFinancialRepo.bulkUpsertForCompany(companyId, rows);
    console.log(`[fileService] financial_statement ${opts.fileId}: upserted ${rows.length} financial row(s) for company ${companyId}`);
  }

  private parseStructuredNotes(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private pickProposedCompanyId(matched: Tables<'files'>['matched_companies']): string | null {
    if (!Array.isArray(matched)) return null;
    for (const m of matched) {
      if (m && typeof (m as { id?: unknown }).id === 'string') {
        return (m as { id: string }).id;
      }
    }
    return null;
  }

  update(id: string, updates: Parameters<FileRepository['updatePartial']>[1]) {
    return this.fileRepo.update(id, updates);
  }

  async getSignedDownloadUrl(id: string) {
    const record = await this.fileRepo.findLinkAndNameById(id);
    const url = await getSignedUrl(record.file_link);
    return { url, fileName: record.file_name };
  }

  async getDownloadUrl(id: string) {
    const record = await this.fileRepo.findLinkAndNameById(id);
    const downloadUrl = await getSignedUrl(record.file_link, 3600, record.file_name);
    return { downloadUrl, fileName: record.file_name };
  }

  async delete(id: string) {
    const record = await this.fileRepo.findLinkAndNameById(id);
    try {
      await deleteFile(record.file_link);
    } catch (s3Error) {
      console.error('S3 delete error:', s3Error);
    }
    await this.fileRepo.delete(id);
  }
}
