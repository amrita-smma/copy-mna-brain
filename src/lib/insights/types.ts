export type InsightKind = 'document' | 'report';

export interface InsightSummary {
  id: string;
  name: string;
  description: string | null;
  kind: InsightKind;
  is_featured: boolean;
  updated_at: string;
  latest_version_no: number;
  created_by_name?: string | null;
  /**
   * The bound sector agent's registry key (MB-546), or null for the general
   * CoPilot. Resolve it with `getSectorAgent` — it may name a deprecated agent.
   */
  agent_key: string | null;
  /**
   * The template the insight was created from, or null. Kept when the template
   * is soft-deleted; nulled when it is purged.
   */
  source_template_id: string | null;
}

/**
 * An insight's refresh schedule, as its list row shows it. `paused_reason` is
 * set when the system paused it (MB-560); a routine switched off by hand is
 * `enabled: false` with no reason.
 */
export interface InsightRefreshStatus {
  enabled: boolean;
  paused_reason: string | null;
}

/** A row of the paged insight list. */
export interface InsightListItem extends InsightSummary {
  created_by_name: string | null;
  /** The active refresh routine, or null when the insight has none. */
  refresh: InsightRefreshStatus | null;
}

/** One page of the insight list, with the total matching the filter. */
export interface InsightListPage {
  items: InsightListItem[];
  total: number;
}

/** The query of the insight list (`GET /api/insights`). */
export interface InsightListQuery {
  /** Case-insensitive search of the name and description. */
  q?: string;
  /** A sector agent key, or `general` for insights on the general CoPilot. */
  agent?: string;
  /** Only insights the signed-in user created. */
  mine?: boolean;
  /** Archived insights instead of live ones. */
  archived?: boolean;
  limit?: number;
  offset?: number;
}

export interface InsightVersionSummary {
  id: string;
  version_no: number;
  trigger: string;
  label: string | null;
  created_at: string;
  created_by: string | null;
  /** The workforce run that produced this version, if any. */
  source_run_id: string | null;
  /** A scheduled refresh that changed nothing material. */
  is_unchanged: boolean;
  /**
   * The sector agent that produced this version, stamped at write time. Null
   * when no sector agent produced it. Independent of the insight's current
   * binding.
   */
  agent_key: string | null;
}

/** A refresh run of an insight that ended without publishing a version. */
export interface InsightFailedRefreshRun {
  run_id: string;
  status: string;
  /** Human-readable failure reason from the run's error payload. */
  reason: string;
  created_at: string;
  ended_at: string | null;
}

/** The insight version a workforce run produced (its latest, if several). */
export interface InsightRunVersionLink {
  insight_id: string;
  insight_name: string;
  version_no: number;
  is_unchanged: boolean;
}

/**
 * One insight a workforce run wrote to: `first_version_no` 1 means the run
 * created it, anything higher means it updated an existing one.
 */
export interface InsightRunOutput {
  insight_id: string;
  insight_name: string;
  first_version_no: number;
  latest_version_no: number;
}

export interface InsightDetail extends InsightSummary {
  html: string;
  version_no: number;
  versions: InsightVersionSummary[];
  /**
   * The source template's name while it is live (not soft-deleted), for the
   * "From template" header; null when there is no source template or it is
   * deleted.
   */
  source_template_name: string | null;
}

export interface InsightCreateApprovalPayload {
  approval_id: string;
  name: string;
  description: string;
  html: string;
  kind?: InsightKind;
  /** The insight template the document was built on, recorded as its source. */
  template_id?: string;
}

export type InsightCreateApprovalMarker = Omit<InsightCreateApprovalPayload, 'html'>;

export interface InsightEditApprovalPayload {
  approval_id: string;
  insight_id: string;
  summary: string;
  /**
   * The `data-section` key the edit is scoped to. When set, `html` is the
   * replacement fragment for that one block, not a document: the card splices
   * it into the current version to preview and diff, and approving sends the
   * fragment for the server to splice over the version the user reviewed.
   * Absent on a whole-document edit, where `html` is the complete document.
   */
  section?: string | null;
  html: string;
}

export type InsightEditApprovalMarker = Omit<InsightEditApprovalPayload, 'html'>;

/**
 * An insight's current version without its HTML (MB-554): what an open edit
 * card polls to notice that a scheduled refresh (or anyone else) published
 * over the version it is diffing against.
 */
export interface InsightHead {
  version_no: number;
  created_at: string;
  /** What published it: 'routine', 'copilot_edit', 'workforce', 'rollback', … */
  trigger: string;
}

/**
 * The "Refresh this insight now" card (MB-552 AC3): offered after CoPilot shows
 * a retrieved figure that contradicts the open insight. It carries no
 * document — accepting runs the insight's refresh (routine or one-off).
 */
export interface InsightRefreshApprovalPayload {
  approval_id: string;
  insight_id: string;
  /** Why a refresh is worth running, e.g. the contradiction just shown. */
  reason: string;
}


/**
 * The compact outline of an insight's current version that a CoPilot turn made
 * while the insight is open carries as system context (MB-550). The same value
 * the "context in use" panel shows, so the user sees exactly what was sent.
 */
export interface InsightChatContext {
  insightId: string;
  name: string;
  versionNo: number;
  /** ISO timestamp the current version was published. */
  publishedAt: string;
  /** Plain-text/markdown outline, header line first; at most the outline budget. */
  outline: string;
  /** True when the budget forced parts of the document out of the outline. */
  truncated: boolean;
}
