import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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

  async listAll(): Promise<Topic[]> {
    return this.db.select().from(topics).orderBy(asc(topics.name));
  }

  async findByName(name: string): Promise<Topic | undefined> {
    const rows = await this.db
      .select()
      .from(topics)
      .where(eq(topics.name, name))
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
  ): Promise<Topic> {
    const existing = await this.findByName(name);
    if (existing) return existing;
    const [row] = await this.db
      .insert(topics)
      .values({ name, slug: slugify(name), is_deal_related: opts.is_deal_related ?? false })
      .onConflictDoUpdate({
        target: topics.name,
        set: { name },
      })
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
      .where(eq(employerTopics.employer_id, employerId))
      .orderBy(
        desc(employerTopics.is_highlight),
        asc(employerTopics.source),
        asc(topics.name),
      );
    return rows;
  }

  async assignToEmployer(
    employerId: string,
    topicId: string,
    opts: { source?: "auto" | "manual"; is_highlight?: boolean } = {},
  ): Promise<EmployerTopic> {
    const [row] = await this.db
      .insert(employerTopics)
      .values({
        employer_id: employerId,
        topic_id: topicId,
        source: opts.source ?? "manual",
        is_highlight: opts.is_highlight ?? false,
      })
      .onConflictDoUpdate({
        target: [employerTopics.employer_id, employerTopics.topic_id],
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
  ): Promise<void> {
    await this.db
      .delete(employerTopics)
      .where(
        and(
          eq(employerTopics.employer_id, employerId),
          eq(employerTopics.topic_id, topicId),
        ),
      );
  }

  async countEmployerTopics(employerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employerTopics)
      .where(eq(employerTopics.employer_id, employerId));
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
      const res = await this.db
        .insert(topics)
        .values(chunk)
        .onConflictDoUpdate({
          target: topics.slug,
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
