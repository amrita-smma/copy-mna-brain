import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
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
  pgClient: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
}> {
  const { host, port, database, user, password } = parseExplicitDbFromEnv();
  const useIam = rdsIamDbAuthFromEnv();

  const sslEnv = process.env.DB_SSL?.trim().toLowerCase();
  const useSsl = sslEnv === 'false' || isLocalPostgresHost(host) ? false : true;

  const resolvedPassword = useIam ? await rdsIamAuthToken(host, port, user) : password;

  const pgClient = new pg.Pool({
    host,
    port,
    database,
    user,
    password: resolvedPassword,
    ssl: useSsl,
    connectionTimeoutMillis: 20000,
    max: 1, // Lambdas should only use one connection each
  });

  const db = drizzle(pgClient, { schema });
  return { pgClient, db };
}
