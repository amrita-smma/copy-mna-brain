import { eq, inArray, isNull, sql, and } from 'drizzle-orm';
import { workspaces } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class WorkspaceRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Live workspaces only — soft-deleted rows (`deleted_at IS NOT NULL`) are
   * excluded. This is the default every caller wants: pickers, switchers,
   * cron sweeps and background jobs must all behave as if an archived
   * workspace no longer exists. Use `findAllIncludingDeleted` for the
   * superadmin admin-portal listing, which is the one place that shows them.
   */
  async findAll(): Promise<Tables<'workspaces'>[]> {
    return this.db.select().from(workspaces).where(isNull(workspaces.deleted_at));
  }

  /** Every workspace row, archived ones included. Superadmin listings only. */
  async findAllIncludingDeleted(): Promise<Tables<'workspaces'>[]> {
    return this.db.select().from(workspaces);
  }

  /**
   * Raw row lookup — returns soft-deleted workspaces too, since reinstating
   * one has to be able to read it first. Callers that must not act on an
   * archived workspace check `deleted_at` (or use `findActiveById`).
   */
  async findById(id: string): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return row;
  }

  /**
   * Batched counterpart to {@link findActiveById}. Callers resolving names for
   * a set of workspace ids (e.g. the email-ingest fan-out) must use this
   * rather than looping the single-id lookup, which would fan out one query
   * per id. Soft-deleted rows read as missing, same as `findActiveById`.
   */
  async findActiveByIds(ids: string[]): Promise<Tables<'workspaces'>[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(workspaces)
      .where(and(inArray(workspaces.id, ids), isNull(workspaces.deleted_at)))
      .orderBy(workspaces.created_at);
  }

  /** Same as `findById`, but a soft-deleted workspace reads as missing. */
  async findActiveById(id: string): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), isNull(workspaces.deleted_at)))
      .limit(1);
    return row;
  }

  /**
   * Lookup by URL slug, archived rows included. The `/w/<slug>` layout needs
   * the row itself (not just "does it exist") to tell a soft-deleted
   * workspace apart from an unknown slug.
   */
  async findBySlug(slug: string): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    return row;
  }

  async insert(data: TablesInsert<'workspaces'>): Promise<Tables<'workspaces'>> {
    const [row] = await this.db.insert(workspaces).values(data).returning();
    return row;
  }

  async update(id: string, updates: TablesUpdate<'workspaces'>): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db.update(workspaces).set(updates).where(eq(workspaces.id, id)).returning();
    return row;
  }

  /**
   * Archive the workspace. Idempotent by design: an already-deleted row keeps
   * its original `deleted_at` (the `isNull` guard), so re-deleting never
   * rewrites when it was archived.
   */
  async softDelete(id: string): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db
      .update(workspaces)
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deleted_at)))
      .returning();
    return row;
  }

  /** Reinstate an archived workspace. Returns undefined if the id is unknown. */
  async restore(id: string): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db
      .update(workspaces)
      .set({ deleted_at: null, updated_at: sql`now()` })
      .where(eq(workspaces.id, id))
      .returning();
    return row;
  }
}
