import { and, eq, sql } from 'drizzle-orm';
import { insightRunDrafts } from '@/lib/db/schema';
import type { DbClient } from './types';

export type InsightRunDraft = typeof insightRunDrafts.$inferSelect;
export interface UpsertInsightRunDraftInput {
  run_id: string;
  workspace_id: string;
  insight_id: string;
  base_version_no: number;
  html: string;
}

export class InsightRunDraftRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async findByRunId(
    runId: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<InsightRunDraft | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(insightRunDrafts)
      .where(
        and(
          eq(insightRunDrafts.workspace_id, workspaceId),
          eq(insightRunDrafts.run_id, runId),
        ),
      )
      .limit(1);
    return row;
  }

  // INSERT … ON CONFLICT (run_id) DO UPDATE SET html, updated_at = now().
  // base_version_no and insight_id are NEVER changed by the update branch.
  async upsert(
    input: UpsertInsightRunDraftInput,
    executor?: DbClient,
  ): Promise<InsightRunDraft> {
    const [row] = await this.getExecutor(executor)
      .insert(insightRunDrafts)
      .values(input)
      .onConflictDoUpdate({
        target: insightRunDrafts.run_id,
        set: {
          html: input.html,
          updated_at: sql`now()`,
        },
      })
      .returning();
    return row;
  }

  async deleteByRunId(
    runId: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(insightRunDrafts)
      .where(
        and(
          eq(insightRunDrafts.workspace_id, workspaceId),
          eq(insightRunDrafts.run_id, runId),
        ),
      );
  }
}
