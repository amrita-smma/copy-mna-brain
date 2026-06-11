import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // `next start` cannot serve a standalone build, so disable standalone output
  // for the Playwright e2e build (set via the webServer env in playwright.config.ts).
  // Real deployments leave this unset and keep the standalone output.
  output: process.env.NEXT_DISABLE_STANDALONE ? undefined : "standalone",
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default withWorkflow(nextConfig);
