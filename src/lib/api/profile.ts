import { apiRequest } from '@/lib/api/client';
import type { ProfileItems } from '@/lib/services/profileService';

export type {
  ProfileActionItem,
  ProfileActionItemKind,
  ProfileCompanyItem,
  ProfileCompanyRole,
  ProfileInsightItem,
  ProfileItems,
  ProfileSection,
} from '@/lib/services/profileService';

/**
 * The signed-in user's own items in the active workspace, in one request —
 * companies, insights and action items together. The endpoint reads the user
 * from the session, so there is nothing to pass but the per-section cap.
 */
export async function getProfileItems(params: { limit?: number } = {}): Promise<ProfileItems> {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const query = search.toString();
  return apiRequest<ProfileItems>(`/api/profile/items${query ? `?${query}` : ''}`);
}
