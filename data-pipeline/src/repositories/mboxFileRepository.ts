import { and, asc, between, eq, inArray } from 'drizzle-orm';
import { mboxFiles } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type MboxFile = Tables<'mbox_files'>;
export type MboxFileInsert = TablesInsert<'mbox_files'>;

export class MboxFileRepository {
  constructor(private readonly db: DbClient) {}

  async insert(data: MboxFileInsert): Promise<MboxFile> {
    const [row] = await this.db.insert(mboxFiles).values(data).returning();
    return row;
  }

  async insertIgnore(data: MboxFileInsert): Promise<MboxFile | null> {
    const [row] = await this.db
      .insert(mboxFiles)
      .values(data)
      .onConflictDoNothing({ target: mboxFiles.s3_key })
      .returning();
    return row ?? null;
  }

  async findById(id: string): Promise<MboxFile | null> {
    const [row] = await this.db
      .select()
      .from(mboxFiles)
      .where(eq(mboxFiles.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByJobId(jobId: string): Promise<MboxFile[]> {
    return this.db
      .select()
      .from(mboxFiles)
      .where(eq(mboxFiles.job_id, jobId))
      .orderBy(asc(mboxFiles.created_at));
  }

  /**
   * Files awaiting parse. When `includeFailed` is true, also returns files
   * with `parse_status = 'failed'` so callers can retry them without manual
   * DB resets.
   */
  async listPending(limit: number = 50, includeFailed = false): Promise<MboxFile[]> {
    const statuses = includeFailed ? ['pending', 'failed'] : ['pending'];
    return this.db
      .select()
      .from(mboxFiles)
      .where(inArray(mboxFiles.parse_status, statuses))
      .orderBy(asc(mboxFiles.created_at))
      .limit(limit);
  }

  /**
   * Files that fall inside `[start, end)` — used to report what's already on
   * disk for a given calendar window without scanning the jobs table.
   */
  async findByWindow(
    source: string,
    startIso: string,
    endIso: string,
  ): Promise<MboxFile[]> {
    return this.db
      .select()
      .from(mboxFiles)
      .where(
        and(
          eq(mboxFiles.source, source),
          between(mboxFiles.window_start, startIso, endIso),
        ),
      )
      .orderBy(asc(mboxFiles.window_start));
  }

  /**
   * Atomically claim a pending file for parsing. Returns the updated row, or
   * null when no row matches the (id, parse_status='pending') predicate —
   * caller treats null as "someone else claimed it; skip."
   */
  async markParsing(fileId: string, allowStatuses = ['pending']): Promise<MboxFile | null> {
    const [row] = await this.db
      .update(mboxFiles)
      .set({ parse_status: 'parsing', updated_at: new Date().toISOString() })
      .where(and(eq(mboxFiles.id, fileId), inArray(mboxFiles.parse_status, allowStatuses)))
      .returning();
    return row ?? null;
  }

  async markParsed(fileId: string, rawEmailCount: number): Promise<MboxFile> {
    const now = new Date().toISOString();
    const [row] = await this.db
      .update(mboxFiles)
      .set({
        parse_status: 'parsed',
        parsed_at: now,
        raw_email_count: rawEmailCount,
        parse_error: null,
        updated_at: now,
      })
      .where(eq(mboxFiles.id, fileId))
      .returning();
    if (!row) throw new Error(`mbox_file ${fileId} not found`);
    return row;
  }

  async markFailed(fileId: string, error: string): Promise<MboxFile> {
    const [row] = await this.db
      .update(mboxFiles)
      .set({
        parse_status: 'failed',
        parse_error: error,
        updated_at: new Date().toISOString(),
      })
      .where(eq(mboxFiles.id, fileId))
      .returning();
    if (!row) throw new Error(`mbox_file ${fileId} not found`);
    return row;
  }
}
