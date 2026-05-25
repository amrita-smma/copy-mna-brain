import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { correspondents, emailParticipants, emails, employers } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Email = typeof emails.$inferSelect;
export type EmailInsert = typeof emails.$inferInsert;
export type EmailParticipant = typeof emailParticipants.$inferSelect;
export type EmailParticipantInsert = typeof emailParticipants.$inferInsert;

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

  async countSince(isoDate: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(emails)
      .where(gte(emails.sent_at, isoDate));
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
  async countStaleEmployers(thresholdIso: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(employers)
      .where(
        and(
          eq(employers.curation_status, "published"),
          // Match the CRM card: "last contact" = any email this employer's
          // correspondents participated in (not just emails they sent).
          sql`COALESCE(
            (SELECT MAX(${emails.sent_at})
             FROM ${emailParticipants}
             JOIN ${correspondents} ON ${correspondents.id} = ${emailParticipants.correspondent_id}
             JOIN ${emails}         ON ${emails.id}         = ${emailParticipants.email_id}
             WHERE ${correspondents.employer_id} = ${employers.id}),
            ${employers.created_at}
          ) < ${thresholdIso}`,
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}
