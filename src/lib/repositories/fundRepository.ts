import { and, eq } from 'drizzle-orm';
import { funds } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FundRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findAll(): Promise<Tables<'funds'>[]> {
    return this.db
      .select()
      .from(funds)
      .where(eq(funds.workspace_id, this.workspaceId))
      .orderBy(funds.name, funds.id);
  }

  async findById(id: string): Promise<Tables<'funds'> | undefined> {
    const [row] = await this.db
      .select()
      .from(funds)
      .where(and(eq(funds.id, id), eq(funds.workspace_id, this.workspaceId)))
      .limit(1);
    return row;
  }

  // workspace_id is always this.workspaceId, regardless of what's passed in.
  async insert(data: Omit<TablesInsert<'funds'>, 'workspace_id'>): Promise<Tables<'funds'>> {
    const [row] = await this.db
      .insert(funds)
      .values({ ...data, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  async update(id: string, updates: TablesUpdate<'funds'>): Promise<Tables<'funds'> | undefined> {
    const [row] = await this.db
      .update(funds)
      .set(updates)
      .where(and(eq(funds.id, id), eq(funds.workspace_id, this.workspaceId)))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db
      .delete(funds)
      .where(and(eq(funds.id, id), eq(funds.workspace_id, this.workspaceId)));
  }
}
