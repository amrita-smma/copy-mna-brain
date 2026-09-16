import { apiRequest } from '@/lib/api/client';

/**
 * Client wrapper for the admin portal's User Management section. Every
 * endpoint here is session-gated superadmin-only `/api/users*` (not the M2M
 * `X-Api-Secret` `/api/auth/signup` route, which can't be called from the
 * browser).
 */

export interface CreateUserInput {
  email: string;
  name: string;
}

export interface CreatedUser {
  id: string;
  name: string;
  email: string | null;
}

/** A row in the admin portal's full user directory, deactivated users included. */
export interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  is_superadmin: boolean;
  deactivated_at: string | null;
  created_at: string | null;
}

/**
 * Create a new platform user and email them a one-time link to set their
 * password. No password is collected here — see `AuthService.signUp`.
 */
export function createUser(input: CreateUserInput): Promise<CreatedUser> {
  return apiRequest<CreatedUser>('/api/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** The full user directory (active and deactivated) for User Management. */
export function listAllUsersForAdmin(): Promise<AdminUser[]> {
  return apiRequest<AdminUser[]>('/api/users?scope=admin');
}

/** Change a user's name and/or email. Either field may be omitted. */
export function updateUser(
  id: string,
  updates: { name?: string; email?: string },
): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/** Deactivate a user — blocks sign-in, keeps all their data and history. */
export function deactivateUser(id: string): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/api/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** Reactivate a previously-deactivated user. */
export function reactivateUser(id: string): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/api/users/${encodeURIComponent(id)}/reactivate`, {
    method: 'POST',
  });
}

/** Send a password-reset link to this user's email on the admin's behalf. */
export function sendResetLink(id: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(
    `/api/users/${encodeURIComponent(id)}/send-reset-link`,
    { method: 'POST' },
  );
}
