import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { crmSuggestedQuestions } from '@/lib/db/schema';
import type { DbClient } from './types';

/** One stored day of "Ask Brain" questions for one user. */
export interface CrmSuggestedQuestionRecord {
  workspaceId: string;
  userId: string;
  /** `YYYY-MM-DD`, the Asia/Jakarta day the questions are for. */
  forDate: string;
  questions: unknown;
  createdAt: string;
}

export interface UpsertCrmSuggestedQuestionInput {
  workspaceId: string;
  userId: string;
  forDate: string;
  questions: unknown;
}

const columns = {
  workspaceId: crmSuggestedQuestions.workspace_id,
  userId: crmSuggestedQuestions.user_id,
  forDate: crmSuggestedQuestions.for_date,
  questions: crmSuggestedQuestions.questions,
  createdAt: crmSuggestedQuestions.created_at,
};

/**
 * Data access for `crm_suggested_questions` (MB-862): one row per
 * (workspace, user, day). Every read and write names the workspace and the
 * user, so one user's row can never be read for another.
 */
export class CrmSuggestedQuestionRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * The user's most recent row dated on or before `onOrBefore` (`YYYY-MM-DD`):
   * today's row when it exists, else the latest earlier one.
   */
  async findLatestForUser(
    workspaceId: string,
    userId: string,
    onOrBefore: string,
  ): Promise<CrmSuggestedQuestionRecord | undefined> {
    const [row] = await this.db
      .select(columns)
      .from(crmSuggestedQuestions)
      .where(
        and(
          eq(crmSuggestedQuestions.workspace_id, workspaceId),
          eq(crmSuggestedQuestions.user_id, userId),
          lte(crmSuggestedQuestions.for_date, onOrBefore),
        ),
      )
      .orderBy(desc(crmSuggestedQuestions.for_date))
      .limit(1);
    return row;
  }

  /**
   * Write (or replace) many users' questions in one statement. A concurrent
   * write for the same (workspace, user, day) resolves to the last writer
   * instead of failing.
   */
  async upsertMany(inputs: UpsertCrmSuggestedQuestionInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db
      .insert(crmSuggestedQuestions)
      .values(
        inputs.map((i) => ({
          workspace_id: i.workspaceId,
          user_id: i.userId,
          for_date: i.forDate,
          questions: i.questions,
        })),
      )
      .onConflictDoUpdate({
        target: [
          crmSuggestedQuestions.workspace_id,
          crmSuggestedQuestions.user_id,
          crmSuggestedQuestions.for_date,
        ],
        set: {
          questions: sql`excluded.questions`,
          created_at: sql`now()`,
        },
      });
  }
}
