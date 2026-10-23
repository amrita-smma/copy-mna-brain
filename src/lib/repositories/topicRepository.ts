import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { employerTopics, topics } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Topic = typeof topics.$inferSelect;
export type TopicInsert = typeof topics.$inferInsert;
export type EmployerTopic = typeof employerTopics.$inferSelect;
export type EmployerTopicInsert = typeof employerTopics.$inferInsert;

export interface EmployerTopicAssignment {
  id: string;
  topic_id: string;
  name: string;
  slug: string;
  source: string;
  is_highlight: boolean;
  is_deal_related: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export class TopicRepository {
  constructor(private db: DbClient) {}

  async listAll(workspaceId: string): Promise<Topic[]> {
    return this.db
      .select()
      .from(topics)
      .where(or(isNull(topics.workspace_id), eq(topics.workspace_id, workspaceId)))
      .orderBy(asc(topics.name));
  }

  /**
   * `workspaceId` omitted looks up the shared classification vocabulary
   * (workspace_id IS NULL); passed looks up that workspace's own private
   * topic of the same name. See 20260705000003_topics_workspace_id.sql.
   */
  async findByName(
    name: string,
    workspaceId?: string,
  ): Promise<Topic | undefined> {
    const rows = await this.db
      .select()
      .from(topics)
      .where(
        and(
          eq(topics.name, name),
          workspaceId ? eq(topics.workspace_id, workspaceId) : isNull(topics.workspace_id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findById(id: string): Promise<Topic | undefined> {
    const rows = await this.db
      .select()
      .from(topics)
      .where(eq(topics.id, id))
      .limit(1);
    return rows[0];
  }

  /**
   * Upsert by name — returns the topic id. The unique index on `name` would
   * otherwise crash a duplicate insert, which is annoying when concurrent
   * imports race to create the same tag.
   */
  async findOrCreate(
    name: string,
    opts: { is_deal_related?: boolean } = {},
    workspaceId?: string,
  ): Promise<Topic> {
    const existing = await this.findByName(name, workspaceId);
    if (existing) return existing;
    const [row] = await this.db
      .insert(topics)
      .values({
        name,
        slug: slugify(name),
        is_deal_related: opts.is_deal_related ?? false,
        workspace_id: workspaceId ?? null,
      })
      .onConflictDoUpdate(
        workspaceId
          ? {
              target: [topics.workspace_id, topics.name],
              targetWhere: sql`workspace_id IS NOT NULL`,
              set: { name },
            }
          : {
              target: topics.name,
              targetWhere: sql`workspace_id IS NULL`,
              set: { name },
            },
      )
      .returning();
    return row;
  }

  async setDealRelated(topicId: string, is_deal_related: boolean): Promise<void> {
    await this.db
      .update(topics)
      .set({ is_deal_related })
      .where(eq(topics.id, topicId));
  }

  /**
   * Topics assigned to an employer (joined with the topic dictionary). Drives
   * both the summary chip strip and the Topics-tab list on the CRM card.
   */
  async listForEmployer(
    employerId: string,
    workspaceId: string,
  ): Promise<EmployerTopicAssignment[]> {
    const rows = await this.db
      .select({
        id: employerTopics.id,
        topic_id: topics.id,
        name: topics.name,
        slug: topics.slug,
        source: employerTopics.source,
        is_highlight: employerTopics.is_highlight,
        is_deal_related: topics.is_deal_related,
      })
      .from(employerTopics)
      .innerJoin(topics, eq(employerTopics.topic_id, topics.id))
      .where(
        and(
          eq(employerTopics.employer_id, employerId),
          // Tags are per workspace (MB-687); the topic vocabulary filter
          // still hides another workspace's private topic names.
          eq(employerTopics.workspace_id, workspaceId),
          or(isNull(topics.workspace_id), eq(topics.workspace_id, workspaceId)),
        ),
      )
      .orderBy(
        desc(employerTopics.is_highlight),
        asc(employerTopics.source),
        asc(topics.name),
      );
    return rows;
  }

  /**
   * Batched counterpart to `listForEmployer` — topics for many employers in one
   * query, ordered by employer first so callers can group in a single pass.
   * Use this instead of calling `listForEmployer` per employer (that fan-out is
   * an N+1: one query per row, see CLAUDE.md §Backend Development).
   */
  async listForEmployers(
    employerIds: string[],
    workspaceId: string,
  ): Promise<Array<EmployerTopicAssignment & { employer_id: string }>> {
    if (employerIds.length === 0) return [];
    return this.db
      .select({
        id: employerTopics.id,
        employer_id: employerTopics.employer_id,
        topic_id: topics.id,
        name: topics.name,
        slug: topics.slug,
        source: employerTopics.source,
        is_highlight: employerTopics.is_highlight,
        is_deal_related: topics.is_deal_related,
      })
      .from(employerTopics)
      .innerJoin(topics, eq(employerTopics.topic_id, topics.id))
      .where(
        and(
          inArray(employerTopics.employer_id, employerIds),
          eq(employerTopics.workspace_id, workspaceId),
          or(isNull(topics.workspace_id), eq(topics.workspace_id, workspaceId)),
        ),
      )
      .orderBy(
        asc(employerTopics.employer_id),
        desc(employerTopics.is_highlight),
        asc(topics.name),
      );
  }

  async assignToEmployer(
    employerId: string,
    topicId: string,
    workspaceId: string,
    opts: { source?: "auto" | "manual"; is_highlight?: boolean } = {},
  ): Promise<EmployerTopic> {
    const [row] = await this.db
      .insert(employerTopics)
      .values({
        workspace_id: workspaceId,
        employer_id: employerId,
        topic_id: topicId,
        source: opts.source ?? "manual",
        is_highlight: opts.is_highlight ?? false,
      })
      .onConflictDoUpdate({
        target: [
          employerTopics.workspace_id,
          employerTopics.employer_id,
          employerTopics.topic_id,
        ],
        set: {
          source: opts.source ?? "manual",
          is_highlight: opts.is_highlight ?? false,
        },
      })
      .returning();
    return row;
  }

  async removeFromEmployer(
    employerId: string,
    topicId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.db
      .delete(employerTopics)
      .where(
        and(
          eq(employerTopics.workspace_id, workspaceId),
          eq(employerTopics.employer_id, employerId),
          eq(employerTopics.topic_id, topicId),
        ),
      );
  }

  async countEmployerTopics(employerId: string, workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employerTopics)
      .where(
        and(
          eq(employerTopics.workspace_id, workspaceId),
          eq(employerTopics.employer_id, employerId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  async findByIds(ids: string[]): Promise<Topic[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(topics).where(inArray(topics.id, ids));
  }

  /**
   * Bulk upsert from a list of canonical slugs. Mirrors
   * `crmIngest` step [4/7]. Returns the upserted rows so
   * the caller can build a slug→id map for downstream `email_topics` inserts.
   *
   * `is_deal_related` is **upgrade-only**: a new email that classifies a topic
   * as deal-related promotes an existing non-deal topic, but the LLM can never
   * demote a topic back to non-deal (`EXCLUDED.is_deal_related OR
   * topics.is_deal_related`). Only a human can move a topic back down via
   * `setDealRelated`. This lets historical topics drift toward deal as new
   * deal-context emails arrive, without the LLM clobbering an earlier signal.
   */
  async upsertBatch(
    items: Array<{ slug: string; is_deal_related?: boolean }>,
  ): Promise<Topic[]> {
    if (items.length === 0) return [];
    const CHUNK = 1000;
    const out: Topic[] = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK).map((item) => ({
        name: item.slug,
        slug: item.slug,
        is_deal_related: item.is_deal_related ?? false,
      }));
      // crmIngest only ever creates shared-vocabulary topics (workspace_id
      // stays NULL) — must match topics_slug_global_key exactly, see
      // 20260705000003_topics_workspace_id.sql.
      const res = await this.db
        .insert(topics)
        .values(chunk)
        .onConflictDoUpdate({
          target: topics.slug,
          targetWhere: sql`workspace_id IS NULL`,
          set: {
            name: sql`EXCLUDED.name`,
            is_deal_related: sql`${topics.is_deal_related} OR EXCLUDED.is_deal_related`,
          },
        })
        .returning();
      out.push(...res);
    }
    return out;
  }
}
