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

export const crmEnabled = booleanFlag(
  "CRM_ENABLED",
  process.env.CRM_ENABLED === "true",
);

export const aiWorkforceEnabled = booleanFlag(
  "AI_WORKFORCE_ENABLED",
  process.env.AI_WORKFORCE_ENABLED === "true",
);

export const crmGoogleVaultSyncEnabled = booleanFlag(
  "CRM_GOOGLE_VAULT_SYNC",
  process.env.CRM_GOOGLE_VAULT_SYNC === "true",
);
