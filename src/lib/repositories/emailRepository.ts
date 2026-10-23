import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  correspondents,
  emailParticipants,
  emails,
  emailTopics,
  employers,
  workspaceCorrespondents,
} from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Email = typeof emails.$inferSelect;
export type EmailInsert = typeof emails.$inferInsert;
export type EmailParticipant = typeof emailParticipants.$inferSelect;
export type EmailParticipantInsert = typeof emailParticipants.$inferInsert;
export type EmailTopic = typeof emailTopics.$inferSelect;
export type EmailTopicInsert = typeof emailTopics.$inferInsert;

export class EmailRepository {
  constructor(private db: DbClient) {}

  // Returns every email that touches the employer via any participant
  // (sender or to/cc), not just emails whose sender's domain matches.
  // Matches the CRM card's participant-based email_count semantics.
  async findByEmployerId(
    employerId: string,
    opts: { limit?: number } = {},
  ): Promise<Email[]> {
    return this.db
      .selectDistinct()
      .from(emails)
      .innerJoin(emailParticipants, eq(emailParticipants.email_id, emails.id))
      .innerJoin(correspondents, eq(correspondents.id, emailParticipants.correspondent_id))
      .where(eq(correspondents.employer_id, employerId))
      .orderBy(desc(emails.sent_at))
      .limit(opts.limit ?? 50)
      .then((rows) => rows.map((r) => r.emails));
  }

