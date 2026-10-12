import { apiRequest } from '@/lib/api/client';
import type { UserProfile, UserProfileInput } from '@/lib/services/userProfileService';

export type { UserProfile, UserProfileInput } from '@/lib/services/userProfileService';

/**
 * The signed-in user's own profile. The endpoint reads the user from the
 * session, so there is nothing to pass.
 */
export async function getMyProfile(): Promise<UserProfile> {
  return apiRequest<UserProfile>('/api/profile/me');
}

/** Save the editable fields. Omitted keys are left as they are. */
export async function updateMyProfile(input: UserProfileInput): Promise<UserProfile> {
  return apiRequest<UserProfile>('/api/profile/me', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
