import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@/lib/db/schema';
import {
  parseExplicitDbFromEnv,
  rdsIamDbAuthFromEnv,
  rdsIamAuthToken,
  isLocalPostgresHost,
} from '@/lib/server/db';

/**
 * Create a short-lived postgres client + Drizzle DB instance for Lambda use.
 * Supports both password auth (local/SAM) and RDS IAM auth (staging/prod) via
 * RDS_IAM_DB_AUTH=true. Caller MUST call `pgClient.end()` in a finally block.
 */
export async function createLambdaDb(): Promise<{
  pgClient: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle<typeof schema>>;
}> {
  const { host, port, database, user, password } = parseExplicitDbFromEnv();
  const useIam = rdsIamDbAuthFromEnv();

  const sslEnv = process.env.DB_SSL?.trim().toLowerCase();
  const useSsl = sslEnv === 'false' || isLocalPostgresHost(host) ? false : ('require' as const);

  const resolvedPassword = useIam ? await rdsIamAuthToken(host, port, user) : password;

  const pgClient = postgres({
    host,
    port,
    database,
    user,
    password: resolvedPassword,
    ssl: useSsl,
    prepare: false,
    max: 1,
    idle_timeout: 20,
  });

  const db = drizzle(pgClient, { schema });
  return { pgClient, db };
}
