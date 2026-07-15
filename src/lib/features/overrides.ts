import { cache } from 'react';
import { createDb } from '@/lib/server/db';
import { FeatureFlagRepository } from '@/lib/repositories/featureFlagRepository';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { FEATURE_CATALOG, featureEnvDefault } from './catalog';

/**
 * Runtime, per-workspace feature-flag overrides set by a superadmin from the
 * admin portal.
 *
 * Each workspace's overrides live one row per (workspace, feature) in the
 * `feature_flags` table. `@/lib/flags` consults {@link resolveFeatureOverride},
 * which resolves the request's active workspace, so an admin toggle takes
 * precedence over the env/catalog default for that workspace only — without
 * every flag consumer having to change. {@link resolveWorkspaceFeatureFlags}
 * returns the fully-resolved map for the active workspace (used by the
 * navigation shell to gate sidebar items).
 */

const rawLoadOverrides = async (workspaceId: string): Promise<Record<string, boolean>> => {
  try {
    const db = createDb();
    const repo = new FeatureFlagRepository(db);
    return await repo.getOverrideMap(workspaceId);
  } catch {
    return {};
  }
};

// `cache` dedupes the read within a single RSC request (keyed by workspaceId);
// it's only defined in a React server runtime, so fall back to the raw loader
// elsewhere (e.g. tests).
const loadOverrides =
  typeof cache === 'function' ? cache(rawLoadOverrides) : rawLoadOverrides;

/**
 * Resolve the active workspace's override for a feature key: `true`/`false`
 * when an override row exists, or `undefined` when the caller should use the
 * env/catalog default. Short-circuits under vitest so unit tests never touch
 * the database.
 */
export async function resolveFeatureOverride(key: string): Promise<boolean | undefined> {
  if (process.env.VITEST) return undefined;
  try {
    const workspaceId = await getActiveWorkspaceId();
    const overrides = await loadOverrides(workspaceId);
    return typeof overrides[key] === 'boolean' ? overrides[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fully-resolved effective state of every catalog feature for a workspace:
 * the stored override when present, else the env/catalog default. Provided to
 * the client nav shell so `DashboardLayout` can gate sidebar items without
 * per-page prop threading. Pass `workspaceId` explicitly (the workspace layout
 * already knows it, and it may differ from `getActiveWorkspaceId()` for a
 * superadmin viewing a workspace they don't belong to); omit it to resolve the
 * request's active workspace.
 */
export async function resolveWorkspaceFeatureFlags(
  workspaceId?: string,
): Promise<Record<string, boolean>> {
  let overrides: Record<string, boolean> = {};
  if (!process.env.VITEST) {
    try {
      const wsId = workspaceId ?? (await getActiveWorkspaceId());
      overrides = await loadOverrides(wsId);
    } catch {
      overrides = {};
    }
  }
  const map: Record<string, boolean> = {};
  for (const def of FEATURE_CATALOG) {
    map[def.key] =
      typeof overrides[def.key] === 'boolean' ? overrides[def.key] : featureEnvDefault(def.key);
  }
  return map;
}
