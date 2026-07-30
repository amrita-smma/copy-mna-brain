/**
 * DESTRUCTIVE — drops every non-system schema (tables, views, functions, and
 * drizzle migration bookkeeping) so `pnpm db:migrate` can rebuild from scratch.
 *
 * Prompts interactively with the target DB host; type `y` to confirm.
 * For non-interactive CI, use `pnpm db:reset` with DB_RESET_CONFIRM instead.
 *
 * Usage: pnpm db:drop
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from 'dotenv';
// Load .env.local first (if present), then .env as a fallback. dotenv won't
// overwrite variables that are already set, so .env.local takes precedence.
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();

async function confirm(host: string): Promise<boolean> {
  if (!input.isTTY) {
    console.error(
      'refusing to drop: no TTY for confirmation. Use `DB_RESET_CONFIRM=drop-and-recreate pnpm db:reset` in CI.',
    );
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Drop ALL schemas on ${host}? This cannot be undone. [y/N] `,
    );
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

async function main() {
  const host = process.env.DB_HOST;
  if (!host) {
    console.error('DB_HOST is not set — load .env.local / .env first');
    process.exit(1);
  }

  const hostHint = `${host}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? '?'}`;
  console.log(`target: ${hostHint}`);

  if (!(await confirm(host))) {
    console.log('aborted');
    process.exit(0);
  }

  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({
    connect_timeout: 15,
    onnotice: () => {},
    prepare: false,
  });

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
  console.error('db drop failed:');
  console.error(err);
  process.exit(1);
});
