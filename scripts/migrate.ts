/**
 * Programmatic migrate runner — bypass drizzle-kit CLI to get reliable SSL +
 * error reporting. Uses DB_* env via createPostgresClientFromEnv (supports
 * RDS IAM auth when RDS_IAM_DB_AUTH=true). Applies everything in
 * drizzle/migrations/ that isn't already in drizzle.__drizzle_migrations.
 *
 * Usage: pnpm tsx scripts/migrate.ts
 */
import { config } from 'dotenv';
// Load .env.local first (if present), then .env as a fallback. dotenv won't
// overwrite variables that are already set, so .env.local takes precedence.
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

async function main() {
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({
    connect_timeout: 15,
    onnotice: () => {}, // silence NOTICE spam from IF NOT EXISTS etc
    prepare: false,
  });

  const db = drizzle(client);
  const hostHint = `${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`;
  console.log(`connecting to ${hostHint}...`);
  try {
    await migrate(db, {
      migrationsFolder: './drizzle/migrations',
      migrationsTable: '__drizzle_migrations',
      migrationsSchema: 'drizzle',
    });
    console.log('✓ migrations applied');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('migrate failed:');
  console.error(err);
  process.exit(1);
});
