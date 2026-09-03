import { and, eq, isNotNull } from 'drizzle-orm';
import { roles, userWorkspaces, workspaces, users, userConsents } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export interface MembershipDetail {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  roleId: string;
  roleName: string;
  isEmailSynced: boolean;
}

export interface WorkspaceMemberDetail {
  userId: string;
  userName: string;
  userEmail: string | null;
  roleId: string;
  roleName: string;
  isEmailSynced: boolean;
  /** Whether this member has accepted the Sync/Terms consent screen. */
  hasConsented: boolean;
}

export class UserWorkspaceRepository {
  constructor(private readonly db: DbClient) {}

  async findByUserId(userId: string): Promise<Tables<'user_workspaces'>[]> {
    return this.db.select().from(userWorkspaces).where(eq(userWorkspaces.user_id, userId));
  }

  async findByWorkspaceId(workspaceId: string): Promise<Tables<'user_workspaces'>[]> {
    return this.db.select().from(userWorkspaces).where(eq(userWorkspaces.workspace_id, workspaceId));
  }

  async insert(data: TablesInsert<'user_workspaces'>): Promise<Tables<'user_workspaces'>> {
    const [row] = await this.db.insert(userWorkspaces).values(data).returning();
    return row;
  }

  /** One row per membership, joined with workspace + role details, oldest workspace first. */
  async findMembershipsForUser(userId: string): Promise<MembershipDetail[]> {
    return this.db
      .select({
        workspaceId: userWorkspaces.workspace_id,
        workspaceName: workspaces.name,
        workspaceSlug: workspaces.slug,
        roleId: userWorkspaces.role_id,
        roleName: roles.name,
        isEmailSynced: userWorkspaces.is_email_synced,
      })
      .from(userWorkspaces)
      .innerJoin(workspaces, eq(userWorkspaces.workspace_id, workspaces.id))
      .innerJoin(roles, eq(userWorkspaces.role_id, roles.id))
      .where(eq(userWorkspaces.user_id, userId))
      .orderBy(workspaces.created_at);
  }

  /**
   * One row per member of a workspace, joined with user + role details.
   * `userConsents` is left-joined (not inner) — a member who hasn't accepted
   * the Sync consent screen still has to appear in this list, just with
   * `hasConsented: false`, so the admin portal can surface who's pending.
   */
  async findMembersForWorkspace(workspaceId: string): Promise<WorkspaceMemberDetail[]> {
    const rows = await this.db
      .select({
        userId: userWorkspaces.user_id,
        userName: users.name,
        userEmail: users.email,
        roleId: userWorkspaces.role_id,
        roleName: roles.name,
        isEmailSynced: userWorkspaces.is_email_synced,
        consentedAt: userConsents.consented_at,
      })
      .from(userWorkspaces)
      .innerJoin(users, eq(userWorkspaces.user_id, users.id))
      .innerJoin(roles, eq(userWorkspaces.role_id, roles.id))
      .leftJoin(userConsents, eq(userConsents.user_id, users.id))
      .where(eq(userWorkspaces.workspace_id, workspaceId))
      .orderBy(users.name);
    return rows.map(({ consentedAt, ...rest }) => ({ ...rest, hasConsented: consentedAt !== null }));
  }

