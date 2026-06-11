/**
 * Resolve a valid test user's email/password from environment variables,
 * picking the local, staging, or production set based on `TEST_ENV` (defaults
 * to `local`). Keeping the environments in separate vars avoids ever pointing
 * a run at the wrong environment's credentials by accident.
 *
 * Expected env vars:
 *   LOCAL_TEST_EMAIL       / LOCAL_TEST_PASSWORD
 *   STAGING_TEST_EMAIL     / STAGING_TEST_PASSWORD
 *   PRODUCTION_TEST_EMAIL  / PRODUCTION_TEST_PASSWORD
 *   TEST_ENV=local | staging | production
 */
export type TestEnv = 'local' | 'staging' | 'production';

export const getTestEnv = (): TestEnv => {
  switch (process.env.TEST_ENV) {
    case 'production':
      return 'production';
    case 'staging':
      return 'staging';
    default:
      return 'local';
  }
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
