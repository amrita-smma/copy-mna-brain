import { and, eq } from 'drizzle-orm';
import { feedback } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export interface CreateFeedbackInput {
  userId: string | null;
  title: string;
  message: string;
}

/** Workspace-scoped data access for in-app feedback submissions (MB-480). */
export class FeedbackRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async create(input: CreateFeedbackInput): Promise<Tables<'feedback'>> {
    const [row] = await this.db
      .insert(feedback)
      .values({
        workspace_id: this.workspaceId,
        user_id: input.userId,
        title: input.title,
        message: input.message,
      } satisfies TablesInsert<'feedback'>)
      .returning();
    return row;
  }

  /** Stamp the Jira issue key back onto a feedback row once it's been filed. */
  async setJiraIssueKey(id: string, jiraIssueKey: string): Promise<void> {
    await this.db
      .update(feedback)
      .set({ jira_issue_key: jiraIssueKey })
      .where(and(eq(feedback.id, id), eq(feedback.workspace_id, this.workspaceId)));
  }
}
