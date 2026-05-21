import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

export const crmEnabled = flag<boolean>({
  key: "CRM_ENABLED",
  defaultValue: process.env.CRM_ENABLED === "true",
  adapter: vercelAdapter(),
});

export const aiWorkforceEnabled = flag<boolean>({
  key: "AI_WORKFORCE_ENABLED",
  defaultValue: process.env.AI_WORKFORCE_ENABLED === "true",
  adapter: vercelAdapter(),
});

export const crmGoogleVaultSyncEnabled = flag<boolean>({
  key: "CRM_GOOGLE_VAULT_SYNC",
  defaultValue: process.env.CRM_GOOGLE_VAULT_SYNC === "true",
  adapter: vercelAdapter(),
});
