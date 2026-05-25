import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { correspondents } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Correspondent = typeof correspondents.$inferSelect;
export type CorrespondentInsert = typeof correspondents.$inferInsert;
export type CorrespondentUpdate = Partial<CorrespondentInsert>;

export class CorrespondentRepository {
  constructor(private db: DbClient) {}

  async findByEmployerId(employerId: string): Promise<Correspondent[]> {
    return this.db
      .select()
      .from(correspondents)
      .where(eq(correspondents.employer_id, employerId))
      .orderBy(desc(correspondents.is_primary), asc(correspondents.created_at));
  }

  async findById(id: string): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondents)
      .where(eq(correspondents.id, id))
      .limit(1);
    return rows[0];
  }

  async findByEmployerAndEmail(
    employerId: string,
    email: string,
  ): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondents)
      .where(
        and(
          eq(correspondents.employer_id, employerId),
          eq(correspondents.email, email),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findByEmail(email: string): Promise<Correspondent[]> {
    return this.db
      .select()
      .from(correspondents)
      .where(eq(correspondents.email, email));
  }

  async insert(data: CorrespondentInsert): Promise<Correspondent> {
    if (data.is_primary) {
      await this.clearPrimary(data.employer_id);
    }
    const [row] = await this.db
      .insert(correspondents)
      .values(data)
      .returning();
    return row;
  }

  async update(
    id: string,
    data: CorrespondentUpdate,
  ): Promise<Correspondent | undefined> {
    if (data.is_primary === true) {
      const current = await this.findById(id);
      if (current) await this.clearPrimary(current.employer_id);
    }
    const [row] = await this.db
      .update(correspondents)
      .set({ ...data, updated_at: new Date().toISOString() })
      .where(eq(correspondents.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(correspondents).where(eq(correspondents.id, id));
  }

  async findByIds(ids: string[]): Promise<Correspondent[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(correspondents)
      .where(inArray(correspondents.id, ids));
  }

  /**
   * Clears the primary flag for all correspondents on an employer. Used when
   * promoting a different correspondent so the partial unique index doesn't
   * fire.
   */
  private async clearPrimary(employerId: string): Promise<void> {
    await this.db
      .update(correspondents)
      .set({ is_primary: false })
      .where(
        and(
          eq(correspondents.employer_id, employerId),
          eq(correspondents.is_primary, true),
        ),
      );
  }

  /** Sums emails-with-this-correspondent per employer for quick stats. */
  async countByEmployer(employerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(correspondents)
      .where(eq(correspondents.employer_id, employerId));
    return Number(rows[0]?.n ?? 0);
  }
}
