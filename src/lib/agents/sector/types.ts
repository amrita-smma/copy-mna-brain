/**
 * Types shared by the sector agent registry, the per-agent seeds and the
 * `/api/agents` read API. Type-only and dependency-free: routes, the UI and
 * the workforce body import this, so it must never reach LangChain or a tool
 * module.
 */

/** The registry key of a sector agent. Phase 1 ships exactly these three. */
export type SectorAgentKey = 'minerba' | 'dikti' | 'bangun';

/** The two ways a sector agent's graph is built — see sector/graph.ts. */
export type SectorAgentRole = 'chat' | 'workforce';

/** One registry entry: what the binding selector shows and resolves. */
export interface SectorAgentEntry {
  key: SectorAgentKey;
  /** The name users type and see, e.g. `@minerba`. */
  handle: string;
  /** Display name, e.g. "Mining and Minerals Agent". */
  name: string;
  /** The sector the agent covers, as the PRD names it. */
  sector: string;
  /** One line for the selector. */
  description: string;
  /**
   * A deprecated agent is not offered for new bindings but stays resolvable
   * for existing ones (PRD §4.1 unhappy path, US-01).
   */
  deprecated: boolean;
  /** The agent to rebind to when this one is deprecated. */
  successorKey?: SectorAgentKey;
}

/**
 * A declared data limit (MB-542 AC1). When a request falls inside one, the
 * agent states `statement` instead of estimating.
 */
export interface SectorDataLimit {
  /** Stable kebab-case id. */
  id: string;
  /** What the limit is about, e.g. "Company-level RKAB quota". */
  topic: string;
  /** The limit as the agent must state it. Taken from the BRD via PRD §4.1. */
  statement: string;
}

/** A named source the agent knows about. */
export interface SectorSource {
  name: string;
  /** Extra context on what the source carries or how it is used. */
  detail?: string;
  /**
   * Set when the source is covered by a declared data limit (unreachable,
   * login-only, thin coverage). Points at the `SectorDataLimit.id`.
   */
  limitId?: string;
}

/** A group of metrics in the agent's vocabulary. */
export interface SectorMetricLayer {
  id: string;
  name: string;
  metrics: string[];
  note?: string;
}

/** The seed peer cohort. */
export interface SectorCohort {
  members: string[];
  /** How the cohort is extended beyond `members`. */
  extension?: string;
  /** A caveat on the cohort. */
  note?: string;
}

/** Fields every sector seed carries. */
export interface SectorSeedBase {
  key: SectorAgentKey;
  /** The question the agent answers (PRD §4.1 "Answers" column). */
  answers: string;
  sources: SectorSource[];
  metricLayers: SectorMetricLayer[];
  cohort: SectorCohort;
  dataLimits: SectorDataLimit[];
  /** What a scheduled refresh run does (PRD §4.5 "Proposed Default Cadences"). */
  refreshScope: string;
}
