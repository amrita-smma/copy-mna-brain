import type { DbClient } from '@/lib/repositories/types';
import type {
  InsightRepository,
  Insight,
  InsightListFilter,
} from '@/lib/repositories/insightRepository';
import type {
  InsightVersionRepository,
  InsightVersion,
} from '@/lib/repositories/insightVersionRepository';
import type {
  InsightRunDraftRepository,
  InsightRunDraft,
} from '@/lib/repositories/insightRunDraftRepository';
import type {
  InsightChatContext,
  InsightHead,
  InsightDetail,
  InsightKind,
  InsightListPage,
  InsightRefreshStatus,
  InsightRunVersionLink,
  InsightSummary,
  InsightVersionSummary,
} from '@/lib/insights/types';
import { MAX_INSIGHT_BYTES } from '@/lib/insights/srcdoc';
import { INSIGHT_LIST_DEFAULT_LIMIT } from '@/lib/insights/listQuery';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/toolValidation';
import { duplicateInsightName } from '@/lib/insights/duplicateName';
import { replaceInsightSection } from '@/lib/insights/sectionEdit';
import { rejectInvalidInsightDocument } from '@/lib/insights/documentGuard';
import { checkInsightStructure } from '@/lib/insights/structuralCheck';
import {
  buildInsightChatOutline,
  INSIGHT_CHAT_OUTLINE_MAX_CHARS,
} from '@/lib/insights/chatOutline';
import { createLruCache } from '@/lib/insights/lruCache';
import {
  insightContentHash,
  sameInsightContent,
} from '@/lib/insights/contentHash';
import type { InsightAgentStamp } from '@/lib/insights/agentStamp';
import {
  findInsightMarkerProblems,
  hasInsightMarkerProblems,
  insightMarkerCorrection,
} from '@/lib/agents/sector/evidenceMarkers';
// The LangChain-free registry only: InsightService runs inside the workforce
// body, where the agent stack (sector/graph, <agent>/tools) must not load.
import {
  getSectorAgent,
  type SectorRegistry,
} from '@/lib/agents/sector/registry';
import type { RoutinesRepository } from '@/lib/repositories/routinesRepository';
import type { InsightTemplateRepository } from '@/lib/repositories/insightTemplateRepository';
import { isUuid } from '@/lib/uuid';
import { computeNextFireAt, type ScheduleKind } from '@/lib/routines/schedule';
import { isRoutinePausedReason } from '@/lib/routines/pauseReason';

/**
 * The routine reads/writes the service needs: setAgentBinding's resume of a
 * paused refresh (MB-560), and the list's batched refresh status.
 */
export type InsightRoutineResumer = Pick<
  RoutinesRepository,
  'findActiveByInsightId' | 'findActiveByInsightIds' | 'resumeFromAgentPause'
>;

/** The template read that records and names an insight's source template. */
export type InsightSourceTemplateLookup = Pick<InsightTemplateRepository, 'findLiveRefById'>;

// ─── Typed Errors ─────────────────────────────────────────────────────────────

export class InsightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsightError';
  }
}

export class InsightNotFoundError extends InsightError {
  /** `versionNo` names a missing version of an existing insight. */
  constructor(id: string, versionNo?: number) {
    super(
      versionNo === undefined
        ? `Insight "${id}" not found`
        : `Version ${versionNo} for insight "${id}" not found`,
    );
    this.name = 'InsightNotFoundError';
  }
}

export class InsightValidationError extends InsightError {
  constructor(message: string) {
    super(message);
    this.name = 'InsightValidationError';
  }
}

/**
 * A version whose markers are malformed: a source reference that resolves to
 * no Sources entry, a malformed Sources entry or unavailable cell (any writer,
 * MB-551/556), or a @dikti evidence marker (MB-543). A validation error, so
 * routes answer 400 and the tools' "Rejection:" path hands the message back
 * to the agent.
 */
export class InsightEvidenceMarkerError extends InsightValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InsightEvidenceMarkerError';
  }
}

export class InsightPayloadTooLargeError extends InsightError {
  constructor(message: string) {
    super(message);
    this.name = 'InsightPayloadTooLargeError';
  }
}

/**
 * Raised when a change prepared against version N is submitted after the
 * insight has moved past N. Maps to HTTP 409 so the caller can re-propose
 * against the latest version.
 */
export class StaleInsightVersionError extends InsightError {
  readonly insightId: string;
  readonly baseVersionNo: number;
  readonly currentVersionNo: number;

  constructor(
    insightId: string,
    baseVersionNo: number,
    currentVersionNo: number,
  ) {
    super(
      `This change was prepared against version ${baseVersionNo} of insight "${insightId}", but the current version is now ${currentVersionNo}. Re-propose the change against the latest version.`,
    );
    this.name = 'StaleInsightVersionError';
    this.insightId = insightId;
    this.baseVersionNo = baseVersionNo;
    this.currentVersionNo = currentVersionNo;
  }
}

export type InsightRunPublishErrorCode =
  | 'structural_check_failed'
  | 'insight_archived'
  | 'insight_not_found';

export class InsightRunPublishError extends InsightError {
  readonly code: InsightRunPublishErrorCode;
  constructor(code: InsightRunPublishErrorCode, message: string) {
    super(message);
    this.name = 'InsightRunPublishError';
    this.code = code;
  }
}

export function toSummary(
  insight: Pick<
    Insight,
    'id' | 'name' | 'description' | 'kind' | 'is_featured' | 'updated_at'
  > & { agent_key?: string | null; source_template_id?: string | null },
  latestVersionNo: number,
): InsightSummary {
  return {
    id: insight.id,
    name: insight.name,
    description: insight.description,
    kind: insight.kind,
    is_featured: insight.is_featured,
    updated_at: insight.updated_at,
    latest_version_no: latestVersionNo,
    agent_key: insight.agent_key ?? null,
    source_template_id: insight.source_template_id ?? null,
  };
}

