import { apiRequest } from '@/lib/api/client';
import type { SectorAgentEntry } from '@/lib/agents/sector/types';

export type { SectorAgentEntry };

export interface FetchSectorAgentsOptions {
  /** Also return deprecated agents, to resolve an existing binding. */
  includeDeprecated?: boolean;
}

/**
 * The sector agents the binding selector can offer (GET /api/agents).
 * Non-deprecated only unless `includeDeprecated`.
 */
export async function fetchSectorAgents(
  options: FetchSectorAgentsOptions = {},
): Promise<SectorAgentEntry[]> {
  const query = options.includeDeprecated ? '?include_deprecated=1' : '';
  return apiRequest<SectorAgentEntry[]>(`/api/agents${query}`);
}
