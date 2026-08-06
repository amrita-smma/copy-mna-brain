import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { IFRAME_EMBED_ENABLED, getAllowedAncestorOrigins } from "./src/lib/iframe";

// `frame-ancestors` controls who may embed this app in an <iframe>. When
// embedding is enabled we permit the launcher origins (plus 'self'); otherwise
// we lock framing down to same-origin as clickjacking hardening. We rely on
// this CSP directive rather than `X-Frame-Options` (which we never send) —
// `frame-ancestors` is the modern mechanism and overrides X-Frame-Options.
const frameAncestors = IFRAME_EMBED_ENABLED
  ? ["'self'", ...getAllowedAncestorOrigins()].join(" ")
  : "'self'";

const nextConfig: NextConfig = {
  // Apply `frame-ancestors` to every route so page and asset responses alike
  // are (dis)allowed from framing consistently.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${frameAncestors};`,
          },
        ],
      },
    ];
  },
  // `output: "standalone"` is for self-host / Docker-style deploys.
  // Disable it when:
  // - Playwright e2e sets NEXT_DISABLE_STANDALONE (next start can't serve standalone)
  // - Vercel (VERCEL=1): Next 16.3+ Turbopack skips next-server.js.nft.json when
  //   build adapters run (e.g. withWorkflow), so writeStandaloneDirectory fails
  //   with ENOENT. Vercel ignores the standalone folder anyway.
  output:
    process.env.NEXT_DISABLE_STANDALONE || process.env.VERCEL
      ? undefined
      : "standalone",
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ["@resvg/resvg-js"],
};

export default withWorkflow(nextConfig);
