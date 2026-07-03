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
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<Tables<'files'>> {
    const [row] = await this.db.select().from(files).where(eq(files.id, id)).limit(1);
    if (!row) throw new Error(`File ${id} not found`);
    return row;
  }

  async findLinkAndNameById(
    id: string,
  ): Promise<Pick<Tables<'files'>, 'file_link' | 'file_name'>> {
    const [row] = await this.db
      .select({ file_link: files.file_link, file_name: files.file_name })
      .from(files)
      .where(eq(files.id, id))
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
    return this.db
      .select()
      .from(files)
      .where(fileType ? eq(files.file_type, fileType) : undefined)
      .orderBy(desc(files.created_at));
  }

  async insert(data: TablesInsert<'files'>): Promise<Tables<'files'>> {
    const [row] = await this.db.insert(files).values(data).returning();
    return row;
  }

  async update(id: string, updates: TablesUpdate<'files'>): Promise<Tables<'files'>> {
    const [row] = await this.db.update(files).set(updates).where(eq(files.id, id)).returning();
    if (!row) throw new Error(`File ${id} not found`);
    return row;
  }

  async updatePartial(id: string, updates: TablesUpdate<'files'>): Promise<void> {
    await this.db.update(files).set(updates).where(eq(files.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(files).where(eq(files.id, id));
  }

  /**
   * Search used by the AI agent tools. Supports filtering by company name
   * (matches raw_notes / structured_notes), tag (via array containment), and a
   * general search term across file_name / notes. Results ordered by file_date
   * descending, capped at 20.
   */
  async searchForAgent(opts: FileAgentSearchOptions): Promise<Tables<'files'>[]> {
    const { companyName, tag, searchTerm, limit = 20 } = opts;
    const conditions: (SQL | undefined)[] = [];

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
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(files.file_date))
      .limit(Math.min(limit, 20));
  }
}
