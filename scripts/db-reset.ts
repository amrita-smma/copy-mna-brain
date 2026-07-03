/**
 * DESTRUCTIVE database reset — drops every non-system schema (tables, views,
 * functions, and the drizzle migration bookkeeping) so `pnpm db:migrate` can
 * rebuild the database from scratch. Used by the manually-dispatched
 * "Reset DB & Rerun Migrations" GitHub Actions workflow against Neon.
 *
 * Refuses to run unless DB_RESET_CONFIRM=drop-and-recreate is set, so it
 * cannot be executed by accident.
 *
 * Usage: DB_RESET_CONFIRM=drop-and-recreate pnpm db:reset
 */
import { config } from 'dotenv';
// Load .env.local first (if present), then .env as a fallback. dotenv won't
// overwrite variables that are already set, so .env.local takes precedence.
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();

const CONFIRM_VALUE = 'drop-and-recreate';

async function main() {
  if (process.env.DB_RESET_CONFIRM !== CONFIRM_VALUE) {
    console.error(
      `refusing to reset: set DB_RESET_CONFIRM=${CONFIRM_VALUE} to confirm this destructive operation`,
    );
    process.exit(1);
  }

  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({
    connect_timeout: 15,
    onnotice: () => {},
    prepare: false,
  });

  const hostHint = `${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME}`;
  console.log(`connecting to ${hostHint}...`);

  try {
    const schemas = await client<{ schema_name: string }[]>`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema')
        AND schema_name NOT LIKE 'pg\\_%'
      ORDER BY schema_name
    `;

    if (schemas.length === 0) {
      console.log('no user schemas found — nothing to drop');
    }

    for (const { schema_name } of schemas) {
      console.log(`dropping schema "${schema_name}" CASCADE...`);
      await client.unsafe(`DROP SCHEMA "${schema_name.replaceAll('"', '""')}" CASCADE`);
    }

    // Recreate an empty public schema so migrations have a default search_path
    // target to build into.
    await client.unsafe('CREATE SCHEMA public');
    await client.unsafe('GRANT ALL ON SCHEMA public TO public');
    console.log(`✓ dropped ${schemas.length} schema(s); recreated empty "public"`);
    console.log('run `pnpm db:migrate` to rebuild the database from scratch');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('db reset failed:');
  console.error(err);
  process.exit(1);
});
