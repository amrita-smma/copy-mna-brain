import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Load `.env.local` into the test runner process so specs can read test
// credentials (STAGING_/PRODUCTION_TEST_EMAIL, etc.) from `process.env`.
dotenv.config({ path: '.env.local' });

// Pick where the suite runs from `TEST_ENV` (matches e2e/helpers/credentials.ts):
//   unset | 'local' -> build & boot a local server, hit localhost:3000
//   'staging'       -> hit the deployed staging site, no local server
//   'production'    -> hit the deployed production site, no local server
const TEST_ENV = process.env.TEST_ENV ?? 'local';

// Base URLs come from the environment (see `.env.local` / `.env.example`) so the
// deployed hostnames are not hardcoded; fall back to localhost when unset.
const BASE_URLS: Record<string, string> = {
  local: process.env.LOCAL_BASE_URL ?? 'http://localhost:3000',
  staging: process.env.STAGING_BASE_URL ?? 'http://localhost:3000',
  production: process.env.PRODUCTION_BASE_URL ?? 'http://localhost:3000',
};

const baseURL = BASE_URLS[TEST_ENV] ?? BASE_URLS.local;
const isLocal = TEST_ENV === 'local';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  // Pages gated behind the NextAuth session fetch render a loading spinner
  // first, so the default 5s is tight on a cold navigation. Give web-first
  // assertions more headroom (they still resolve as soon as the element appears).
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    // The app registers a service worker (src/components/service-worker-register.tsx)
    // that intercepts navigations and serves a cached offline fallback on any
    // fetch failure. In tests that causes stale content and "couldn't load"
    // flake, so block it — specs always hit the network/mocks directly.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only build & boot a local server when debugging locally. Staging/production
  // runs target the already-deployed site, so there is nothing to start.
  webServer: isLocal
    ? {
        command: 'pnpm build && pnpm start',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        // Build + start can take longer than a dev boot, so allow more headroom.
        timeout: 240_000,
        env: {
          // Build without `output: "standalone"` so `next start` can serve it
          // (see next.config.ts). Without this the server never binds to :3000.
          NEXT_DISABLE_STANDALONE: '1',
          PORT: '3000',
          // A production build (unlike `next dev`) does not auto-trust the host, so
          // server-side Auth.js `auth()` calls throw UntrustedHost on localhost.
          // Vercel sets this automatically in real deployments.
          AUTH_TRUST_HOST: 'true',
          // Same secret the test runner uses to sign flag-override cookies, so the
          // server can decrypt and apply them (see the FLAGS_SECRET note above).
          FLAGS_SECRET: process.env.FLAGS_SECRET,
        },
      }
    : undefined,
});
