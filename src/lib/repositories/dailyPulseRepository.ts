import { and, eq, sql } from 'drizzle-orm';
import { dailyPulse } from '@/lib/db/schema';
import type { DbClient } from './types';

/**
 * Workspace-scoped data access for the "Today's Recap" daily pipeline pulse
 * cache (`daily_pulse`). One row per workspace per UTC day holds the assembled
 * pulse payload. Pure data access — the compute/narrate logic lives in
 * `DailyPulseService`.
 */
export class DailyPulseRepository {
  constructor(
    private db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /** The stored pulse payload for a UTC day (`YYYY-MM-DD`), or null when none. */
  async findByDate<T>(pulseDate: string): Promise<T | null> {
    const [row] = await this.db
      .select({ payload: dailyPulse.payload })
      .from(dailyPulse)
      .where(
        and(
          eq(dailyPulse.workspace_id, this.workspaceId),
          eq(dailyPulse.pulse_date, pulseDate),
        ),
      )
      .limit(1);
    return (row?.payload ?? null) as T | null;
  }

  /** Upsert the pulse payload for a UTC day (bumps `updated_at` on refresh). */
  async upsert(pulseDate: string, payload: unknown): Promise<void> {
    await this.db
      .insert(dailyPulse)
      .values({ workspace_id: this.workspaceId, pulse_date: pulseDate, payload })
      .onConflictDoUpdate({
        target: [dailyPulse.workspace_id, dailyPulse.pulse_date],
        set: { payload, updated_at: sql`now()` },
      });
  }
}
