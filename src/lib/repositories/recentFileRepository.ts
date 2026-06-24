import { desc, eq, sql } from 'drizzle-orm';
import { recentFiles } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export interface RecentFileListOptions {
  limit: number;
  offset: number;
}

export class RecentFileRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Records that a user opened a file. Re-opening the same file (same
   * user_id + file_key) bumps opened_at and refreshes the display name
   * instead of inserting a duplicate row.
   */
  async recordOpen(userId: string, fileName: string, fileKey: string): Promise<void> {
    await this.db
      .insert(recentFiles)
      .values({ user_id: userId, file_name: fileName, file_key: fileKey })
      .onConflictDoUpdate({
        target: [recentFiles.user_id, recentFiles.file_key],
        set: { file_name: fileName, opened_at: sql`now()` },
      });
  }

  async listByUser(
    userId: string,
    { limit, offset }: RecentFileListOptions,
  ): Promise<Tables<'recent_files'>[]> {
    return this.db
      .select()
      .from(recentFiles)
      .where(eq(recentFiles.user_id, userId))
      .orderBy(desc(recentFiles.opened_at))
      .limit(limit)
      .offset(offset);
  }

  async countByUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(recentFiles)
      .where(eq(recentFiles.user_id, userId));
    return row?.count ?? 0;
  }
}
