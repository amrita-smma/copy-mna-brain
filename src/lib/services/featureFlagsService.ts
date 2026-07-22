import type { FeatureFlagRepository } from '@/lib/repositories/featureFlagRepository';
import { FEATURE_CATALOG, FEATURE_KEYS, featureEnvDefault } from '@/lib/features/catalog';

/** Who last changed the feature-flag overrides for a workspace, and when. */
export interface FeatureFlagsMeta {
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null; email: string | null } | null;
}

/** One feature's resolved state for the admin Features tab. */
export interface FeatureFlagState {
  key: string;
  label: string;
  description: string;
  /** Effective state: the admin override if set, else the env/catalog default. */
  enabled: boolean;
  /** True when a per-workspace override row exists (i.e. differs from the default source). */
  isOverridden: boolean;
  /** True when this feature is a sidebar section; false when it's not on the navbar. */
  navItem: boolean;
  /** Which admin settings tab surfaces this toggle — 'general' (Features) or 'funds'. */
  category: 'general' | 'funds';
}

/** Raised when a toggle targets a feature key that isn't in the catalog. */
export class UnknownFeatureError extends Error {
  constructor(key: string) {
    super(`Unknown feature: ${key}`);
    this.name = 'UnknownFeatureError';
  }
}

/**
 * Reads and writes the per-workspace runtime feature-flag overrides that back
 * the admin portal's Features tab. Overrides are stored one row per
 * (workspace, feature) in the `feature_flags` table (via
 * {@link FeatureFlagRepository}); the effective state of each feature is its
 * override when a row exists, else the env/catalog default from
 * `@/lib/features/catalog`.
 */
export class FeatureFlagsService {
  constructor(private repo: FeatureFlagRepository) {}

  /** Every catalog feature with its effective state (for `workspaceId`) and audit metadata. */
  async listFeatures(
    workspaceId: string,
  ): Promise<{ features: FeatureFlagState[]; meta: FeatureFlagsMeta }> {
    const { overrides, updatedAt, updatedBy } = await this.repo.findByWorkspace(workspaceId);
    const features = FEATURE_CATALOG.map((def) => {
      const hasOverride = typeof overrides[def.key] === 'boolean';
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        enabled: hasOverride ? overrides[def.key] : featureEnvDefault(def.key),
        isOverridden: hasOverride,
        navItem: def.navItem,
        category: def.category ?? 'general',
      };
    });
    return { features, meta: { updatedAt, updatedBy } };
  }

  /**
   * Turn a single feature on or off for a workspace. Validates the key against
   * the catalog, upserts that workspace's row, and returns the refreshed list.
   * `updatedBy` is the id of the superadmin making the change.
   */
  async setFeature(
    workspaceId: string,
    key: string,
    enabled: boolean,
    updatedBy?: string | null,
  ): Promise<{ features: FeatureFlagState[]; meta: FeatureFlagsMeta }> {
    if (!FEATURE_KEYS.has(key)) {
      throw new UnknownFeatureError(key);
    }
    await this.repo.upsert(workspaceId, key, enabled, updatedBy ?? null);
    return this.listFeatures(workspaceId);
  }
}
