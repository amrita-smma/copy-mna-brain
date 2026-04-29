import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

export const crmEnabled = flag({
  key: "CRM_ENABLED",
  adapter: vercelAdapter(),
});
