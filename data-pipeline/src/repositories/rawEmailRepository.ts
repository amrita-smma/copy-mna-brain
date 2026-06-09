import { eq, sql } from 'drizzle-orm';
import { rawEmails } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type RawEmail = Tables<'raw_emails'>;
export type RawEmailInsert = TablesInsert<'raw_emails'>;

export class RawEmailRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Bulk insert. Returns only the rows that were actually inserted —
   * `ON CONFLICT (message_id) DO NOTHING` filters out anything that collides
   * with an existing row (Drizzle 0.45 over postgres-js semantics). Callers
   * compute skipped count as `inputBatch.length - returned.length`.
   */
  async insertBatch(rows: RawEmailInsert[]): Promise<RawEmail[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(rawEmails)
      .values(rows)
      .onConflictDoNothing({ target: rawEmails.message_id })
      .returning();
  }

  async countByFileId(fileId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(rawEmails)
      .where(eq(rawEmails.file_id, fileId));
    return row?.count ?? 0;
  }
}
