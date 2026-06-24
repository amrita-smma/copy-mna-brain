import { getSignedUrl } from '@/lib/s3';
import type { RecentFileRepository } from '@/lib/repositories';

export interface RecentFileItem {
  id: string;
  file_name: string;
  file_key: string;
  opened_at: string | null;
}

export interface RecentFilePage {
  items: RecentFileItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const RECENT_FILES_PAGE_SIZE = 10;

export class RecentFileService {
  constructor(private readonly recentFileRepo: RecentFileRepository) {}

  /** Records (or refreshes) a file the user just opened in the Presentation page. */
  recordOpen(userId: string, fileName: string, fileKey: string) {
    return this.recentFileRepo.recordOpen(userId, fileName, fileKey);
  }

  /** Returns a page of the user's recently-opened files, most recent first. */
  async listRecent(userId: string, page: number): Promise<RecentFilePage> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const offset = (safePage - 1) * RECENT_FILES_PAGE_SIZE;

    const [rows, total] = await Promise.all([
      this.recentFileRepo.listByUser(userId, {
        limit: RECENT_FILES_PAGE_SIZE,
        offset,
      }),
      this.recentFileRepo.countByUser(userId),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        file_name: row.file_name,
        file_key: row.file_key,
        opened_at: row.opened_at,
      })),
      total,
      page: safePage,
      pageSize: RECENT_FILES_PAGE_SIZE,
    };
  }

  /**
   * Short-lived signed URL for viewing a file by its S3 key. No
   * Content-Disposition is set, so the browser renders it inline (in an
   * iframe / Office embed) instead of downloading it.
   */
  resolveSignedUrl(fileKey: string): Promise<string> {
    return getSignedUrl(fileKey, 3600);
  }

  /**
   * Short-lived signed URL that forces a download (Content-Disposition:
   * attachment) with the given file name.
   */
  resolveDownloadUrl(fileKey: string, fileName: string): Promise<string> {
    return getSignedUrl(fileKey, 3600, fileName);
  }
}
