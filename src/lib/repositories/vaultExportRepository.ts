import { desc, inArray } from 'drizzle-orm';
import { vaultExports } from '@/lib/db/schema';
import type { DbClient } from './types';

/** Statuses of an export whose mail has landed in the archive. */
const ARCHIVED_STATUSES = ['archived', 'archived_partial'];

/**
 * Read access to `analytics.vault_exports`, the pipeline's record of Google
 * Vault exports. Not workspace-scoped: a Vault export is one org-wide job
 * covering every synced custodian, so there is no per-workspace row to filter
 * on. The pipeline owns writes; the app only reads.
 */
export class VaultExportRepository {
  constructor(private db: DbClient) {}

  /** When the most recent export finished archiving, or null if none has. */
  async findLastArchivedAt(): Promise<string | null> {
    const rows = await this.db
      .select({ updated_at: vaultExports.updated_at })
      .from(vaultExports)
      .where(inArray(vaultExports.status, ARCHIVED_STATUSES))
      .orderBy(desc(vaultExports.updated_at))
      .limit(1);
    return rows[0]?.updated_at ?? null;
  }
}