  async countByEmployer(employerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(DISTINCT ${emails.id})` })
      .from(emails)
      .innerJoin(emailParticipants, eq(emailParticipants.email_id, emails.id))
      .innerJoin(correspondents, eq(correspondents.id, emailParticipants.correspondent_id))
      .where(eq(correspondents.employer_id, employerId));
    return Number(rows[0]?.n ?? 0);
  }

  async insert(data: EmailInsert): Promise<Email> {
    const [row] = await this.db.insert(emails).values(data).returning();
    return row;
  }

  async insertParticipants(
    rows: EmailParticipantInsert[],
  ): Promise<EmailParticipant[]> {
    if (rows.length === 0) return [];
    return this.db.insert(emailParticipants).values(rows).returning();
  }

  async findById(id: string): Promise<Email | undefined> {
    const rows = await this.db
      .select()
      .from(emails)
      .where(eq(emails.id, id))
      .limit(1);
    return rows[0];
  }

  async countSince(isoDate: string, workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(DISTINCT ${emails.id})` })
      .from(emails)
      .innerJoin(emailParticipants, eq(emailParticipants.email_id, emails.id))
      .innerJoin(correspondents, eq(correspondents.id, emailParticipants.correspondent_id))
      .innerJoin(
        workspaceCorrespondents,
        eq(workspaceCorrespondents.correspondent_id, correspondents.id)
      )
      .where(
        and(
          gte(emails.sent_at, isoDate),
          eq(workspaceCorrespondents.workspace_id, workspaceId),
        )
      );
    return Number(rows[0]?.n ?? 0);
  }

  async listParticipants(emailId: string): Promise<EmailParticipant[]> {
    return this.db
      .select()
      .from(emailParticipants)
      .where(eq(emailParticipants.email_id, emailId));
  }

  async findByIds(ids: string[]): Promise<Email[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(emails).where(inArray(emails.id, ids));
  }

  /**
   * Aggregate "silent for N days" stat used by the insight bar — counts
   * employers whose latest email is older than the threshold (or who have no
   * emails at all but were created earlier).
   */
  /**
   * Bulk insert with `ON CONFLICT (message_id) DO NOTHING`. Mirrors
   * `crmIngest` email insert. Returns successfully-inserted
   * rows (`{ id, message_id }`); caller can compute skipped count as
   * `inputBatch.length - returned.length`.
   *
   * Quirk: drizzle 0.45 honors `where` on `onConflictDoNothing` even though
   * it's deprecated; this is required to satisfy the partial unique index
   * `WHERE message_id IS NOT NULL` on `emails.message_id`.
   */
  async insertBatchIgnoringDupes(
    rows: EmailInsert[],
  ): Promise<Array<{ id: string; message_id: string | null }>> {
    if (rows.length === 0) return [];
    const CHUNK = 1000;
    const out: Array<{ id: string; message_id: string | null }> = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const res = await this.db
        .insert(emails)
        .values(chunk)
        .onConflictDoNothing({
          target: emails.message_id,
          where: sql`message_id IS NOT NULL`,
        })
        .returning({
          id: emails.id,
          message_id: emails.message_id,
        });
      out.push(...res);
    }
    return out;
  }

  /**
   * Deletes the emails with these Message-IDs that were ingested before
   * `beforeIso`, so a re-extract can insert them again. Notes, role signals,
   * topics, participants and related-company evidence cascade with them.
   * Rows written at or after `beforeIso` (this re-extract's own) are kept.
   * Returns each deleted row's Message-ID and custodian.
   */
  async deleteByMessageIdsCreatedBefore(
    messageIds: string[],
    beforeIso: string,
  ): Promise<Array<{ message_id: string | null; custodian_email: string | null }>> {
    if (messageIds.length === 0) return [];
    return this.db
      .delete(emails)
      .where(
        and(
          inArray(emails.message_id, messageIds),
          sql`${emails.created_at} < ${beforeIso}::timestamptz`,
        ),
      )
      .returning({
        message_id: emails.message_id,
        custodian_email: emails.custodian_email,
      });
  }

  /**
   * Bulk insert participants, deduping on `UNIQUE(email_id, address, role)`.
   * Mirrors `crmIngest` participant insert.
   */
  async insertParticipantsBatch(
    rows: EmailParticipantInsert[],
  ): Promise<EmailParticipant[]> {
    if (rows.length === 0) return [];
    const CHUNK = 1000;
    const out: EmailParticipant[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const res = await this.db
        .insert(emailParticipants)
        .values(chunk)
        .onConflictDoNothing()
        .returning();
      out.push(...res);
    }
    return out;
  }

  /**
   * Bulk insert email_topics, deduping on `UNIQUE(email_id, topic_id)`.
   * Mirrors `crmIngest` email_topics insert.
   */
  async insertTopicsBatch(rows: EmailTopicInsert[]): Promise<EmailTopic[]> {
    if (rows.length === 0) return [];
    const CHUNK = 1000;
    const out: EmailTopic[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const res = await this.db
        .insert(emailTopics)
        .values(chunk)
        .onConflictDoNothing()
        .returning();
      out.push(...res);
    }
    return out;
  }

  async countStaleEmployers(thresholdIso: string, workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employers)
      .where(
        and(
          eq(employers.curation_status, "published"),
          sql`EXISTS (
            SELECT 1 FROM ${correspondents}
            JOIN ${workspaceCorrespondents} ON ${workspaceCorrespondents.correspondent_id} = ${correspondents.id}
            WHERE ${correspondents.employer_id} = ${employers.id}
              AND ${workspaceCorrespondents.workspace_id} = ${workspaceId}
          )`,
          sql`COALESCE(
            (SELECT MAX(${emails.sent_at})
             FROM ${emailParticipants}
             JOIN ${correspondents} ON ${correspondents.id} = ${emailParticipants.correspondent_id}
             JOIN ${emails}         ON ${emails.id}         = ${emailParticipants.email_id}
             JOIN ${workspaceCorrespondents} ON ${workspaceCorrespondents.correspondent_id} = ${correspondents.id}
             WHERE ${correspondents.employer_id} = ${employers.id}
               AND ${workspaceCorrespondents.workspace_id} = ${workspaceId}),
            ${employers.created_at}
          ) < ${thresholdIso}`
        )
      );
    return Number(rows[0]?.n ?? 0);
  }
}
