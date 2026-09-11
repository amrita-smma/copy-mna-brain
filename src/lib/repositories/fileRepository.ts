import { and, asc, desc, eq, ilike, isNull, notInArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { files } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export interface FileAgentSearchOptions {
  companyName?: string;
  tag?: string;
  searchTerm?: string;
  limit?: number;
}

/** Columns the Smart Files list view is allowed to sort by. */
export type FileSortField = 'file_name' | 'file_date' | 'processing_status' | 'created_at';

export interface FileListOptions {
  /** Restrict to a single `file_type` bucket; omit for all types. */
  fileType?: string;
  /** Free-text query matched against file_name, tags and matched company names. */
  search?: string;
  sortField?: FileSortField;
  sortDirection?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface FileListResult {
  rows: Tables<'files'>[];
  /** Total rows matching the filter/search, ignoring limit/offset. */
  total: number;
}

/** File types that have their own dedicated tab in the Smart Files view. */
const DEDICATED_FILE_TYPES = [
  'mom',
  'prospectus',
  'shopping_list',
  'banker_communications',
  'fund_updates',
  'market_study',
] as const;

const FILE_SORT_COLUMNS: Record<FileSortField, AnyColumn> = {
  file_name: files.file_name,
  file_date: files.file_date,
  processing_status: files.processing_status,
  created_at: files.created_at,
};

export class FileRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async findById(id: string, executor?: DbClient): Promise<Tables<'files'>> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)))
      .limit(1);
    if (!row) throw new Error(`File ${id} not found`);
    return row;
  }

  async findByIdForUpdate(id: string, executor: DbClient): Promise<Tables<'files'>> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspace_id, this.workspaceId)))
      .for('update')
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

  /** Oldest file uploaded under `fileName` within this workspace, or null. */
  async findFirstByName(fileName: string): Promise<Tables<'files'> | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.file_name, fileName), eq(files.workspace_id, this.workspaceId)))
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
   * Paginated + searchable + sortable listing backing the Smart Files view.
   * The view used to load every row and filter/sort/paginate in the browser;
   * this pushes all three server-side so only one page is ever fetched.
   *
   * Search matches file_name, any tag, or any matched company name (the same
   * three fields the old client-side filter compared). Files awaiting review
   * are always pinned to the top, then the caller's sort is applied with NULLS
   * LAST so unset dates sort to the bottom in either direction. Returns the
   * page rows alongside the unpaginated total so the caller can render page
   * counts.
   */
  async listPaginated(opts: FileListOptions): Promise<FileListResult> {
    const { fileType, search, sortField = 'file_date', sortDirection = 'desc', limit, offset } = opts;

    const conditions: (SQL | undefined)[] = [eq(files.workspace_id, this.workspaceId)];
    if (fileType === 'other') {
      // Capture every type that doesn't have its own dedicated tab, including
      // financial_statement and any future classifier outputs.
      conditions.push(
        or(isNull(files.file_type), notInArray(files.file_type, [...DEDICATED_FILE_TYPES])),
      );
    } else if (fileType) {
      conditions.push(eq(files.file_type, fileType));
    }

    const term = search?.trim();
    if (term) {
      const like = `%${term}%`;
      conditions.push(
        or(
          ilike(files.file_name, like),
          sql`EXISTS (SELECT 1 FROM unnest(${files.tags}) AS tag WHERE tag ILIKE ${like})`,
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${files.matched_companies}) AS mc WHERE mc->>'name' ILIKE ${like})`,
        ),
      );
    }

    const where = and(...conditions);
    const sortColumn = FILE_SORT_COLUMNS[sortField] ?? files.file_date;
    const directionSql = sortDirection === 'asc' ? asc(sortColumn) : desc(sortColumn);

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(files)
        .where(where)
        .orderBy(sql`(${files.processing_status} = 'awaiting_review') DESC`, sql`${directionSql} NULLS LAST`)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::int` }).from(files).where(where),
    ]);

    return { rows, total };
  }

  /**
   * Returns file counts for every tab bucket in a single query.
   * "other" captures all types not in DEDICATED_FILE_TYPES (including NULL).
   */
  async countsByType(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        file_type: files.file_type,
        count: sql<number>`count(*)::int`,
      })
      .from(files)
      .where(eq(files.workspace_id, this.workspaceId))
      .groupBy(files.file_type);

    const dedicated = new Set<string>(DEDICATED_FILE_TYPES);
    const counts: Record<string, number> = {
      mom: 0,
      prospectus: 0,
      shopping_list: 0,
      banker_communications: 0,
      fund_updates: 0,
      market_study: 0,
      other: 0,
    };

    for (const row of rows) {
      const ft = row.file_type;
      if (ft && dedicated.has(ft)) {
        counts[ft] = (counts[ft] ?? 0) + row.count;
      } else {
        counts.other += row.count;
      }
    }

    return counts;
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

  async updatePartial(id: string, updates: TablesUpdate<'files'>, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor)
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
  /**
   * Smart Files linked to a company via `matched_companies`, newest first.
   *
   * Company Card regeneration reads these to pick up information that only
   * exists in an uploaded file (MoM, prospectus, financials) and to compare
   * each file's date against the card's `created_at`.
   */
  async findByMatchedCompanyId(companyId: string, limit = 50): Promise<Tables<'files'>[]> {
    return this.db
      .select()
      .from(files)
      .where(
        and(
          sql`${files.matched_companies} @> ${JSON.stringify([{ id: companyId }])}::jsonb`,
          eq(files.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(files.file_date), desc(files.created_at))
      .limit(limit);
  }

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
