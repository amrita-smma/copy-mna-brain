import { sql } from 'drizzle-orm';
import type { DbClient } from './types';

/** A company claimed off the Pending Confirmation auto-scan queue. */
export interface ClaimedAutoScan {
  companyId: string;
  workspaceId: string;
  force: boolean;
}

/**
 * The Pending Confirmation auto-scan queue: `companies.auto_scan_requested_at`
 * marks set by `CompanyRepository.requestAutoScan*`. Deliberately NOT
 * workspace-scoped — the per-minute cron drains every workspace's queue, the
 * same way `JobRepository` and the AI Workforce queue are global.
 */
export class AutoScanQueueRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Atomically claim up to `limit` queued companies, oldest request first,
   * clearing their mark so a concurrent drain can't claim them too
   * (`FOR UPDATE SKIP LOCKED`). Returns each row's `force` as it was queued.
   */
  async claim(limit: number): Promise<ClaimedAutoScan[]> {
    if (limit <= 0) return [];
    const result = await this.db.execute<{
      id: string;
      workspace_id: string;
      auto_scan_force: boolean;
    }>(sql`
      WITH picked AS (
        SELECT id, workspace_id, auto_scan_force
        FROM companies
        WHERE auto_scan_requested_at IS NOT NULL
        ORDER BY auto_scan_requested_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE companies c
      SET auto_scan_requested_at = NULL,
          auto_scan_force = false
      FROM picked
      WHERE c.id = picked.id
      RETURNING picked.id, picked.workspace_id, picked.auto_scan_force
    `);
    const rows = (
      result as unknown as {
        rows: Array<{ id: string; workspace_id: string; auto_scan_force: boolean }>;
      }
    ).rows;
    return rows.map((r) => ({
      companyId: r.id,
      workspaceId: r.workspace_id,
      force: r.auto_scan_force,
    }));
  }
}
