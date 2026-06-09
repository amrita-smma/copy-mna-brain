import { eq } from 'drizzle-orm';
import { llmBatches } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type LlmBatch = Tables<'llm_batches'>;
export type LlmBatchInsert = TablesInsert<'llm_batches'>;

export class LlmBatchRepository {
  constructor(private readonly db: DbClient) {}

  async insert(data: LlmBatchInsert): Promise<LlmBatch> {
    const [row] = await this.db.insert(llmBatches).values(data).returning();
    return row;
  }

  async findById(id: string): Promise<LlmBatch | null> {
    const [row] = await this.db
      .select()
      .from(llmBatches)
      .where(eq(llmBatches.id, id))
      .limit(1);
    return row ?? null;
  }

  async listInProgress(): Promise<LlmBatch[]> {
    return this.db
      .select()
      .from(llmBatches)
      .where(eq(llmBatches.status, 'in_progress'));
  }

  async markEnded(id: string, endedAt: string): Promise<LlmBatch> {
    const [row] = await this.db
      .update(llmBatches)
      .set({ status: 'ended', ended_at: endedAt })
      .where(eq(llmBatches.id, id))
      .returning();
    if (!row) throw new Error(`llm_batches ${id} not found`);
    return row;
  }

  async markFetched(id: string, fetchJobId: string | null): Promise<LlmBatch> {
    const [row] = await this.db
      .update(llmBatches)
      .set({
        status: 'fetched',
        fetched_at: new Date().toISOString(),
        fetch_job_id: fetchJobId,
      })
      .where(eq(llmBatches.id, id))
      .returning();
    if (!row) throw new Error(`llm_batches ${id} not found`);
    return row;
  }

  async markFailed(id: string, error: string): Promise<LlmBatch> {
    const [row] = await this.db
      .update(llmBatches)
      .set({ status: 'failed', error })
      .where(eq(llmBatches.id, id))
      .returning();
    if (!row) throw new Error(`llm_batches ${id} not found`);
    return row;
  }
}
