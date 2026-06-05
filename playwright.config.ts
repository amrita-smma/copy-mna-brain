import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// Load `.env.local` into the test runner process so specs can read test
// credentials (STAGING_/PRODUCTION_TEST_EMAIL, etc.) from `process.env`.
dotenv.config({ path: '.env.local' });

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
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    // Build + start can take longer than a dev boot, so allow more headroom.
    timeout: 240_000,
    env: {
      __NEXT_PRIVATE_STANDALONE_CONFIG: '',
      __NEXT_PRIVATE_ORIGIN: '',
      NEXT_DEPLOYMENT_ID: '',
      PORT: '3000',
      // A production build (unlike `next dev`) does not auto-trust the host, so
      // server-side Auth.js `auth()` calls throw UntrustedHost on localhost.
      // Vercel sets this automatically in real deployments.
      AUTH_TRUST_HOST: 'true',
      // Same secret the test runner uses to sign flag-override cookies, so the
      // server can decrypt and apply them (see the FLAGS_SECRET note above).
      FLAGS_SECRET: process.env.FLAGS_SECRET,
    },
  },
});
