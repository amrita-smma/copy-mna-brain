import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { insights, insightVersions } from '@/lib/db/schema';
import type {
  InsightRunOutput,
  InsightRunVersionLink,
  InsightVersionSummary,
} from '@/lib/insights/types';
import type { DbClient } from './types';

export type InsightVersion = typeof insightVersions.$inferSelect;
export type CreateInsightVersionInput = typeof insightVersions.$inferInsert;

export class InsightVersionRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async findCurrent(
    insightId: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<{ version_no: number; content_hash: string | null } | undefined> {
    const [row] = await this.getExecutor(executor)
      .select({
        version_no: insightVersions.version_no,
        content_hash: insightVersions.content_hash,
      })
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.insight_id, insightId),
        ),
      )
      .orderBy(desc(insightVersions.version_no))
      .limit(1);
    return row;
  }

  /**
   * The current version's identity — id, number, publish time and what
   * published it — without its HTML, so a caller that memoises per version
   * (the CoPilot's insight outline, MB-550) can skip reading the document when
   * nothing changed, and an open edit card can poll for a moved base (MB-554).
   */
  async findCurrentHead(
    insightId: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<
    { id: string; version_no: number; created_at: string; trigger: string } | undefined
  > {
    const [row] = await this.getExecutor(executor)
      .select({
        id: insightVersions.id,
        version_no: insightVersions.version_no,
        created_at: insightVersions.created_at,
        trigger: insightVersions.trigger,
      })
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.insight_id, insightId),
        ),
      )
      .orderBy(desc(insightVersions.version_no))
      .limit(1);
    return row;
  }

  async findByInsightId(
    insightId: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<InsightVersionSummary[]> {
    return this.getExecutor(executor)
      .select({
        id: insightVersions.id,
        version_no: insightVersions.version_no,
        trigger: insightVersions.trigger,
        label: insightVersions.label,
        created_at: insightVersions.created_at,
        created_by: insightVersions.created_by,
        source_run_id: insightVersions.source_run_id,
        is_unchanged: insightVersions.is_unchanged,
        agent_key: insightVersions.agent_key,
      })
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.insight_id, insightId),
        ),
      )
      .orderBy(desc(insightVersions.version_no));
  }

  async findByVersionNo(
    insightId: string,
    workspaceId: string,
    versionNo: number,
    executor?: DbClient,
  ): Promise<InsightVersion | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.insight_id, insightId),
          eq(insightVersions.version_no, versionNo),
        ),
      )
      .limit(1);
    return row;
  }

  async findRoutineVersionBySourceRunId(
    runId: string,
    workspaceId: string,
    executor?: DbClient,
  ): Promise<{ id: string; version_no: number; insight_id: string } | undefined> {
    const [row] = await this.getExecutor(executor)
      .select({
        id: insightVersions.id,
        version_no: insightVersions.version_no,
        insight_id: insightVersions.insight_id,
      })
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.source_run_id, runId),
          eq(insightVersions.trigger, 'routine'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * The version a workforce run produced, joined to its insight for the name,
   * in one query. A non-refresh workforce run can stamp several versions
   * (possibly across insights), so this returns the newest by time; version_no
   * is per insight and can't order across them.
   */
  async findLatestBySourceRunId(
    runId: string,
    workspaceId: string,
  ): Promise<InsightRunVersionLink | undefined> {
    const [row] = await this.db
      .select({
        insight_id: insightVersions.insight_id,
        insight_name: insights.name,
        version_no: insightVersions.version_no,
        is_unchanged: insightVersions.is_unchanged,
      })
      .from(insightVersions)
      .innerJoin(
        insights,
        and(
          eq(insights.id, insightVersions.insight_id),
          eq(insights.workspace_id, workspaceId),
          // An archived insight's page 404s, so there is nothing to link to.
          isNull(insights.archived_at),
        ),
      )
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.source_run_id, runId),
        ),
      )
      .orderBy(desc(insightVersions.created_at), desc(insightVersions.version_no))
      .limit(1);
    return row;
  }

  /**
   * Every live insight a workforce run wrote a version of, one row per
   * insight, in the order the run first touched them. Unchanged-marker
   * versions are skipped: they record that nothing was written.
   */
  async findInsightsBySourceRunId(
    runId: string,
    workspaceId: string,
  ): Promise<InsightRunOutput[]> {
    return this.db
      .select({
        insight_id: insightVersions.insight_id,
        insight_name: insights.name,
        first_version_no: sql<number>`min(${insightVersions.version_no})`.mapWith(Number),
        latest_version_no: sql<number>`max(${insightVersions.version_no})`.mapWith(Number),
      })
      .from(insightVersions)
      .innerJoin(
        insights,
        and(
          eq(insights.id, insightVersions.insight_id),
          eq(insights.workspace_id, workspaceId),
          // An archived insight's page 404s, so there is nothing to link to.
          isNull(insights.archived_at),
        ),
      )
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          eq(insightVersions.source_run_id, runId),
          eq(insightVersions.is_unchanged, false),
        ),
      )
      .groupBy(insightVersions.insight_id, insights.name)
      .orderBy(sql`min(${insightVersions.created_at})`);
  }

  async findLatestVersionNosByInsightIds(
    insightIds: string[],
    workspaceId: string,
  ): Promise<Map<string, number>> {
    if (insightIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({
        insightId: insightVersions.insight_id,
        latestVersionNo: sql<number>`max(${insightVersions.version_no})`.as('latest_version_no'),
      })
      .from(insightVersions)
      .where(
        and(
          eq(insightVersions.workspace_id, workspaceId),
          inArray(insightVersions.insight_id, insightIds),
        ),
      )
      .groupBy(insightVersions.insight_id);

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.insightId, Number(row.latestVersionNo));
    }
    return map;
  }

  // NOTE: there is deliberately no `nextVersionNo` helper here. Allocating the
  // next version is a read-then-insert and is only safe under the parent
  // insight row lock, so it lives in InsightService, which takes that lock first.
  // A bare helper on the repository invites callers to allocate without a lock
  // and collide on uq_insight_versions_insight_id_version_no.

  async create(
    input: CreateInsightVersionInput,
    executor?: DbClient,
  ): Promise<InsightVersion> {
    const [row] = await this.getExecutor(executor)
      .insert(insightVersions)
      .values(input)
      .returning();
    return row;
  }
}
