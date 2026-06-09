import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/repositories';

/**
 * The analytics materialized views, in dependency-free refresh order. These are
 * the only names ever interpolated into the raw REFRESH statement, so the
 * `sql.raw` below is safe — there is no user input.
 */
export const MART_VIEWS = ['mart_crm', 'mart_mom', 'mart_topics'] as const;
export type MartView = (typeof MART_VIEWS)[number];

/**
 * Read-only data access for the precomputed analytics marts (RFC MB-205 §Phase
 * 5). Refresh is the only DB operation we own here — the marts are populated at
 * creation (`CREATE MATERIALIZED VIEW … AS SELECT`, no `WITH NO DATA`), so this
 * keeps them in step with `analytics.emails` after each ingest.
 */
export class MartRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * `REFRESH MATERIALIZED VIEW CONCURRENTLY` a single mart. CONCURRENTLY needs
   * the mart's UNIQUE index (all three have one) and must run OUTSIDE any
   * transaction — callers invoke this after their write tx has committed.
   */
  async refresh(view: MartView): Promise<void> {
    await this.db.execute(
      sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.${view}`),
    );
  }

  /**
   * Refresh every mart, isolating failures: a missing/erroring view (e.g. the
   * 4a migration hasn't been applied yet) must not abort the others or the
   * caller's already-committed work. Returns the names that refreshed cleanly.
   */
  async refreshAll(): Promise<MartView[]> {
    const refreshed: MartView[] = [];
    for (const view of MART_VIEWS) {
      try {
        await this.refresh(view);
        refreshed.push(view);
      } catch (err) {
        console.error(`[mart-refresh] failed to refresh analytics.${view}:`, err);
      }
    }
    return refreshed;
  }
}
