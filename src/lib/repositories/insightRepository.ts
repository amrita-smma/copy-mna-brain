import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { insights, users } from '@/lib/db/schema';
import type { DbClient } from './types';

export type Insight = typeof insights.$inferSelect;
export type CreateInsightInput = typeof insights.$inferInsert;
export type UpdateInsightInput = Partial<
  Omit<typeof insights.$inferInsert, 'id' | 'workspace_id' | 'created_at'>
>;

/**
 * The filters of the paged insight list. Every field is optional; an absent
 * field does not filter.
 */
export interface InsightListFilter {
  /** Case-insensitive substring of the name or description. */
  q?: string;
  /**
   * The bound sector agent's key; `null` means the general CoPilot
   * (`agent_key IS NULL`). Absent means any agent.
   */
  agentKey?: string | null;
  /** Only insights this user created. */
  createdBy?: string;
  /** The archived insights instead of the live ones. Default false. */
  archived?: boolean;
}

export interface InsightPageOptions {
  limit: number;
  offset: number;
}

export type InsightWithCreator = Insight & { created_by_name: string | null };

/**
 * Escapes the LIKE wildcards in user input so they match literally.
 * The backslash goes first: it is Postgres's default LIKE escape character.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class InsightRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async findByWorkspaceId(workspaceId: string): Promise<Insight[]> {
    return this.db
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          isNull(insights.archived_at),
        ),
      )
      .orderBy(desc(insights.updated_at));
  }

  /**
   * The WHERE shared by the list page and its count, so the two can never
   * disagree about which rows match.
   */
  private listWhere(workspaceId: string, filter: InsightListFilter): SQL | undefined {
    const term = filter.q?.trim();
    const pattern = term ? `%${escapeLikePattern(term)}%` : null;
    return and(
      eq(insights.workspace_id, workspaceId),
      filter.archived ? isNotNull(insights.archived_at) : isNull(insights.archived_at),
      pattern
        ? or(ilike(insights.name, pattern), ilike(insights.description, pattern))
        : undefined,
      filter.agentKey === undefined
        ? undefined
        : filter.agentKey === null
          ? isNull(insights.agent_key)
          : eq(insights.agent_key, filter.agentKey),
      filter.createdBy === undefined ? undefined : eq(insights.created_by, filter.createdBy),
    );
  }

  /**
   * One page of the workspace's insights with each creator's name, in one
   * query. Live insights put the featured one first, then newest updated;
   * archived ones are newest updated only (featured means nothing there).
   * `id` breaks ties so offset paging is stable.
   */
  async findPageWithCreator(
    workspaceId: string,
    filter: InsightListFilter,
    page: InsightPageOptions,
  ): Promise<InsightWithCreator[]> {
    const order = filter.archived
      ? [desc(insights.updated_at), asc(insights.id)]
      : [desc(insights.is_featured), desc(insights.updated_at), asc(insights.id)];
    return this.db
      .select({
        ...getTableColumns(insights),
        created_by_name: users.name,
      })
      .from(insights)
      .leftJoin(users, eq(users.id, insights.created_by))
      .where(this.listWhere(workspaceId, filter))
      .orderBy(...order)
      .limit(page.limit)
      .offset(page.offset);
  }

  /** How many insights match the list filter, for the list's total. */
  async countByFilter(workspaceId: string, filter: InsightListFilter): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(insights)
      .where(this.listWhere(workspaceId, filter));
    return Number(row?.total ?? 0);
  }

  /**
   * How many non-archived insights each template is the source of, in one
   * grouped query. Templates no insight came from are absent.
   */
  async countBySourceTemplate(
    workspaceId: string,
  ): Promise<Array<{ template_id: string; usage_count: number }>> {
    const rows = await this.db
      .select({
        template_id: insights.source_template_id,
        usage_count: count(),
      })
      .from(insights)
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          isNull(insights.archived_at),
          isNotNull(insights.source_template_id),
        ),
      )
      .groupBy(insights.source_template_id);
    // The WHERE rules out nulls; the filter narrows the column's type.
    return rows.filter(
      (r): r is { template_id: string; usage_count: number } => r.template_id !== null,
    );
  }

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<Insight | undefined> {
    const [row] = await this.db
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Same read as findById, but takes a row-level write lock.
   *
   * This is the serialization point for allocating the next `version_no`. The
   * version row being allocated does not exist yet, so it cannot itself be
   * locked — concurrent publishes are ordered by contending for the PARENT
   * insight row instead.
   *
   * Pass the transaction executor. `FOR UPDATE` outside a transaction releases
   * the lock as soon as the statement returns and serializes nothing.
   */
  async lockById(
    id: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Insight | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.id, id),
        ),
      )
      .limit(1)
      .for('update');
    return row;
  }

  async create(
    input: CreateInsightInput,
    executor?: DbClient,
  ): Promise<Insight> {
    const [row] = await this.getExecutor(executor)
      .insert(insights)
      .values(input)
      .returning();
    return row;
  }

  async update(
    id: string,
    workspaceId: string,
    patch: UpdateInsightInput,
    executor?: DbClient,
  ): Promise<Insight | undefined> {
    const payload = {
      ...patch,
      updated_at: sql`now()`,
    };
    const [row] = await this.getExecutor(executor)
      .update(insights)
      .set(payload)
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.id, id),
        ),
      )
      .returning();
    return row;
  }

  async archive(
    id: string,
    workspaceId: string,
  ): Promise<Insight | undefined> {
    const [row] = await this.db
      .update(insights)
      .set({
        archived_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.id, id),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Restores an archived insight. Clears `is_featured` in the same statement:
   * `uq_insights_workspace_featured` allows one featured live insight per
   * workspace, so bringing back a featured row while another is featured
   * would violate it. Only matches an archived row — undefined otherwise.
   */
  async unarchive(
    id: string,
    workspaceId: string,
  ): Promise<Insight | undefined> {
    const [row] = await this.db
      .update(insights)
      .set({
        archived_at: null,
        is_featured: false,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.id, id),
          isNotNull(insights.archived_at),
        ),
      )
      .returning();
    return row;
  }

  async hardDelete(
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .delete(insights)
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.id, id),
        ),
      )
      .returning();
    return Boolean(row);
  }

  async clearFeatured(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .update(insights)
      .set({
        is_featured: false,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(insights.workspace_id, workspaceId),
          eq(insights.is_featured, true),
        ),
      );
  }
}
