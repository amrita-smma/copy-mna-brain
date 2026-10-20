import type { AdminUserListItem, Tables, UserRepository } from '@/lib/repositories';
import type { AuthService } from './authService';

/** Raised when a user id passed to a management method doesn't exist. */
export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`Unknown user: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}

/** Raised when a superadmin tries to deactivate their own account. */
export class CannotDeactivateSelfError extends Error {
  constructor() {
    super('You cannot deactivate your own account');
    this.name = 'CannotDeactivateSelfError';
  }
}

/** Raised when a superadmin tries to permanently delete their own account. */
export class CannotDeleteSelfError extends Error {
  constructor() {
    super('You cannot delete your own account');
    this.name = 'CannotDeleteSelfError';
  }
}

/** Raised when a hard delete targets a user who is still active. */
export class UserNotDeactivatedError extends Error {
  constructor() {
    super('Deactivate this user before deleting them permanently');
    this.name = 'UserNotDeactivatedError';
  }
}

/** Raised when the typed confirmation does not exactly match the user's name. */
export class DeleteConfirmationMismatchError extends Error {
  constructor() {
    super("The name you typed doesn't match this user's name");
    this.name = 'DeleteConfirmationMismatchError';
  }
}

/**
 * Raised when the user has history that must outlive them — votes they ran or
 * cast, routines they created — and whose foreign keys block the delete.
 */
export class UserHasRetainedHistoryError extends Error {
  constructor() {
    super(
      'This user has voting or routine history that must be kept, so they cannot be deleted. Keep them deactivated instead.',
    );
    this.name = 'UserHasRetainedHistoryError';
  }
}

/** Postgres `foreign_key_violation`. */
function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23503';
}

/** Admin-portal projection — never includes `password` or other secrets. */
function toAdminUser(row: Tables<'users'>): AdminUserListItem {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    is_superadmin: row.is_superadmin,
    deactivated_at: row.deactivated_at,
    created_at: row.created_at,
  };
}

export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly workspaceId: string,
    private readonly authService: AuthService,
  ) {}

  /**
   * Users selectable in this workspace. Scoped to workspace membership — the
   * pickers this backs (Entered by, Deal Sponsor, Deal Captain) must not
   * offer users from other workspaces.
   */
  list() {
    return this.userRepo.findAllInWorkspace(this.workspaceId);
  }

  /**
   * The whole user directory of *active* users, ignoring workspace membership.
   * Used so the superadmin workspace member picker can offer non-members.
   * Deactivated accounts are omitted — they cannot sign in and should not
   * be added as members. See `listAllForAdmin` for the full directory.
   */
  listAll() {
    return this.userRepo.findAll();
  }

  /**
   * Every user, deactivated ones included, for the admin portal's User
   * Management section. Superadmin-only — the route gates this, same as
   * every other `/api/users*` mutation in this class.
   */
  listAllForAdmin(): Promise<AdminUserListItem[]> {
    return this.userRepo.findAllIncludingDeactivated();
  }

  /**
   * Deactivate a user. Idempotent — re-deactivating an already-deactivated
   * user returns it unchanged. A superadmin cannot deactivate their own
   * account (that would lock them out with no one left to reactivate it).
   */
  async deactivateUser(actorUserId: string, id: string): Promise<AdminUserListItem> {
    if (actorUserId === id) throw new CannotDeactivateSelfError();
    const existing = await this.userRepo.findById(id);
    if (!existing) throw new UserNotFoundError(id);
    if (existing.deactivated_at !== null) return toAdminUser(existing);
    const row = await this.userRepo.deactivate(id);
    return toAdminUser(row ?? existing);
  }

  /** Reactivate a deactivated user. A user that isn't deactivated is returned unchanged. */
  async reactivateUser(id: string): Promise<AdminUserListItem> {
    const existing = await this.userRepo.findById(id);
    if (!existing) throw new UserNotFoundError(id);
    if (existing.deactivated_at === null) return toAdminUser(existing);
    const row = await this.userRepo.reactivate(id);
    return toAdminUser(row ?? existing);
  }

  /**
   * Permanently delete a user. Only allowed once the user is deactivated, never
   * on the caller's own account, and only when `confirmName` exactly matches
   * the user's current name (the admin portal makes the superadmin type it).
   *
   * Workspace memberships, chats, consents, assignments and similar per-user
   * rows cascade away; authorship columns elsewhere are set to null. Votes and
   * routines block the delete (`restrict` FKs) — that history must be kept, so
   * such a user can only stay deactivated.
   */
  async hardDeleteUser(
    actorUserId: string,
    id: string,
    confirmName: string,
  ): Promise<AdminUserListItem> {
    if (actorUserId === id) throw new CannotDeleteSelfError();
    const existing = await this.userRepo.findById(id);
    if (!existing) throw new UserNotFoundError(id);
    if (existing.deactivated_at === null) throw new UserNotDeactivatedError();
    if (confirmName !== existing.name) throw new DeleteConfirmationMismatchError();
    if (await this.userRepo.hasDeleteBlockingHistory(id)) throw new UserHasRetainedHistoryError();

    let row: Awaited<ReturnType<UserRepository['hardDeleteDeactivated']>>;
    try {
      row = await this.userRepo.hardDeleteDeactivated(id);
    } catch (err) {
      // A vote or routine created between the probe and the delete.
      if (isForeignKeyViolation(err)) throw new UserHasRetainedHistoryError();
      throw err;
    }
    if (!row) {
      // Someone else got there between the read and the delete: either the
      // user is already gone, or they were reactivated.
      if (!(await this.userRepo.findById(id))) throw new UserNotFoundError(id);
      throw new UserNotDeactivatedError();
    }
    return toAdminUser(row);
  }

  /**
   * Change a user's display name and/or email from the admin portal. Either
   * field may be omitted to leave it untouched. A new email must not already
   * belong to a different user.
   */
  async updateProfile(
    id: string,
    updates: { name?: string; email?: string },
  ): Promise<AdminUserListItem> {
    const existing = await this.userRepo.findById(id);
    if (!existing) throw new UserNotFoundError(id);

    const patch: { name?: string; email?: string } = {};
    if (updates.name !== undefined) {
      const trimmed = updates.name.trim();
      if (!trimmed) throw new Error('Name is required');
      patch.name = trimmed;
    }
    if (updates.email !== undefined) {
      const normalized = updates.email.toLowerCase().trim();
      if (!normalized) throw new Error('Email is required');
      if (normalized !== (existing.email ?? '').toLowerCase()) {
        const owner = await this.userRepo.findByEmail(normalized);
        if (owner && owner.id !== id) throw new Error('Email already registered');
      }
      patch.email = normalized;
    }

    if (Object.keys(patch).length === 0) return toAdminUser(existing);
    const row = await this.userRepo.update(id, patch);
    return toAdminUser(row ?? existing);
  }

  /**
   * Send a password-reset link to a user's email on an admin's behalf —
   * the same mechanism as the self-service "Forgot password?" flow, just
   * triggered from the admin portal instead of the login page.
   */
  async sendResetLink(id: string, appUrl: string): Promise<void> {
    const existing = await this.userRepo.findById(id);
    if (!existing) throw new UserNotFoundError(id);
    if (!existing.email) throw new Error('This user has no email on file');
    await this.authService.forgetPassword(existing.email, appUrl);
  }
}
