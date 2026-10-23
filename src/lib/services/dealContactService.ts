import type {
  CompanyRepository,
  CorrespondentRepository,
  DealContactRecord,
  DealContactRepository,
  FileSourceLinkScope,
  InsertedFileSourceLink,
  PipelineStageRepository,
  PipelineStageRow,
} from '@/lib/repositories';
import {
  DEAL_CONTACT_ROLES,
  type DealContactOrigin,
  type DealContactRole,
  type DealContactStatus,
} from '@/lib/db/schema';
import { decodeHtmlEntities } from '@/lib/crm/displayText';
import { INTERNAL_MAIL_DOMAINS } from '@/lib/crm/mailDomains';
import { isInPipelineStage, stageLabel } from '@/lib/pipeline/stages';
import { PENDING_CONFIRMATION_KEY, PENDING_CONFIRMATION_LABEL } from '@/lib/pipeline/stageMoves';
import { isUuid } from '@/lib/uuid';
import { ContactNotFoundError } from './crmContactEnrichmentService';
import { toDef } from './pipelineStageService';

export type { DealContactRole, DealContactOrigin, DealContactStatus };

/** A deal a contact is linked to (active links only). */
export interface ContactDealLink {
  companyId: string;
  companyName: string;
  role: DealContactRole;
  origin: DealContactOrigin;
  /** `companies.pipeline_stage` key. */
  stage: string;
  /** How the stage reads in this workspace: "L3 · Due Diligence", "Pending Confirmation". */
  stageLabel: string;
  isDropped: boolean;
  linkedAt: string;
  /** `companies.geography` / `companies.segment`, decoded; null when blank. */
  geography: string | null;
  segment: string | null;
  /** When the deal entered Brain (`companies.created_at`). */
  openedAt: string | null;
}

/** A deal the contact's emails point at, waiting for Confirm / Dismiss. */
export interface ContactDealSuggestion {
  companyId: string;
  companyName: string;
  stage: string;
  stageLabel: string;
  isDropped: boolean;
  /** Distinct evidence emails the contact took part in. */
  evidenceCount: number;
  lastSeenAt: string | null;
}

export interface ContactDeals {
  deals: ContactDealLink[];
  suggestions: ContactDealSuggestion[];
}

/** The stored state of one link after a write. */
export interface DealContactLinkState {
  companyId: string;
  correspondentId: string;
  role: DealContactRole;
  origin: DealContactOrigin;
  status: DealContactStatus;
}

export class DealCompanyNotFoundError extends Error {
  constructor(companyId: string) {
    super(`Company ${companyId} not found in this workspace`);
    this.name = 'DealCompanyNotFoundError';
  }
}

export class DealContactLinkNotFoundError extends Error {
  constructor(correspondentId: string, companyId: string) {
    super(`Contact ${correspondentId} is not linked to company ${companyId}`);
    this.name = 'DealContactLinkNotFoundError';
  }
}

export class InvalidDealContactRoleError extends Error {
  constructor(role: unknown) {
    super(`Invalid deal contact role: ${String(role)} (expected ${DEAL_CONTACT_ROLES.join(' or ')})`);
    this.name = 'InvalidDealContactRoleError';
  }
}

function isDealContactRole(value: unknown): value is DealContactRole {
  return typeof value === 'string' && (DEAL_CONTACT_ROLES as readonly string[]).includes(value);
}

/** Upper bound on links one reconcile pass writes. */
export const SMART_FILE_LINK_RECONCILE_LIMIT = 500;

/** Names of the pre-pipeline buckets, which have no `pipeline_stages` row. */
const PRE_PIPELINE_STAGE_LABELS: Record<string, string> = {
  [PENDING_CONFIRMATION_KEY]: PENDING_CONFIRMATION_LABEL,
  market_screening: 'Market Screening',
  discovered: 'Discovered',
};

