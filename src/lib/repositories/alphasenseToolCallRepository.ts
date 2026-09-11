import { and, desc, eq } from 'drizzle-orm';
import { alphasenseToolCalls } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export type AlphasenseToolCallRow = Tables<'alphasense_tool_calls'>;

/** Cap unbounded lookback reads — this table grows one row per AlphaSense call. */
export const DEFAULT_ALPHASENSE_TOOL_CALL_LIST_LIMIT = 100;

export interface ListAlphasenseToolCallsOptions {
  limit?: number;
  offset?: number;
}

export class AlphasenseToolCallRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async create(
    input: Omit<TablesInsert<'alphasense_tool_calls'>, 'workspace_id'>,
  ): Promise<AlphasenseToolCallRow> {
    const [row] = await this.db
      .insert(alphasenseToolCalls)
      .values({ ...input, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  /** Every call made within a single chat thread, most recent first. */
  async listByChatThreadId(
    chatThreadId: string,
    { limit = DEFAULT_ALPHASENSE_TOOL_CALL_LIST_LIMIT, offset }: ListAlphasenseToolCallsOptions = {},
  ): Promise<AlphasenseToolCallRow[]> {
    const base = this.db
      .select()
      .from(alphasenseToolCalls)
      .where(
        and(
          eq(alphasenseToolCalls.chat_thread_id, chatThreadId),
          eq(alphasenseToolCalls.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(alphasenseToolCalls.created_at))
      .limit(limit);
    return offset ? base.offset(offset) : base;
  }

  /** Recent calls across the workspace, most recent first — for a lookback dashboard. */
  async listRecent(
    { limit = DEFAULT_ALPHASENSE_TOOL_CALL_LIST_LIMIT, offset }: ListAlphasenseToolCallsOptions = {},
  ): Promise<AlphasenseToolCallRow[]> {
    const base = this.db
      .select()
      .from(alphasenseToolCalls)
      .where(eq(alphasenseToolCalls.workspace_id, this.workspaceId))
      .orderBy(desc(alphasenseToolCalls.created_at))
      .limit(limit);
    return offset ? base.offset(offset) : base;
  }
}
