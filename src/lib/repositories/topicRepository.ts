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
  async findOrCreate(name: string): Promise<Topic> {
    const existing = await this.findByName(name);
    if (existing) return existing;
    const [row] = await this.db
      .insert(topics)
      .values({ name, slug: slugify(name) })
      .onConflictDoUpdate({
        target: topics.name,
        set: { name },
      })
      .returning();
    return row;
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
   * The UPDATE is a no-op `name = EXCLUDED.name` forcing RETURNING for both
   * new and existing rows.
   */
  async upsertBatch(slugs: string[]): Promise<Topic[]> {
    if (slugs.length === 0) return [];
    const CHUNK = 1000;
    const out: Topic[] = [];
    for (let i = 0; i < slugs.length; i += CHUNK) {
      const chunk = slugs.slice(i, i + CHUNK).map((slug) => ({ name: slug, slug }));
      const res = await this.db
        .insert(topics)
        .values(chunk)
        .onConflictDoUpdate({
          target: topics.slug,
          set: { name: sql`EXCLUDED.name` },
        })
        .returning();
      out.push(...res);
    }
    return out;
  }
}
