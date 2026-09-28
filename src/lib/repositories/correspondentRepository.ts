import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  correspondents,
  correspondentEffective,
  workspaceCorrespondents,
} from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Correspondent = typeof correspondents.$inferSelect;
export type CorrespondentInsert = typeof correspondents.$inferInsert;
export type CorrespondentUpdate = Partial<CorrespondentInsert>;

export class CorrespondentRepository {
  constructor(private db: DbClient) {}

  /**
   * Correspondent identity is shared/global (see workspace_correspondents
   * migration comment) — `workspaceId` here is a required read-time filter,
   * not a constructor-bound scope, because crmIngest needs unscoped writes
   * through this same class. Mirrors the `workspaceTrackIds()`
   * derived-table subquery idiom used by CriteriaRepository/TrackVariableRepository.
   *
   * Membership in this workspace is the ONLY visibility rule — every source
   * (`manual`, `direct`, `ingest`) is equally durable. The old
   * `source='ingest'` branch additionally required this workspace to have at
   * least one `user_workspaces.is_email_synced = true` member, so turning a
   * member's mailbox sync off retroactively hid CRM contacts that had
   * already been ingested. Sync state governs which mailboxes the pipeline
   * *pulls* from (`findSyncedCustodianEmails` /
   * `findWorkspaceIdsBySyncedEmail`), not what a workspace member can *read*.
   */
  private visibleCorrespondentIds(workspaceId: string) {
    return this.db
      .select({ id: workspaceCorrespondents.correspondent_id })
      .from(workspaceCorrespondents)
      .where(eq(workspaceCorrespondents.workspace_id, workspaceId));
  }

  // Reads go through the effective view so the human overlay wins (RFC §3.4).
  // Primary PIC is always the oldest visible correspondent — no user-settable
  // designation, just positional: first in the sorted list.
  async findByEmployerId(
    employerId: string,
    workspaceId: string,
  ): Promise<Correspondent[]> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          eq(correspondentEffective.employer_id, employerId),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .orderBy(asc(correspondentEffective.created_at), asc(correspondentEffective.id));
    return rows.map((r, i) => ({ ...r, is_primary: i === 0 }));
  }

  /**
   * Batched counterpart to findByEmployerId — the primary-PIC lookup for many
   * employers in one query. `is_primary` stays positional (oldest visible
   * correspondent per employer), computed by grouping the ordered rows and
   * flagging the first of each employer's group. Callers group by
   * `employer_id` to reconstruct each employer's list.
   */
  async findByEmployerIds(
    employerIds: string[],
    workspaceId: string,
  ): Promise<Correspondent[]> {
    if (employerIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          inArray(correspondentEffective.employer_id, employerIds),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .orderBy(
        asc(correspondentEffective.employer_id),
        asc(correspondentEffective.created_at),
        asc(correspondentEffective.id),
      );
    const seen = new Set<string>();
    return rows.map((r) => {
      const isPrimary = !seen.has(r.employer_id);
      seen.add(r.employer_id);
      return { ...r, is_primary: isPrimary };
    });
  }

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<Correspondent | undefined> {
    const rows = await this.db
      .select()
      .from(correspondentEffective)
      .where(
        and(
          eq(correspondentEffective.id, id),
          inArray(correspondentEffective.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { ...row, is_primary: false };
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

  async insert(data: CorrespondentInsert, workspaceId: string): Promise<Correspondent> {
    const { is_primary: _ignored, ...rest } = data;
    const [row] = await this.db
      .insert(correspondents)
      .values(rest)
      .returning();
    return { ...row, is_primary: false };
  }

  async update(
    id: string,
    data: CorrespondentUpdate,
    workspaceId: string,
  ): Promise<Correspondent | undefined> {
    const { is_primary: _ignored, ...rest } = data;
    if (Object.keys(rest).length === 0) {
      return this.findById(id, workspaceId);
    }
    const [row] = await this.db
      .update(correspondents)
      .set({ ...rest, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(correspondents.id, id),
          inArray(correspondents.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      )
      .returning();
    if (!row) return undefined;
    return { ...row, is_primary: false };
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    await this.db
      .delete(correspondents)
      .where(
        and(
          eq(correspondents.id, id),
          inArray(correspondents.id, this.visibleCorrespondentIds(workspaceId)),
        ),
      );
  }

  async findByIds(ids: string[]): Promise<Correspondent[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(correspondentEffective)
      .where(inArray(correspondentEffective.id, ids));
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
