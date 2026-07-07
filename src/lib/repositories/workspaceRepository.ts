import { eq } from 'drizzle-orm';
import { workspaces } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class WorkspaceRepository {
  constructor(private readonly db: DbClient) {}

  async findAll(): Promise<Tables<'workspaces'>[]> {
    return this.db.select().from(workspaces);
  }

  async findById(id: string): Promise<Tables<'workspaces'> | undefined> {
    const [row] = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
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
}
