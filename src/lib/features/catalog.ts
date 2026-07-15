/**
 * Canonical registry of the app's toggleable features.
 *
 * A superadmin can override each feature's state per workspace at runtime from
 * the admin portal's Features tab; the override is persisted in the
 * `feature_flags` table (see FeatureFlagRepository) and consulted by
 * `@/lib/flags` / `resolveFeatureOverride` for the request's active workspace.
 * When no override row exists, the effective state is {@link featureEnvDefault}
 * — the env var when set, otherwise the catalog's `defaultEnabled`.
 *
 * Two kinds of entries live here:
 *  - Flags with a code-level consumer, exported from `@/lib/flags` (e.g.
 *    `COMPANY_GRAPH_ENABLED`, `CHAT_CACHE_ENABLED`).
 *  - Navigation features whose only gate is the sidebar in `DashboardLayout`
 *    (e.g. `PIPELINE_ENABLED`, `MASTER_DATA_ENABLED`). These default ON so the
 *    app is unchanged until an admin turns one off.
 *
 * This is a plain data module with no server-only imports, so it is safe to
 * import from both server and client code.
 */

export interface FeatureDefinition {
  /** Stable identifier — also the env-var name and (for `@/lib/flags`) the flag key. */
  key: string;
  /** Human label shown in the admin Features tab. */
  label: string;
  /** One-line explanation of what the feature does. */
  description: string;
  /**
   * State to use when neither an env var nor a per-workspace override is set.
   * Navigation features default `true` (visible); opt-in flags default `false`.
   */
  defaultEnabled: boolean;
  /**
   * True when this feature is a sidebar section in `DashboardLayout` (its `key`
   * matches a `baseNavigation` item's `flag`). False for features that aren't
   * on the navbar (in-page flags, background/sub-features). Drives the
   * Navigation vs. Other sub-tabs in the admin Features tab.
   */
  navItem: boolean;
}

/**
 * Every feature that can be turned on/off from the admin portal. Nav-feature
 * keys must match the `flag` fields in `DashboardLayout`'s `baseNavigation`.
 */
export const FEATURE_CATALOG: FeatureDefinition[] = [
  // ── Navigation features (sidebar entries) — default ON ──────────────────
  {
    key: 'DASHBOARD_ENABLED',
    label: 'Dashboard',
    description: 'Overview dashboard with pipeline KPIs and recent activity.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'PIPELINE_ENABLED',
    label: 'Pipeline',
    description: 'Deal pipeline board across screening and diligence stages.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'MASTER_DATA_ENABLED',
    label: 'Master Data',
    description: 'Company master data — the canonical company records and fields.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'CRM_ENABLED',
    label: 'CRM',
    description: 'Relationship CRM — correspondents, employers, topics, and notes.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'AI_FILE_DUMP_ENABLED',
    label: 'AI File Dump',
    description: 'Bulk file ingestion for AI extraction and enrichment.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'PRESENTATION_ENABLED',
    label: 'Presentation',
    description: 'Slide/presentation builder for deal materials.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'AI_WORKFORCE_ENABLED',
    label: 'AI Workforce',
    description: 'Autonomous AI agent tasks and routines.',
    defaultEnabled: true,
    navItem: true,
  },
  {
    key: 'COMPANY_GRAPH_ENABLED',
    label: 'Company Graph',
    description: 'Interactive relationship graph linking companies, deals, and stakeholders.',
    defaultEnabled: false,
    navItem: true,
  },
  {
    key: 'FUND_MANAGEMENT_ENABLED',
    label: 'Fund Management',
    description: 'Fund portfolio, holding entities, and per-asset transaction & valuation ledgers.',
    defaultEnabled: false,
    navItem: true,
  },
  // ── Not on the navbar: in-page flags & background/sub-features (default OFF) ──
  {
    key: 'INSIGHTS_DASHBOARD_ENABLED',
    label: 'Insights Dashboard',
    description: 'Pipeline funnel analytics, conversion rates, and stale-deal insights on the dashboard.',
    defaultEnabled: false,
    navItem: false,
  },
  {
    key: 'TASK_NOTIFICATIONS_ENABLED',
    label: 'Task Notifications',
    description: 'Email notifications for task assignments and status changes.',
    defaultEnabled: false,
    navItem: false,
  },
  {
    key: 'CRM_GOOGLE_VAULT_SYNC',
    label: 'CRM Google Vault Sync',
    description: 'Ingest CRM correspondence from Google Vault into the workspace.',
    defaultEnabled: false,
    navItem: false,
  },
  {
    key: 'CHAT_CACHE_ENABLED',
    label: 'Chat Cache',
    description: 'Cache and reuse Copilot chat responses to speed up repeat queries.',
    defaultEnabled: false,
    navItem: false,
  },
];

const CATALOG_BY_KEY = new Map(FEATURE_CATALOG.map((f) => [f.key, f]));

/** Set of valid feature keys, for validating incoming toggle requests. */
export const FEATURE_KEYS = new Set(FEATURE_CATALOG.map((f) => f.key));

/**
 * The default (unoverridden) enabled state for a feature: the env var when it's
 * explicitly `"true"`/`"false"`, otherwise the catalog's `defaultEnabled`. This
 * is the single source of truth for a feature's baseline, shared by
 * `@/lib/flags` and `FeatureFlagsService`.
 */
export function featureEnvDefault(key: string): boolean {
  const env = process.env[key];
  if (env === 'true') return true;
  if (env === 'false') return false;
  return CATALOG_BY_KEY.get(key)?.defaultEnabled ?? false;
}
