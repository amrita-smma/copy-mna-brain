import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { files } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export interface FileAgentSearchOptions {
  companyName?: string;
  tag?: string;
  searchTerm?: string;
  limit?: number;
}

export class FileRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async findById(id: string): Promise<Tables<'files'>> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)))
      .limit(1);
    if (!row) throw new Error(`File ${id} not found`);
    return row;
  }

  async findLinkAndNameById(
    id: string,
  ): Promise<Pick<Tables<'files'>, 'file_link' | 'file_name'>> {
    const [row] = await this.db
      .select({ file_link: files.file_link, file_name: files.file_name })
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)))
      .limit(1);
    if (!row) throw new Error(`File ${id} not found`);
    return row;
  }

  /** Oldest file uploaded under `fileName`, or null. */
  async findFirstByName(fileName: string): Promise<Tables<'files'> | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(eq(files.file_name, fileName))
      .orderBy(files.created_at)
      .limit(1);
    return row ?? null;
  }

  async findAll(fileType?: string): Promise<Tables<'files'>[]> {
    const workspaceCond = eq(files.workspace_id, this.workspaceId);
    return this.db
      .select()
      .from(files)
      .where(fileType ? and(eq(files.file_type, fileType), workspaceCond) : workspaceCond)
      .orderBy(desc(files.created_at));
  }

  /**
   * Fan-out insert: the attachment pipeline resolves the target workspace(s)
   * for a custodian mailbox and calls this once per workspace, so callers
   * must supply `workspace_id` explicitly rather than it being bound at
   * construction (unlike every other workspace-scoped repository).
   */
  async insert(data: TablesInsert<'files'>): Promise<Tables<'files'>> {
    const [row] = await this.db.insert(files).values(data).returning();
    return row;
  }

  async update(id: string, updates: TablesUpdate<'files'>): Promise<Tables<'files'>> {
    const [row] = await this.db
      .update(files)
      .set(updates)
      .where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)))
      .returning();
    if (!row) throw new Error(`File ${id} not found`);
    return row;
  }

  async updatePartial(id: string, updates: TablesUpdate<'files'>): Promise<void> {
    await this.db
      .update(files)
      .set(updates)
      .where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(files).where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)));
  }

  /**
   * Strip a company reference out of every file's `matched_companies` array.
   * Called when a company is deleted so no file points at a company that no
   * longer exists. Only rows that actually reference the company are touched
   * (the `@>` containment guard), and `jsonb_agg` is coalesced to an empty
   * array so a file whose sole match was this company ends up with `[]`.
   */
  async removeMatchedCompany(companyId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE ${files}
      SET matched_companies = COALESCE(
            (
              SELECT jsonb_agg(elem)
              FROM jsonb_array_elements(${files.matched_companies}) AS elem
              WHERE elem->>'id' <> ${companyId}
            ),
            '[]'::jsonb
          ),
          updated_at = now()
      WHERE ${files.matched_companies} @> ${JSON.stringify([{ id: companyId }])}::jsonb
    `);
  }

  /**
   * Search used by the AI agent tools. Supports filtering by company name
   * (matches raw_notes / structured_notes), tag (via array containment), and a
   * general search term across file_name / notes. Results ordered by file_date
   * descending, capped at 20.
   */
  async searchForAgent(opts: FileAgentSearchOptions): Promise<Tables<'files'>[]> {
    const { companyName, tag, searchTerm, limit = 20 } = opts;
    const conditions: (SQL | undefined)[] = [eq(files.workspace_id, this.workspaceId)];

    if (companyName) {
      conditions.push(
        or(
          ilike(files.raw_notes, `%${companyName}%`),
          ilike(files.structured_notes, `%${companyName}%`),
        ),
      );
    }
    if (tag) {
      conditions.push(sql`${files.tags} @> ARRAY[${tag}]::text[]`);
    }
    if (searchTerm) {
      conditions.push(
        or(
          ilike(files.file_name, `%${searchTerm}%`),
          ilike(files.raw_notes, `%${searchTerm}%`),
          ilike(files.structured_notes, `%${searchTerm}%`),
        ),
      );
    }

    return this.db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(desc(files.file_date))
      .limit(Math.min(limit, 20));
  }
}
