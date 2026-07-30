/**
 * Resolve a valid test user's email/password from environment variables,
 * picking the local, staging, production, or preview set based on `TEST_ENV`
 * (defaults to `local`). Keeping the environments in separate vars avoids
 * ever pointing a run at the wrong environment's credentials by accident.
 *
 * Expected env vars:
 *   LOCAL_TEST_EMAIL       / LOCAL_TEST_PASSWORD
 *   STAGING_TEST_EMAIL     / STAGING_TEST_PASSWORD
 *   PRODUCTION_TEST_EMAIL  / PRODUCTION_TEST_PASSWORD
 *   PREVIEW_TEST_EMAIL     / PREVIEW_TEST_PASSWORD
 *   TEST_ENV=local | staging | production | preview
 *
 * Base URLs (see also `playwright.config.ts`):
 *   LOCAL_BASE_URL / STAGING_BASE_URL / PRODUCTION_BASE_URL / PREVIEW_BASE_URL
 */
export type TestEnv = 'local' | 'staging' | 'production' | 'preview';

export const getTestEnv = (): TestEnv => {
  switch (process.env.TEST_ENV) {
    case 'production':
      return 'production';
    case 'staging':
      return 'staging';
    case 'preview':
      return 'preview';
    default:
      return 'local';
  }
};

export const getBaseUrl = (): string => {
  const env = getTestEnv();
  const defaults: Record<TestEnv, string> = {
    local: process.env.LOCAL_BASE_URL ?? 'http://localhost:3000',
    staging: process.env.STAGING_BASE_URL ?? 'http://localhost:3000',
    production: process.env.PRODUCTION_BASE_URL ?? 'http://localhost:3000',
    preview: process.env.PREVIEW_BASE_URL ?? 'http://localhost:3000',
  };
  return defaults[env];
};

export const getTestCredentials = (): { email: string; password: string } => {
  const env = getTestEnv();
  const prefix = env.toUpperCase();

  const email = process.env[`${prefix}_TEST_EMAIL`];
  const password = process.env[`${prefix}_TEST_PASSWORD`];

  if (!email || !password) {
    throw new Error(
      `Missing test credentials for "${env}". Set ${prefix}_TEST_EMAIL and ${prefix}_TEST_PASSWORD.`,
    );
  }

  return { email, password };
};
