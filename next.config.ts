import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default nextConfig;
