import { downloadFile, getSignedUrl, deleteFile } from '@/lib/s3';
import { and, eq, sql } from 'drizzle-orm';
import { flFunds, flInvestors, flAssets, flFundingSources } from '@/lib/db/schema';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { processFileContent, type FileTypeOverride } from '@/lib/agents/file_processing';
import { processFundUpdateContent } from '@/lib/agents/fund_update_processing';
import {
  tryDeterministicFundUpdateParse,
  hydrateParsedAssetsFromEvents,
  assetCodesForCatalogName,
  normalizeCanonicalName,
  FUND_CATALOG,
  isPersistableV1AssetEventType,
} from '@/lib/fund_updates';
import type {
  FundUpdateStructuredResult,
  ParsedAsset,
  ParsedCommitmentEvent,
} from '@/lib/fund_updates';
import type { FundUpdateAssetSelection } from '@/lib/services/fundUpdateApplyService';
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
  FileRepository,
  JobRepository,
  type DbClient,
  type FileListOptions,
  type CriteriaRepository,
  type ScreeningRepository,
  type Tables,
  type TablesInsert,
  type UserWorkspaceRepository,
  type WorkspaceRepository,
} from '@/lib/repositories';
import { enqueueSendEmail } from '@/lib/queue';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { AIScreeningService } from './aiScreeningService';
import type { CRMService } from './crmService';
import { CompanyL0RequirementsError, CompanyService, IN_PIPELINE_STAGES } from './companyService';
import type { TrackMatchingService } from './trackMatchingService';
import type {
  FundUpdateApplyService,
  FundUpdateApplyOptions,
  FundUpdateApplyResult,
  FundUpdateCommitmentApplyResult,
  FundUpdateAssetReview,
  FundUpdateCatalogMatch,
  FundUpdateCatalogMatchStatus,
  FundUpdateReviewResolution,
  SubmittedRowDisposition,
  SubmittedRowOutcome,
} from './fundUpdateApplyService';
import type { JobDispatcher } from './jobDispatcher';
import {
  runFundUpdateExtraction,
  FUND_UPDATE_EXTRACTION_TIMEOUT_SECONDS,
} from '@/lib/jobs/handlers/fundUpdateExtraction';
import { normalizeWorkbookExtraction } from '@/lib/agents/fund_update_processing/normalizeWorkbookExtraction';
import { validateWorkbookExtraction } from '@/lib/agents/fund_update_processing/validateWorkbookExtraction';
import {
  formatSourceRowKey,
  type LegacyAssetProposal,
  type ProposedEvent,
  type ReviewProposalItem,
  type WorkbookFallbackProposalV1,
  type FundUpdateTwoStepApproval,
  type FundUpdateTwoStepReview,
  type StagedReviewEntityInput,
} from '@/lib/fund_updates/types';
import {
  validateTransferCounterparty,
  buildNormalizedTwoStepReview,
  validateTwoStepDependencies,
  classifyFundUpdateTxn,
  reclassifyReviewTransaction,
  type TxnTypeEnum,
} from '@/lib/fund_updates';
import { FundUpdateValidationError } from './flErrors';
import { isSellProceedsDestination } from '@/lib/sellProceedsDestination';

/**
 * Helper to safely extract a non-empty string jobId from an unknown response payload.
 */
export function asyncJobId(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'jobId' in data) {
    const id = (data as { jobId?: unknown }).jobId;
    if (typeof id === 'string' && id.trim().length > 0) {
      return id.trim();
    }
  }
  return undefined;
}

/**
 * File types that describe deal targets (companies/projects genuinely offered
 * for sale or listed as acquisition targets) and may therefore mint company
 * rows. These files can contain MULTIPLE targets — the agent emits a
 * `companies` array and every entry is auto-ingested on upload: new targets
 * are created, targets matching a pre-pipeline company are auto-enriched, and
 * only targets matching a company actively in the L0–L5 pipeline queue the
 * file for HITL review. Financial statements, legal
 * agreements, MoMs, and buyer/sponsor/advisor material describe counterparties
 * or process, NOT companies on sale, and must never auto-create a company.
 * (MB-300)
 */
const MULTI_COMPANY_FILE_TYPES = new Set<string>(['prospectus', 'shopping_list']);

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

function isExcelUpload(fileName: string, contentType: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    contentType === 'application/vnd.ms-excel.sheet.macroenabled.12'
  );
}

/**
 * Headers of the email an MBOX-ingested attachment arrived on. Supplied by the
 * data pipeline and used only to describe the document in the custodian's
 * ingest notification — deliberately not persisted on the `files` row.
 */
export interface EmailIngestContext {
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  receivedAt?: string;
}

/** Processing states that mean the file is genuinely in Brain. */
const NOTIFIABLE_STATUSES = new Set(['completed', 'awaiting_review']);

function isPdfUpload(fileName: string, contentType: string): boolean {
  return contentType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
}

