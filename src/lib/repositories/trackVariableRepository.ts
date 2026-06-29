import { asc, eq } from 'drizzle-orm';
import { trackVariables } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class TrackVariableRepository {
  constructor(private readonly db: DbClient) {}

  /** All variables, or only those belonging to a given Track when `trackId` is set. */
  async findAll(trackId?: string): Promise<Tables<'track_variables'>[]> {
    return this.db
      .select()
      .from(trackVariables)
      .where(trackId ? eq(trackVariables.track_id, trackId) : undefined)
      .orderBy(asc(trackVariables.sort_order), asc(trackVariables.created_at));
  }

  async insert(
    data: Pick<
      TablesInsert<'track_variables'>,
      'track_id' | 'name' | 'unit' | 'type' | 'options' | 'sort_order'
    >,
  ): Promise<Tables<'track_variables'>> {
    const [row] = await this.db.insert(trackVariables).values(data).returning();
    return row;
  }

  async update(
    id: string,
    updates: Pick<
      TablesUpdate<'track_variables'>,
      'name' | 'unit' | 'type' | 'options' | 'sort_order'
    >,
  ): Promise<Tables<'track_variables'>> {
    const [row] = await this.db
      .update(trackVariables)
      .set(updates)
      .where(eq(trackVariables.id, id))
      .returning();
    if (!row) throw new Error(`Track variable ${id} not found`);
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(trackVariables).where(eq(trackVariables.id, id));
  }
}
