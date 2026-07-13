import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

function booleanFlag(key: string, value: boolean) {
  return flag<boolean>({
    key,
    defaultValue: value,
    ...(process.env.FLAGS
      ? { adapter: vercelAdapter<boolean, any>() }
      : { decide: () => value }),
  });
}

export const crmGoogleVaultSyncEnabled = booleanFlag(
  "CRM_GOOGLE_VAULT_SYNC",
  process.env.CRM_GOOGLE_VAULT_SYNC === "true",
);

export const taskNotificationsEnabled = booleanFlag(
  "TASK_NOTIFICATIONS_ENABLED",
  process.env.TASK_NOTIFICATIONS_ENABLED === "true",
);

export const companyGraphEnabled = booleanFlag(
  "COMPANY_GRAPH_ENABLED",
  process.env.COMPANY_GRAPH_ENABLED === "true",
);

export const insightsDashboardEnabled = booleanFlag(
  "INSIGHTS_DASHBOARD_ENABLED",
  process.env.INSIGHTS_DASHBOARD_ENABLED === "true",
);

export const chatCacheEnabled = booleanFlag(
  "CHAT_CACHE_ENABLED",
  process.env.CHAT_CACHE_ENABLED === "true",
);

export const fundManagementEnabled = booleanFlag(
  "FUND_MANAGEMENT_ENABLED",
  process.env.FUND_MANAGEMENT_ENABLED === "true",
);