/** Base URL for deep links in outbound email. */
function resolveAppUrl(): string {
  return (
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

/** `financial_statement` -> `Financial statement`, for human-facing email copy. */
function humanizeFileType(fileType: string | null | undefined): string | undefined {
  const raw = fileType?.trim();
  if (!raw) return undefined;
  const words = raw.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `Jane Doe <jane@bank.com>`, or whichever half of that we actually have. */
function formatEmailSender(context?: EmailIngestContext): string | undefined {
  const name = context?.senderName?.trim();
  const email = context?.senderEmail?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || undefined;
}

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * RFC-2822 / ISO date to `28 Sep 2026, 14:32 UTC`; undefined if unparseable.
 * Built from UTC parts rather than `toLocaleString` so the rendered string
 * doesn't drift with the host's ICU data (`Sep` vs `Sept`).
 */
function formatReceivedAt(receivedAt?: string): string | undefined {
  if (!receivedAt) return undefined;
  const parsed = new Date(receivedAt);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${parsed.getUTCDate()} ${MONTH_ABBREVIATIONS[parsed.getUTCMonth()]} ` +
    `${parsed.getUTCFullYear()}, ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`
  );
}

/** Byte count as a short human-readable size, e.g. `1.4 MB`. */
function formatFileSize(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

type IngestStructuredResult =
  | NonNullable<Awaited<ReturnType<typeof processFileContent>>>
  | FundUpdateStructuredResult;

/**
 * Resolve extraction for an upload/reprocess:
 * 1. Known Excel master sheets → deterministic fund-update parse (no LLM, synchronous)
 * 2. Explicit fund_updates override or auto-classified fund_updates without deterministic match
 *    → marked as async job to be dispatched to background fund_update_extraction job.
 * 3. Otherwise → general file-processing agent (classifies + extracts in one pass synchronously).
 */
async function resolveFileIngestion(opts: {
  rawText: string;
  buffer: Buffer;
  contentType: string;
  fileName: string;
  rawNotes: string;
  fileTypeOverride?: FileTypeOverride;
}): Promise<{
  structuredResult: IngestStructuredResult | null;
  effectiveFileType: string;
  fundUpdateNeedsReview: boolean;
  isAsyncJob: boolean;
}> {
  const { rawText, buffer, contentType, fileName, rawNotes, fileTypeOverride } = opts;

  const isExcel = isExcelUpload(fileName, contentType);

  // Fast path: STARTECH (and future) master sheets bypass the general agent and run synchronously.
  if (isExcel && (!fileTypeOverride || fileTypeOverride === 'fund_updates')) {
    const deterministic = await tryDeterministicFundUpdateParse(buffer, contentType, fileName);
    if (deterministic) {
      return {
        structuredResult: deterministic,
        effectiveFileType: 'fund_updates',
        fundUpdateNeedsReview: true,
        isAsyncJob: false,
      };
    }
  }

  // Explicit fund_updates override:
  if (fileTypeOverride === 'fund_updates') {
    if (isExcel) {
      return {
        structuredResult: null,
        effectiveFileType: 'fund_updates',
        fundUpdateNeedsReview: true,
        isAsyncJob: true,
      };
    }
    // PDF / text file with explicit fund_updates override -> synchronous extraction
    const fundResult = await processFundUpdateContent(rawText, buffer, contentType, fileName);
    return {
      structuredResult: fundResult,
      effectiveFileType: 'fund_updates',
      fundUpdateNeedsReview: true,
      isAsyncJob: false,
    };
  }

  // General file processing
  const structuredResult = await processFileContent(
    rawText,
    buffer,
    contentType,
    rawNotes,
    fileTypeOverride,
    fileName,
  );
  const effectiveFileType =
    fileTypeOverride ?? structuredResult?.file_type ?? 'other';

  // Auto-classified fund updates:
  if (effectiveFileType === 'fund_updates') {
    if (isExcel) {
      return {
        structuredResult: null,
        effectiveFileType: 'fund_updates',
        fundUpdateNeedsReview: true,
        isAsyncJob: true,
      };
    }
    // Auto-classified PDF / text file -> synchronous extraction
    const fundResult = (structuredResult && 'fund_update_proposal' in structuredResult)
      ? (structuredResult as FundUpdateStructuredResult)
      : await processFundUpdateContent(rawText, buffer, contentType, fileName);

    return {
      structuredResult: fundResult,
      effectiveFileType: 'fund_updates',
      fundUpdateNeedsReview: true,
      isAsyncJob: false,
    };
  }

  return {
    structuredResult,
    effectiveFileType,
    fundUpdateNeedsReview: false,
    isAsyncJob: false,
  };
}

/** File types that are valid `FileTypeOverride`s the agent accepts as a hint. */
const FILE_TYPE_OVERRIDE_VALUES = new Set<FileTypeOverride>([
  'mom',
  'prospectus',
  'other',
  'shopping_list',
  'market_study',
  'fund_updates',
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
  source?: 'inbound' | 'outbound' | null;
  geography?: string | null;
  segment?: string | null;
  /** Editable overrides for the new company's identity fields. */
  target?: string | null;
  project_name?: string | null;
  /**
   * Fund Updates HITL: sheet codes (e.g. "GOTO") to apply. Only used when
   * `file_type` is `fund_updates`. Empty/omitted applies nothing (review-only).
   */
  fund_update_asset_codes?: string[];
  /**
   * Optional per-asset txn/valuation subset and edited rows from review UI.
   * When set, takes precedence over applying all missing/proposed rows.
   */
  fund_update_selections?: FundUpdateAssetSelection[];
  /**
   * Names of catalog records the reviewer ticked. A name absent from a list is
   * NOT created and is written as null on the transactions it would have linked.
   * Undefined (or an undefined sub-list) means "everything selected" — the
   * backward-compatible default.
   */
  fund_update_catalog_selections?: {
    funds?: string[];
    investors?: string[];
    sources?: string[];
  };
  /** Explicit reviewer-configured resolutions for review-required items. */
  fund_update_review_resolutions?: FundUpdateReviewResolution[];
  /** MB-513: Canonical two-step approval DTO containing staged decisions and edits. */
  two_step_approval?: FundUpdateTwoStepApproval;
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

const V1_INVESTOR_ENTITY_TYPES = new Set<string>([
  'investor',
  'institutional_investor',
  'individual_investor',
  'investment_vehicle',
]);

export class FileService {
  private crmService?: CRMService;
  private fundUpdateApplyService?: FundUpdateApplyService;
  private workspaceRepo?: WorkspaceRepository;

  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly fileRepo: FileRepository,
    private readonly companyAnalysisService: CompanyAnalysisService,
    private readonly aiScreeningService: AIScreeningService,
    private readonly criteriaRepo: CriteriaRepository,
    private readonly screeningRepo: ScreeningRepository,
    private readonly companyFinancialRepo: CompanyFinancialRepository,
    private readonly companyService: CompanyService,
    private readonly companyFxAdjustmentRepo: CompanyFxAdjustmentRepository,
    private readonly userWorkspaceRepo: UserWorkspaceRepository,
    // Passed to transaction-scoped CompanyService instances so Smart Files
    // inbound companies entering L0 also trigger agent-driven track matching.
    private readonly trackMatchingService?: TrackMatchingService,
    private readonly userRepo?: import('@/lib/repositories').UserRepository,
    // Injectable for tests; defaults to the real Vercel Queues producer.
    private readonly enqueueEmail: typeof enqueueSendEmail = enqueueSendEmail,
    private jobDispatcher?: JobDispatcher,
  ) {}

  /**
   * Resolves workspace display names for the email-ingest notification.
   * Late-wired (like the CRM and job-dispatcher deps) so the long positional
   * constructor doesn't grow another optional tail argument.
   */
  setWorkspaceRepo(workspaceRepo: WorkspaceRepository) {
    this.workspaceRepo = workspaceRepo;
  }

  setCRMService(crmService: CRMService) {
    this.crmService = crmService;
  }

  setFundUpdateApplyService(service: FundUpdateApplyService) {
    this.fundUpdateApplyService = service;
  }

  setJobDispatcher(dispatcher: JobDispatcher) {
    this.jobDispatcher = dispatcher;
  }

  async findAll(fileType?: string) {
    const files = await this.fileRepo.findAll(fileType);
    return this.attachSignedUrls(files);
  }

  /**
   * Paginated listing for the Smart Files view. Delegates the search / sort /
   * pagination to the repository and only signs URLs for the returned page, so
   * a large workspace no longer signs and ships every file on each load.
   *
   * `skipSignedUrls` opts out of signing entirely — for callers (e.g. a file
   * search/picker) that only need `file_name`/`file_link`, signing every
   * result on each keystroke would be pure waste (a real S3 API round-trip
   * per row for a value that's never read).
   */
  async list(opts: FileListOptions & { skipSignedUrls?: boolean }) {
    const { rows, total } = await this.fileRepo.listPaginated(opts);
    const data = opts.skipSignedUrls ? rows : await this.attachSignedUrls(rows);
    return { data, total };
  }

  async countsByType(): Promise<Record<string, number>> {
    return this.fileRepo.countsByType();
  }

  private attachSignedUrls(files: Tables<'files'>[]) {
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

  /**
   * Resolve which workspace(s) a promoted file belongs to. The pipeline
   * knows only the custodian mailbox (`enteredByEmail`); it may be watched
   * by several workspaces at once, so this can fan out to more than one id.
   * Manual (session-authenticated) uploads have no mailbox at all — they
   * land in this request's own workspace, same as every other write path.
   */
  private async resolveTargetWorkspaceIds(enteredByEmail?: string): Promise<string[]> {
    if (!enteredByEmail) return [this.workspaceId];
    const workspaceIds = await this.userWorkspaceRepo.findWorkspaceIdsBySyncedEmail(enteredByEmail);
    if (workspaceIds.length === 0) {
      console.warn(
        `[fileService] custodian ${enteredByEmail} has no synced user_workspaces mapping; defaulting to ${this.workspaceId}`,
      );
      return [this.workspaceId];
    }
    return workspaceIds;
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
    /** For manual Smart Files uploads: the authenticated session user's UUID. */
    uploaderUserId?: string | null,
    /** For the MBOX email pipeline: headers of the source email, used only to
     *  describe the file in the custodian's ingest notification. */
    emailContext?: EmailIngestContext,
  ) {
    // Dedup gate: a file with this name was already uploaded — return the
    // existing record instead of inserting and processing a duplicate. The
    // freshly uploaded S3 object is removed (best-effort) so the duplicate
    // doesn't leak storage.
    const duplicate = await this.fileRepo.findFirstByName(fileName);
    if (duplicate) {
      console.log(
        `[fileService] "${fileName}" duplicates existing file ${duplicate.id}, skipping insert`,
      );
      if (key !== duplicate.file_link) {
        await deleteFile(key).catch((err) =>
          console.error('[fileService] Failed to delete duplicate S3 object:', err),
        );
      }
      const signedUrl = await getSignedUrl(duplicate.file_link).catch(() => null);
      return { ...duplicate, signed_url: signedUrl, duplicate: true };
    }

    const buffer = await downloadFile(key);
    const fileType = contentType || 'application/octet-stream';

    // Fan-out: one mailbox may be watched by several workspaces. The first
    // resolved workspace is treated as primary — it drives company
    // matching/creation and screening dispatch below, exactly as before this
    // ticket. Extra workspaces (beyond the first) only get their own `files`
    // row; auto-merge/create and screening dispatch for those is deferred
    // until there's a second real workspace to build and test that against.
    const [primaryWorkspaceId, ...secondaryWorkspaceIds] =
      await this.resolveTargetWorkspaceIds(enteredByEmail);
    if (secondaryWorkspaceIds.length > 0) {
      console.warn(
        `[fileService] fanning out file "${fileName}" to ${secondaryWorkspaceIds.length} additional workspace(s); company matching/screening dispatch only runs for the primary workspace ${primaryWorkspaceId}`,
      );
    }
    const primaryFileRepo =
      primaryWorkspaceId === this.workspaceId
        ? this.fileRepo
        : new FileRepository(this.db, primaryWorkspaceId);

    const initialData = await primaryFileRepo.insert({
      file_name: fileName,
      file_link: key,
      processing_status: 'processing',
      file_type: fileTypeOverride ?? 'other',
      origin_email: originEmail ?? false,
      workspace_id: primaryWorkspaceId,
    });

    // `file_uploaded`, captured server-side rather than in the Smart Files
    // view. Emitted here, right after the row lands, because that is the point
    // the upload is definitively accepted — the duplicate gate has already
    // returned above, and everything below is processing, which succeeds or
    // fails on its own and is reported by its own events. Stamped against the
    // primary workspace, which is the one that owns the file.
    captureWorkspaceEvent({
      workspaceId: primaryWorkspaceId,
      // Pipeline (MBOX) ingestion has no session user — those uploads are
      // attributed to 'server' and separable via `source`.
      distinctId: uploaderUserId ?? 'server',
      event: 'file_uploaded',
      properties: {
        file_id: initialData.id,
        file_name: fileName,
        file_type: fileTypeOverride ?? 'other',
        content_type: contentType,
        source: uploaderUserId ? 'user' : 'pipeline',
        origin_email: originEmail ?? false,
        fanned_out_workspaces: secondaryWorkspaceIds.length,
      },
    });

    const secondaryFileRepos = secondaryWorkspaceIds.map(
      (workspaceId) => new FileRepository(this.db, workspaceId),
    );
    const secondaryInitialRows = await Promise.all(
      secondaryFileRepos.map((repo, i) =>
        repo.insert({
          file_name: fileName,
          file_link: key,
          processing_status: 'processing',
          file_type: fileTypeOverride ?? 'other',
          origin_email: originEmail ?? false,
          workspace_id: secondaryWorkspaceIds[i],
        }),
      ),
    );

    let rawText = '';
    let structuredResult: IngestStructuredResult | null = null;
    let tags: string[] = [];
    let matched_companies: unknown[] = [];

    try {
      const isPdf = isPdfUpload(fileName, fileType);
      const isExplicitExcelFundUpdate = fileTypeOverride === 'fund_updates' && isExcelUpload(fileName, fileType);
      if (!isPdf && !isExplicitExcelFundUpdate) {
        rawText = await extractTextFromFile(buffer, fileType, fileName);
      }

      const resolved = await resolveFileIngestion({
        rawText,
        buffer,
        contentType: fileType,
        fileName,
        rawNotes: rawNotes ?? '',
        fileTypeOverride,
      });
      structuredResult = resolved.structuredResult;
      const effectiveFileType = resolved.effectiveFileType;

      if (resolved.isAsyncJob) {
        await primaryFileRepo.updatePartial(initialData.id, {
          file_type: 'fund_updates',
          processing_status: 'processing',
        });

        if (secondaryFileRepos.length > 0) {
          await Promise.all(
            secondaryFileRepos.map((repo, i) =>
              repo.updatePartial(secondaryInitialRows[i].id, {
                file_type: 'fund_updates',
                processing_status: 'failed',
                raw_notes: 'Async fund update extraction does not support secondary workspace fan-out',
              }),
            ),
          );
        }

        let jobId: string | null = null;
        if (this.db) {
          try {
            const jobRepo = new JobRepository(this.db);
            const existingActive = (
              await jobRepo.findByTypeAndPayload('fund_update_extraction', { fileId: initialData.id })
            ).find((j) => j.status === 'pending' || j.status === 'running');
            if (existingActive) {
              jobId = existingActive.id;
            }
          } catch (err) {
            console.error('[fileService] Failed to query existing active jobs:', err);
          }
        }

        if (!jobId && this.jobDispatcher) {
          try {
            const result = await this.jobDispatcher.dispatch({
              type: 'fund_update_extraction',
              payload: { fileId: initialData.id, workspaceId: primaryWorkspaceId, contentType: fileType },
              timeoutSeconds: FUND_UPDATE_EXTRACTION_TIMEOUT_SECONDS,
              work: (ctx) =>
                runFundUpdateExtraction(
                  { fileId: initialData.id, workspaceId: primaryWorkspaceId, contentType: fileType },
                  { db: ctx.db, job: ctx.job },
                ),
            });
            jobId = result.jobId;
          } catch (dispatchErr) {
            console.error('[fileService] Failed to dispatch fund update extraction job:', dispatchErr);
          }
        }

        if (!jobId) {
          const failureReason =
            'Failed to dispatch async fund update extraction job: job dispatcher unavailable or dispatch failed';
          await primaryFileRepo.updatePartial(initialData.id, {
            processing_status: 'failed',
            raw_notes: failureReason,
          });
          throw new Error(failureReason);
        }

        const signedUrl = await getSignedUrl(key).catch(() => null);
        const updated = await primaryFileRepo.findById(initialData.id);
        return {
          ...updated,
          jobId,
          signed_url: signedUrl,
          ...(secondaryFileRepos.length > 0 ? { asyncSecondaryWorkspacesSkipped: true } : {}),
        };
      }

      if (structuredResult) {
        tags = structuredResult.tags || [];
        matched_companies = structuredResult.matched_companies || [];
      }

      const finalFileType = fileTypeOverride ?? structuredResult?.file_type ?? effectiveFileType;

      // Multi-company auto-ingest: deal-target files (prospectus,
      // shopping_list) process one company per extracted target for BOTH
      // manual and email uploads. New targets are auto-created; targets
      // matching an existing PRE-pipeline company (unreviewed /
      // market_screening / discovered) are auto-enriched with the extracted
      // data; targets matching a company actively in the L0–L5 pipeline are
      // never auto-modified — the file is queued for HITL review instead.
      // Financial statements, legal docs, and buyer/sponsor/advisor material
      // must NOT auto-create a company — they describe counterparties, not
      // targets. (MB-300)
      // Company matching/creation only runs for the primary (container-bound)
      // workspace — secondary fan-out workspaces are deferred (see the
      // warning logged above).
      let createdCompanies: Tables<'companies'>[] = [];
      let enrichedCompanies: Tables<'companies'>[] = [];
      let needsHitlReview = resolved.fundUpdateNeedsReview;
      if (needsHitlReview && effectiveFileType === 'fund_updates') {
        needsHitlReview = await this.fundUpdateProposalNeedsReview(structuredResult);
      }

      // Ephemeral pipeline: email-origin files classified as `other` are
      // dropped after classify — delete S3 bytes, keep the files row as audit.
      // Manual uploads (origin_email=false) are never auto-wiped.
      // Never persist classifier summary prose in drop_reason (privacy).
      if (originEmail && !needsHitlReview && finalFileType === 'other') {
        const dropReason = 'afd_classified_other';
        // Mark dropped in DB first so a failed S3 delete still leaves an audit
        // row; never delete bytes while the row still looks processable.
        await primaryFileRepo.updatePartial(initialData.id, {
          raw_notes: null,
          structured_notes: null,
          file_type: finalFileType,
          processing_status: 'dropped',
          drop_reason: dropReason,
          tags: [],
          matched_companies: [],
        });
        await Promise.all(
          secondaryFileRepos.map((repo, i) =>
            repo.updatePartial(secondaryInitialRows[i].id, {
              raw_notes: null,
              structured_notes: null,
              file_type: finalFileType,
              processing_status: 'dropped',
              drop_reason: dropReason,
              tags: [],
            }),
          ),
        );
        await deleteFile(key).catch((err) =>
          console.error('[fileService] Failed to delete dropped origin_email S3 object:', err),
        );
        const dropped = await primaryFileRepo.findById(initialData.id);
        return { ...dropped, signed_url: null, dropped: true };
      }

      const isPrimaryWorkspace = primaryWorkspaceId === this.workspaceId;
      if (isPrimaryWorkspace && structuredResult && MULTI_COMPANY_FILE_TYPES.has(effectiveFileType)) {
        try {
          const result = await this.createCompaniesFromExtraction({
            companies: this.parseExtractedCompanies(structuredResult as Record<string, unknown>),
            matchedCompanies: matched_companies,
            parsedNotes: structuredResult as Record<string, unknown>,
            effectiveFileType,
            companySource: 'inbound',
            bankerSource,
            enteredByEmail,
            uploaderUserId,
            originEmail,
            fileId: initialData.id,
          });
          matched_companies = result.matchedCompanies;
          createdCompanies = result.createdCompanies;
          enrichedCompanies = result.enrichedCompanies;
          needsHitlReview = needsHitlReview || result.needsReview;
        } catch (err) {
          console.error('[fileService] Failed to auto-create companies from file:', err);
        }
      }

      // MB-300: financial statements update company_financials for matched existing
      // deal targets but never create new company rows.
      if (isPrimaryWorkspace && originEmail && structuredResult && finalFileType === 'financial_statement') {
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

      await primaryFileRepo.updatePartial(initialData.id, {
        raw_notes: rawText,
        file_type: effectiveFileType,
        structured_notes: structuredResult ? JSON.stringify(structuredResult, null, 2) : null,
        tags,
        matched_companies: matched_companies as Tables<'files'>['matched_companies'],
        file_date: structuredResult?.file_date || null,
        // HITL when fund-update proposals need review, or when an extracted
        // target matches a company actively in the L0–L5 pipeline.
        processing_status: needsHitlReview ? 'awaiting_review' : 'completed',
      });
      // Secondary fan-out rows share the same extracted content — no
      // company-matching side effects run for them (see warning above).
      await Promise.all(
        secondaryFileRepos.map((repo, i) =>
          repo.updatePartial(secondaryInitialRows[i].id, {
            raw_notes: rawText,
            file_type: effectiveFileType,
            structured_notes: structuredResult ? JSON.stringify(structuredResult, null, 2) : null,
            tags,
            file_date: structuredResult?.file_date || null,
            processing_status: needsHitlReview ? 'awaiting_review' : 'completed',
          }),
        ),
      );

      // Kick off analysis + screening for every company minted or auto-
      // enriched from this file (mirrors the post-approve dispatch;
      // untouched existing companies are not re-analyzed).
      for (const company of [...createdCompanies, ...enrichedCompanies]) {
        await Promise.resolve(
          this.companyAnalysisService.dispatch({ companyId: company.id, source: effectiveFileType }),
        ).catch((err) => console.error('Error dispatching company analysis:', err));
        void this.dispatchScreeningJobs(company.id, company);
      }
    } catch (processError) {
      console.error('Error during file processing:', processError);
      await primaryFileRepo.updatePartial(initialData.id, {
        processing_status: 'failed',
        raw_notes: (processError as Error)?.message || rawText || 'Extraction failed',
      });
      await Promise.all(
        secondaryFileRepos.map((repo, i) =>
          repo.updatePartial(secondaryInitialRows[i].id, {
            processing_status: 'failed',
            raw_notes: (processError as Error)?.message || rawText || 'Extraction failed',
          }),
        ),
      );
      if ((processError as Error)?.message?.includes('Failed to dispatch')) {
        throw processError;
      }
    }

    const updatedData = await primaryFileRepo.findById(initialData.id);
    const signedUrl = await getSignedUrl(key);

    if (structuredResult?.file_type === 'banker_communications' && structuredResult?.communications && this.crmService) {
      const communications = structuredResult.communications as Array<{
        from_email: string;
        from_name?: string;
        to_email?: string;
        to_name?: string;
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
            sent_at: comm.sent_at,
            direction: 'inbound' as const,
            company: comm.company,
          })),
        )
        .catch((err) => {
          console.error('Error adding communications to CRM:', err);
        });
    }

    // Email-pipeline PDFs only: tell the mailbox custodian their attachment
    // landed in Brain. Manual UI uploads never notify (the uploader added the
    // file themselves), and non-PDF attachments are out of scope. Dropped and
    // duplicate files returned earlier, so they never reach here.
    if (originEmail && enteredByEmail && isPdfUpload(fileName, fileType)) {
      await this.notifyPdfIngested({
        custodianEmail: enteredByEmail,
        file: updatedData,
        fileSizeBytes: buffer.length,
        primaryWorkspaceId,
        secondaryWorkspaceIds,
        bankerSource,
        emailContext,
      });
    }

    return { ...updatedData, signed_url: signedUrl };
  }

  /**
   * Enqueue the `email_pdf_ingested` notification for a PDF crawled out of the
   * custodian's mailbox. Best-effort: any failure is logged and never fails the
   * upload, matching {@link notifyCompaniesAssigned}.
   *
   * Recipient is the crawled mailbox address itself, so a custodian without a
   * `users` row still hears about their own attachment; the greeting name is
   * filled in only when the address resolves to a user.
   */
  private async notifyPdfIngested(opts: {
    custodianEmail: string;
    file: Tables<'files'>;
    fileSizeBytes: number;
    primaryWorkspaceId: string;
    secondaryWorkspaceIds: string[];
    bankerSource?: string;
    emailContext?: EmailIngestContext;
  }): Promise<void> {
    try {
      // Only a file that actually landed is "added to Brain". The dropped and
      // duplicate paths already return before this, so this is defence in
      // depth against a future branch reaching here with a non-final status.
      if (!NOTIFIABLE_STATUSES.has(opts.file.processing_status ?? '')) return;

      const workspaceIds = [opts.primaryWorkspaceId, ...opts.secondaryWorkspaceIds];
      const workspaces = (await this.workspaceRepo?.findActiveByIds(workspaceIds)) ?? [];
      const byId = new Map(workspaces.map((w) => [w.id, w]));
      const primary = byId.get(opts.primaryWorkspaceId);
      // Without a resolvable workspace name the email has nothing meaningful to
      // say about where the file landed — skip rather than send "undefined".
      if (!primary) {
        console.warn(
          `[fileService] skipping email_pdf_ingested for file ${opts.file.id}: workspace ${opts.primaryWorkspaceId} not resolvable`,
        );
        return;
      }

      const custodian = await this.userRepo?.findByEmail(opts.custodianEmail);
      const appUrl = resolveAppUrl();
      const matchedCompanies = (opts.file.matched_companies ?? [])
        .map((c) => c?.target || c?.name)
        .filter((n): n is string => Boolean(n));

      await this.enqueueEmail({
        kind: 'email_pdf_ingested',
        to: opts.custodianEmail,
        recipientName: custodian?.name || undefined,
        fileName: opts.file.file_name,
        workspaceName: primary.name,
        additionalWorkspaces: opts.secondaryWorkspaceIds
          .map((id) => byId.get(id)?.name)
          .filter((n): n is string => Boolean(n)),
        fileTypeLabel: humanizeFileType(opts.file.file_type),
        fileSizeLabel: formatFileSize(opts.fileSizeBytes),
        bankerSource: opts.bankerSource,
        emailSender: formatEmailSender(opts.emailContext),
        emailSubject: opts.emailContext?.subject,
        emailReceivedLabel: formatReceivedAt(opts.emailContext?.receivedAt),
        fileDateLabel: opts.file.file_date ?? undefined,
        matchedCompanies,
        tags: opts.file.tags ?? [],
        awaitingReview: opts.file.processing_status === 'awaiting_review',
        fileUrl: `${appUrl}/w/${primary.slug}/smart-files`,
      });
    } catch (err) {
      console.error(
        `[fileService] Failed to enqueue email_pdf_ingested email for file ${opts.file.id}:`,
        err,
      );
    }
  }

  /**
   * Re-run the file-processing agent on an already-uploaded file and refresh
   * its extracted fields in place: `raw_notes`, `structured_notes`, `tags`,
   * `matched_companies`, and `file_date`.
   *
   * This is a pure refresh. Unlike {@link processUpload} it never auto-creates
   * or merges companies, never upserts financials, and never re-ingests banker
   * communications into the CRM — those side effects belong to the upload flow
   * and re-running them would risk duplicating or clobbering already-persisted
   * records. The file keeps its existing `file_type` (so it stays in the same
   * tab) and completes when done.
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
    let structuredResult: IngestStructuredResult | null = null;
    let tags: string[] = [];
    let matched_companies: unknown[] = [];

    try {
      // Prefer the stored type for routing so fund_updates stay on the specialist
      // path. Override is only set when the stored type is a user-facing hint.
      const routingOverride: FileTypeOverride | undefined =
        existingFileType === 'fund_updates' ? 'fund_updates' : override;

      const isPdf = isPdfUpload(fileName, contentType);
      const isExplicitExcelFundUpdate = routingOverride === 'fund_updates' && isExcelUpload(fileName, contentType);
      if (!isPdf && !isExplicitExcelFundUpdate) {
        rawText = await extractTextFromFile(buffer, contentType, fileName);
      }

      const resolved = await resolveFileIngestion({
        rawText,
        buffer,
        contentType,
        fileName,
        rawNotes: '',
        fileTypeOverride: routingOverride,
      });
      structuredResult = resolved.structuredResult;

      if (resolved.isAsyncJob) {
        await this.fileRepo.updatePartial(fileId, {
          file_type: 'fund_updates',
          processing_status: 'processing',
        });

        let jobId: string | null = null;
        if (this.db) {
          try {
            const jobRepo = new JobRepository(this.db);
            const existingActive = (
              await jobRepo.findByTypeAndPayload('fund_update_extraction', { fileId })
            ).find((j) => j.status === 'pending' || j.status === 'running');
            if (existingActive) {
              jobId = existingActive.id;
            }
          } catch (err) {
            console.error('[fileService] Failed to query existing active jobs for reprocess:', err);
          }
        }

        if (!jobId && this.jobDispatcher) {
          try {
            const result = await this.jobDispatcher.dispatch({
              type: 'fund_update_extraction',
              payload: { fileId, workspaceId: this.workspaceId, contentType },
              timeoutSeconds: FUND_UPDATE_EXTRACTION_TIMEOUT_SECONDS,
              work: (ctx) =>
                runFundUpdateExtraction(
                  { fileId, workspaceId: this.workspaceId, contentType },
                  { db: ctx.db, job: ctx.job },
                ),
            });
            jobId = result.jobId;
          } catch (dispatchErr) {
            console.error('[fileService] Failed to dispatch fund update extraction job for reprocess:', dispatchErr);
          }
        }

        if (!jobId) {
          const failureReason =
            'Failed to dispatch async fund update extraction job: job dispatcher unavailable or dispatch failed';
          await this.fileRepo.updatePartial(fileId, {
            processing_status: 'failed',
            raw_notes: failureReason,
          });
          throw new Error(failureReason);
        }

        const updatedData = await this.fileRepo.findById(fileId);
        const signedUrl = await getSignedUrl(key).catch(() => null);
        return { ...updatedData, jobId, signed_url: signedUrl };
      }

      if (structuredResult) {
        tags = structuredResult.tags || [];
        matched_companies = structuredResult.matched_companies || [];
      }

      // file_type is intentionally left untouched so the file stays in its tab.
      // Fund updates only need HITL when there is something to apply (new /
      // add-missing assets). All-unchanged proposals complete immediately —
      // parsed data remains visible via the eye / structured-notes view.
      let fundUpdateNeedsReview = resolved.fundUpdateNeedsReview;
      if (fundUpdateNeedsReview) {
        fundUpdateNeedsReview = await this.fundUpdateProposalNeedsReview(structuredResult);
      }
      await this.fileRepo.updatePartial(fileId, {
        raw_notes: rawText,
        structured_notes: structuredResult ? JSON.stringify(structuredResult, null, 2) : null,
        tags,
        matched_companies: matched_companies as Tables<'files'>['matched_companies'],
        file_date: structuredResult?.file_date || null,
        processing_status: fundUpdateNeedsReview ? 'awaiting_review' : 'completed',
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

  async getReviewData(fileId: string, companyIdOverride?: string | null) {
    const file = await this.fileRepo.findById(fileId);
    const parsedNotes = this.parseStructuredNotes(file.structured_notes);

    if (file.file_type === 'fund_updates' || parsedNotes?.file_type === 'fund_updates') {
      return this.getFundUpdateReviewData(file, parsedNotes);
    }

    const extractedEntries = this.parseExtractedCompanies(parsedNotes);

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

    // Multi-company files extract several targets — diff against the entry
    // that matches the proposed company (falls back to the first entry, which
    // for legacy single-company files is the prospectus_summary itself).
    const summary = this.pickEntryForCompany(extractedEntries, currentCompany);

    // TODO: query files WHERE processing_status='awaiting_review' AND id!=fileId
    // AND matched_companies contains proposedCompanyId for conflict detection.
    const conflicts: Tables<'files'>[] = [];

    return {
      kind: 'company' as const,
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

  private mergeCatalogMatches(
    baseList: FundUpdateCatalogMatch[],
    extraList: Array<{ name: string; english_name?: string | null; status?: FundUpdateCatalogMatchStatus; matched_id?: string | null; auto_created?: boolean; role?: string | null }>,
  ): FundUpdateCatalogMatch[] {
    const map = new Map<string, FundUpdateCatalogMatch>();

    for (const item of baseList) {
      const cleanName = item?.name?.trim();
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      const existing = map.get(key);
      const itemStatus: FundUpdateCatalogMatchStatus = item.status === 'existing' ? 'existing' : 'new';
      const itemMatchedId = item.matched_id ?? null;
      const autoCreated = item.auto_created;
      const role = item.role ?? null;
      const englishName = item.english_name?.trim() || null;

      if (!existing) {
        map.set(key, {
          name: cleanName,
          ...(englishName ? { english_name: englishName } : {}),
          status: itemStatus,
          matched_id: itemMatchedId,
          ...(autoCreated !== undefined ? { auto_created: autoCreated } : {}),
          ...(role ? { role } : {}),
        });
      } else if (existing.status === 'new' && itemStatus === 'existing') {
        map.set(key, {
          name: existing.name,
          ...(existing.english_name || englishName ? { english_name: existing.english_name ?? englishName } : {}),
          status: 'existing',
          matched_id: itemMatchedId,
          ...(autoCreated !== undefined ? { auto_created: autoCreated } : existing.auto_created !== undefined ? { auto_created: existing.auto_created } : {}),
          ...(existing.role || role ? { role: existing.role ?? role ?? undefined } : {}),
        });
      }
    }

    for (const item of extraList) {
      const cleanName = item?.name?.trim();
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      const existing = map.get(key);
      const itemStatus: FundUpdateCatalogMatchStatus = item.status === 'existing' ? 'existing' : 'new';
      const itemMatchedId = item.matched_id ?? null;
      const autoCreated = item.auto_created;
      const role = item.role ?? null;
      const englishName = item.english_name?.trim() || null;

      if (!existing) {
        map.set(key, {
          name: cleanName,
          ...(englishName ? { english_name: englishName } : {}),
          status: itemStatus,
          matched_id: itemMatchedId,
          ...(autoCreated !== undefined ? { auto_created: autoCreated } : {}),
          ...(role ? { role } : {}),
        });
      } else {
        const mergedAutoCreated = autoCreated !== undefined ? autoCreated : existing.auto_created;
        const mergedRole = existing.role ?? role ?? undefined;
        const mergedEnglishName = existing.english_name ?? englishName ?? undefined;
        if (existing.status === 'new' && itemStatus === 'existing') {
          map.set(key, {
            name: existing.name,
            ...(mergedEnglishName ? { english_name: mergedEnglishName } : {}),
            status: 'existing',
            matched_id: itemMatchedId,
            ...(mergedAutoCreated !== undefined ? { auto_created: mergedAutoCreated } : {}),
            ...(mergedRole ? { role: mergedRole } : {}),
          });
        } else if (mergedAutoCreated !== undefined && existing.auto_created === undefined) {
          map.set(key, {
            ...existing,
            ...(mergedEnglishName ? { english_name: mergedEnglishName } : {}),
            auto_created: mergedAutoCreated,
            ...(mergedRole ? { role: mergedRole } : {}),
          });
        } else if ((mergedRole && !existing.role) || (mergedEnglishName && !existing.english_name)) {
          map.set(key, {
            ...existing,
            ...(mergedEnglishName ? { english_name: mergedEnglishName } : {}),
            ...(mergedRole ? { role: mergedRole } : {}),
          });
        }
      }
    }

    return Array.from(map.values());
  }

  private async getFundUpdateReviewData(
    file: Tables<'files'>,
    parsedNotes: Record<string, unknown> | null,
  ) {
    if (!this.fundUpdateApplyService) {
      throw new Error('Fund update apply service is not configured');
    }
    const structuredResult = parsedNotes as unknown as FundUpdateStructuredResult | null;
    const proposal = structuredResult?.fund_update_proposal;
    let assets = (proposal?.assets ?? []) as ParsedAsset[];

    const isV1 = Boolean(
      proposal && 'schema_version' in proposal && proposal.schema_version === 'workbook_fallback_v1',
    );
    const v1Proposal = isV1 ? (proposal as WorkbookFallbackProposalV1) : null;

    if (v1Proposal) {
      assets = hydrateParsedAssetsFromEvents(
        assets,
        v1Proposal.entities ?? [],
        v1Proposal.events ?? [],
      );
    }

    const legacyProposal = proposal as LegacyAssetProposal | undefined;
    const commitmentEvents = isV1
      ? []
      : (legacyProposal?.commitment_events ?? []);
    // An unresolved transfer cannot safely be posted as an ordinary
    // commitment increase. Surface it alongside other non-postable rows, but
    // do not prevent the independent, valid lifecycle events in this upload
    // from being approved.
    const reviewItems: ReviewProposalItem[] = [
      ...(legacyProposal?.review_items ?? []),
      ...commitmentEvents
        .filter((event) =>
          event.intent === 'transfer_in' &&
          (
            event.transferPairing?.status === 'missing_counterparty' ||
            event.transferPairing?.status === 'ambiguous' ||
            event.transferPairing?.requiresReview === true ||
            !event.transferPairing?.eligibleForTransferOut ||
            !event.transferPairing?.transferorName
          ),
        )
        .map((event) => {
          const valRes = event.counterpartyName ? validateTransferCounterparty(event.counterpartyName) : null;
          const category = !event.counterpartyName?.trim()
            ? ('missing_counterparty' as const)
            : valRes?.isMultiParty
              ? ('multi_party_transfer' as const)
              : ('truncated_transfer' as const);

          return {
            sourceRow: event.sourceRow,
            fund: event.fund,
            investorName: event.investorName,
            investorTypeRaw: event.investorTypeRaw,
            date: event.date,
            amount: event.amount,
            currency: 'CNY' as const,
            action: 'Commitment transfer',
            nature: event.natureRaw,
            direction: event.directionRaw,
            explanation: event.transferPairing?.reviewReason
              ?? 'Transfer counterparty could not be verified and will not be posted automatically.',
            isPostable: false as const,
            requiresReview: true as const,
            category,
            counterpartyRaw: event.counterpartyName,
            targetRaw: event.investorName,
            entityRaw: event.investorName,
            transferPairing: event.transferPairing,
          };
        }),
    ];
    const fullReview = await this.fundUpdateApplyService.buildFullReview(
      assets,
      commitmentEvents,
      {
        reconciliation: proposal?.reconciliation,
        review_items: reviewItems,
        fundCatalog: proposal?.fund_catalog,
      },
    );
    const reviews: FundUpdateAssetReview[] = fullReview.assets ?? [];
    let funds: FundUpdateCatalogMatch[] = fullReview.funds ? this.mergeCatalogMatches([], fullReview.funds) : [];
    let investors: FundUpdateCatalogMatch[] = fullReview.investors ? this.mergeCatalogMatches([], fullReview.investors) : [];
    let sources: FundUpdateCatalogMatch[] = fullReview.sources ? this.mergeCatalogMatches([], fullReview.sources) : [];
    let groups: FundUpdateCatalogMatch[] = fullReview.groups ? this.mergeCatalogMatches([], fullReview.groups) : [];

    // The deterministic Nanjing parser preserves bilingual rich-text names on
    // assets/events, while buildFullReview's catalog matching is keyed by the
    // Chinese canonical name. Reattach the English names before normalizing
    // the Step 1 entity model.
    if (!v1Proposal) {
      const bilingualFunds: FundUpdateCatalogMatch[] = [];
      const bilingualInvestors: FundUpdateCatalogMatch[] = [];
      const addBilingual = (
        list: FundUpdateCatalogMatch[],
        name: string | null | undefined,
        englishName: string | null | undefined,
      ) => {
        const cleanName = name?.trim();
        const cleanEnglishName = englishName?.trim();
        if (!cleanName || !cleanEnglishName) return;
        list.push({
          name: cleanName,
          english_name: cleanEnglishName,
          status: 'new',
          matched_id: null,
        });
      };

      for (const item of legacyProposal?.fund_catalog_items ?? []) {
        addBilingual(bilingualFunds, item.nameZh, item.nameEn);
      }
      for (const asset of assets) {
        if (asset.holderKind !== 'investor') {
          addBilingual(bilingualFunds, asset.fund, asset.fundEnglishName);
        }
      }
      for (const event of commitmentEvents) {
        addBilingual(bilingualFunds, event.fund, event.fundEnglishName);
        addBilingual(bilingualInvestors, event.investorName, event.investorEnglishName);
      }
      for (const item of reviewItems) {
        addBilingual(bilingualFunds, item.fund, item.fundEnglishName);
        addBilingual(bilingualInvestors, item.investorName, item.investorEnglishName);
      }

      funds = this.mergeCatalogMatches(funds, bilingualFunds);
      investors = this.mergeCatalogMatches(investors, bilingualInvestors);
    }

    if (v1Proposal) {
      const v1Entities = v1Proposal.entities ?? [];
      const extraFunds: FundUpdateCatalogMatch[] = [];
      const extraInvestors: FundUpdateCatalogMatch[] = [];

      for (const entity of v1Entities) {
        const entityName = (entity.originalName || entity.englishName || '').trim();
        if (!entityName) continue;

        const entityType = (entity.entityType || '').trim().toLowerCase();
        const status: FundUpdateCatalogMatchStatus = entity.existingRecordId ? 'existing' : 'new';
        const matched_id = entity.existingRecordId ?? null;

        if (entityType === 'fund') {
          const isAutoCreated = FUND_CATALOG.some((c) => c.trim().toLowerCase() === entityName.toLowerCase());
          extraFunds.push({
            name: entityName,
            english_name: entity.englishName ?? null,
            status,
            matched_id,
            ...(isAutoCreated ? { auto_created: true } : {}),
          });
        } else if (V1_INVESTOR_ENTITY_TYPES.has(entityType)) {
          extraInvestors.push({ name: entityName, english_name: entity.englishName ?? null, status, matched_id });
        }
      }

      funds = this.mergeCatalogMatches(funds, extraFunds);
      investors = this.mergeCatalogMatches(investors, extraInvestors);
    }

    const linkEntities = v1Proposal?.entities ?? [];
    const linkEvents: ProposedEvent[] = v1Proposal
      ? (v1Proposal.events ?? [])
      : commitmentEvents.map((ev, idx) => ({
          proposalId: `commitment-event-${idx}`,
          eventType: (ev.intent === 'paid_in'
            ? 'capital_contribution'
            : ev.intent === 'distribution'
              ? 'investor_distribution'
              : ev.intent === 'decrease'
                ? 'commitment_reduction'
                : 'commitment') as ProposedEvent['eventType'],
          fromEntityRef: ev.intent === 'distribution' ? ev.fund : ev.investorName,
          toEntityRef: ev.intent === 'distribution' ? ev.investorName : ev.fund,
          relatedFundRef: ev.fund,
          date: ev.date,
          normalizedAmount: ev.amount,
          normalizedCurrency: ev.currency,
          sourceLocation: { sheet: '基金流水明细', row: ev.sourceRow },
          warnings: [],
        }));
    const linkAssets = reviews.map((r) => ({
      code: r.code,
      name: r.name,
      fund: r.fund,
      entity: r.entity,
      funding_source: r.funding_source,
      fundingSource: r.funding_source || r.proposed?.fundingSource,
      fundingSourceRaw: r.proposed?.fundingSourceRaw,
    }));

    funds = funds.map((f) => ({
      ...f,
      asset_codes: assetCodesForCatalogName({
        catalogName: f.name,
        kind: 'fund',
        assets: linkAssets,
        entities: linkEntities,
        events: linkEvents,
      }),
    }));

    investors = investors.map((inv) => ({
      ...inv,
      asset_codes: assetCodesForCatalogName({
        catalogName: inv.name,
        kind: 'investor',
        assets: linkAssets,
        entities: linkEntities,
        events: linkEvents,
      }),
    }));

    sources = sources.map((s) => ({
      ...s,
      asset_codes: assetCodesForCatalogName({
        catalogName: s.name,
        kind: 'source',
        assets: linkAssets,
        entities: linkEntities,
        events: linkEvents,
      }),
    }));

    const twoStep = buildNormalizedTwoStepReview(
      {
        assets: reviews,
        funds,
        investors,
        sources,
        groups,
        reconciliation: proposal?.reconciliation ?? fullReview.reconciliation ?? [],
        review_items: reviewItems ?? fullReview.review_items ?? [],
        commitment_event_statuses: fullReview.commitment_event_statuses,
      },
      proposal,
    );

    return {
      kind: 'fund_updates' as const,
      file: {
        id: file.id,
        file_name: file.file_name,
        file_type: file.file_type,
        processing_status: file.processing_status,
      },
      template_id: proposal?.template_id ?? null,
      stats: proposal?.stats ?? null,
      summary: structuredResult?.summary ?? null,
      two_step_review: twoStep,
      assets: reviews,
      funds,
      investors,
      sources,
      groups,
      reconciliation: proposal?.reconciliation ?? fullReview.reconciliation ?? [],
      review_items: reviewItems ?? fullReview.review_items ?? [],
      commitment_event_statuses: fullReview.commitment_event_statuses,
    };
  }

  async approve(
    fileId: string,
    input: ApproveFileInput,
    enteredBy?: string | null,
  ): Promise<{ file: Tables<'files'>; company_id: string | null; fund_update?: FundUpdateApplyResult }> {
    const file = await this.fileRepo.findById(fileId);
    if (input.file_type === 'fund_updates') {
      if (file.processing_status !== 'awaiting_review') {
        throw new FundUpdateValidationError('Only awaiting_review fund updates may be submitted.');
      }
      return this.approveFundUpdate(fileId, input, enteredBy);
    }
    const parsedNotes = this.parseStructuredNotes(file.structured_notes);
    const extractedEntries = this.parseExtractedCompanies(parsedNotes);
    let summary: ProspectusSummary | undefined = extractedEntries[0];

    let companyId: string | null = input.matched_company_id;
    let companyRecord: Tables<'companies'> | null = null;

    if (!companyId && input.create_company_from_ai && summary) {
      const safeTarget = input.target?.trim()
        || (summary.company_name && !isGenericDocumentPhrase(summary.company_name) ? summary.company_name : null);
      const safeProjectName = input.project_name?.trim()
        || (summary.project_name && !isGenericDocumentPhrase(summary.project_name) ? summary.project_name : null);
      if (safeTarget || safeProjectName) {
        // Required L0 fields the reviewer supplies in the dialog take precedence
        // over whatever the AI extracted; fall back to the AI value (and finally
        // to 'inbound' for source) when the reviewer left them blank.
        const l0Source = input.source ?? 'inbound';
        const l0Geography = input.geography ?? summary.geography ?? null;
        const l0Segment = input.segment ?? summary.segment ?? null;

        // Run L0 requirements check via the shared static method — same rules
        // as the triage promote flow. Throws if any required fields are missing.
        const missing = CompanyService.checkL0Requirements({
          target: safeTarget,
          project_name: safeProjectName,
          entered_by: input.entered_by,
          source: l0Source,
          deal_type: input.deal_type,
          geography: l0Geography,
          segment: l0Segment,
          banker: input.banker,
        });
        if (missing.length > 0) throw new CompanyL0RequirementsError(missing);

        const overrides = input.company_field_updates ?? {};
        const pick = <K extends keyof typeof overrides>(
          key: K,
          fallback: string | null | undefined,
        ): string | null =>
          Object.prototype.hasOwnProperty.call(overrides, key)
            ? (overrides[key] ?? null)
            : (fallback ?? null);
        const insertData: Omit<TablesInsert<'companies'>, 'workspace_id'> = {
          pipeline_stage: 'L0',
          target: safeTarget,
          project_name: safeProjectName,
          thesis_content: null,
          segment: l0Segment,
          segment_related_offerings: pick('segment_related_offerings', summary.segment_related_offerings),
          company_focus: pick('company_focus', summary.company_focus),
          website: pick('website', summary.website),
          watchlist_status: pick('watchlist_status', summary.watchlist_status),
          comments: pick('comments', summary.comments),
          ownership: pick('ownership', summary.ownership),
          geography: l0Geography,
          remarks: pick('remarks', summary.remarks),
          source: l0Source,
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
      // Re-resolve the extracted entry against the company being enriched so
      // multi-company files apply the right target's financials.
      summary = this.pickEntryForCompany(extractedEntries, companyRecord);
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

    if (MULTI_COMPANY_FILE_TYPES.has(input.file_type) && companyId && summary) {
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

  private async approveFundUpdate(fileId: string, input: ApproveFileInput, enteredBy?: string | null) {
    if (!this.fundUpdateApplyService) {
      throw new Error('Fund update apply service is not configured');
    }
    const file = await this.fileRepo.findById(fileId);
    const parsedNotes = this.parseStructuredNotes(file.structured_notes);
    const proposal = (parsedNotes as unknown as FundUpdateStructuredResult | null)?.fund_update_proposal;

    const isV1 = proposal && 'schema_version' in proposal && proposal.schema_version === 'workbook_fallback_v1';
    // Server-side validation gate for v1 fallback proposals
    if (isV1) {
      const v1 = proposal as unknown as WorkbookFallbackProposalV1;

      if (
        !v1.row_accounting ||
        !v1.row_accounting.plannedRows ||
        !Array.isArray(v1.row_accounting.plannedRows) ||
        v1.row_accounting.plannedRows.length === 0
      ) {
        throw new Error('Cannot approve fund update: missing row_accounting or plannedRows');
      }

      // Check unique planned rows universe and reject duplicate planned row keys
      const seenPlannedKeys = new Set<string>();
      const duplicatePlannedKeys = new Set<string>();
      for (const pl of v1.row_accounting.plannedRows) {
        const key = pl.rowKey || formatSourceRowKey(pl.sheet, pl.row, pl.tableId);
        if (seenPlannedKeys.has(key)) {
          duplicatePlannedKeys.add(key);
        } else {
          seenPlannedKeys.add(key);
        }
      }

      if (duplicatePlannedKeys.size > 0) {
        throw new Error(
          `Cannot approve fund update: duplicate planned row keys detected for ${duplicatePlannedKeys.size} row(s) in extraction plan`,
        );
      }

      const uniquePlannedUniverseSize = seenPlannedKeys.size;
      const accountingTotal = v1.row_accounting.totalDataRows;
      const statsTotal = v1.stats?.total_data_rows;

      if (accountingTotal !== uniquePlannedUniverseSize || statsTotal !== uniquePlannedUniverseSize) {
        throw new Error(
          `Cannot approve fund update: row_accounting.totalDataRows (${accountingTotal}) and proposal.stats.total_data_rows (${statsTotal}) must equal unique plannedRows universe size (${uniquePlannedUniverseSize})`,
        );
      }

      // Re-normalize a cloned v1 merged payload from stored source fields + interpretation before validation
      const clonedEvents = (v1.events || []).map((e) => ({
        ...e,
        warnings: [...(e.warnings || [])],
        sourceLocation: { ...e.sourceLocation },
        normalizedAmount: null,
        normalizedCurrency: null,
        amountMultiplier: null,
      }));
      const clonedValuations = (v1.valuations || []).map((v) => ({
        ...v,
        warnings: [...(v.warnings || [])],
        sourceLocation: { ...v.sourceLocation },
        normalizedMarketValue: null,
        normalizedCurrency: null,
      }));

      const recomputed = normalizeWorkbookExtraction(
        {
          entities: (v1.entities || []).map((ent) => ({
            ...ent,
            aliases: [...(ent.aliases || [])],
            sourceLocations: (ent.sourceLocations || []).map((loc) => ({ ...loc })),
            warnings: [...(ent.warnings || [])],
          })),
          events: clonedEvents,
          valuations: clonedValuations,
          rowAccounting: v1.row_accounting,
          warnings: [...(v1.warnings || [])],
        },
        v1.interpretation,
      );

      // Reject if stored normalized amounts/currencies materially disagree with recomputed values
      for (let i = 0; i < (v1.events || []).length; i++) {
        const stored = v1.events[i];
        const recomputedEvt = recomputed.events[i];

        const storedCurr = stored.normalizedCurrency || null;
        const recomputedCurr = recomputedEvt.normalizedCurrency || null;
        if (storedCurr !== recomputedCurr) {
          throw new Error(
            `Cannot approve fund update: stored normalizedCurrency "${storedCurr}" does not match recomputed currency "${recomputedCurr}" for event at row ${stored.sourceLocation?.row}`,
          );
        }

        const storedAmt = stored.normalizedAmount;
        const recomputedAmt = recomputedEvt.normalizedAmount;
        if (
          (storedAmt == null && recomputedAmt != null) ||
          (storedAmt != null && recomputedAmt == null) ||
          (storedAmt != null && recomputedAmt != null && Math.abs(storedAmt - recomputedAmt) > 0.01)
        ) {
          throw new Error(
            `Cannot approve fund update: stored normalizedAmount (${storedAmt}) does not match recomputed amount (${recomputedAmt}) for event at row ${stored.sourceLocation?.row}`,
          );
        }
      }

      for (let i = 0; i < (v1.valuations || []).length; i++) {
        const stored = v1.valuations[i];
        const recomputedVal = recomputed.valuations[i];

        const storedCurr = stored.normalizedCurrency || null;
        const recomputedCurr = recomputedVal.normalizedCurrency || null;
        if (storedCurr !== recomputedCurr) {
          throw new Error(
            `Cannot approve fund update: stored normalizedCurrency "${storedCurr}" does not match recomputed currency "${recomputedCurr}" for valuation at row ${stored.sourceLocation?.row}`,
          );
        }

        const storedValAmt = stored.normalizedMarketValue;
        const recomputedValAmt = recomputedVal.normalizedMarketValue;
        if (
          (storedValAmt == null && recomputedValAmt != null) ||
          (storedValAmt != null && recomputedValAmt == null) ||
          (storedValAmt != null && recomputedValAmt != null && Math.abs(storedValAmt - recomputedValAmt) > 0.01)
        ) {
          throw new Error(
            `Cannot approve fund update: stored normalizedMarketValue (${storedValAmt}) does not match recomputed market value (${recomputedValAmt}) for valuation at row ${stored.sourceLocation?.row}`,
          );
        }
      }

      // Re-run deterministic validation server-side on recomputed data + interpretation
      const revalidated = validateWorkbookExtraction(recomputed, v1.interpretation);

      if (!revalidated.validation.isReviewable || revalidated.validation.hardFailures.length > 0) {
        throw new Error(
          `Cannot approve proposal with critical validation failures: ${revalidated.validation.hardFailures.join('; ')}`,
        );
      }

      // Check if proposal has any persistable asset records
      const persistableEvents = (v1.events || []).filter((ev) =>
        isPersistableV1AssetEventType(ev.eventType),
      );
      if (persistableEvents.length === 0 && (v1.valuations || []).length === 0 && (!v1.assets || v1.assets.length === 0)) {
        throw new Error(
          'Cannot approve fund update: proposal contains only investor-to-fund events and no persistable portfolio assets or valuations. Direct investor ledger writes are not supported.',
        );
      }
    }

    const legacyProposal = !isV1 ? (proposal as LegacyAssetProposal | undefined) : undefined;
    const fundCatalogItems = legacyProposal?.fund_catalog_items;

    // Reconciliation is intentionally advisory: a lifecycle ledger can contain
    // partial commitments, staged capital calls, or only the rows in this
    // upload, while 基金汇总 is a cumulative snapshot.  It must remain visible
    // in review, but is not evidence that a posted event is unsafe.
    const assets = (proposal?.assets ?? []) as ParsedAsset[];
    let selections = input.fund_update_selections;
    let codes =
      selections?.map((s) => s.asset_code) ?? input.fund_update_asset_codes ?? [];
    let catalogSelections = input.fund_update_catalog_selections;
    let sourceRemaps: Map<string, string> | undefined = undefined;
    let investorRemaps: Map<string, string> | undefined = undefined;
    let fundRemaps: Map<string, string> | undefined = undefined;
    let reviewResolutions = input.fund_update_review_resolutions;
    let commitmentEvents = !isV1
      ? (legacyProposal?.commitment_events ?? [])
      : [];

function isValidIsoDate(d: unknown): boolean {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [yearStr, monthStr, dayStr] = d.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidFiniteNumber(
  v: unknown,
  options?: { allowNegative?: boolean; nonZero?: boolean; allowNull?: boolean },
): boolean {
  if (v === null && options?.allowNull) return true;
  if (v == null) return false;
  if (typeof v !== 'number' && typeof v !== 'string') return false;
  const str = String(v).trim();
  if (str === '') return false;
  const num = Number(str);
  if (!Number.isFinite(num)) return false;
  if (!options?.allowNegative && num < 0) return false;
  if (options?.nonZero && num === 0) return false;
  return true;
}

function isEntityDecisionRemapped(
  key: string,
  canonicalEntitiesMap: Map<string, { matchedId?: string | null; status?: string }>,
  decisionsByKey: Map<string, { key: string; action: string; matchedId?: string | null; remappedName?: string | null }>,
): boolean {
  const d = decisionsByKey.get(key);
  if (!d) return false;
  if (d.remappedName && d.remappedName.trim()) return true;
  const canonical = canonicalEntitiesMap.get(key);
  if (!canonical) return false;
  if (d.matchedId && canonical.matchedId && d.matchedId !== canonical.matchedId) return true;
  if (d.action === 'use_existing' && canonical.status === 'new' && d.matchedId) return true;
  return false;
}

    const preReviewDuplicateOutcomes: SubmittedRowOutcome[] = [];

    // MB-513 Two-Step Approval Processing & Server-Side Validation
    if (input.two_step_approval) {
      const approval = input.two_step_approval;
      const reviewData = await this.getFundUpdateReviewData(file, parsedNotes);
      const canonicalReview = reviewData.two_step_review;
      const canonicalEntitiesMap = new Map(canonicalReview.entities.map((e) => [e.key, e]));
      // `target_kind` is authoritative when the review carries it. When the
      // review has no row for this code, fall back to the asset's own type —
      // the pre-`target_kind` behaviour — rather than assuming an asset target.
      const reviewAssets = reviewData.assets ?? [];
      const targetsFund = (asset: ParsedAsset): boolean => {
        const reviewAsset = reviewAssets.find((item) => item.code === asset.code);
        return reviewAsset?.target_kind === 'fund' ||
          (reviewAsset?.target_kind == null && asset.assetType === 'fund_of_funds');
      };

      // 1. Validate decisions and build staged entity map
      const stagedEntitiesMap = new Map<string, StagedReviewEntityInput>();
      const decisionsByKey = new Map<string, (typeof approval.entityDecisions)[number]>();
      const seenDecisionKeys = new Set<string>();

      const isKnownEntityDecisionKey = (key: string): boolean => {
        if (canonicalEntitiesMap.has(key)) return true;
        for (const ent of canonicalReview.entities) {
          if (ent.key === key) return true;
          if (ent.rawAssets?.some((ra) => ra.code === key.replace(/^asset:/, '') || `asset:${ra.code}` === key)) {
            return true;
          }
        }
        if (
          assets.some(
            (a) =>
              `asset:${a.code}` === key ||
              `asset:${a.name}` === key ||
              `fund:${a.fund}` === key ||
              `fund:${a.name}` === key ||
              (a.fundingSource && `source:${a.fundingSource}` === key) ||
              (a.entity && `investor:${a.entity}` === key) ||
              (a.holderName && `investor:${a.holderName}` === key) ||
              (a.group && `group:${a.group}` === key) ||
              (a.holderKind === 'investor' && a.fund && `group:${a.fund}` === key),
          )
        ) {
          return true;
        }
        if (proposal?.fund_catalog?.some((f) => `fund:${f}` === key)) {
          return true;
        }
        return false;
      };

      for (const d of approval.entityDecisions) {
        if (seenDecisionKeys.has(d.key)) {
          throw new FundUpdateValidationError(`Duplicate entity decision for key "${d.key}" submitted in approval`);
        }
        seenDecisionKeys.add(d.key);
        if (!isKnownEntityDecisionKey(d.key)) {
          throw new FundUpdateValidationError(`Unknown entity key "${d.key}" submitted in approval decisions`);
        }
        const canonical = canonicalEntitiesMap.get(d.key);
        if (d.action !== 'create' && d.action !== 'use_existing' && d.action !== 'omit') {
          throw new FundUpdateValidationError(`Invalid entity action "${d.action}" for key "${d.key}"`);
        }
        if (d.action === 'use_existing' && d.matchedId) {
          if (typeof (this.db as any)?.select === 'function' && canonical) {
            let existsInWorkspace = false;
            if (canonical.isGroup) {
              const [row] = await this.db.select({ id: flInvestors.id }).from(flInvestors).where(and(eq(flInvestors.workspace_id, this.workspaceId), eq(flInvestors.id, d.matchedId)));
              existsInWorkspace = Boolean(row);
            } else if (canonical.tab === 'source') {
              const [row] = await this.db.select({ id: flFundingSources.id }).from(flFundingSources).where(and(eq(flFundingSources.workspace_id, this.workspaceId), eq(flFundingSources.id, d.matchedId)));
              existsInWorkspace = Boolean(row);
            } else if (canonical.tab === 'investor') {
              const [row] = await this.db.select({ id: flInvestors.id }).from(flInvestors).where(and(eq(flInvestors.workspace_id, this.workspaceId), eq(flInvestors.id, d.matchedId)));
              existsInWorkspace = Boolean(row);
            } else if (canonical.tab === 'fund') {
              const [row] = await this.db.select({ id: flFunds.id }).from(flFunds).where(and(eq(flFunds.workspace_id, this.workspaceId), eq(flFunds.id, d.matchedId)));
              existsInWorkspace = Boolean(row);
            } else if (canonical.tab === 'asset') {
              const [row] = await this.db.select({ id: flAssets.id }).from(flAssets).where(and(eq(flAssets.workspace_id, this.workspaceId), eq(flAssets.id, d.matchedId)));
              existsInWorkspace = Boolean(row);
            }
            if (!existsInWorkspace) {
              throw new FundUpdateValidationError(`Cannot remap entity "${d.key}": target ID "${d.matchedId}" does not exist in workspace.`);
            }
          }
        }
        decisionsByKey.set(d.key, d);
      }

      for (const ent of canonicalReview.entities) {
        const decision = decisionsByKey.get(ent.key);
        let isStaged = true;
        let matchedId = ent.matchedId;
        let matchedIdConflict = ent.matchedIdConflict ?? null;
        let blockReason = ent.blockReason ?? null;
        let status = ent.status;

        if (decision) {
          if (decision.action === 'omit') {
            isStaged = false;
            matchedId = null;
          } else if (decision.action === 'create') {
            isStaged = true;
            matchedId = null;
            // 'create' must NOT silently bypass a conflict and create a third canonical record.
            // If the entity has a matchedIdConflict, it remains set so validation catches it.
          } else if (decision.action === 'use_existing') {
            isStaged = true;
            if (decision.matchedId) {
              // Explicit choice of existing matched ID resolves/clears the conflict
              matchedId = decision.matchedId;
              matchedIdConflict = null;
              blockReason = null;
              status = 'matched';
            } else {
              matchedId = ent.matchedId;
            }
          }
        } else {
          // Default: matched entities are staged and matched; new entities are staged
          isStaged = ent.isStaged !== false;
        }

        stagedEntitiesMap.set(ent.key, {
          key: ent.key,
          name: ent.name,
          kind: ent.tab,
          tab: ent.tab,
          status,
          matchedId,
          isStaged,
          isGroup: ent.isGroup,
          rawAssets: ent.rawAssets,
          matchedIdConflict,
          blockReason,
        });
      }

      // 1b. Prevalidate all submitted transaction and valuation IDs against regenerated review
      const seenTxnIds = new Set<string>();
      const canonicalTxnById = new Map(canonicalReview.transactions.map((t) => [t.id, t]));
      for (const t of approval.transactions) {
        if (seenTxnIds.has(t.id)) {
          throw new FundUpdateValidationError(`Duplicate transaction ID "${t.id}" submitted in approval`);
        }
        seenTxnIds.add(t.id);

        const canonical = canonicalTxnById.get(t.id);
        if (!canonical) {
          throw new FundUpdateValidationError(`Unknown transaction ID "${t.id}" submitted in approval`);
        }

        const isResolvedTransfer = Boolean(
          t.edits?.transferorName ||
          (t.edits?.allocations && t.edits.allocations.length > 0) ||
          canonical.singleTransferState?.enabled ||
          (canonical.allocations && canonical.allocations.length > 0)
        );
        const isResolvedNonCash = Boolean(t.edits?.investorName || canonical.nonCashState?.enabled);
        const isResolvedReviewItem =
          canonical.backingRef?.kind === 'review_item' && !canonical.blockReason;

        const effectiveTxn = reclassifyReviewTransaction(canonical, t.edits);

        if (canonical.status === 'blocked') {
          if (!isResolvedTransfer && !isResolvedNonCash && !isResolvedReviewItem) {
            if (effectiveTxn.status === 'blocked') {
              throw new FundUpdateValidationError(
                `Cannot approve transaction "${t.id}": item is blocked (${effectiveTxn.blockReason ?? canonical.blockReason ?? 'unresolved transaction requires classification before posting'})`,
              );
            }
          }
        } else if (canonical.status !== 'actionable' && canonical.status !== 'duplicate') {
          throw new FundUpdateValidationError(
            `Cannot approve transaction "${t.id}": item is not actionable (status "${canonical.status}")`,
          );
        }

        if (t.edits) {
          if (t.edits.date !== undefined) {
            if (!isValidIsoDate(t.edits.date)) {
              throw new FundUpdateValidationError(`Invalid date "${t.edits.date}" for transaction "${t.id}"`);
            }
          }
          if (t.edits.amount !== undefined) {
            if (!isValidFiniteNumber(t.edits.amount, { allowNegative: false })) {
              throw new FundUpdateValidationError(`Invalid amount "${t.edits.amount}" for transaction "${t.id}"`);
            }
          }
          if (t.edits.cashDelta !== undefined) {
            if (!isValidFiniteNumber(t.edits.cashDelta, { allowNegative: true, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid cashDelta "${t.edits.cashDelta}" for transaction "${t.id}"`);
            }
            if (t.edits.cashDelta === null && t.edits.amount === undefined && !canonical.nonCashState?.enabled) {
              throw new FundUpdateValidationError(
                `Cannot clear cashDelta for cash-bearing transaction "${t.id}": missing required cash amount`,
              );
            }
          }
          if (t.edits.quantityDelta !== undefined) {
            if (!isValidFiniteNumber(t.edits.quantityDelta, { allowNegative: true, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid quantityDelta "${t.edits.quantityDelta}" for transaction "${t.id}"`);
            }
          }
          if (t.edits.pricePerShare !== undefined) {
            if (!isValidFiniteNumber(t.edits.pricePerShare, { allowNegative: false, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid pricePerShare "${t.edits.pricePerShare}" for transaction "${t.id}"`);
            }
          }
          if (t.edits.sellProceedsDestination !== undefined && t.edits.sellProceedsDestination !== null) {
            if (!isSellProceedsDestination(t.edits.sellProceedsDestination)) {
              throw new FundUpdateValidationError(
                `Invalid sellProceedsDestination "${t.edits.sellProceedsDestination}" for transaction "${t.id}"`,
              );
            }
          }
        }
      }

      const seenValIds = new Set<string>();
      const canonicalValById = new Map(canonicalReview.valuations.map((v) => [v.id, v]));
      for (const v of approval.valuations) {
        if (seenValIds.has(v.id)) {
          throw new FundUpdateValidationError(`Duplicate valuation ID "${v.id}" submitted in approval`);
        }
        seenValIds.add(v.id);

        const canonical = canonicalValById.get(v.id);
        if (!canonical) {
          throw new FundUpdateValidationError(`Unknown valuation ID "${v.id}" submitted in approval`);
        }

        if (canonical.status === 'blocked') {
          throw new FundUpdateValidationError(
            `Cannot approve valuation "${v.id}": item is blocked (${canonical.blockReason ?? 'unresolved dependency'})`,
          );
        } else if (canonical.status !== 'actionable' && canonical.status !== 'duplicate') {
          throw new FundUpdateValidationError(
            `Cannot approve valuation "${v.id}": item is not actionable (status "${canonical.status}")`,
          );
        }

        if (v.edits) {
          if (v.edits.asOfDate !== undefined) {
            if (!isValidIsoDate(v.edits.asOfDate)) {
              throw new FundUpdateValidationError(`Invalid asOfDate "${v.edits.asOfDate}" for valuation "${v.id}"`);
            }
          }
          if (v.edits.marketValue !== undefined) {
            if (!isValidFiniteNumber(v.edits.marketValue, { allowNegative: true, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid marketValue "${v.edits.marketValue}" for valuation "${v.id}"`);
            }
          }
          if (v.edits.pricePerShare !== undefined) {
            if (!isValidFiniteNumber(v.edits.pricePerShare, { allowNegative: false, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid pricePerShare "${v.edits.pricePerShare}" for valuation "${v.id}"`);
            }
          }
          if (v.edits.sharesOutstanding !== undefined) {
            if (!isValidFiniteNumber(v.edits.sharesOutstanding, { allowNegative: false, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid sharesOutstanding "${v.edits.sharesOutstanding}" for valuation "${v.id}"`);
            }
          }
          if (v.edits.shareholdingPct !== undefined) {
            if (!isValidFiniteNumber(v.edits.shareholdingPct, { allowNegative: false, allowNull: true })) {
              throw new FundUpdateValidationError(`Invalid shareholdingPct "${v.edits.shareholdingPct}" for valuation "${v.id}"`);
            }
          }
        }
      }

      // 2. Map selected transactions and apply allow-listed edits
      const approvedTxnEditsById = new Map(approval.transactions.map((t) => [t.id, t.edits]));
      const selectedTransactions = canonicalReview.transactions.map((t) => {
        const edits = approvedTxnEditsById.get(t.id);
        const hasEdits = Boolean(edits && Object.keys(edits).length > 0);
        const txnAssetCode = t.backingRef && 'assetCode' in t.backingRef ? t.backingRef.assetCode : undefined;
        const isTxnRemapped = Boolean(
          (t.fromKey && isEntityDecisionRemapped(t.fromKey, canonicalEntitiesMap, decisionsByKey)) ||
          (t.toKey && isEntityDecisionRemapped(t.toKey, canonicalEntitiesMap, decisionsByKey)) ||
          (txnAssetCode && (
            isEntityDecisionRemapped(`asset:${txnAssetCode}`, canonicalEntitiesMap, decisionsByKey) ||
            isEntityDecisionRemapped(`fund:${txnAssetCode}`, canonicalEntitiesMap, decisionsByKey)
          ))
        );
        const effectiveTxn = reclassifyReviewTransaction(t, edits);
        const isEligible =
          effectiveTxn.status === 'actionable' ||
          (t.status === 'duplicate' && (hasEdits || isTxnRemapped)) ||
          (t.status === 'blocked' && (isTxnRemapped || t.backingRef?.kind === 'review_item' || effectiveTxn.singleTransferState?.enabled || effectiveTxn.nonCashState?.enabled || (effectiveTxn.allocations && effectiveTxn.allocations.length > 0)));
        const isSelected = isEligible && approvedTxnEditsById.has(t.id);
        return {
          ...effectiveTxn,
          selected: isSelected,
        };
      });

      // 3. Map selected valuations and apply allow-listed edits
      const approvedValEditsById = new Map(approval.valuations.map((v) => [v.id, v.edits]));
      const selectedValuations = canonicalReview.valuations.map((v) => {
        const edits = approvedValEditsById.get(v.id);
        const hasEdits = Boolean(edits && Object.keys(edits).length > 0);
        const valAssetCode = v.backingRef && 'assetCode' in v.backingRef ? v.backingRef.assetCode : undefined;
        const isValRemapped = Boolean(
          valAssetCode && (
            isEntityDecisionRemapped(`asset:${valAssetCode}`, canonicalEntitiesMap, decisionsByKey) ||
            isEntityDecisionRemapped(`fund:${valAssetCode}`, canonicalEntitiesMap, decisionsByKey)
          )
        );
        const isEligible = v.status === 'actionable' || (v.status === 'duplicate' && (hasEdits || isValRemapped));
        const isSelected = isEligible && approvedValEditsById.has(v.id);
        const updated = { ...v, selected: isSelected };
        if (edits) {
          if (edits.asOfDate !== undefined) updated.asOfDate = edits.asOfDate;
          if (edits.marketValue !== undefined) {
            updated.marketValue = edits.marketValue === null ? null : Number(edits.marketValue);
          }
          if (edits.pricePerShare !== undefined) {
            updated.pricePerShare = edits.pricePerShare === null ? null : Number(edits.pricePerShare);
          }
          if (edits.sharesOutstanding !== undefined) {
            updated.sharesOutstanding = edits.sharesOutstanding === null ? null : Number(edits.sharesOutstanding);
          }
          if (edits.shareholdingPct !== undefined) {
            updated.shareholdingPct = edits.shareholdingPct === null ? null : Number(edits.shareholdingPct);
          }
          if (edits.valuationMethod !== undefined) updated.valuationMethod = edits.valuationMethod;
          if (edits.notes !== undefined) updated.notes = edits.notes;
        }
        return updated;
      });

      // 4. Server-Side Dependency Validation
      const depResult = validateTwoStepDependencies({
        stagedEntities: stagedEntitiesMap,
        transactions: selectedTransactions,
        valuations: selectedValuations,
      });

      if (!depResult.isValid) {
        throw new FundUpdateValidationError(
          `Cannot approve fund update due to dependency validation failures: ${depResult.errors.join('; ')}`,
        );
      }

      // 5. Translate into applySelected and applyCommitmentEvents inputs
      const managedFundNormNames = new Set<string>();
      for (const a of assets) {
        if (a.fund) managedFundNormNames.add(normalizeCanonicalName(a.fund) || a.fund.trim().toLowerCase());
      }
      for (const e of commitmentEvents) {
        if (e.fund) managedFundNormNames.add(normalizeCanonicalName(e.fund) || e.fund.trim().toLowerCase());
      }
      for (const r of legacyProposal?.review_items ?? []) {
        if (r.fund) managedFundNormNames.add(normalizeCanonicalName(r.fund) || r.fund.trim().toLowerCase());
      }
      for (const f of proposal?.fund_catalog ?? []) {
        managedFundNormNames.add(normalizeCanonicalName(f) || f.trim().toLowerCase());
      }

      sourceRemaps = new Map<string, string>();
      investorRemaps = new Map<string, string>();
      fundRemaps = new Map<string, string>();
      for (const d of approval.entityDecisions) {
        if (d.action === 'use_existing' && d.matchedId) {
          if (d.key.startsWith('source:')) {
            sourceRemaps.set(d.key, d.matchedId);
            sourceRemaps.set(d.key.replace(/^source:/, ''), d.matchedId);
          } else if (d.key.startsWith('investor:')) {
            investorRemaps.set(d.key, d.matchedId);
            investorRemaps.set(d.key.replace(/^investor:/, ''), d.matchedId);
          } else if (d.key.startsWith('fund:')) {
            fundRemaps.set(d.key, d.matchedId);
            fundRemaps.set(d.key.replace(/^fund:/, ''), d.matchedId);
          }
        }
      }

      const postingSourceKeys = new Set<string>();
      for (const t of depResult.validatedTransactions) {
        if (t.selected) {
          if (t.srcKey) {
            postingSourceKeys.add(t.srcKey);
            postingSourceKeys.add(t.srcKey.replace(/^source:/, ''));
          }
          const raw = t.rawTxn;
          if (raw?.fundingSource) postingSourceKeys.add(raw.fundingSource);
          if ((t as any).fundingSource) postingSourceKeys.add((t as any).fundingSource);
          if (raw?.allocations) {
            for (const a of raw.allocations) {
              if (a.fundingSourceId) postingSourceKeys.add(a.fundingSourceId);
              if ((a as any).funding_source_id) postingSourceKeys.add((a as any).funding_source_id);
            }
          }
        }
      }
      for (const e of commitmentEvents) {
        if ((e as any).fundingSource) {
          postingSourceKeys.add((e as any).fundingSource);
        }
      }

      const verifyOnlySourceKeys = new Set<string>();
      for (const t of depResult.validatedTransactions) {
        if (!t.selected) {
          if (t.srcKey) {
            verifyOnlySourceKeys.add(t.srcKey);
            verifyOnlySourceKeys.add(t.srcKey.replace(/^source:/, ''));
          }
          const raw = t.rawTxn;
          if (raw?.fundingSource) verifyOnlySourceKeys.add(raw.fundingSource);
          if ((t as any).fundingSource) verifyOnlySourceKeys.add((t as any).fundingSource);
        }
      }

      const isFofTargetName = (name: string): boolean => {
        const norm = normalizeCanonicalName(name);
        const lower = name.trim().toLowerCase();
        return assets.some(
          (a) =>
            a.assetType === 'fund_of_funds' &&
            ((norm && normalizeCanonicalName(a.name) === norm) ||
              a.name.trim().toLowerCase() === lower),
        );
      };

      const stagedFunds = Array.from(stagedEntitiesMap.values())
        .filter((e) => {
          if (!e.isStaged) return false;
          if (e.isGroup) {
            const dec = decisionsByKey.get(e.key);
            return dec?.action !== 'omit';
          }
          if (e.kind !== 'fund') return false;
          // A managed fund is eligible even when the same workbook also holds it as a
          // fund_of_funds target: a managed fund held by another managed fund is a legitimate
          // structure (Nanjing chains 桐德 -> 月升星繁 -> 淮安熙和). It must stay in the
          // allowlist or applySelected leaves `fundId` null for every asset it holds and the
          // whole approval aborts with "unresolved position for holder".
          const isManagedFund = managedFundNormNames.has(normalizeCanonicalName(e.name) || e.name.trim().toLowerCase());
          if (isManagedFund) return true;
          // A purely external FoF target — never a holder, absent from the fund catalog — is
          // created by the FoF branch of applySelected as `managed: false` /
          // `ownership_basis: 'capital_account'`. Keep it out of the eager catalog creation so
          // that branch stays authoritative for its attributes.
          if (isFofTargetName(e.name)) return false;
          const dec = decisionsByKey.get(e.key);
          if (dec?.action === 'create') return true;
          return false;
        })
        .map((e) => e.name);

      const stagedInvestors = Array.from(stagedEntitiesMap.values())
        .filter((e) => e.kind === 'investor' && !e.isGroup && e.isStaged)
        .map((e) => e.name);

      const stagedSources = Array.from(stagedEntitiesMap.values())
        .filter((e) => {
          if (e.kind !== 'source' || !e.isStaged) return false;
          const dec = decisionsByKey.get(e.key);
          if (dec?.action === 'use_existing' || dec?.action === 'omit') return false;
          if (dec?.action === 'create') return true;
          if (e.status !== 'new') return false;
          const isReferencedByVerifyOnly = verifyOnlySourceKeys.has(e.key) || verifyOnlySourceKeys.has(e.name);
          const isReferencedByPosting = postingSourceKeys.has(e.key) || postingSourceKeys.has(e.name);
          if (isReferencedByVerifyOnly && !isReferencedByPosting) {
            return false;
          }
          return true;
        })
        .map((e) => e.name);
      catalogSelections = { funds: stagedFunds, investors: stagedInvestors, sources: stagedSources };

      // fl_assets and fl_funds are standalone master-data tables — neither has a
      // parent-fund column. Only fl_positions needs a fund, and applySelected
      // already opens one solely when the owning fund resolves (`if (fundId)`).
      // So a staged entity is created whether or not its owning fund was staged;
      // deselecting the fund costs the holding, not the record itself.
      const stagedAssetCodesSet = new Set<string>();
      for (const ent of stagedEntitiesMap.values()) {
        if (ent.kind === 'asset' && ent.isStaged) {
          const dec = decisionsByKey.get(ent.key);
          if (dec?.action === 'omit') continue;
          stagedAssetCodesSet.add(ent.key.replace(/^asset:/, ''));
          if (ent.rawAssets) {
            for (const ra of ent.rawAssets) {
              if (ra.code) stagedAssetCodesSet.add(ra.code);
            }
          }
        }
      }
      for (const asset of assets) {
        if (targetsFund(asset)) {
          const fundKey = `fund:${asset.name}`;
          const normKey = normalizeCanonicalName(asset.name) || asset.name.trim().toLowerCase();
          const targetFundEntity =
            stagedEntitiesMap.get(fundKey) ??
            Array.from(stagedEntitiesMap.values()).find(
              (e) => e.kind === 'fund' && (normalizeCanonicalName(e.name) === normKey || e.name.trim().toLowerCase() === asset.name.trim().toLowerCase()),
            );

          if (targetFundEntity && targetFundEntity.isStaged) {
            const dec = decisionsByKey.get(targetFundEntity.key);
            if (dec?.action !== 'omit') {
              stagedAssetCodesSet.add(asset.code);
            }
          }
        } else {
          const normKey = normalizeCanonicalName(asset.name) || normalizeCanonicalName(asset.legalName) || asset.name.trim().toLowerCase();
          const targetAssetEntity =
            stagedEntitiesMap.get(`asset:${asset.code}`) ??
            Array.from(stagedEntitiesMap.values()).find(
              (e) => e.kind === 'asset' && (normalizeCanonicalName(e.name) === normKey || e.name.trim().toLowerCase() === asset.name.trim().toLowerCase() || (e.rawAssets && e.rawAssets.some((ra) => ra.code === asset.code))),
            );

          if (targetAssetEntity && targetAssetEntity.isStaged) {
            const dec = decisionsByKey.get(targetAssetEntity.key);
            if (dec?.action !== 'omit') {
              stagedAssetCodesSet.add(asset.code);
            }
          }
        }
      }

      for (const t of approval.transactions) {
        const canonical = canonicalTxnById.get(t.id);
        if (canonical?.backingRef?.kind === 'asset_txn' && canonical.backingRef.assetCode) {
          stagedAssetCodesSet.add(canonical.backingRef.assetCode);
        }
      }

      // Construct per-asset selections
      const derivedAssetSelections: FundUpdateAssetSelection[] = [];
      for (const assetCode of stagedAssetCodesSet) {
        const assetObj = assets.find((a) => a.code === assetCode);
        let matchedTargetId: string | undefined;
        let remappedTargetName: string | undefined;

        if (assetObj && targetsFund(assetObj)) {
          const normKey = normalizeCanonicalName(assetObj.name) || assetObj.name.trim().toLowerCase();
          const targetFundEnt = Array.from(stagedEntitiesMap.values()).find(
            (e) =>
              e.kind === 'fund' &&
              (e.key === `fund:${assetObj.name}` ||
                (e.rawAssets && e.rawAssets.some((ra) => ra.code === assetCode)) ||
                (e.name && (normalizeCanonicalName(e.name) === normKey || e.name.trim().toLowerCase() === assetObj.name.trim().toLowerCase()))),
          );
          const targetDecision =
            approval.entityDecisions.find((d) => d.key === `fund:${assetObj.name}`) ??
            (targetFundEnt ? approval.entityDecisions.find((d) => d.key === targetFundEnt.key) : undefined) ??
            approval.entityDecisions.find(
              (d) =>
                d.key.startsWith('fund:') &&
                (normalizeCanonicalName(d.key.replace(/^fund:/, '')) === normKey ||
                  d.key.replace(/^fund:/, '').trim().toLowerCase() === assetObj.name.trim().toLowerCase()),
            );
          if (targetDecision) {
            matchedTargetId = targetDecision.matchedId ?? undefined;
            remappedTargetName = targetDecision.remappedName ?? undefined;
          }
        } else if (assetObj) {
          const normKey =
            normalizeCanonicalName(assetObj.name) ||
            normalizeCanonicalName(assetObj.legalName) ||
            assetObj.name.trim().toLowerCase();
          const targetAssetEnt = Array.from(stagedEntitiesMap.values()).find(
            (e) =>
              e.kind === 'asset' &&
              (e.key === `asset:${assetObj.code}` ||
                (e.rawAssets && e.rawAssets.some((ra) => ra.code === assetCode)) ||
                (e.name && (normalizeCanonicalName(e.name) === normKey || e.name.trim().toLowerCase() === assetObj.name.trim().toLowerCase()))),
          );
          const assetDecision =
            approval.entityDecisions.find((d) => d.key === `asset:${assetObj.code}`) ??
            (targetAssetEnt ? approval.entityDecisions.find((d) => d.key === targetAssetEnt.key) : undefined) ??
            approval.entityDecisions.find((d) => {
              if (!d.key.startsWith('asset:')) return false;
              const rawKey = d.key.replace(/^asset:/, '');
              if (normalizeCanonicalName(rawKey) === normKey) return true;
              if (d.remappedName && normalizeCanonicalName(d.remappedName) === normKey) return true;
              const decisionAsset = assets.find((a) => a.code === rawKey);
              if (decisionAsset) {
                const decisionNorm =
                  normalizeCanonicalName(decisionAsset.name) ||
                  normalizeCanonicalName(decisionAsset.legalName) ||
                  decisionAsset.name.trim().toLowerCase();
                return decisionNorm === normKey;
              }
              return false;
            });
          if (assetDecision) {
            matchedTargetId = assetDecision.matchedId ?? undefined;
            remappedTargetName = assetDecision.remappedName ?? undefined;
          }
        }

        const assetTxns = depResult.validatedTransactions
          .filter((t) => (t.selected || approvedTxnEditsById.has(t.id)) && t.backingRef?.kind === 'asset_txn' && t.backingRef.assetCode === assetCode && t.rawTxn)
          .map((t) => {
            const raw = t.rawTxn!;
            const edits = approvedTxnEditsById.get(t.id);
            const resolvedShareCount =
              t.quantityDelta !== undefined ? t.quantityDelta : (raw.shareCount ?? null);
            const resolvedPricePerShare =
              t.pricePerShare !== undefined ? t.pricePerShare : (raw.pricePerShare ?? null);
            const resolvedNotes =
              edits?.notes !== undefined ? edits.notes : (t.notes !== undefined ? t.notes : (raw.notes ?? null));
            const resolvedSubTypeLabel =
              (edits?.subTypeLabel !== undefined ? edits.subTypeLabel : raw.subTypeLabel) ?? null;

            const isUnresolvedRaw =
              raw.type === 'other' ||
              (raw.type as string) === 'others' ||
              (raw.type as string) === 'unknown';

            // Point 1: Preserve semantic type for unchanged canonical rows.
            // Explicit classification resolution is applied only when deliberately chosen for an unresolved row.
            const reviewerResolvedType =
              isUnresolvedRaw && t.type !== 'other' && t.type !== 'unknown';
            const resolvedType = (reviewerResolvedType ? t.type : raw.type) as TxnTypeEnum;

            // A reviewer may classify an estimate-worded row into an actual event. It posts,
            // but the ledger entry carries needs_verification so reporting can still flag it.
            const isEstimateWorded = classifyFundUpdateTxn({
              type: 'other',
              subTypeLabel: resolvedSubTypeLabel,
              notes: resolvedNotes,
              valueAmount: raw.valueAmount,
            }).isEstimated;
            const resolvedDataStatus =
              reviewerResolvedType && isEstimateWorded ? 'needs_verification' : raw.dataStatus;

            // Point 2: Eventual posting and review validation see identical effective values from effectiveTxn.
            const resolvedAmount = t.cashDelta != null ? t.cashDelta : (t.amount ?? raw.valueAmount);

            let resolvedFundingSource: string | null | undefined = (t as any).fundingSource ?? raw.fundingSource;
            let resolvedFundingSourceId: string | null | undefined = (t as any).fundingSourceId ?? raw.fundingSourceId ?? null;
            if (t.srcKey) {
              const srcDecision = approval.entityDecisions.find((d) => d.key === t.srcKey);
              if (srcDecision?.action === 'use_existing' && srcDecision.matchedId) {
                resolvedFundingSourceId = srcDecision.matchedId;
                resolvedFundingSource = srcDecision.remappedName ?? srcDecision.matchedId;
              } else if (srcDecision?.remappedName) {
                resolvedFundingSource = srcDecision.remappedName;
              } else {
                resolvedFundingSource = t.srcKey.replace(/^source:/, '');
              }
            }

            let remappedAllocations = (t as any).allocations ?? raw.allocations;
            if (remappedAllocations && remappedAllocations.length > 0 && sourceRemaps) {
              remappedAllocations = remappedAllocations.map((a: any) => {
                const rawKey = (a.funding_source_id ?? a.fundingSourceId)?.trim();
                const remapped = rawKey ? (sourceRemaps!.get(rawKey) ?? sourceRemaps!.get(`source:${rawKey}`)) : undefined;
                if (remapped) {
                  return {
                    ...a,
                    funding_source_id: remapped,
                    fundingSourceId: remapped,
                  };
                }
                return a;
              });
            }

            return {
              ...raw,
              submittedId: t.id,
              date: t.date,
              type: resolvedType,
              valueAmount: resolvedAmount,
              currency: t.currency || raw.currency,
              shareCount: resolvedShareCount,
              pricePerShare: resolvedPricePerShare,
              notes: resolvedNotes,
              subTypeLabel: resolvedSubTypeLabel,
              reviewerResolvedType,
              dataStatus: resolvedDataStatus,
              // Prefer reviewer edit; otherwise keep the source-stated value.
              // Do NOT fall back to the review row's effective/inferred destination —
              // that would clear D1's inferred flag on every unmarked sale.
              sellProceedsDestination:
                edits?.sellProceedsDestination !== undefined
                  ? edits.sellProceedsDestination
                  : (raw.sellProceedsDestination ?? null),
              fundingSource: resolvedFundingSource,
              fundingSourceId: resolvedFundingSourceId,
              allocations: remappedAllocations,
              allowPost: Boolean(t.selected),
            };
          });

        const assetVals = depResult.validatedValuations
          .filter((v) => v.selected && v.backingRef?.kind === 'asset_valuation' && v.backingRef.assetCode === assetCode && v.rawVal)
          .map((v) => {
            const raw = v.rawVal!;
            return {
              ...raw,
              submittedId: v.id,
              asOfDate: v.asOfDate,
              marketValue: v.marketValue !== undefined ? v.marketValue : (raw.marketValue ?? null),
              pricePerShare: v.pricePerShare !== undefined ? v.pricePerShare : (raw.pricePerShare ?? null),
              sharesOutstanding: v.sharesOutstanding !== undefined ? v.sharesOutstanding : (raw.sharesOutstanding ?? null),
              shareholdingPct: v.shareholdingPct !== undefined ? v.shareholdingPct : (raw.shareholdingPct ?? null),
              valuationMethod: v.valuationMethod !== undefined ? (v.valuationMethod as any) : (raw.valuationMethod ?? null),
              notes: v.notes !== undefined ? v.notes : (raw.notes ?? null),
            };
          });

        derivedAssetSelections.push({
          asset_code: assetCode,
          txns: assetTxns,
          valuations: assetVals,
          matched_target_id: matchedTargetId,
          remapped_target_name: remappedTargetName,
        });
      }

      // Pre-approval safety invariant: Prevent multiple proposed direct assets
      // with the same canonical identity from having conflicting action decisions (e.g. create vs use-existing),
      // conflicting matched asset IDs, or inconsistent remapped targets.
      const directAssetTargetByIdentity = new Map<
        string,
        {
          code: string;
          action: 'use_existing' | 'create';
          matchedTargetId?: string;
          remappedTargetName?: string;
          effectiveCanonicalTarget: string;
        }
      >();

      for (const sel of derivedAssetSelections) {
        const assetObj = assets.find((a) => a.code === sel.asset_code);
        if (assetObj && !targetsFund(assetObj)) {
          const normKey =
            normalizeCanonicalName(assetObj.name) ||
            normalizeCanonicalName(assetObj.legalName) ||
            assetObj.name.trim().toLowerCase();

          const isUseExisting = Boolean(sel.matched_target_id);
          const action = isUseExisting ? ('use_existing' as const) : ('create' as const);
          const effectiveCanonicalTarget = sel.remapped_target_name
            ? (normalizeCanonicalName(sel.remapped_target_name) || sel.remapped_target_name.trim().toLowerCase())
            : normKey;

          const existing = directAssetTargetByIdentity.get(normKey);
          if (existing) {
            if (existing.action !== action) {
              throw new FundUpdateValidationError(
                `Pre-approval safety invariant violation: Proposed direct assets "${existing.code}" and "${sel.asset_code}" share canonical identity "${assetObj.name}" but have conflicting action decisions (${existing.action} vs ${action}). Direct assets with the same canonical identity must resolve to the same entity decision.`,
              );
            }
            if (existing.matchedTargetId && sel.matched_target_id && existing.matchedTargetId !== sel.matched_target_id) {
              throw new FundUpdateValidationError(
                `Pre-approval safety invariant violation: Proposed direct assets "${existing.code}" and "${sel.asset_code}" share canonical identity "${assetObj.name}" but have conflicting matched asset IDs (${existing.matchedTargetId} vs ${sel.matched_target_id}). Direct assets with the same canonical identity must resolve to the same asset ID.`,
              );
            }
            if (existing.effectiveCanonicalTarget !== effectiveCanonicalTarget) {
              throw new FundUpdateValidationError(
                `Pre-approval safety invariant violation: Proposed direct assets "${existing.code}" and "${sel.asset_code}" share canonical identity "${assetObj.name}" but have inconsistent target names ("${existing.remappedTargetName ?? existing.effectiveCanonicalTarget}" vs "${sel.remapped_target_name ?? effectiveCanonicalTarget}"). Direct assets with the same canonical identity must resolve to the same target entity.`,
              );
            }
          } else {
            directAssetTargetByIdentity.set(normKey, {
              code: sel.asset_code,
              action,
              matchedTargetId: sel.matched_target_id,
              remappedTargetName: sel.remapped_target_name,
              effectiveCanonicalTarget,
            });
          }
        }
      }

      const fofTargetByIdentity = new Map<
        string,
        {
          code: string;
          action: 'use_existing' | 'create';
          matchedTargetId?: string;
          remappedTargetName?: string;
          effectiveCanonicalTarget: string;
        }
      >();

      for (const sel of derivedAssetSelections) {
        const assetObj = assets.find((a) => a.code === sel.asset_code);
        if (assetObj && targetsFund(assetObj)) {
          const normKey =
            normalizeCanonicalName(assetObj.name) ||
            normalizeCanonicalName(assetObj.legalName) ||
            assetObj.name.trim().toLowerCase();

          const isUseExisting = Boolean(sel.matched_target_id);
          const action = isUseExisting ? ('use_existing' as const) : ('create' as const);
          const effectiveCanonicalTarget = sel.remapped_target_name
            ? (normalizeCanonicalName(sel.remapped_target_name) || sel.remapped_target_name.trim().toLowerCase())
            : normKey;

          const existing = fofTargetByIdentity.get(normKey);
          if (existing) {
            if (existing.action !== action) {
              throw new FundUpdateValidationError(
                `Pre-approval safety invariant violation: Proposed FoF holdings "${existing.code}" and "${sel.asset_code}" share canonical identity "${assetObj.name}" but have conflicting action decisions (${existing.action} vs ${action}).`,
              );
            }
            if (existing.matchedTargetId && sel.matched_target_id && existing.matchedTargetId !== sel.matched_target_id) {
              throw new FundUpdateValidationError(
                `Pre-approval safety invariant violation: Proposed FoF holdings "${existing.code}" and "${sel.asset_code}" share canonical identity "${assetObj.name}" but have conflicting matched fund IDs (${existing.matchedTargetId} vs ${sel.matched_target_id}).`,
              );
            }
            if (existing.effectiveCanonicalTarget !== effectiveCanonicalTarget) {
              throw new FundUpdateValidationError(
                `Pre-approval safety invariant violation: Proposed FoF holdings "${existing.code}" and "${sel.asset_code}" share canonical identity "${assetObj.name}" but have inconsistent target names ("${existing.remappedTargetName ?? existing.effectiveCanonicalTarget}" vs "${sel.remapped_target_name ?? effectiveCanonicalTarget}").`,
              );
            }
          } else {
            fofTargetByIdentity.set(normKey, {
              code: sel.asset_code,
              action,
              matchedTargetId: sel.matched_target_id,
              remappedTargetName: sel.remapped_target_name,
              effectiveCanonicalTarget,
            });
          }
        }
      }

      selections = derivedAssetSelections;
      codes = Array.from(stagedAssetCodesSet);

      // Construct commitment events and review resolutions
      const derivedResolutions: FundUpdateReviewResolution[] = [];
      const derivedCommitmentEvents: ParsedCommitmentEvent[] = [];

      for (const t of depResult.validatedTransactions) {
        if (!t.selected) continue;

        if (t.backingRef?.kind === 'commitment_event' && t.rawCommitmentEvent) {
          derivedCommitmentEvents.push({
            ...t.rawCommitmentEvent,
            submittedId: t.id,
          });
        } else if (t.backingRef?.kind === 'review_item') {
          if (t.isNonCashAdjustment && t.nonCashState) {
            derivedResolutions.push({
              submittedId: t.id,
              sourceRow: Number(t.sheetRow),
              resolutionType: 'non_cash_adjustment',
              investorName: t.nonCashState.investorName || t.fromKey.replace(/^investor:/, ''),
              fundName: t.rawReviewItem?.fund ?? '',
              date: t.date,
              amount: t.rawReviewItem?.amount ?? (typeof t.amount === 'number' ? t.amount : 0),
              currency: (t.currency || 'CNY') as 'CNY',
              direction: t.nonCashState.direction,
              subType: t.nonCashState.subType,
            });
          } else if (t.isTransfer) {
            if (t.isMultiPartyTransfer && t.allocations && t.allocations.length > 0) {
              derivedResolutions.push({
                submittedId: t.id,
                sourceRow: Number(t.sheetRow),
                resolutionType: 'split_transfer',
                transfereeName: t.toKey.replace(/^investor:/, ''),
                fundName: t.rawCommitmentEvent?.fund ?? t.rawReviewItem?.fund ?? '',
                date: t.date,
                totalAmount: t.rawCommitmentEvent?.amount ?? t.rawReviewItem?.amount ?? (typeof t.amount === 'number' ? t.amount : 0),
                currency: (t.currency || 'CNY') as 'CNY',
                allocations: t.allocations.map((a) => ({ transferorName: a.transferorName, amount: Number(a.amount) })),
              });
            } else if (t.singleTransferState) {
              derivedResolutions.push({
                submittedId: t.id,
                sourceRow: Number(t.sheetRow),
                resolutionType: 'single_transfer',
                transferorName: t.singleTransferState.transferorName,
                transfereeName: t.toKey.replace(/^investor:/, ''),
                fundName: t.rawCommitmentEvent?.fund ?? t.rawReviewItem?.fund ?? '',
                date: t.date,
                amount: t.rawCommitmentEvent?.amount ?? t.rawReviewItem?.amount ?? (typeof t.amount === 'number' ? t.amount : 0),
                currency: (t.currency || 'CNY') as 'CNY',
              });
            }
          }
        }
      }

      for (const t of approval.transactions) {
        const canonical = canonicalTxnById.get(t.id);
        const sel = selectedTransactions.find((st) => st.id === t.id);
        if (canonical && (!sel || !sel.selected)) {
          if (canonical.backingRef?.kind === 'asset_txn') {
            continue; // Bypassed shortcut: routed through applySelected for attribution/proceeds verification
          }
          preReviewDuplicateOutcomes.push({
            submittedId: t.id,
            family: canonical.backingRef?.kind === 'review_item'
              ? 'review_resolution'
              : canonical.backingRef?.kind === 'commitment_event'
                ? 'commitment_event'
                : 'transaction',
            disposition: 'duplicate',
            reason: 'Skipped: already recorded in ledger (pre-review duplicate without edits)',
            assetCode: canonical.backingRef && 'assetCode' in canonical.backingRef ? (canonical.backingRef as { assetCode?: string }).assetCode : undefined,
            persistedTable: 'fl_ledger_entries',
          });
        }
      }

      for (const v of approval.valuations) {
        const canonical = canonicalValById.get(v.id);
        const sel = selectedValuations.find((sv) => sv.id === v.id);
        if (canonical && (!sel || !sel.selected)) {
          preReviewDuplicateOutcomes.push({
            submittedId: v.id,
            family: 'valuation',
            disposition: 'duplicate',
            reason: 'Skipped: already recorded in ledger (pre-review duplicate without edits)',
            assetCode: canonical.backingRef && 'assetCode' in canonical.backingRef ? (canonical.backingRef as { assetCode?: string }).assetCode : undefined,
            persistedTable: 'fl_valuations',
          });
        }
      }

      // An empty two-step selection means "post none", never "fall back to all".
      // Falling back here caused deselected commitment rows to be persisted.
      reviewResolutions = derivedResolutions;
      commitmentEvents = derivedCommitmentEvents;
    }

    const reviewItems: ReviewProposalItem[] = !isV1
      ? [
          ...(legacyProposal?.review_items ?? []),
          ...commitmentEvents
            .filter((event) =>
              event.intent === 'transfer_in' &&
              (
                event.transferPairing?.status === 'missing_counterparty' ||
                event.transferPairing?.status === 'ambiguous' ||
                event.transferPairing?.requiresReview === true ||
                !event.transferPairing?.eligibleForTransferOut ||
                !event.transferPairing?.transferorName
              ),
            )
            .map((event) => {
              const validation = event.counterpartyName
                ? validateTransferCounterparty(event.counterpartyName)
                : null;
              const category = !event.counterpartyName?.trim()
                ? ('missing_counterparty' as const)
                : validation?.isMultiParty
                  ? ('multi_party_transfer' as const)
                  : ('truncated_transfer' as const);
              return {
                sourceRow: event.sourceRow,
                fund: event.fund,
                investorName: event.investorName,
                investorTypeRaw: event.investorTypeRaw,
                date: event.date,
                amount: event.amount,
                currency: 'CNY' as const,
                action: 'Commitment transfer',
                nature: event.natureRaw,
                direction: event.directionRaw,
                explanation: event.transferPairing?.reviewReason
                  ?? 'Transfer counterparty could not be verified and will not be posted automatically.',
                isPostable: false as const,
                requiresReview: true as const,
                category,
                counterpartyRaw: event.counterpartyName,
                targetRaw: event.investorName,
                entityRaw: event.investorName,
                transferPairing: event.transferPairing,
              };
            }),
        ]
      : [];

    const runInTransaction = async <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> => {
      if (this.db && typeof (this.db as any).transaction === 'function') {
        return (this.db as any).transaction(fn);
      }
      throw new Error('Database client does not support transactions');
    };

    return runInTransaction(async (tx: DbClient) => {
      const lockKey = `fund-update-approval:${this.workspaceId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const lockedFile = await this.fileRepo.findByIdForUpdate(fileId, tx);
      if (lockedFile.processing_status !== 'awaiting_review') {
        throw new FundUpdateValidationError('Only awaiting_review fund updates may be submitted.');
      }

      const applyOptions: FundUpdateApplyOptions = {
        isV1: Boolean(isV1),
        fileId,
        fundCatalogItems,
        ...(sourceRemaps !== undefined ? { sourceRemaps } : {}),
        ...(investorRemaps !== undefined ? { investorRemaps } : {}),
        ...(fundRemaps !== undefined ? { fundRemaps } : {}),
        ...(tx ? { executor: tx } : {}),
      };

      const applyResult = proposal?.fund_catalog
        ? await this.fundUpdateApplyService!.applySelected(
            assets,
            codes,
            selections,
            applyOptions,
            catalogSelections,
            proposal.fund_catalog,
          )
        : await this.fundUpdateApplyService!.applySelected(
            assets,
            codes,
            selections,
            applyOptions,
            catalogSelections,
          );

      let commitmentResult: FundUpdateCommitmentApplyResult | null = null;
      if (!isV1 && (commitmentEvents.length > 0 || (reviewResolutions && reviewResolutions.length > 0))) {
        commitmentResult = await this.fundUpdateApplyService!.applyCommitmentEvents(commitmentEvents, {
          source: proposal?.template_id,
          fundCatalog: proposal?.fund_catalog,
          fundCatalogItems,
          fileId,
          createdBy: enteredBy ?? null,
          catalogSelections,
          reviewResolutions,
          reviewItems,
          ...(tx ? { executor: tx } : {}),
        });
      }

      const combinedOutcomes: SubmittedRowOutcome[] = [
        ...(applyResult.outcomes ?? []),
        ...(commitmentResult?.outcomes ?? []),
        ...preReviewDuplicateOutcomes,
      ];

      function aggregateSubmittedOutcomes(list: SubmittedRowOutcome[]): SubmittedRowOutcome {
        if (list.length === 1) return list[0];
        const allChildren: SubmittedRowOutcome[] = list.flatMap((o) =>
          o.childOutcomes && o.childOutcomes.length > 0 ? o.childOutcomes : [o]
        );
        const postedAllocs = allChildren.filter((o) => o.disposition === 'posted');
        const dupAllocs = allChildren.filter((o) => o.disposition === 'duplicate');
        const rejAllocs = allChildren.filter((o) => o.disposition === 'rejected');
        const staleAllocs = allChildren.filter((o) => o.disposition === 'stale');

        let disposition: SubmittedRowDisposition;
        let reason: string | null = null;
        if (postedAllocs.length > 0 && (rejAllocs.length > 0 || staleAllocs.length > 0)) {
          disposition = 'partial';
          const parts: string[] = [];
          if (postedAllocs.length > 0) parts.push(`${postedAllocs.length} posted`);
          if (dupAllocs.length > 0) parts.push(`${dupAllocs.length} duplicate`);
          if (rejAllocs.length > 0) parts.push(`${rejAllocs.length} rejected`);
          if (staleAllocs.length > 0) parts.push(`${staleAllocs.length} stale`);
          const failReasons = allChildren
            .filter((o) => o.disposition !== 'posted' && o.reason)
            .map((o) => o.reason)
            .join('; ');
          reason = `Partial result (${parts.join(', ')})${failReasons ? `: ${failReasons}` : ''}`;
        } else if (postedAllocs.length > 0) {
          disposition = 'posted';
          reason = postedAllocs[0].reason ?? null;
        } else if (dupAllocs.length === allChildren.length && allChildren.length > 0) {
          disposition = 'duplicate';
          reason = allChildren.map((o) => o.reason).filter(Boolean).join('; ') || 'Duplicate rows already recorded';
        } else if (staleAllocs.length === allChildren.length && allChildren.length > 0) {
          disposition = 'stale';
          reason = allChildren.map((o) => o.reason).filter(Boolean).join('; ') || 'Stale/unsupported rows';
        } else {
          disposition = 'rejected';
          reason = allChildren.map((o) => o.reason).filter(Boolean).join('; ') || 'Rows rejected';
        }

        const firstPersistedId = postedAllocs[0]?.persistedId ?? null;
        const persistedTable = postedAllocs[0]?.persistedTable ?? null;
        const warnings = Array.from(
          new Set(
            allChildren
              .flatMap((o) => o.warnings ?? (o.disposition === 'rejected' && o.reason ? [o.reason] : []))
              .filter(Boolean)
          )
        );

        return {
          submittedId: list[0].submittedId,
          family: list[0].family,
          disposition,
          reason,
          assetCode: list[0].assetCode,
          targetId: list[0].targetId,
          persistedId: firstPersistedId,
          persistedTable,
          warnings: warnings.length > 0 ? warnings : undefined,
          childOutcomes: allChildren,
        };
      }

      let finalOutcomes: SubmittedRowOutcome[] = combinedOutcomes;
      if (input.two_step_approval) {
        const outcomesBySubmittedId = new Map<string, SubmittedRowOutcome[]>();
        for (const o of combinedOutcomes) {
          const existingList = outcomesBySubmittedId.get(o.submittedId) ?? [];
          existingList.push(o);
          outcomesBySubmittedId.set(o.submittedId, existingList);
        }
        const aggregatedBySubmittedId = new Map<string, SubmittedRowOutcome>();
        for (const [id, list] of outcomesBySubmittedId.entries()) {
          aggregatedBySubmittedId.set(id, aggregateSubmittedOutcomes(list));
        }

        const orderedOutcomes: SubmittedRowOutcome[] = [];
        for (const t of input.two_step_approval.transactions) {
          const o = aggregatedBySubmittedId.get(t.id);
          if (o) {
            orderedOutcomes.push(o);
          } else {
            throw new Error(
              `Invariant violation: incomplete result - no outcome recorded for submitted transaction "${t.id}"`,
            );
          }
        }
        for (const v of input.two_step_approval.valuations) {
          const o = aggregatedBySubmittedId.get(v.id);
          if (o) {
            orderedOutcomes.push(o);
          } else {
            throw new Error(
              `Invariant violation: incomplete result - no outcome recorded for submitted valuation "${v.id}"`,
            );
          }
        }
        for (const [id, o] of aggregatedBySubmittedId.entries()) {
          if (!orderedOutcomes.some((x) => x.submittedId === id)) {
            orderedOutcomes.push(o);
          }
        }
        finalOutcomes = orderedOutcomes;
      }

      const mergedFundUpdateResult: FundUpdateApplyResult = {
        ...applyResult,
        ...(input.two_step_approval
          ? {
              selected_txns_count: input.two_step_approval.transactions.length,
              selected_valuations_count: input.two_step_approval.valuations.length,
            }
          : {}),
        ...(commitmentResult
          ? {
              commitment_events_inserted: commitmentResult.events_inserted,
              commitment_events_skipped_duplicate: commitmentResult.events_skipped_duplicate,
              commitment_events_skipped: commitmentResult.events_skipped,
              ...(commitmentResult.review_items_applied !== undefined ? { review_items_applied: commitmentResult.review_items_applied } : {}),
              ...(commitmentResult.review_items_skipped_unresolved !== undefined ? { review_items_skipped_unresolved: commitmentResult.review_items_skipped_unresolved } : {}),
              commitment_event_warnings: commitmentResult.warnings,
            }
          : {}),
        ...(finalOutcomes.length > 0 || input.two_step_approval ? { outcomes: finalOutcomes } : {}),
      };

      await this.fileRepo.updatePartial(
        fileId,
        {
          file_type: 'fund_updates',
          processing_status: 'completed',
        },
        tx,
      );

      const updated = await this.fileRepo.findById(fileId, tx);
      return { file: updated, company_id: null, fund_update: mergedFundUpdateResult };
    });
  }

  /**
   * Fund-update HITL is only needed when at least one proposed asset is new
   * or has missing ledger rows. If everything already matches the DB, complete
   * the file so the table shows the eye (parsed notes) without a Review pen.
   */
  private async fundUpdateProposalNeedsReview(
    structuredResult: IngestStructuredResult | null,
  ): Promise<boolean> {
    if (!structuredResult || !this.fundUpdateApplyService) return false;
    const proposal = (structuredResult as FundUpdateStructuredResult).fund_update_proposal;
    if (!proposal) return false;

    if ('schema_version' in proposal && proposal.schema_version === 'workbook_fallback_v1') {
      const v1 = proposal as unknown as import('@/lib/fund_updates/types').WorkbookFallbackProposalV1;
      if (v1.events.length > 0 || v1.entities.length > 0) return true;
      if (v1.assets && v1.assets.length > 0) {
        const reviews = await this.fundUpdateApplyService.buildReview(v1.assets);
        return reviews.some((a) => a.status === 'new' || a.status === 'add_missing');
      }
      return false;
    }

    const legacy = proposal as LegacyAssetProposal;
    if (legacy.review_items && legacy.review_items.length > 0) return true;
    if (legacy.commitment_events && legacy.commitment_events.length > 0) return true;

    const assets = (proposal?.assets ?? []) as ParsedAsset[];
    if (assets.length === 0) return false;
    const reviews = await this.fundUpdateApplyService.buildReview(assets);
    return reviews.some((a) => a.status === 'new' || a.status === 'add_missing');
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

  private buildCompanyCreateInput(
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
      // Explicit banker source (email pipeline) wins; fall back to the
      // banker the agent extracted from the document itself.
      banker_source: bankerSource ?? cleanText(summary?.banker) ?? null,
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

  /**
   * Extract the deal-target entries from the agent output. Prefers the
   * multi-company `companies` array; falls back to the legacy single
   * `prospectus_summary` for records produced before multi-company support.
   */
  private parseExtractedCompanies(
    parsedNotes: Record<string, unknown> | null | undefined,
  ): ProspectusSummary[] {
    const companies = (parsedNotes as { companies?: unknown } | null | undefined)?.companies;
    if (Array.isArray(companies)) {
      const entries = companies.filter(
        (e): e is ProspectusSummary => !!e && typeof e === 'object',
      );
      if (entries.length > 0) return entries;
    }
    const summary = (parsedNotes as { prospectus_summary?: unknown } | null | undefined)
      ?.prospectus_summary;
    return summary && typeof summary === 'object' ? [summary as ProspectusSummary] : [];
  }

  /**
   * Auto-ingest one company per extracted deal target. For each entry:
   * resolve an identity name, then
   *   - no existing company (fuzzy name match) → auto-create an `unreviewed`
   *     pipeline company from the entry's fields;
   *   - existing company OUTSIDE the active pipeline (unreviewed /
   *     market_screening / discovered) → auto-accept the extracted changes:
   *     fill empty fields and add missing financial years (the same defaults
   *     the HITL review dialog pre-checks), no human review;
   *   - existing company IN the L0–L5 pipeline → never auto-modify; the
   *     entry is flagged so the caller queues the file for HITL review.
   * Creation runs under a per-name advisory lock so concurrent uploads of
   * the same target can't double-insert.
   *
   * Returns the matched_companies payload (one entry per created OR matched
   * existing company, review-flagged matches first so the review dialog
   * proposes them), the newly created and auto-enriched companies so the
   * caller can dispatch analysis/screening jobs, and whether any match
   * requires HITL review.
   */
  private async createCompaniesFromExtraction(opts: {
    companies: ProspectusSummary[];
    matchedCompanies: unknown[];
    parsedNotes?: Record<string, unknown>;
    effectiveFileType: string;
    companySource: 'inbound' | 'outbound';
    bankerSource?: string;
    enteredByEmail?: string;
    uploaderUserId?: string | null;
    /** True when the file arrived via the email pipeline (drives assignment emails). */
    originEmail?: boolean;
    fileId: string;
  }): Promise<{
    matchedCompanies: unknown[];
    createdCompanies: Tables<'companies'>[];
    enrichedCompanies: Tables<'companies'>[];
    needsReview: boolean;
  }> {
    // Resolve entered_by once, outside the per-company lock: the custodian
    // email (MBOX pipeline) wins, else the authenticated uploader.
    let resolvedEnteredBy: string | null = null;
    let custodianUser: Tables<'users'> | null = null;
    if (opts.enteredByEmail && this.userRepo) {
      custodianUser = await this.userRepo.findByEmail(opts.enteredByEmail);
      resolvedEnteredBy = custodianUser?.id ?? null;
    }
    if (!resolvedEnteredBy && opts.uploaderUserId) {
      resolvedEnteredBy = opts.uploaderUserId;
    }

    const payloads: unknown[] = [];
    const reviewPayloads: unknown[] = [];
    const createdCompanies: Tables<'companies'>[] = [];
    const enrichedCompanies: Tables<'companies'>[] = [];

    for (const entry of opts.companies) {
      const identityName = this.companyIdentityName(entry);
      if (!identityName) {
        console.warn(
          `[fileService] Skipping company auto-create for file ${opts.fileId}: no company/project name extracted`,
        );
        continue;
      }

      const result = await this.withCompanyNameLock(identityName, async (companyService) => {
        // Dedup gate: an existing company with this name is never re-created.
        //  1) Fast SQL substring match (suffix-stripped) — catches "Acme Ltd"
        //     vs "Acme Co." style variations.
        //  2) Levenshtein fallback — catches spelling variants, typos, and OCR
        //     noise that substring matching misses (e.g. "Acme Corp" vs "Acme
        //     Crop") so the same target isn't ingested twice.
        const existing =
          (await companyService.findByNameFuzzy(identityName)) ??
          (await companyService.findBestFuzzyMatch(identityName));
        if (existing) {
          console.log(
            `[fileService] file ${opts.fileId}: "${identityName}" matches existing company ${existing.id}, skipping create`,
          );
          return { company: existing, created: false };
        }

        const created = await companyService.createFromDTO({
          pipeline_stage: 'unreviewed',
          status: 'active',
          entered_by: resolvedEnteredBy,
          matched_track_ids: this.extractSuggestedTrackIds(opts.parsedNotes),
          ...this.buildCompanyCreateInput(
            entry,
            opts.effectiveFileType,
            opts.companySource,
            opts.bankerSource,
          ),
        }, `auto_created_from_file:${opts.fileId}`);
        return { company: created, created: true };
      });

      if (result.created) {
        payloads.push(this.companyMatchPayload(result.company));
        // Re-fetch outside the (now committed) lock transaction so screening
        // sees the full row incl. matched_track_ids.
        createdCompanies.push(await this.companyService.findById(result.company.id));
        continue;
      }

      const existing = result.company as Tables<'companies'>;
      if (IN_PIPELINE_STAGES.has(existing.pipeline_stage ?? '')) {
        // Company is actively worked in the L0–L5 pipeline — extracted
        // changes need explicit human approval via the review dialog.
        reviewPayloads.push(this.companyMatchPayload(existing));
        continue;
      }

      // Pre-pipeline company: auto-accept the extracted changes.
      try {
        const enriched = await this.autoEnrichExistingCompany(existing, entry, opts.fileId);
        if (enriched) enrichedCompanies.push(enriched);
      } catch (err) {
        console.error(
          `[fileService] file ${opts.fileId}: failed to auto-enrich company ${existing.id}:`,
          err,
        );
      }
      payloads.push(this.companyMatchPayload(existing));
    }

    // Email-pipeline uploads only: tell the custodian (the email recipient we
    // stamped as entered_by) about each company assigned to them so they can
    // verify the data or reroute it. Manual UI uploads never notify — the
    // uploader entered the file themselves.
    if (opts.originEmail && custodianUser?.email) {
      await this.notifyCompaniesAssigned(
        { name: custodianUser.name, email: custodianUser.email },
        createdCompanies,
        opts.bankerSource,
      );
    }

    const allPayloads = [...reviewPayloads, ...payloads];
    return {
      // If nothing was created or matched (e.g. every entry lacked an
      // identity name), keep the agent-provided matches untouched.
      matchedCompanies: allPayloads.length > 0 ? allPayloads : opts.matchedCompanies,
      createdCompanies,
      enrichedCompanies,
      needsReview: reviewPayloads.length > 0,
    };
  }

  /**
   * Enqueue one `company_assigned` email per auto-created company. Best-effort:
   * a queue failure is logged and never blocks file processing or company
   * creation.
   */
  private async notifyCompaniesAssigned(
    recipient: { name: string; email: string },
    companies: Tables<'companies'>[],
    bankerSource?: string,
  ): Promise<void> {
    const appUrl = resolveAppUrl();

    for (const company of companies) {
      const companyName = company.target ?? company.project_name;
      if (!companyName) continue;
      try {
        await this.enqueueEmail({
          kind: 'company_assigned',
          to: recipient.email,
          recipientName: recipient.name,
          companyName,
          bankerSource,
          companyUrl: `${appUrl}/pipeline/${company.id}`,
        });
      } catch (err) {
        console.error(
          `[fileService] Failed to enqueue company_assigned email for company ${company.id}:`,
          err,
        );
      }
    }
  }

  /** Company columns the auto-accept path may fill from an extracted entry.
   *  Mirrors the review dialog's enrichable set; identity fields (target,
   *  project_name) are excluded — a fuzzy name match must never rename. */
  private static readonly AUTO_ENRICH_FIELDS = [
    'segment',
    'segment_related_offerings',
    'company_focus',
    'website',
    'watchlist_status',
    'comments',
    'ownership',
    'geography',
    'remarks',
  ] as const;

  /**
   * Auto-accept the extracted changes for a PRE-pipeline company (not in
   * L0–L5): fill fields that are currently empty and upsert financial/FX
   * rows for fiscal years the company doesn't have yet — exactly the
   * selections the HITL review dialog pre-checks by default. Existing values
   * and existing years are never overwritten. Returns the refreshed company
   * when anything was applied, null when the entry added nothing new.
   */
  private async autoEnrichExistingCompany(
    company: Tables<'companies'>,
    entry: ProspectusSummary,
    fileId: string,
  ): Promise<Tables<'companies'> | null> {
    const updates: Partial<Record<(typeof FileService.AUTO_ENRICH_FIELDS)[number], string>> = {};
    for (const field of FileService.AUTO_ENRICH_FIELDS) {
      const current = company[field];
      if (typeof current === 'string' && current.trim().length > 0) continue;
      const proposed = entry[field];
      if (typeof proposed === 'string' && proposed.trim().length > 0) {
        updates[field] = proposed.trim();
      }
    }
    if (Object.keys(updates).length > 0) {
      await this.companyService.updateFromDTO(
        company.id,
        updates as CompanyDTOInput,
        `auto_enriched_from_file:${fileId}`,
      );
    }

    const existingYears = new Set(
      (await this.companyFinancialRepo.findByCompany(company.id)).map((r) => r.fiscal_year),
    );
    const financialRows = (entry.financials ?? []).filter(
      (r) =>
        !existingYears.has(r.fiscal_year) &&
        (r.revenue_usd_mn !== null ||
          r.ebitda_usd_mn !== null ||
          r.ev_usd_mn !== null ||
          r.ebitda_margin !== null ||
          r.ev_ebitda !== null ||
          r.revenue_cagr_vs_prior !== null),
    );
    if (financialRows.length > 0) {
      await this.companyFinancialRepo.bulkUpsertForCompany(company.id, financialRows);
    }
    const fxRows = (entry.fx_adjustments ?? []).filter((r) => !existingYears.has(r.fiscal_year));
    if (fxRows.length > 0) {
      await this.companyFxAdjustmentRepo.bulkUpsertForCompany(company.id, fxRows);
    }

    const appliedAnything =
      Object.keys(updates).length > 0 || financialRows.length > 0 || fxRows.length > 0;
    if (!appliedAnything) return null;
    console.log(
      `[fileService] file ${fileId}: auto-enriched pre-pipeline company ${company.id} ` +
        `(${Object.keys(updates).length} field(s), ${financialRows.length} financial year(s))`,
    );
    return this.companyService.findById(company.id);
  }

  /**
   * Pick the extracted entry that corresponds to `company` by name (multi-
   * company files extract several targets); falls back to the first entry,
   * which for legacy single-company output is the prospectus_summary itself.
   */
  private pickEntryForCompany(
    entries: ProspectusSummary[],
    company: Pick<Tables<'companies'>, 'target' | 'project_name'> | null,
  ): ProspectusSummary | undefined {
    if (!company) return entries[0];
    const norm = (s: string | null | undefined) => s?.trim().toLowerCase() ?? '';
    const names = new Set(
      [norm(company.target), norm(company.project_name)].filter((n) => n.length > 0),
    );
    return (
      entries.find((e) => names.has(norm(e.company_name)) || names.has(norm(e.project_name))) ??
      entries[0]
    );
  }

  private extractSuggestedTrackIds(parsedNotes: Record<string, unknown> | null | undefined): string[] {
    const ids = (parsedNotes as { suggested_track_ids?: unknown })?.suggested_track_ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  }

  private companyIdentityName(summary: ProspectusSummary | undefined): string | null {
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

  private async withCompanyNameLock<T>(
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
      this.workspaceId,
      new CompanyRepository(db, this.workspaceId, companyGraphRepo),
      new CompanyLogRepository(db, this.workspaceId),
      new DealDocumentRepository(db, this.workspaceId),
      new DealNoteRepository(db, this.workspaceId),
      new DealLinkRepository(db, this.workspaceId),
      new CompanyFinancialRepository(db, this.workspaceId),
      new CompanyFxAdjustmentRepository(db, this.workspaceId),
      new CompanyScreeningDerivedRepository(db, this.workspaceId),
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
    // Substring match first, then Levenshtein so a typo'd/variant name still
    // merges financials into the existing company rather than silently dropping.
    if (!companyId && opts.financialStatementSummary?.company_name) {
      const name = opts.financialStatementSummary.company_name;
      const found =
        (await this.companyService.findByNameFuzzy(name)) ??
        (await this.companyService.findBestFuzzyMatch(name));
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

  /**
   * Front-table rematch: append an existing pipeline company to the file's
   * `matched_companies` array. Idempotent when the company is already linked.
   * Does not change processing_status (works for awaiting_review and completed).
   */
  async addMatchedCompany(fileId: string, companyId: string): Promise<Tables<'files'>> {
    const file = await this.fileRepo.findById(fileId);
    const company = await this.companyService.findById(companyId);
    if (!company) throw new Error(`Company ${companyId} not found`);

    const current = this.normalizeMatchedCompanies(file.matched_companies);
    if (current.some((m) => m.id === companyId)) {
      return file;
    }

    const displayName = company.target?.trim() || company.project_name?.trim() || 'Unnamed';
    current.unshift({
      id: company.id,
      target: company.target ?? undefined,
      name: displayName,
      type: 'company',
      similarity: 1,
    });

    return this.fileRepo.update(fileId, {
      matched_companies: current as Tables<'files'>['matched_companies'],
    });
  }

  /**
   * Front-table rematch: remove a linked company (by id) or an unmatched AI
   * suggestion chip (null/missing id + display name).
   */
  async removeMatchedCompanyEntry(
    fileId: string,
    opts: { companyId?: string; unmatchedName?: string },
  ): Promise<Tables<'files'>> {
    if (!opts.companyId && !opts.unmatchedName) {
      throw new Error('companyId or unmatchedName is required');
    }

    const file = await this.fileRepo.findById(fileId);
    const current = this.normalizeMatchedCompanies(file.matched_companies);
    const unmatchedNeedle = opts.unmatchedName?.trim().toLowerCase();
    const next = current.filter((m) => {
      if (opts.companyId) return m.id !== opts.companyId;
      const hasId = typeof m.id === 'string' && m.id.length > 0;
      if (hasId) return true;
      // Match MatchedCompaniesCell.chipLabel: name?.trim() || target?.trim() || Unnamed
      const name = (
        String(m.name ?? '').trim() ||
        String(m.target ?? '').trim() ||
        'Unnamed'
      ).toLowerCase();
      return name !== unmatchedNeedle;
    });

    return this.fileRepo.update(fileId, {
      matched_companies: next as Tables<'files'>['matched_companies'],
    });
  }

  private normalizeMatchedCompanies(
    raw: Tables<'files'>['matched_companies'],
  ): Array<{
    id?: string | null;
    name?: string;
    target?: string;
    type?: string;
    similarity?: number;
    [key: string]: unknown;
  }> {
    if (!Array.isArray(raw)) return [];
    return raw.filter((m) => !!m && typeof m === 'object') as Array<{
      id?: string | null;
      name?: string;
      target?: string;
      type?: string;
      similarity?: number;
      [key: string]: unknown;
    }>;
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