  /** Whether this user has email sync enabled on at least one workspace membership. */
  async hasAnySyncEnabled(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ workspace_id: userWorkspaces.workspace_id })
      .from(userWorkspaces)
      .where(and(eq(userWorkspaces.user_id, userId), eq(userWorkspaces.is_email_synced, true)))
      .limit(1);
    return row !== undefined;
  }

  async findOne(userId: string, workspaceId: string): Promise<Tables<'user_workspaces'> | undefined> {
    const [row] = await this.db
      .select()
      .from(userWorkspaces)
      .where(and(eq(userWorkspaces.user_id, userId), eq(userWorkspaces.workspace_id, workspaceId)))
      .limit(1);
    return row;
  }

  async updateRole(userId: string, workspaceId: string, roleId: string): Promise<Tables<'user_workspaces'> | undefined> {
    const [row] = await this.db
      .update(userWorkspaces)
      .set({ role_id: roleId })
      .where(and(eq(userWorkspaces.user_id, userId), eq(userWorkspaces.workspace_id, workspaceId)))
      .returning();
    return row;
  }

  async updateEmailSync(
    userId: string,
    workspaceId: string,
    isEmailSynced: boolean,
  ): Promise<Tables<'user_workspaces'> | undefined> {
    const [row] = await this.db
      .update(userWorkspaces)
      .set({ is_email_synced: isEmailSynced })
      .where(and(eq(userWorkspaces.user_id, userId), eq(userWorkspaces.workspace_id, workspaceId)))
      .returning();
    return row;
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    await this.db
      .delete(userWorkspaces)
      .where(and(eq(userWorkspaces.user_id, userId), eq(userWorkspaces.workspace_id, workspaceId)));
  }

  /**
   * Workspaces watching this email as their custodian mailbox, oldest
   * workspace first — callers that fan out to more than one (e.g. the
   * attachment pipeline, crmIngest) treat the first id as "primary", so this
   * must be deterministically ordered, not left to Postgres's arbitrary scan
   * order. Same "oldest first" convention as findMembershipsForUser.
   *
   * Replaces the old dedicated workspace_email_to_sync table: a user's own
   * email can be flagged as "synced" per workspace via is_email_synced.
   *
   * Also requires a `user_consents` row — a user who has toggled sync on but
   * never accepted the Sync consent screen must not be treated as a synced
   * custodian. See `ConsentService.hasConsented`.
   */
  async findWorkspaceIdsBySyncedEmail(email: string): Promise<string[]> {
    const rows = await this.db
      .select({ workspace_id: userWorkspaces.workspace_id })
      .from(userWorkspaces)
      .innerJoin(users, eq(userWorkspaces.user_id, users.id))
      .innerJoin(workspaces, eq(userWorkspaces.workspace_id, workspaces.id))
      .innerJoin(userConsents, eq(userConsents.user_id, users.id))
      .where(and(eq(users.email, email), eq(userWorkspaces.is_email_synced, true)))
      .orderBy(workspaces.created_at);
    return rows.map((r) => r.workspace_id);
  }

  /**
   * Every distinct user email currently flagged as a synced custodian
   * mailbox, across all workspaces. This is the single source of truth for
   * which mailboxes the Vault archive/export pipeline should pull from —
   * replaces the old hardcoded VAULT_CUSTODIAN_EMAILS list.
   *
   * Requires a `user_consents` row in addition to `is_email_synced = true` —
   * a mailbox is never handed to the pipeline for a user who hasn't accepted
   * the Sync consent screen, regardless of the toggle.
   */
  async findSyncedCustodianEmails(): Promise<string[]> {
    const rows = await this.db
      .select({ email: users.email })
      .from(userWorkspaces)
      .innerJoin(users, eq(userWorkspaces.user_id, users.id))
      .innerJoin(userConsents, eq(userConsents.user_id, users.id))
      .where(and(eq(userWorkspaces.is_email_synced, true), isNotNull(users.email)));
    return [...new Set(rows.map((r) => r.email as string))];
  }

  /** Count of distinct synced + consented custodian mailboxes belonging to one workspace. */
  async countSyncedCustodians(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ email: users.email })
      .from(userWorkspaces)
      .innerJoin(users, eq(userWorkspaces.user_id, users.id))
      .innerJoin(userConsents, eq(userConsents.user_id, users.id))
      .where(
        and(
          eq(userWorkspaces.workspace_id, workspaceId),
          eq(userWorkspaces.is_email_synced, true),
          isNotNull(users.email),
        ),
      );
    return new Set(rows.map((r) => r.email)).size;
  }
}
