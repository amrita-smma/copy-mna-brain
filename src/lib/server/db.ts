import { Signer } from '@aws-sdk/rds-signer';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/lib/db/schema';

export type PostgresClientFromEnvOptions = {
  onnotice?: () => void;
  connect_timeout?: number;
  prepare?: boolean;
};

export function rdsIamDbAuthFromEnv(): boolean {
  const value = process.env.RDS_IAM_DB_AUTH?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function parseExplicitDbFromEnv(): {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
} {
  const host = process.env.DB_HOST?.trim();
  const database = process.env.DB_NAME?.trim();
  const user = process.env.DB_USER?.trim();
  const port = Number(process.env.DB_PORT ?? '5432') || 5432;

  if (!host || !database || !user) {
    throw new Error('Database not configured: set DB_HOST, DB_PORT, DB_NAME, and DB_USER.');
  }

  const rawPw = process.env.DB_PASSWORD;
  const password = rawPw === undefined || rawPw === '' ? undefined : rawPw;
  return { host, port, database, user, password };
}

export async function rdsIamAuthToken(host: string, port: number, username: string): Promise<string> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error('Set AWS_REGION (or AWS_DEFAULT_REGION) for RDS IAM database authentication.');
  }
  const signer = new Signer({ hostname: host, port, region, username });
  return signer.getAuthToken();
}

export function isLocalPostgresHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost|postgres)$/i.test(host) || !host.includes('.');
}

// Retained for scripts that depend on tagged template literals or postgres.js internals
export function createPostgresClientFromEnv(
  extra: PostgresClientFromEnvOptions = {},
): ReturnType<typeof postgres> {
  const explicitDb = parseExplicitDbFromEnv();
  const useIam = rdsIamDbAuthFromEnv();

  if (useIam && explicitDb.password) {
    throw new Error('With RDS_IAM_DB_AUTH, leave DB_PASSWORD empty; the app uses an IAM token.');
  }
  if (!useIam && explicitDb.password === undefined) {
    throw new Error('Without RDS_IAM_DB_AUTH, set DB_PASSWORD.');
  }

  const common = {
    prepare: true,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
  } as const;

  const isPooler = explicitDb.port === 6543;
  const poolCommon = {
    ...common,
    prepare: extra.prepare ?? !isPooler,
    max: isPooler ? 1 : 10,
    connect_timeout: extra.connect_timeout ?? 10,
    ...(extra.onnotice ? { onnotice: extra.onnotice } : {}),
  };

  if (useIam) {
    return postgres({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: () => rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user),
      ssl: 'require',
      ...poolCommon,
    });
  }

  const useSsl = isLocalPostgresHost(explicitDb.host) ? false : 'require';

  return postgres({
    host: explicitDb.host,
    port: explicitDb.port,
    database: explicitDb.database,
    user: explicitDb.user,
    password: explicitDb.password!,
    ssl: useSsl,
    ...poolCommon,
  });
}

// App uses pg for connection pooling on Vercel
export function createPgPoolFromEnv(): Pool {
  const explicitDb = parseExplicitDbFromEnv();
  const useIam = rdsIamDbAuthFromEnv();

  const isPooler = explicitDb.port === 6543;
  const max = isPooler ? 1 : 10;
  
  const poolCommon = {
    max,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 10000, // Matching the 10 seconds default connect_timeout
  };

  let pool: Pool;
  if (useIam) {
    pool = new Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: () => rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user),
      ssl: { rejectUnauthorized: false },
      ...poolCommon,
    });
  } else {
    const useSsl = isLocalPostgresHost(explicitDb.host) ? false : { rejectUnauthorized: false };
    pool = new Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: explicitDb.password!,
      ssl: useSsl ? useSsl : undefined,
      ...poolCommon,
    });
  }

  // Prevents idle connections from keeping the Vercel function suspended and leaking connections
  
  return pool;
}

type AppPgClient = Pool;
const globalForDb = globalThis as unknown as {
  __pg?: AppPgClient;
  __db?: ReturnType<typeof makeDb>;
};

function makeDb(client: AppPgClient) {
  return drizzlePg(client, { schema });
}

export type DbClient = ReturnType<typeof makeDb>;

export function createDb(): DbClient {
  if (globalForDb.__db) return globalForDb.__db;

  const client: AppPgClient = globalForDb.__pg ?? createPgPoolFromEnv();
  const db = makeDb(client);

  globalForDb.__pg = client;
  globalForDb.__db = db;

  return db;
}

export const db = new Proxy({} as DbClient, {
  get(_target, prop, receiver) {
    return Reflect.get(createDb() as object, prop, receiver);
  },
}) as DbClient;

/**
 * Creates a short-lived, unmanaged database connection specifically for use
 * inside Next.js `after()` blocks or background jobs.
 * 
 * Unlike `createDb()`, this does NOT use `attachDatabasePool()`, so it will
 * not be prematurely killed by Vercel when the HTTP response is sent.
 * It opens a single connection, runs your function, and explicitly closes it
 * to prevent zombie connections when the serverless function suspends.
 */
export async function withBackgroundDb<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
  const explicitDb = parseExplicitDbFromEnv();
  const useIam = rdsIamDbAuthFromEnv();

  const poolCommon = {
    max: 1, // Only need 1 connection for this background task
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 10000,
  };

  let pool: Pool;
  if (useIam) {
    pool = new Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: () => rdsIamAuthToken(explicitDb.host, explicitDb.port, explicitDb.user),
      ssl: { rejectUnauthorized: false },
      ...poolCommon,
    });
  } else {
    const useSsl = isLocalPostgresHost(explicitDb.host) ? false : { rejectUnauthorized: false };
    pool = new Pool({
      host: explicitDb.host,
      port: explicitDb.port,
      database: explicitDb.database,
      user: explicitDb.user,
      password: explicitDb.password!,
      ssl: useSsl ? useSsl : undefined,
      ...poolCommon,
    });
  }

  const bgDb = makeDb(pool);

  try {
    return await fn(bgDb);
  } finally {
    await pool.end();
  }
}
