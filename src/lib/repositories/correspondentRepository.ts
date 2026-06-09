import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { correspondents, correspondentEffective } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Correspondent = typeof correspondents.$inferSelect;
export type CorrespondentInsert = typeof correspondents.$inferInsert;
export type CorrespondentUpdate = Partial<CorrespondentInsert>;

export class CorrespondentRepository {
  constructor(private db: DbClient) {}

  // Reads go through the effective view so the human overlay wins (RFC §3.4).
  async findByEmployerId(employerId: string): Promise<Correspondent[]> {
    return this.db
      .select()
      .from(correspondentEffective)
      .where(eq(correspondentEffective.employer_id, employerId))
      .orderBy(
        desc(correspondentEffective.is_primary),
        asc(correspondentEffective.created_at),
      );
  }

  async findById(id: string): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(eq(correspondentEffective.id, id))
      .limit(1);
    return rows[0];
  }

  async findByEmployerAndEmail(
    employerId: string,
    email: string,
  ): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          eq(correspondentEffective.employer_id, employerId),
          eq(correspondentEffective.email, email),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findByEmail(email: string): Promise<Correspondent[]> {
    return this.db
      .select()
      .from(correspondentEffective)
      .where(eq(correspondentEffective.email, email));
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
      .from(correspondentEffective)
      .where(inArray(correspondentEffective.id, ids));
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

  /**
   * Bulk upsert on partial UNIQUE `(employer_id, email) WHERE email IS NOT NULL`.
   * Mirrors `crmIngest` correspondent upsert. Returns `{ id, email }`
   * per upserted row so callers can build an email→correspondent map.
   *
   * The `targetWhere` is required: Postgres doesn't infer a partial unique
   * index from a bare ON CONFLICT, and Drizzle 0.45 honors `targetWhere` on
   * `onConflictDoUpdate`.
   */
  async upsertBatch(
    rows: CorrespondentInsert[],
  ): Promise<Array<{ id: string; email: string | null }>> {
    if (rows.length === 0) return [];
    const CHUNK = 1000;
    const out: Array<{ id: string; email: string | null }> = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const res = await this.db
        .insert(correspondents)
        .values(chunk)
        .onConflictDoUpdate({
          target: [correspondents.employer_id, correspondents.email],
          targetWhere: sql`email IS NOT NULL`,
          set: {
            name: sql`EXCLUDED.name`,
            title: sql`COALESCE(EXCLUDED.title, ${correspondents.title})`,
            phone: sql`COALESCE(EXCLUDED.phone, ${correspondents.phone})`,
            type: sql`EXCLUDED.type`,
            source: sql`EXCLUDED.source`,
            updated_at: sql`now()`,
          },
        })
        .returning({
          id: correspondents.id,
          email: correspondents.email,
        });
      out.push(...res);
    }
    return out;
  }
}
