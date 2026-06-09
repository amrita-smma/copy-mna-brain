import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'drizzle-kit';

function rdsIamDbAuthFromEnv(): boolean {
  const value = process.env.RDS_IAM_DB_AUTH?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isLocalHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost|postgres)$/i.test(host) || !host.includes('.');
}

function buildDrizzleKitUrl(): { url: string; host: string } {
  const host = process.env.DB_HOST?.trim();
  const port = Number(process.env.DB_PORT ?? '5432') || 5432;
  const dbName = process.env.DB_NAME?.trim();
  const user = process.env.DB_USER?.trim();

  if (!host || !dbName || !user) {
    throw new Error('drizzle-kit: set DB_HOST, DB_PORT, DB_NAME, and DB_USER.');
  }

  if (rdsIamDbAuthFromEnv()) {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error('drizzle-kit: set AWS_REGION (or AWS_DEFAULT_REGION) when RDS_IAM_DB_AUTH=true.');
    }
    const token = execFileSync(
      'aws',
      [
        'rds',
        'generate-db-auth-token',
        '--hostname',
        host,
        '--port',
        String(port),
        '--region',
        region,
        '--username',
        user,
      ],
      { encoding: 'utf8' },
    ).trim();
    return {
      host,
      url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(token)}@${host}:${port}/${encodeURIComponent(dbName)}`,
    };
  }

  const password = process.env.DB_PASSWORD;
  if (!password) {
    throw new Error('drizzle-kit: set DB_PASSWORD when RDS_IAM_DB_AUTH=false.');
  }
  return {
    host,
    url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(dbName)}`,
  };
}

const { url, host } = buildDrizzleKitUrl();
const isLocal = isLocalHost(host);

export default defineConfig({
  dialect: 'postgresql',
  schema: '../src/lib/db/schema.ts',
  out: './data-pipeline/migrations',
  dbCredentials: {
    url,
    ssl: isLocal ? false : 'require',
  },
  schemaFilter: ['analytics'],
  casing: 'snake_case',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'drizzle_pipeline',
  },
  verbose: true,
  strict: true,
});
