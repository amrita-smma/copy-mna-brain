import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default withWorkflow(nextConfig);