// ─── Input Types ──────────────────────────────────────────────────────────────

/** The list's filters and page, as parsed from `GET /api/insights`. */
export interface ListInsightsInput {
  q?: string;
  /** A sector agent key, `null` for the general CoPilot, absent for any. */
  agentKey?: string | null;
  /** Only the insights `userId` created. */
  mine?: boolean;
  userId?: string | null;
  archived?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateInsightFromDocumentInput {
  workspaceId: string;
  name: string;
  description?: string | null;
  html: string;
  userId?: string | null;
  kind?: InsightKind;
  /**
   * The sector agent producing v1, if any (MB-541). Stamps the version only —
   * it does not bind the new insight.
   */
  agentStamp?: InsightAgentStamp | null;
  /**
   * The insight template the document was built on. Recorded as the source
   * only when it names a live template in `workspaceId`; anything else is
   * stored as null and never fails the create.
   */
  templateId?: string | null;
}

export interface PublishInsightVersionInput {
  workspaceId: string;
  insightId: string;
  html: string;
  label?: string | null;
  userId?: string | null;
  baseVersionNo?: number | null;
  trigger?: 'copilot_edit' | 'workforce';
  sourceRunId?: string | null;
  /** The sector agent producing this version, if any (MB-541). */
  agentStamp?: InsightAgentStamp | null;
}

export interface RollbackInsightInput {
  workspaceId: string;
  insightId: string;
  toVersionNo: number;
  userId?: string | null;
}

export type RunDraftEdit =
  | { kind: 'section'; section: string; html: string }
  | { kind: 'document'; html: string };

export interface ApplyRunDraftEditInput {
  workspaceId: string;
  runId: string;
  insightId: string;
  edit: RunDraftEdit;
}

export interface RunDraftEditResult {
  insightId: string;
  insightName: string;
  baseVersionNo: number;
}

export type PublishRunDraftResult =
  | {
      status: 'published';
      insightId: string;
      insightName: string;
      versionNo: number;
      baseMoved: boolean;
      ownerUserId: string | null;
    }
  | {
      // The run changed nothing material (no draft, or a draft whose content
      // hash equals the current version's). An is_unchanged version was still
      // recorded so the run shows in history; nothing is notified.
      status: 'unchanged';
      insightId: string;
      versionNo: number;
    }
  | { status: 'already_published'; insightId: string; versionNo: number };

/** Label of a refresh version that changed nothing. */
export const UNCHANGED_REFRESH_LABEL = 'Scheduled refresh — no changes';

// ─── Validators ───────────────────────────────────────────────────────────────

function validateName(name: string): string {
  if (typeof name !== 'string') {
    throw new InsightValidationError('Insight name must be a string');
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new InsightValidationError('Insight name cannot be empty');
  }
  if (trimmed.length > MAX_INSIGHT_NAME_LENGTH) {
    throw new InsightValidationError(
      `Insight name exceeds maximum length of ${MAX_INSIGHT_NAME_LENGTH} characters (received ${trimmed.length})`,
    );
  }
  return trimmed;
}

/**
 * Refuse a version with malformed markers. The source references, Sources
 * entries and unavailable cells are checked for every writer — agent or
 * person — because the check only fires on markers that are present; the
 * MB-543 evidence markers only when the stamp is a validated sector agent
 * (@dikti). The stamp is resolved by the caller from the run's configured
 * agent or the chat's pinned agent — never from the body. Only the
 * author-facing writes call this (create, publish, a refresh run's draft
 * edit); rollback, duplicate and a refresh's finalize re-publish HTML that was
 * already checked.
 */
function assertInsightMarkers(html: string, stamp: InsightAgentStamp | null | undefined): void {
  const problems = findInsightMarkerProblems(html, stamp?.agentKey ?? null);
  if (hasInsightMarkerProblems(problems)) {
    throw new InsightEvidenceMarkerError(
      `${insightMarkerCorrection(problems)}\n\nThe whole document is checked, so a malformed marker may sit outside the part you changed.`,
    );
  }
}

function validateHtml(html: string): void {
  if (typeof html !== 'string') {
    throw new InsightValidationError('Insight HTML must be a string');
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_INSIGHT_BYTES) {
    throw new InsightPayloadTooLargeError(
      `Insight HTML exceeds maximum allowed size of ${MAX_INSIGHT_BYTES} bytes (received ${bytes} bytes)`,
    );
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Chat outlines already built in this process, keyed by version id and the
 * insight's name (the header carries the name, and a rename makes no new
 * version). A version's HTML never changes, so an entry never goes stale; the
 * cap only bounds memory (≤ 64 × the outline budget).
 */
const chatOutlineMemo = createLruCache<{ outline: string; truncated: boolean }>(64);

export class InsightService {
  constructor(
    private readonly insightRepo: InsightRepository,
    private readonly insightVersionRepo: InsightVersionRepository,
    private readonly insightRunDraftRepo: InsightRunDraftRepository,
    private readonly db?: DbClient,
    // Injectable so the deprecated-agent rules can be tested against a
    // fixture; the shipped registry has no deprecated agent.
    private readonly sectorRegistry: Pick<SectorRegistry, 'getSectorAgent'> = {
      getSectorAgent,
    },
    // The workspace's routines, for resuming a refresh schedule the system
    // paused when the insight is rebound (MB-560). Optional: the workforce
    // publish path never rebinds, so it doesn't wire one.
    private readonly routinesRepo?: InsightRoutineResumer,
    // The workspace's templates, for recording and naming an insight's source
    // template. Optional: without it no source is recorded or named.
    private readonly templateRepo?: InsightSourceTemplateLookup,
  ) {}

  /**
   * The live template `templateId` names in `workspaceId`, or null: not a
   * uuid, unknown, soft-deleted, in another workspace, no lookup wired, or the
   * lookup failed. Never throws — a source template is metadata, and a create
   * must not fail over it.
   */
  private async liveSourceTemplate(
    workspaceId: string,
    templateId: string | null | undefined,
  ): Promise<{ id: string; name: string } | null> {
    if (!this.templateRepo || typeof templateId !== 'string' || !isUuid(templateId)) {
      return null;
    }
    try {
      const row = await this.templateRepo.findLiveRefById(templateId);
      return row && row.workspace_id === workspaceId ? { id: row.id, name: row.name } : null;
    } catch {
      return null;
    }
  }

  /**
   * The detail with its live source template's name. A publish or rollback
   * hands its detail straight to the open view, which must keep the "From
   * template" header.
   */
  private async withSourceTemplateName(
    workspaceId: string,
    detail: InsightDetail,
  ): Promise<InsightDetail> {
    return {
      ...detail,
      source_template_name: await this.sourceTemplateName(
        workspaceId,
        detail.source_template_id,
      ),
    };
  }

  /** The live source template's name for the detail header; one row read. */
  private async sourceTemplateName(
    workspaceId: string,
    templateId: string | null | undefined,
  ): Promise<string | null> {
    if (!templateId) return null;
    return (await this.liveSourceTemplate(workspaceId, templateId))?.name ?? null;
  }

  private async withTransaction<T>(
    fn: (tx: DbClient | undefined) => Promise<T>,
  ): Promise<T> {
    if (this.db && typeof (this.db as any).transaction === 'function') {
      return (this.db as any).transaction(async (tx: unknown) => {
        return fn(tx as DbClient);
      });
    }
    return fn(this.db);
  }

  /** The version-row shape the API answers with. */
  private static toVersionSummary(v: InsightVersionSummary): InsightVersionSummary {
    return {
      id: v.id,
      version_no: v.version_no,
      trigger: v.trigger,
      label: v.label,
      created_at: v.created_at,
      created_by: v.created_by,
      source_run_id: v.source_run_id ?? null,
      is_unchanged: v.is_unchanged ?? false,
      agent_key: v.agent_key ?? null,
    };
  }

  /** The version-row stamp column; null when nothing is stamped. */
  private static stampColumns(stamp: InsightAgentStamp | null | undefined): {
    agent_key: string | null;
  } {
    return { agent_key: stamp?.agentKey ?? null };
  }

  /**
   * Locks the insight row, verifies it exists and is not archived, allocates
   * the next version number under the row lock (checking baseVersionNo for staleness),
   * writes the new version, touches the insight, and returns the API detail shape.
   */
  private async appendVersion(
    tx: DbClient | undefined,
    args: {
      workspaceId: string;
      insightId: string;
      html: string;
      trigger: InsightVersion['trigger'];
      label: string | null;
      userId?: string | null;
      baseVersionNo?: number | null;
      sourceRunId?: string | null;
      isUnchanged?: boolean;
      agentStamp?: InsightAgentStamp | null;
    },
  ): Promise<InsightDetail> {
    const locked = await this.insightRepo.lockById(
      args.insightId,
      args.workspaceId,
      tx,
    );
    if (!locked || locked.archived_at !== null) {
      throw new InsightNotFoundError(args.insightId);
    }

    const current = await this.insightVersionRepo.findCurrent(
      args.insightId,
      args.workspaceId,
      tx,
    );
    const currentVersionNo = current?.version_no ?? 0;

    if (
      args.baseVersionNo !== undefined &&
      args.baseVersionNo !== null &&
      args.baseVersionNo !== currentVersionNo
    ) {
      throw new StaleInsightVersionError(
        args.insightId,
        args.baseVersionNo,
        currentVersionNo,
      );
    }

    const nextVersionNo = currentVersionNo + 1;

    const newVersion = await this.insightVersionRepo.create(
      {
        workspace_id: args.workspaceId,
        insight_id: args.insightId,
        version_no: nextVersionNo,
        html: args.html,
        trigger: args.trigger,
        label: args.label,
        created_by: args.userId ?? null,
        source_run_id: args.sourceRunId ?? null,
        content_hash: insightContentHash(args.html),
        is_unchanged: args.isUnchanged ?? false,
        ...InsightService.stampColumns(args.agentStamp),
      },
      tx,
    );

    // An unchanged refresh doesn't touch the insight: bumping updated_at would
    // float an insight whose content never changed to the top of the list on
    // every scheduled run, and it would null updated_by.
    const updated = args.isUnchanged
      ? locked
      : ((await this.insightRepo.update(
          args.insightId,
          args.workspaceId,
          { updated_by: args.userId ?? null },
          tx,
        )) ?? locked);

    const allVersions = await this.insightVersionRepo.findByInsightId(
      args.insightId,
      args.workspaceId,
      tx,
    );

    return {
      ...toSummary(updated, nextVersionNo),
      html: newVersion.html,
      version_no: nextVersionNo,
      versions: allVersions.map(InsightService.toVersionSummary),
      // Named by the callers after the transaction (withSourceTemplateName),
      // so the lookup never holds a second connection under the row lock.
      source_template_name: null,
    };
  }

  /**
   * One page of the workspace's insights, with the total matching the filter.
   * Live insights by default (featured first, then newest updated); archived
   * ones with `archived`. `mine` keeps the insights `userId` created, and
   * matches nothing without a user rather than widening to everyone's.
   *
   * A fixed number of queries per page whatever its size: the page, the
   * count, the latest version numbers and the refresh routines, each batched.
   * Without a routines repository (the workforce publish path) every row's
   * `refresh` is null.
   */
  async list(workspaceId: string, input: ListInsightsInput = {}): Promise<InsightListPage> {
    const { mine = false, userId = null } = input;
    if (mine && !userId) {
      return { items: [], total: 0 };
    }
    const filter: InsightListFilter = {
      q: input.q,
      agentKey: input.agentKey,
      archived: input.archived ?? false,
      ...(mine && userId ? { createdBy: userId } : {}),
    };
    const page = {
      limit: input.limit ?? INSIGHT_LIST_DEFAULT_LIMIT,
      offset: input.offset ?? 0,
    };

    const [rows, total] = await Promise.all([
      this.insightRepo.findPageWithCreator(workspaceId, filter, page),
      this.insightRepo.countByFilter(workspaceId, filter),
    ]);
    if (rows.length === 0) {
      return { items: [], total };
    }

    const ids = rows.map((a) => a.id);
    const [versionMap, refreshMap] = await Promise.all([
      this.insightVersionRepo.findLatestVersionNosByInsightIds(ids, workspaceId),
      this.refreshStatusByInsightId(ids),
    ]);

    return {
      items: rows.map((a) => ({
        ...toSummary(a, versionMap.get(a.id) ?? 1),
        created_by_name: a.created_by_name ?? null,
        refresh: refreshMap.get(a.id) ?? null,
      })),
      total,
    };
  }

  /** The refresh status of each insight that has an active routine, in one query. */
  private async refreshStatusByInsightId(
    insightIds: string[],
  ): Promise<Map<string, InsightRefreshStatus>> {
    const statuses = new Map<string, InsightRefreshStatus>();
    if (!this.routinesRepo) return statuses;
    const routines = await this.routinesRepo.findActiveByInsightIds(insightIds);
    for (const routine of routines) {
      if (!routine.insight_id || statuses.has(routine.insight_id)) continue;
      statuses.set(routine.insight_id, {
        enabled: routine.enabled,
        paused_reason: routine.paused_reason ?? null,
      });
    }
    return statuses;
  }

  /**
   * The sector agent an insight is bound to, for picking the agent a CoPilot
   * chat opened on it runs on (MB-549). One row read — no versions, no HTML —
   * because it runs on every new thread's first turn. Workspace-scoped; null
   * when the insight is missing, archived or in another workspace, so the
   * caller treats it as "not on an insight". `agentKey` is the raw stored key
   * (null when unbound); validating it against the registry is the caller's.
   */
  async findBoundAgent(
    workspaceId: string,
    id: string,
  ): Promise<{ agentKey: string | null } | null> {
    const insight = await this.insightRepo.findById(id, workspaceId);
    if (!insight || insight.archived_at !== null) return null;
    return { agentKey: insight.agent_key ?? null };
  }

  /**
   * The compact outline of an insight's current version that a CoPilot turn
   * carries while the insight is open, and that the "context in use" panel
   * shows (MB-550). Workspace-scoped; null when the insight is missing,
   * archived, in another workspace, or has no version.
   *
   * Runs on every chat turn made on an insight, so the outline is memoised per
   * version in-process: a long thread reads two small rows per turn and parses
   * the document once per version.
   */
  async getChatContext(
    workspaceId: string,
    insightId: string,
  ): Promise<InsightChatContext | null> {
    const insight = await this.insightRepo.findById(insightId, workspaceId);
    if (!insight || insight.archived_at !== null) return null;

    const head = await this.insightVersionRepo.findCurrentHead(insightId, workspaceId);
    if (!head) return null;

    const memoKey = `${head.id}\u0000${insight.name}`;
    let built = chatOutlineMemo.get(memoKey);
    if (!built) {
      const version = await this.insightVersionRepo.findByVersionNo(
        insightId,
        workspaceId,
        head.version_no,
      );
      if (!version) return null;
      built = buildInsightChatOutline(version.html, {
        maxChars: INSIGHT_CHAT_OUTLINE_MAX_CHARS,
        name: insight.name,
        versionNo: head.version_no,
        publishedAt: head.created_at,
      });
      chatOutlineMemo.set(memoKey, built);
    }

    return {
      insightId,
      name: insight.name,
      versionNo: head.version_no,
      publishedAt: head.created_at,
      outline: built.outline,
      truncated: built.truncated,
    };
  }

  /**
   * The insight's current version number, publish time and trigger, without
   * its HTML (MB-554) — cheap enough for an open edit card to poll. Null when
   * the insight is missing, archived, in another workspace, or has no version.
   */
  async getHead(workspaceId: string, insightId: string): Promise<InsightHead | null> {
    const insight = await this.insightRepo.findById(insightId, workspaceId);
    if (!insight || insight.archived_at !== null) return null;

    const head = await this.insightVersionRepo.findCurrentHead(insightId, workspaceId);
    if (!head) return null;

    return { version_no: head.version_no, created_at: head.created_at, trigger: head.trigger };
  }

  /**
   * Retrieves an insight detail by id and optional versionNo (defaults to latest).
   * Throws InsightNotFoundError when not found.
   */
  async get(
    workspaceId: string,
    id: string,
    versionNo?: number,
  ): Promise<InsightDetail> {
    const insight = await this.insightRepo.findById(id, workspaceId);
    if (!insight || insight.archived_at !== null) {
      throw new InsightNotFoundError(id);
    }

    const allVersions = await this.insightVersionRepo.findByInsightId(
      id,
      workspaceId,
    );
    if (allVersions.length === 0) {
      throw new InsightNotFoundError(id);
    }

    const latestVersionNo = allVersions[0].version_no;
    const targetVersionNo = versionNo ?? latestVersionNo;

    if (versionNo !== undefined && !allVersions.some((v) => v.version_no === versionNo)) {
      throw new InsightNotFoundError(id, versionNo);
    }

    const targetVersion = await this.insightVersionRepo.findByVersionNo(
      id,
      workspaceId,
      targetVersionNo,
    );
    if (!targetVersion) {
      throw new InsightNotFoundError(id, versionNo);
    }

    return {
      ...toSummary(insight, latestVersionNo),
      html: targetVersion.html,
      version_no: targetVersion.version_no,
      versions: allVersions.map(InsightService.toVersionSummary),
      source_template_name: await this.sourceTemplateName(
        workspaceId,
        insight.source_template_id,
      ),
    };
  }

  /**
   * Creates an insight plus version 1 (trigger: 'copilot_create') in one transaction.
   * Returns InsightDetail.
   */
  async createFromDocument(
    input: CreateInsightFromDocumentInput,
  ): Promise<InsightDetail> {
    const name = validateName(input.name);
    validateHtml(input.html);
    assertInsightMarkers(input.html, input.agentStamp);
    const kind: InsightKind = input.kind ?? 'document';
    if (kind !== 'document' && kind !== 'report') {
      throw new InsightValidationError(`Invalid insight kind: ${kind}`);
    }

    // Before the transaction: a failed read inside it would abort the insert.
    const sourceTemplate = await this.liveSourceTemplate(
      input.workspaceId,
      input.templateId,
    );

    return this.withTransaction(async (tx) => {
      const insight = await this.insightRepo.create(
        {
          workspace_id: input.workspaceId,
          name,
          description: input.description?.trim() || null,
          kind,
          is_featured: false,
          created_by: input.userId ?? null,
          updated_by: input.userId ?? null,
          source_template_id: sourceTemplate?.id ?? null,
        },
        tx,
      );

      const version = await this.insightVersionRepo.create(
        {
          workspace_id: input.workspaceId,
          insight_id: insight.id,
          version_no: 1,
          html: input.html,
          trigger: 'copilot_create',
          label: null,
          created_by: input.userId ?? null,
          content_hash: insightContentHash(input.html),
          ...InsightService.stampColumns(input.agentStamp),
        },
        tx,
      );

      return {
        ...toSummary(insight, 1),
        html: version.html,
        version_no: 1,
        versions: [InsightService.toVersionSummary(version)],
        source_template_name: sourceTemplate?.name ?? null,
      };
    });
  }

  /**
   * Appends a new version (trigger: 'copilot_edit' or 'workforce').
   * Locks the parent insight row inside the transaction for concurrency safety.
   */
  async publishVersion(
    input: PublishInsightVersionInput,
  ): Promise<InsightDetail> {
    validateHtml(input.html);
    assertInsightMarkers(input.html, input.agentStamp);

    const detail = await this.withTransaction(async (tx) => {
      return this.appendVersion(tx, {
        workspaceId: input.workspaceId,
        insightId: input.insightId,
        html: input.html,
        trigger: input.trigger ?? 'copilot_edit',
        label: input.label ?? null,
        userId: input.userId,
        baseVersionNo: input.baseVersionNo,
        sourceRunId: input.sourceRunId ?? null,
        agentStamp: input.agentStamp ?? null,
      });
    });
    return this.withSourceTemplateName(input.workspaceId, detail);
  }

  /**
   * Appends a NEW version carrying the HTML of the target version (trigger: 'rollback').
   * Never deletes history.
   */
  async rollback(input: RollbackInsightInput): Promise<InsightDetail> {
    const target = await this.insightVersionRepo.findByVersionNo(
      input.insightId,
      input.workspaceId,
      input.toVersionNo,
    );
    if (!target) {
      throw new InsightNotFoundError(input.insightId, input.toVersionNo);
    }

    const detail = await this.withTransaction(async (tx) => {
      return this.appendVersion(tx, {
        workspaceId: input.workspaceId,
        insightId: input.insightId,
        html: target.html,
        trigger: 'rollback',
        label: target.label ?? `Restored from v${input.toVersionNo}`,
        userId: input.userId,
      });
    });
    return this.withSourceTemplateName(input.workspaceId, detail);
  }

  /**
   * Duplicates an existing insight.
   * Copies the current version's HTML into a single v1 with trigger 'duplicate'.
   */
  async duplicate(
    workspaceId: string,
    id: string,
    userId?: string | null,
  ): Promise<InsightDetail> {
    const source = await this.insightRepo.findById(id, workspaceId);
    if (!source || source.archived_at !== null) {
      throw new InsightNotFoundError(id);
    }

    const current = await this.insightVersionRepo.findCurrent(id, workspaceId);
    if (!current) {
      throw new InsightNotFoundError(id);
    }

    const currentVersion = await this.insightVersionRepo.findByVersionNo(
      id,
      workspaceId,
      current.version_no,
    );
    if (!currentVersion) {
      throw new InsightNotFoundError(id);
    }

    const existing = await this.insightRepo.findByWorkspaceId(workspaceId);
    const existingNames = existing.map((a) => a.name);
    const newName = duplicateInsightName(
      source.name,
      existingNames,
      MAX_INSIGHT_NAME_LENGTH,
    );
    const sourceTemplateName = await this.sourceTemplateName(
      workspaceId,
      source.source_template_id,
    );

    return this.withTransaction(async (tx) => {
      const newInsight = await this.insightRepo.create(
        {
          workspace_id: workspaceId,
          name: newName,
          description: source.description,
          kind: source.kind,
          is_featured: false,
          // The copy keeps the source's agent binding, unless that agent has
          // since been deprecated: a deprecated agent takes no new bindings.
          agent_key: this.bindableAgentKey(source.agent_key),
          // The copy comes from the same template as its source.
          source_template_id: source.source_template_id ?? null,
          created_by: userId ?? null,
          updated_by: userId ?? null,
        },
        tx,
      );

      const version = await this.insightVersionRepo.create(
        {
          workspace_id: workspaceId,
          insight_id: newInsight.id,
          version_no: 1,
          html: currentVersion.html,
          trigger: 'duplicate',
          label: `Duplicated from "${source.name}" v${current.version_no}`,
          created_by: userId ?? null,
          content_hash: insightContentHash(currentVersion.html),
        },
        tx,
      );

      return {
        ...toSummary(newInsight, 1),
        html: version.html,
        version_no: 1,
        versions: [InsightService.toVersionSummary(version)],
        source_template_name: sourceTemplateName,
      };
    });
  }

  /** `agentKey` if it names a live (non-deprecated) agent, else null. */
  private bindableAgentKey(agentKey: string | null): string | null {
    if (!agentKey) return null;
    const agent = this.sectorRegistry.getSectorAgent(agentKey);
    return agent && !agent.deprecated ? agentKey : null;
  }

  /**
   * Renames an insight.
   */
  async rename(
    workspaceId: string,
    id: string,
    name: string,
    userId?: string | null,
  ): Promise<InsightSummary> {
    const validatedName = validateName(name);
    const existing = await this.insightRepo.findById(id, workspaceId);
    if (!existing || existing.archived_at !== null) {
      throw new InsightNotFoundError(id);
    }

    const updated = await this.insightRepo.update(id, workspaceId, {
      name: validatedName,
      updated_by: userId ?? null,
    });
    if (!updated) {
      throw new InsightNotFoundError(id);
    }

    const current = await this.insightVersionRepo.findCurrent(id, workspaceId);

    return toSummary(updated, current?.version_no ?? 1);
  }

  /**
   * Sets the featured state of an insight.
   * If isFeatured is true, unfeatures any other insight in the workspace first.
   */
  async setFeatured(
    workspaceId: string,
    id: string,
    isFeatured: boolean,
    userId?: string | null,
  ): Promise<InsightSummary> {
    const existing = await this.insightRepo.findById(id, workspaceId);
    if (!existing || existing.archived_at !== null) {
      throw new InsightNotFoundError(id);
    }

    let updated: Insight | undefined;
    if (isFeatured) {
      updated = await this.withTransaction(async (tx) => {
        await this.insightRepo.clearFeatured(workspaceId, tx);
        return this.insightRepo.update(
          id,
          workspaceId,
          { is_featured: true, updated_by: userId ?? null },
          tx,
        );
      });
    } else {
      updated = await this.insightRepo.update(id, workspaceId, {
        is_featured: false,
        updated_by: userId ?? null,
      });
    }

    if (!updated) {
      throw new InsightNotFoundError(id);
    }

    const current = await this.insightVersionRepo.findCurrent(id, workspaceId);

    return toSummary(updated, current?.version_no ?? 1);
  }

  /**
   * Binds the insight to a sector agent (MB-546), or unbinds it with `null`
   * (back to the general CoPilot). At most one agent per insight; one agent
   * may serve many insights.
   *
   * Binding is configuration, not content: no version is written and past
   * versions keep the agent they were stamped with. The next CoPilot session
   * or scheduled refresh reads the new binding.
   *
   * Refuses an unknown key, and a deprecated agent unless it is already the
   * current binding — re-saving that is a no-op, so an insight left on a
   * deprecated agent can still save its settings without being forced off it.
   *
   * When the binding ends on general or a non-deprecated agent, resumes the
   * insight's refresh routine if the system paused it for a broken binding
   * (MB-560) — see resumeAgentPausedRoutine.
   */
  async setAgentBinding(
    workspaceId: string,
    id: string,
    agentKey: string | null,
    userId?: string | null,
  ): Promise<InsightSummary> {
    if (agentKey !== null && typeof agentKey !== 'string') {
      throw new InsightValidationError('agent_key must be a string or null');
    }

    const existing = await this.insightRepo.findById(id, workspaceId);
    if (!existing || existing.archived_at !== null) {
      throw new InsightNotFoundError(id);
    }

    if (agentKey !== null) {
      const agent = this.sectorRegistry.getSectorAgent(agentKey);
      if (!agent) {
        throw new InsightValidationError(`Unknown sector agent "${agentKey}"`);
      }
      if (agent.deprecated && existing.agent_key !== agentKey) {
        const successor = agent.successorKey
          ? this.sectorRegistry.getSectorAgent(agent.successorKey)
          : undefined;
        throw new InsightValidationError(
          `Sector agent ${agent.handle} is deprecated and cannot be bound` +
            (successor ? `; bind ${successor.handle} instead` : ''),
        );
      }
    }

    let row: Insight = existing;
    // Saving the current binding again changes nothing, so it doesn't touch
    // updated_at/updated_by either.
    if (existing.agent_key !== agentKey) {
      const updated = await this.insightRepo.update(id, workspaceId, {
        agent_key: agentKey,
        updated_by: userId ?? null,
      });
      if (!updated) {
        throw new InsightNotFoundError(id);
      }
      row = updated;
    }

    const boundAgent = agentKey ? this.sectorRegistry.getSectorAgent(agentKey) : undefined;
    if (!boundAgent?.deprecated) {
      await this.resumeAgentPausedRoutine(id);
    }

    const current = await this.insightVersionRepo.findCurrent(id, workspaceId);

    return toSummary(row, current?.version_no ?? 1);
  }

  /**
   * Resume the insight's refresh routine if, and only if, the system paused it
   * for a broken binding: enabled again, reason cleared, cadence untouched,
   * next_fire_at recomputed from now so a long pause doesn't fire a backlog.
   * A manual pause (no reason) is left alone — the repository's
   * `paused_reason IS NOT NULL` guard enforces that even under a race.
   *
   * Runs whenever the binding ends valid, not only when it changed: re-saving a
   * valid binding then heals a pause left behind (e.g. an agent un-deprecated
   * in a later release). A deprecated binding never reaches here.
   */
  private async resumeAgentPausedRoutine(insightId: string): Promise<void> {
    if (!this.routinesRepo) return;
    const routine = await this.routinesRepo.findActiveByInsightId(insightId);
    if (!routine || !isRoutinePausedReason(routine.paused_reason)) return;
    const nextFireAt = computeNextFireAt(
      routine.cron_expression,
      routine.timezone,
      new Date(),
      {
        kind: routine.schedule_kind as ScheduleKind,
        spec: routine.schedule_spec as Record<string, unknown>,
      },
    );
    await this.routinesRepo.resumeFromAgentPause(routine.id, nextFireAt);
  }

  /**
   * Soft-deletes / archives an insight.
   */
  async archive(
    workspaceId: string,
    id: string,
  ): Promise<InsightSummary> {
    const existing = await this.insightRepo.findById(id, workspaceId);
    if (!existing || existing.archived_at !== null) {
      throw new InsightNotFoundError(id);
    }

    const archived = await this.insightRepo.archive(id, workspaceId);
    if (!archived) {
      throw new InsightNotFoundError(id);
    }

    const current = await this.insightVersionRepo.findCurrent(id, workspaceId);

    return toSummary(archived, current?.version_no ?? 1);
  }

  /**
   * Restores an archived insight to the live list. It comes back unfeatured:
   * one live insight per workspace may be featured, and another may have
   * taken the spot while this one was archived. Not-found when the insight is
   * missing or not archived.
   */
  async restore(
    workspaceId: string,
    id: string,
  ): Promise<InsightSummary> {
    const existing = await this.insightRepo.findById(id, workspaceId);
    if (!existing || existing.archived_at === null) {
      throw new InsightNotFoundError(id);
    }

    const restored = await this.insightRepo.unarchive(id, workspaceId);
    if (!restored) {
      throw new InsightNotFoundError(id);
    }

    const current = await this.insightVersionRepo.findCurrent(id, workspaceId);

    return toSummary(restored, current?.version_no ?? 1);
  }

  /**
   * Permanently hard-deletes an insight and cascades to its versions.
   */
  async delete(
    workspaceId: string,
    id: string,
  ): Promise<void> {
    const existing = await this.insightRepo.findById(id, workspaceId);
    if (!existing) {
      throw new InsightNotFoundError(id);
    }

    const deleted = await this.insightRepo.hardDelete(workspaceId, id);
    if (!deleted) {
      throw new InsightNotFoundError(id);
    }
  }

  /**
   * Draft-or-nothing read for get_insight.
   */
  async getRunDraft(
    workspaceId: string,
    runId: string,
  ): Promise<InsightRunDraft | undefined> {
    return this.insightRunDraftRepo.findByRunId(runId, workspaceId);
  }

  /**
   * Applies an edit (section or document) to a run's insight draft.
   *
   * Read-modify-write MUST happen inside one withTransaction after lockById:
   * the model often issues parallel tool calls in one turn, so two edits in
   * one turn must serialize under the insight row lock or one section edit
   * would overwrite another and be lost.
   */
  async applyRunDraftEdit(
    input: ApplyRunDraftEditInput,
  ): Promise<RunDraftEditResult> {
    return this.withTransaction(async (tx) => {
      const locked = await this.insightRepo.lockById(
        input.insightId,
        input.workspaceId,
        tx,
      );
      if (!locked || locked.archived_at !== null) {
        throw new InsightNotFoundError(input.insightId);
      }

      const existingDraft = await this.insightRunDraftRepo.findByRunId(
        input.runId,
        input.workspaceId,
        tx,
      );
      if (existingDraft && existingDraft.insight_id !== input.insightId) {
        throw new InsightValidationError(
          `Run "${input.runId}" already has a draft for insight "${existingDraft.insight_id}", cannot edit insight "${input.insightId}"`,
        );
      }

      let baseHtml: string;
      let baseVersionNo: number;

      if (existingDraft) {
        baseHtml = existingDraft.html;
        baseVersionNo = existingDraft.base_version_no;
      } else {
        const current = await this.insightVersionRepo.findCurrent(
          input.insightId,
          input.workspaceId,
          tx,
        );
        if (!current) {
          throw new InsightNotFoundError(input.insightId);
        }
        const currentVersion = await this.insightVersionRepo.findByVersionNo(
          input.insightId,
          input.workspaceId,
          current.version_no,
          tx,
        );
        if (!currentVersion) {
          throw new InsightNotFoundError(input.insightId);
        }
        baseHtml = currentVersion.html;
        baseVersionNo = currentVersion.version_no;
      }

      let newHtml: string;
      if (input.edit.kind === 'section') {
        const res = replaceInsightSection(
          baseHtml,
          input.edit.section,
          input.edit.html,
        );
        if (!res.success) {
          throw new InsightValidationError(res.error);
        }
        newHtml = res.html;
      } else {
        newHtml = input.edit.html;
      }

      const trimmedHtml = (newHtml ?? '').trim();
      if (!trimmedHtml) {
        throw new InsightValidationError('Spliced HTML document is empty.');
      }

      validateHtml(trimmedHtml);

      const guardError = rejectInvalidInsightDocument(trimmedHtml, locked.kind);
      if (guardError) {
        throw new InsightValidationError(guardError);
      }

      // The spliced draft as a whole (MB-551/556): a section's [S1] must
      // resolve to an entry somewhere in the document. finalize publishes the
      // draft without re-checking it, so this is the refresh's only gate. The
      // tools already checked a @dikti fragment's evidence markers.
      assertInsightMarkers(trimmedHtml, null);

      await this.insightRunDraftRepo.upsert(
        {
          run_id: input.runId,
          workspace_id: input.workspaceId,
          insight_id: input.insightId,
          base_version_no: baseVersionNo,
          html: trimmedHtml,
        },
        tx,
      );

      return {
        insightId: input.insightId,
        insightName: locked.name,
        baseVersionNo,
      };
    });
  }

  /**
   * The insight version a workforce run produced, for the task page's link
   * back to it. Undefined when the run published nothing (or its insight is
   * archived).
   */
  async findVersionForRun(
    workspaceId: string,
    runId: string,
  ): Promise<InsightRunVersionLink | undefined> {
    return this.insightVersionRepo.findLatestBySourceRunId(runId, workspaceId);
  }

  /**
   * Records a refresh run of `insightId` as one new 'routine' version.
   *
   * - The run's draft differs from the current version → published.
   * - No draft, or a draft whose content hash equals the current version's →
   *   an is_unchanged version (so every run is in the version history) and
   *   status 'unchanged', which the caller must not notify on.
   *
   * Executed in a single transaction. Idempotent: returns 'already_published'
   * if a routine version for this run already exists (published or unchanged).
   */
  async publishRunDraft(
    workspaceId: string,
    runId: string,
    insightId: string,
    agentStamp: InsightAgentStamp | null = null,
  ): Promise<PublishRunDraftResult> {
    return this.withTransaction(async (tx) => {
      // 1. Check if routine version already exists
      const existingRoutine =
        await this.insightVersionRepo.findRoutineVersionBySourceRunId(
          runId,
          workspaceId,
          tx,
        );
      if (existingRoutine) {
        return {
          status: 'already_published',
          insightId: existingRoutine.insight_id,
          versionNo: existingRoutine.version_no,
        };
      }

      // 2. The draft, if the run edited anything. Refresh tools only write
      // drafts for the refresh insight, so a draft's insight_id is insightId.
      const draft = await this.insightRunDraftRepo.findByRunId(
        runId,
        workspaceId,
        tx,
      );
      const targetInsightId = draft?.insight_id ?? insightId;

      // 3. Lock target insight row
      const locked = await this.insightRepo.lockById(
        targetInsightId,
        workspaceId,
        tx,
      );
      if (!locked) {
        throw new InsightRunPublishError(
          'insight_not_found',
          `Insight "${targetInsightId}" not found`,
        );
      }
      if (locked.archived_at !== null) {
        throw new InsightRunPublishError(
          'insight_archived',
          `insight "${locked.name}" is archived; the refresh was not published`,
        );
      }

      // 4. Re-check for concurrent publication under the lock
      const concurrentRoutine =
        await this.insightVersionRepo.findRoutineVersionBySourceRunId(
          runId,
          workspaceId,
          tx,
        );
      if (concurrentRoutine) {
        return {
          status: 'already_published',
          insightId: concurrentRoutine.insight_id,
          versionNo: concurrentRoutine.version_no,
        };
      }

      const current = await this.insightVersionRepo.findCurrent(
        targetInsightId,
        workspaceId,
        tx,
      );
      if (!current) {
        throw new InsightRunPublishError(
          'insight_not_found',
          `Insight "${targetInsightId}" has no versions`,
        );
      }

      // 5. Unchanged: no draft at all, or a draft equal to the current
      // version. Checked before the structural check: there is nothing new to
      // validate, and an older document that predates the check must not fail
      // a refresh that left it alone.
      if (
        !draft ||
        sameInsightContent(insightContentHash(draft.html), current.content_hash)
      ) {
        // The current version's exact HTML, not the draft's: an unchanged
        // version must be byte-identical to the one it says it didn't change.
        const html = await this.currentVersionHtml(
          targetInsightId,
          workspaceId,
          current.version_no,
          tx,
        );
        const detail = await this.appendVersion(tx, {
          workspaceId,
          insightId: targetInsightId,
          html,
          trigger: 'routine',
          label: UNCHANGED_REFRESH_LABEL,
          userId: null,
          baseVersionNo: null,
          sourceRunId: runId,
          isUnchanged: true,
          agentStamp,
        });
        if (draft) {
          await this.insightRunDraftRepo.deleteByRunId(runId, workspaceId, tx);
        }
        return {
          status: 'unchanged',
          insightId: targetInsightId,
          versionNo: detail.version_no,
        };
      }

      // 6. Structural check
      const structuralError = checkInsightStructure(draft.html, locked.kind);
      if (structuralError) {
        throw new InsightRunPublishError(
          'structural_check_failed',
          `refresh draft failed the structural check: ${structuralError}`,
        );
      }

      // 7. Base version moved check (last write wins)
      const baseMoved = current.version_no !== draft.base_version_no;
      const label = baseMoved
        ? `Scheduled refresh (base moved from v${draft.base_version_no})`
        : 'Scheduled refresh';

      // 8. Append routine version
      const detail = await this.appendVersion(tx, {
        workspaceId,
        insightId: targetInsightId,
        html: draft.html,
        trigger: 'routine',
        label,
        userId: null,
        baseVersionNo: null,
        sourceRunId: runId,
        agentStamp,
      });

      // 9. Delete draft and return published result
      await this.insightRunDraftRepo.deleteByRunId(runId, workspaceId, tx);

      return {
        status: 'published',
        insightId: targetInsightId,
        insightName: locked.name,
        versionNo: detail.version_no,
        baseMoved,
        ownerUserId: locked.created_by,
      };
    });
  }

  private async currentVersionHtml(
    insightId: string,
    workspaceId: string,
    versionNo: number,
    tx: DbClient | undefined,
  ): Promise<string> {
    const version = await this.insightVersionRepo.findByVersionNo(
      insightId,
      workspaceId,
      versionNo,
      tx,
    );
    if (!version) {
      throw new InsightRunPublishError(
        'insight_not_found',
        `Version ${versionNo} of insight "${insightId}" not found`,
      );
    }
    return version.html;
  }
}
