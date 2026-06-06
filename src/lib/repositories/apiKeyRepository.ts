import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { apiKeys } from '@/lib/db/schema';
import type { DbClient, TablesInsert, TablesUpdate } from './types';

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export class ApiKeyRepository {
  constructor(private readonly db: DbClient) {}

  async create(row: TablesInsert<'api_keys'>): Promise<ApiKeyRow> {
    const [created] = await this.db.insert(apiKeys).values(row).returning();
    return created;
  }

  async list(): Promise<ApiKeyRow[]> {
    return this.db.select().from(apiKeys).orderBy(desc(apiKeys.created_at));
  }

  async update(
    id: string,
    fields: TablesUpdate<'api_keys'>,
  ): Promise<ApiKeyRow | null> {
    const [row] = await this.db
      .update(apiKeys)
      .set(fields)
      .where(eq(apiKeys.id, id))
      .returning();
    return row ?? null;
  }

  async getById(id: string): Promise<ApiKeyRow | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Look up non-revoked keys by their non-secret prefix. The prefix is not
   * unique by itself, so callers must still verify the full token against
   * each candidate's hash.
   */
  async findActiveByPrefix(prefix: string): Promise<ApiKeyRow[]> {
    return this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.key_prefix, prefix), isNull(apiKeys.revoked_at)));
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ last_used_at: sql`now()` })
      .where(eq(apiKeys.id, id));
  }

  async revoke(id: string): Promise<ApiKeyRow | null> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revoked_at: sql`now()` })
      .where(eq(apiKeys.id, id))
      .returning();
    return row ?? null;
  }
}
