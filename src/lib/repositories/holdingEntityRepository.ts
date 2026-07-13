import { and, eq } from 'drizzle-orm';
import { holdingEntities } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class HoldingEntityRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findAll(): Promise<Tables<'holding_entities'>[]> {
    return this.db
      .select()
      .from(holdingEntities)
      .where(eq(holdingEntities.workspace_id, this.workspaceId))
      .orderBy(holdingEntities.name, holdingEntities.id);
  }

  async findById(id: string): Promise<Tables<'holding_entities'> | undefined> {
    const [row] = await this.db
      .select()
      .from(holdingEntities)
      .where(and(eq(holdingEntities.id, id), eq(holdingEntities.workspace_id, this.workspaceId)))
      .limit(1);
    return row;
  }

  // workspace_id is always this.workspaceId, regardless of what's passed in.
  async insert(
    data: Omit<TablesInsert<'holding_entities'>, 'workspace_id'>,
  ): Promise<Tables<'holding_entities'>> {
    const [row] = await this.db
      .insert(holdingEntities)
      .values({ ...data, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  async update(
    id: string,
    updates: TablesUpdate<'holding_entities'>,
  ): Promise<Tables<'holding_entities'> | undefined> {
    const [row] = await this.db
      .update(holdingEntities)
      .set(updates)
      .where(and(eq(holdingEntities.id, id), eq(holdingEntities.workspace_id, this.workspaceId)))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(holdingEntities)
      .where(and(eq(holdingEntities.id, id), eq(holdingEntities.workspace_id, this.workspaceId)));
  }
}
