import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { flSourceRecords } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export class FlSourceRecordRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_source_records'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flSourceRecords)
      .values(data)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_source_records'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'>> {
    return this.create(data, executor);
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flSourceRecords)
      .where(
        and(
          eq(flSourceRecords.workspace_id, workspaceId),
          eq(flSourceRecords.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  async findByIds(
    workspaceId: string,
    ids: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'>[]> {
    if (ids.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flSourceRecords)
      .where(
        and(
          eq(flSourceRecords.workspace_id, workspaceId),
          inArray(flSourceRecords.id, ids),
        ),
      )
      .orderBy(asc(flSourceRecords.id));
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flSourceRecords)
      .where(eq(flSourceRecords.workspace_id, workspaceId))
      .orderBy(desc(flSourceRecords.imported_at), asc(flSourceRecords.id));
  }

  async upsertByHash(
    data: TablesInsert<'fl_source_records'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'>> {
    const exec = this.getExecutor(executor);
    const [inserted] = await exec
      .insert(flSourceRecords)
      .values(data)
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return inserted;
    }

    const conditions: SQL[] = [
      eq(flSourceRecords.workspace_id, data.workspace_id),
      eq(flSourceRecords.file_id, data.file_id),
      eq(flSourceRecords.payload_hash, data.payload_hash),
    ];
    if (data.sheet_name !== undefined && data.sheet_name !== null) {
      conditions.push(eq(flSourceRecords.sheet_name, data.sheet_name));
    } else {
      conditions.push(isNull(flSourceRecords.sheet_name));
    }
    if (data.row_number !== undefined && data.row_number !== null) {
      conditions.push(eq(flSourceRecords.row_number, data.row_number));
    } else {
      conditions.push(isNull(flSourceRecords.row_number));
    }

    const [existing] = await exec
      .select()
      .from(flSourceRecords)
      .where(and(...conditions))
      .limit(1);

    return existing;
  }

  async update(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_source_records'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_source_records'>> {
    const [row] = await this.getExecutor(executor)
      .update(flSourceRecords)
      .set({ ...updates, updated_at: sql`now()` })
      .where(
        and(
          eq(flSourceRecords.workspace_id, workspaceId),
          eq(flSourceRecords.id, id),
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
      .delete(flSourceRecords)
      .where(
        and(
          eq(flSourceRecords.workspace_id, workspaceId),
          eq(flSourceRecords.id, id),
        ),
      );
  }
}
