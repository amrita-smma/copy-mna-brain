import { desc, eq, sql } from 'drizzle-orm';
import { featureFlags, users } from '@/lib/db/schema';
import type { DbClient } from './types';

/** A workspace's stored feature-flag overrides plus latest-change audit meta. */
export interface WorkspaceFeatureOverrides {
  /** Map of feature key → enabled, for keys with a stored override row. */
  overrides: Record<string, boolean>;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null; email: string | null } | null;
}

/**
 * Per-workspace feature-flag overrides in the `feature_flags` table. One row =
 * one feature's on/off state for one workspace. Pure data access — the merge
 * with catalog/env defaults happens in FeatureFlagsService.
 */
export class FeatureFlagRepository {
  constructor(private db: DbClient) {}

  /** Every stored override for a workspace as a map, plus latest audit meta. */
  async findByWorkspace(workspaceId: string): Promise<WorkspaceFeatureOverrides> {
    const rows = await this.db
      .select({
        featureKey: featureFlags.feature_key,
        enabled: featureFlags.enabled,
        updatedAt: featureFlags.updated_at,
        updatedById: featureFlags.updated_by,
        updatedByName: users.name,
        updatedByEmail: users.email,
      })
      .from(featureFlags)
      .leftJoin(users, eq(users.id, featureFlags.updated_by))
      .where(eq(featureFlags.workspace_id, workspaceId))
      .orderBy(desc(featureFlags.updated_at));

    const overrides: Record<string, boolean> = {};
    for (const row of rows) overrides[row.featureKey] = row.enabled;

    const latest = rows[0]; // ordered updated_at desc
    return {
      overrides,
      updatedAt: latest?.updatedAt ?? null,
      updatedBy: latest?.updatedById
        ? {
            id: latest.updatedById,
            name: latest.updatedByName ?? null,
            email: latest.updatedByEmail ?? null,
          }
        : null,
    };
  }

  /** Lightweight override map for flag resolution — no user join, no meta. */
  async getOverrideMap(workspaceId: string): Promise<Record<string, boolean>> {
    const rows = await this.db
      .select({ featureKey: featureFlags.feature_key, enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.workspace_id, workspaceId));
    const map: Record<string, boolean> = {};
    for (const row of rows) map[row.featureKey] = row.enabled;
    return map;
  }

  /** Turn one feature on/off for a workspace (insert or update the row). */
  async upsert(
    workspaceId: string,
    featureKey: string,
    enabled: boolean,
    updatedBy?: string | null,
  ): Promise<void> {
    await this.db
      .insert(featureFlags)
      .values({
        workspace_id: workspaceId,
        feature_key: featureKey,
        enabled,
        updated_by: updatedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [featureFlags.workspace_id, featureFlags.feature_key],
        set: { enabled, updated_by: updatedBy ?? null, updated_at: sql`now()` },
      });
  }
}
