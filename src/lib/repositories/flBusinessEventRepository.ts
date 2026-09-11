import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { flBusinessEvents } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlBusinessEventRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_business_events'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flBusinessEvents)
      .values(data)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_business_events'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'>> {
    return this.create(data, executor);
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flBusinessEvents)
      .where(
        and(
          eq(flBusinessEvents.workspace_id, workspaceId),
          eq(flBusinessEvents.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flBusinessEvents)
      .where(
        and(
          eq(flBusinessEvents.workspace_id, workspaceId),
          inArray(flBusinessEvents.id, ids),
        ),
      )
      .orderBy(asc(flBusinessEvents.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flBusinessEvents)
      .where(eq(flBusinessEvents.workspace_id, workspaceId))
      .orderBy(
        desc(flBusinessEvents.event_date),
        asc(flBusinessEvents.id),
      );
  }

  async markReversed(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flBusinessEvents)
      .set({
        status: 'reversed',
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(flBusinessEvents.workspace_id, workspaceId),
          eq(flBusinessEvents.id, id),
        ),
      )
      .returning();
    return row;
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_business_events'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flBusinessEvents)
      .set({ ...updates, updated_at: sql`now()` })
      .where(
        and(
          eq(flBusinessEvents.workspace_id, workspaceId),
          eq(flBusinessEvents.id, id),
        ),
      )
      .returning();
    return row;
  }

  async delete(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(flBusinessEvents)
      .where(
        and(
          eq(flBusinessEvents.workspace_id, workspaceId),
          eq(flBusinessEvents.id, id),
        ),
      );
  }
}
