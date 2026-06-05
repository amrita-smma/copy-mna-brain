/**
 * Resolve a valid test user's email/password from environment variables,
 * picking the staging or production set based on `TEST_ENV` (defaults to
 * `staging`). Keeping the two environments in separate vars avoids ever
 * pointing a staging run at production credentials by accident.
 *
 * Expected env vars:
 *   STAGING_TEST_EMAIL     / STAGING_TEST_PASSWORD
 *   PRODUCTION_TEST_EMAIL  / PRODUCTION_TEST_PASSWORD
 *   TEST_ENV=staging | production
 */
export type TestEnv = 'staging' | 'production';

export const getTestEnv = (): TestEnv =>
  process.env.TEST_ENV === 'production' ? 'production' : 'staging';

export const getTestCredentials = (): { email: string; password: string } => {
  const env = getTestEnv();
  const prefix = env === 'production' ? 'PRODUCTION' : 'STAGING';

  const email = process.env[`${prefix}_TEST_EMAIL`];
  const password = process.env[`${prefix}_TEST_PASSWORD`];

  if (!email || !password) {
    throw new Error(
      `Missing test credentials for "${env}". Set ${prefix}_TEST_EMAIL and ${prefix}_TEST_PASSWORD.`,
    );
  }

  return { email, password };
};