/** Postgres timestamp text ("2026-10-17 10:46:59.43+00") → ISO; unparseable stays as is. */
function isoOf(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function textOrNull(value: string | null): string | null {
  const t = value ? decodeHtmlEntities(value).trim() : '';
  return t || null;
}

/**
 * Stage key → how it reads in this workspace: "L3 · Due Diligence" for a
 * pipeline stage (deleted ones too), "Pending Confirmation" for a
 * pre-pipeline bucket, the raw key otherwise.
 */
export function dealStageLabeler(rows: readonly PipelineStageRow[]): (stage: string) => string {
  const stages = rows.map(toDef);
  return (stage) => {
    if (!isInPipelineStage(stage)) return PRE_PIPELINE_STAGE_LABELS[stage] ?? stage;
    return stageLabel(stages, stage);
  };
}

function toState(row: DealContactRecord): DealContactLinkState {
  return {
    companyId: row.company_id,
    correspondentId: row.correspondent_id,
    role: row.role,
    origin: row.origin,
    status: row.status,
  };
}

/**
 * Deal ↔ banker links (MB-856): which Brain deals a CRM contact (one person)
 * brought (`source`) or was involved in (`involved`).
 *
 * - Automatic: an email attachment that auto-created a deal in Smart Files
 *   links its external sender as `source`; one that only matched an existing
 *   deal links them as `involved` ({@link linkFromSmartFile},
 *   {@link reconcileSmartFileLinks}). Automatic writes never touch an
 *   existing row.
 * - Suggested: related-company email evidence, computed on read, needing
 *   Confirm / Dismiss.
 * - Manual add / remove always wins; a removed or dismissed link stays
 *   dismissed (the row is kept), so nothing automatic re-adds it.
 */
export class DealContactService {
  constructor(
    private readonly dealContactRepo: DealContactRepository,
    private readonly correspondentRepo: CorrespondentRepository,
    private readonly companyRepo: CompanyRepository,
    private readonly stageRepo: PipelineStageRepository,
    private readonly workspaceId: string,
  ) {}

  /**
   * The contact's active deal links and open suggestions. Resolves the
   * contact's pending Smart Files links first (a file processed before the
   * contact existed), best-effort. Throws {@link ContactNotFoundError} when
   * the contact is not visible in this workspace.
   */
  async listContactDeals(correspondentId: string): Promise<ContactDeals> {
    await this.requireContact(correspondentId);
    return this.listDealsOfVisibleContact(correspondentId);
  }

  /**
   * {@link listContactDeals} for a contact the caller has already found in
   * this workspace (skips the visibility read).
   */
  async listDealsOfVisibleContact(correspondentId: string): Promise<ContactDeals> {
    try {
      await this.reconcileSmartFileLinks({ correspondentIds: [correspondentId] });
    } catch (err) {
      console.error('[dealContactService] smart-file link reconcile failed:', err);
    }

    const [links, suggestions, labelOf] = await Promise.all([
      this.dealContactRepo.listForContacts(this.workspaceId, [correspondentId]),
      this.dealContactRepo.listSuggestions(this.workspaceId, [correspondentId]),
      this.stageLabeler(),
    ]);

    const deals = links
      .filter((l) => l.status === 'active')
      .map<ContactDealLink>((l) => ({
        companyId: l.companyId,
        companyName: decodeHtmlEntities(l.companyName),
        role: l.role,
        origin: l.origin,
        stage: l.pipelineStage,
        stageLabel: labelOf(l.pipelineStage),
        isDropped: l.companyStatus === 'dropped',
        linkedAt: isoOf(l.createdAt),
        geography: textOrNull(l.geography),
        segment: textOrNull(l.segment),
        openedAt: l.companyCreatedAt ? isoOf(l.companyCreatedAt) : null,
      }))
      .sort(
        (a, b) =>
          (a.role === b.role ? 0 : a.role === 'source' ? -1 : 1) ||
          a.companyName.localeCompare(b.companyName),
      );

    return {
      deals,
      suggestions: suggestions.map((s) => ({
        companyId: s.companyId,
        companyName: decodeHtmlEntities(s.companyName),
        stage: s.pipelineStage,
        stageLabel: labelOf(s.pipelineStage),
        isDropped: s.companyStatus === 'dropped',
        evidenceCount: s.evidenceCount,
        lastSeenAt: s.lastSeenAt,
      })),
    };
  }

  /**
   * Manually link a contact to a deal. Overwrites whatever is there — an
   * automatic link's role, or a dismissed row (manual wins).
   */
  async addLink(
    correspondentId: string,
    companyId: string,
    role: unknown,
    userId: string | null,
  ): Promise<DealContactLinkState> {
    if (!isDealContactRole(role)) throw new InvalidDealContactRoleError(role);
    await Promise.all([this.requireContact(correspondentId), this.requireCompany(companyId)]);
    const row = await this.dealContactRepo.upsertLink({
      workspaceId: this.workspaceId,
      companyId,
      correspondentId,
      role,
      origin: 'manual',
      status: 'active',
      createdBy: userId,
    });
    return toState(row);
  }

  /** Remove a link. The row is kept as `dismissed` so it is never re-added automatically. */
  async removeLink(correspondentId: string, companyId: string): Promise<DealContactLinkState> {
    await this.requireContact(correspondentId);
    if (!isUuid(companyId)) throw new DealContactLinkNotFoundError(correspondentId, companyId);
    const row = await this.dealContactRepo.setStatus(
      this.workspaceId,
      companyId,
      correspondentId,
      'dismissed',
    );
    if (!row) throw new DealContactLinkNotFoundError(correspondentId, companyId);
    return toState(row);
  }

  /**
   * Accept a suggestion as an active `involved` link. A pair that is already
   * actively linked is left as it is (never downgrades a `source`); a
   * dismissed pair is reactivated, since this is a manual action.
   */
  async confirmSuggestion(
    correspondentId: string,
    companyId: string,
    userId: string | null,
  ): Promise<DealContactLinkState> {
    await Promise.all([this.requireContact(correspondentId), this.requireCompany(companyId)]);
    const existing = await this.dealContactRepo.findLink(this.workspaceId, companyId, correspondentId);
    if (existing?.status === 'active') return toState(existing);
    const row = await this.dealContactRepo.upsertLink({
      workspaceId: this.workspaceId,
      companyId,
      correspondentId,
      role: 'involved',
      origin: 'confirmed_suggestion',
      status: 'active',
      createdBy: userId,
    });
    return toState(row);
  }

  /**
   * Hide a suggestion for good: writes a `dismissed` row for the pair (origin
   * `manual` — a human decided), or dismisses the existing row.
   */
  async dismissSuggestion(
    correspondentId: string,
    companyId: string,
  ): Promise<DealContactLinkState> {
    await Promise.all([this.requireContact(correspondentId), this.requireCompany(companyId)]);
    const existing = await this.dealContactRepo.setStatus(
      this.workspaceId,
      companyId,
      correspondentId,
      'dismissed',
    );
    if (existing) return toState(existing);
    const row = await this.dealContactRepo.upsertLink({
      workspaceId: this.workspaceId,
      companyId,
      correspondentId,
      role: 'involved',
      origin: 'manual',
      status: 'dismissed',
    });
    return toState(row);
  }

  /**
   * Automatic source link for one Smart Files file, once its companies are
   * created / matched: the file's external email sender becomes `source` of
   * each company the file auto-created and `involved` in each existing
   * company it matched. Internal senders (our domains, app users) are
   * skipped; existing links of any status are never touched; idempotent.
   * A sender with no contact in the workspace yet writes nothing here — the
   * link is resolved later by {@link reconcileSmartFileLinks}.
   */
  async linkFromSmartFile(fileId: string): Promise<InsertedFileSourceLink[]> {
    return this.insertFileSourceLinks({ fileIds: [fileId] });
  }

  /**
   * Resolve every Smart Files source link that is still missing — typically
   * a file processed before its sender became a CRM contact. Bulk and
   * set-based: one statement for all files, narrowed to `correspondentIds`
   * when given (call it with a page's contacts before reading their links in
   * bulk). Same rules as {@link linkFromSmartFile}.
   */
  async reconcileSmartFileLinks(
    opts: { correspondentIds?: string[] } = {},
  ): Promise<InsertedFileSourceLink[]> {
    const ids = opts.correspondentIds ? [...new Set(opts.correspondentIds)] : undefined;
    if (ids && ids.length === 0) return [];
    return this.insertFileSourceLinks(ids ? { correspondentIds: ids } : {});
  }

  /** Smart Files source links in `scope`, never from our own domains, at most one pass's worth. */
  private insertFileSourceLinks(
    scope: Pick<FileSourceLinkScope, 'fileIds' | 'correspondentIds'>,
  ): Promise<InsertedFileSourceLink[]> {
    return this.dealContactRepo.insertFileSourceLinks(this.workspaceId, {
      ...scope,
      excludedSenderDomains: [...INTERNAL_MAIL_DOMAINS],
      limit: SMART_FILE_LINK_RECONCILE_LIMIT,
    });
  }

  private async requireContact(correspondentId: string): Promise<void> {
    if (!isUuid(correspondentId)) throw new ContactNotFoundError(correspondentId);
    const contact = await this.correspondentRepo.findById(correspondentId, this.workspaceId);
    if (!contact) throw new ContactNotFoundError(correspondentId);
  }

  private async requireCompany(companyId: string): Promise<void> {
    if (!isUuid(companyId)) throw new DealCompanyNotFoundError(companyId);
    const company = await this.companyRepo.findByIdOrNull(companyId);
    if (!company) throw new DealCompanyNotFoundError(companyId);
  }

  /** Stage key → how it reads in this workspace; one stage-list read. */
  private async stageLabeler(): Promise<(stage: string) => string> {
    return dealStageLabeler(await this.stageRepo.list());
  }
}
