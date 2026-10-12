import { flag } from "flags/next";
import { memoryDeploymentEnabled } from "./memory/switch";
import { vercelAdapter } from "@flags-sdk/vercel";
import { featureEnvDefault } from "./features/catalog";
import { resolveFeatureOverride } from "./features/overrides";

/**
 * Build a boolean feature flag whose default comes from the env var named
 * `key`, layered so a runtime admin override (persisted in `app_settings` and
 * managed from the admin portal's Features tab) takes precedence. When no
 * override is set the flag behaves exactly as before — Vercel adapter when
 * `FLAGS` is configured, otherwise the static env default.
 */
function booleanFlag(key: string) {
  const value = featureEnvDefault(key);
  const base = flag<boolean>({
    key,
    defaultValue: value,
    ...(process.env.FLAGS
      ? { adapter: vercelAdapter<boolean, any>() }
      : { decide: () => value }),
  });
  const wrapped = async () => {
    const override = await resolveFeatureOverride(key);
    if (override !== undefined) return override;
    return base();
  };
  return Object.assign(wrapped, base) as typeof base;
}

export const crmGoogleVaultSyncEnabled = booleanFlag("CRM_GOOGLE_VAULT_SYNC");

export const taskNotificationsEnabled = booleanFlag("TASK_NOTIFICATIONS_ENABLED");

export const companyGraphEnabled = booleanFlag("COMPANY_GRAPH_ENABLED");

export const insightsDashboardEnabled = booleanFlag("INSIGHTS_DASHBOARD_ENABLED");

export const chatCacheEnabled = booleanFlag("CHAT_CACHE_ENABLED");

export const fundManagementEnabled = booleanFlag("FUND_MANAGEMENT_ENABLED");

export const ledgerEnabled = booleanFlag("LEDGER_ENABLED");

export const sourceOfFundsEnabled = booleanFlag("SOURCE_OF_FUNDS_ENABLED");

export const fundVehicleViewEnabled = booleanFlag("FUND_VEHICLE_VIEW_ENABLED");

export const corporateActionsEnabled = booleanFlag("CORPORATE_ACTIONS_ENABLED");

export const insightsEnabled = booleanFlag("INSIGHTS_ENABLED");

/**
 * The CoPilot's long-term memory (mem0) — a deployment-wide kill-switch, ON by
 * default.
 *
 * Deliberately NOT a `booleanFlag`, and deliberately absent from
 * `FEATURE_CATALOG`: memory is a per-user setting
 * (`users.copilot_memory_enabled`, owned from Profile → Memory), not a
 * per-workspace one, so there must be no admin-portal toggle that turns it off
 * for one workspace's members.
 *
 * The implementation lives in `@/lib/memory/switch` — a module with no imports
 * — so `UserMemoryService` can enforce it without pulling `flags/next` into the
 * service layer, and so this file stays cheap to import. This is the
 * route-facing alias, async to match every other flag's call shape.
 *
 * Set `COPILOT_MEMORY_ENABLED=false` to switch memory off for the whole
 * deployment regardless of anyone's preference.
 */
export async function copilotMemoryEnabled(): Promise<boolean> {
  return memoryDeploymentEnabled();
}
