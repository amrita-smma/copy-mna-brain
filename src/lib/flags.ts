import { flag } from "flags/next";
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
