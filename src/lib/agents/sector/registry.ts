/**
 * The sector agent registry (MB-540): the read-only list of named sector
 * agents the app can offer for binding. Agents are defined in code and
 * reviewed at merge — there is no DB registry and no create/edit/delete path.
 *
 * This module is deliberately LangChain-free and tool-free: the `/api/agents`
 * route, the binding UI and the workforce body all import it, and the
 * workforce body runs in a sandbox where any LangChain import kills the run.
 * registry.test.ts enforces that it imports nothing but ./types.
 *
 * ## Adding or deprecating an agent
 *
 * Add: extend `SectorAgentKey` in ./types, add an entry below, create
 * `src/lib/agents/<key>/` (seed, prompt, tools, index) and register it in
 * `sector/graph.ts`. Deprecate: never delete an entry — set
 * `deprecated: true` (and `successorKey` when there is one). Existing bindings
 * keep resolving it via `getSectorAgent`.
 */
import type { SectorAgentEntry, SectorAgentKey } from './types';

export type { SectorAgentEntry, SectorAgentKey } from './types';

const SECTOR_AGENTS: readonly SectorAgentEntry[] = [
  {
    key: 'minerba',
    handle: '@minerba',
    name: 'Mining and Minerals Agent',
    sector: 'Mining and minerals',
    description:
      'Who holds the licence, the quota and the tonnes behind a mining asset, and where its cost position sits against the cohort.',
    deprecated: false,
  },
  {
    key: 'dikti',
    handle: '@dikti',
    name: 'Education Agent',
    sector: 'Education',
    description:
      'Who is quietly buying Indonesian campuses, and what they effectively paid.',
    deprecated: false,
  },
  {
    key: 'bangun',
    handle: '@bangun',
    name: 'Construction and Property Development Agent',
    sector: 'Construction and property development',
    description:
      'Whether a developer builds at a normal cost, sells at a normal price, and sells down phases at a normal pace.',
    deprecated: false,
  },
];

export interface ListSectorAgentsOptions {
  /** Include deprecated agents (for resolving existing bindings). Default false. */
  includeDeprecated?: boolean;
}

export interface SectorRegistry {
  listSectorAgents(options?: ListSectorAgentsOptions): SectorAgentEntry[];
  getSectorAgent(key: string): SectorAgentEntry | undefined;
  isSectorAgentKey(value: unknown): value is SectorAgentKey;
}

/**
 * Build the lookup functions over a list of entries. Exported so the
 * deprecation behaviour can be tested against a fixture while the shipped
 * registry has no deprecated agent.
 */
export function createSectorRegistry(entries: readonly SectorAgentEntry[]): SectorRegistry {
  const keys: ReadonlySet<string> = new Set(entries.map((a) => a.key));
  return {
    // Non-deprecated only unless `includeDeprecated` — a deprecated agent must
    // not be offered for a new binding. Copies, so callers cannot mutate the
    // registry.
    listSectorAgents(options = {}) {
      return entries
        .filter((a) => options.includeDeprecated || !a.deprecated)
        .map((a) => ({ ...a }));
    },
    // Deprecated or not — an existing binding must keep resolving after its
    // agent is deprecated.
    getSectorAgent(key) {
      const entry = entries.find((a) => a.key === key);
      return entry ? { ...entry } : undefined;
    },
    isSectorAgentKey(value): value is SectorAgentKey {
      return typeof value === 'string' && keys.has(value);
    },
  };
}

const registry = createSectorRegistry(SECTOR_AGENTS);

/** The registry entries, in registry order (non-deprecated unless asked). */
export const listSectorAgents = registry.listSectorAgents;

/** Resolve one agent by key, deprecated included; `undefined` if unknown. */
export const getSectorAgent = registry.getSectorAgent;

/** Narrow an untrusted value (a query param, a DB column) to a registry key. */
export const isSectorAgentKey = registry.isSectorAgentKey;
