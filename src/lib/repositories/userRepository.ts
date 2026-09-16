import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { users, userWorkspaces } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export type UserListItem = Pick<Tables<'users'>, 'id' | 'name' | 'email' | 'role'>;

/** Full row shape for the superadmin admin-portal user directory, including
 *  fields plain pickers never need (superadmin flag, deactivation, join date). */
export type AdminUserListItem = Pick<
  Tables<'users'>,
  'id' | 'name' | 'email' | 'role' | 'is_superadmin' | 'deactivated_at' | 'created_at'
>;

export class UserRepository {
  constructor(private readonly db: DbClient) {}

  async findAll(): Promise<UserListItem[]> {
    // Active users only — deactivated accounts stay in `findAllIncludingDeactivated`.
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(isNull(users.deactivated_at))
      .orderBy(asc(users.name));
  }

  /**
   * Members of a single workspace, alphabetical by name. This — not
   * `findAll` — backs every user picker in the app (Entered by, Deal
   * Sponsor, Deal Captain, Track PIC, assignees): those columns are uuid FKs
   * to users.id, but only a member of the current workspace is a valid
   * choice. The unique (user_id, workspace_id) key on user_workspaces means
   * the join cannot duplicate a user.
   */
  async findAllInWorkspace(workspaceId: string): Promise<UserListItem[]> {
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .innerJoin(userWorkspaces, eq(userWorkspaces.user_id, users.id))
      .where(and(eq(userWorkspaces.workspace_id, workspaceId), isNull(users.deactivated_at)))
      .orderBy(asc(users.name));
  }

  // Bulk id → name/email lookup. Used to attribute workforce-queue rows to
  // their submitter without an N+1 fetch from the client. Returns only the
  // ids present in the table; callers should treat missing rows as null.
  async findByIds(ids: string[]): Promise<Array<Pick<UserListItem, 'id' | 'name' | 'email'>>> {
    if (ids.length === 0) return [];
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
  }

  /** Case-insensitive bulk email lookup for ingestion pipelines. */
  async findByEmails(
    emails: string[],
  ): Promise<Array<Pick<UserListItem, 'id' | 'email'>>> {
    const normalized = [...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    )];
    if (normalized.length === 0) return [];

    return this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(sql<string>`lower(${users.email})`, normalized));
  }

  /**
   * Case-insensitive bulk name lookup. Used to resolve free-text PIC fields
   * (deal_sponsor / deal_captain / Track PIC) to platform users so they can
   * be emailed. Names are not unique — callers get every match.
   */
  async findByNames(
    names: string[],
  ): Promise<Array<Pick<UserListItem, 'id' | 'name' | 'email'>>> {
    const normalized = [...new Set(
      names.map((name) => name.trim().toLowerCase()).filter(Boolean),
    )];
    if (normalized.length === 0) return [];

    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(sql<string>`lower(${users.name})`, normalized));
  }

  async findByEmail(email: string): Promise<Tables<'users'> | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(ilike(users.email, email.toLowerCase().trim()))
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<Tables<'users'> | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Every user, deactivated ones included, with the fields the superadmin
   * admin-portal's User Management section needs. Never use this to
   * populate an in-app picker — see `findAll`/`findAllInWorkspace`.
   */
  async findAllIncludingDeactivated(): Promise<AdminUserListItem[]> {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        is_superadmin: users.is_superadmin,
        deactivated_at: users.deactivated_at,
        created_at: users.created_at,
      })
      .from(users)
      .orderBy(asc(users.name));
  }

  async create(row: TablesInsert<'users'>): Promise<Tables<'users'>> {
    const [created] = await this.db.insert(users).values(row).returning();
    return created;
  }

  async update(id: string, updates: TablesUpdate<'users'>): Promise<Tables<'users'> | undefined> {
    const [row] = await this.db.update(users).set(updates).where(eq(users.id, id)).returning();
    return row;
  }

  /**
   * Deactivate a user. Idempotent by design: an already-deactivated row keeps
   * its original `deactivated_at` (the `isNull` guard), so re-deactivating
   * never rewrites when it happened.
   */
  async deactivate(id: string): Promise<Tables<'users'> | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ deactivated_at: sql`now()`, updated_at: sql`now()` })
      .where(and(eq(users.id, id), isNull(users.deactivated_at)))
      .returning();
    return row;
  }

  /** Reactivate a deactivated user. Returns undefined if the id is unknown. */
  async reactivate(id: string): Promise<Tables<'users'> | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ deactivated_at: null, updated_at: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    return row;
  }
}
