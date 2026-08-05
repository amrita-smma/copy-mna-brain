/**
 * Scaffold a new empty migration file using this repo's date+counter naming
 * convention, and regenerate the journal for its folder.
 *
 * Filenames are `YYYYMMDDXXXXXX_<slug>.sql`, where `XXXXXX` is a per-day
 * zero-padded counter — NOT a wall-clock time. The first migration on a given
 * UTC date gets counter `000000`; each subsequent migration on that same date
 * gets the next integer (`000001`, `000002`, ...). This keeps migrations
 * lexically (and therefore chronologically) ordered without ever depending on
 * the exact minute/second a migration happened to be created.
 *
 * Usage:
 *   pnpm db:migration:new <name>                              # drizzle/migrations (default)
 *   pnpm db:migration:new <name> data-pipeline/migrations      # pipeline migrations
 */
import { writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const name = process.argv[2];
const migrationsDir = process.argv[3] ?? './drizzle/migrations';

if (!name) {
  console.error('usage: pnpm db:migration:new <name> [migrationsDir]');
  process.exit(1);
}

const slug = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_|_$/g, '');

if (!slug) {
  console.error('name must contain at least one alphanumeric character');
  process.exit(1);
}

const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;

mkdirSync(migrationsDir, { recursive: true });

const existingCounters = readdirSync(migrationsDir)
  .map((f) => f.match(new RegExp(`^${date}(\\d{6})_`)))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => Number(m[1]));

const counter = existingCounters.length > 0 ? Math.max(...existingCounters) + 1 : 0;
const prefix = `${date}${String(counter).padStart(6, '0')}`;
const path = join(migrationsDir, `${prefix}_${slug}.sql`);

writeFileSync(path, `-- ${name}\n`, { flag: 'wx' });
console.log(path);

// Journal is fully derived from filenames — never hand-edit meta/_journal.json.
execFileSync('tsx', ['scripts/build-drizzle-journal.ts', migrationsDir], { stdio: 'inherit' });
