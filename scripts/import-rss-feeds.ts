/**
 * Import the validated RSS feed catalog into rss.feeds via the admin API.
 *
 * Usage:
 *   pnpm rss:import-feeds                       # against http://localhost:3000
 *   pnpm rss:import-feeds --base https://staging.example.com
 *   pnpm rss:import-feeds --file path/to.csv
 *
 * Idempotent: the endpoint upserts on feed_url, so re-running only refreshes
 * editorial columns and never disturbs poller health state.
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

config({ path: '.env.local' });
config();

const DEFAULT_FILE = 'data-pipeline/fixtures/rss-feeds.csv';

/** Minimal RFC4180 line splitter: handles quoted fields containing commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (!header) return [];
  return body.map((cells) =>
    Object.fromEntries(header.map((key, i) => [key.trim(), (cells[i] ?? '').trim()])),
  );
}

/**
 * The PoC CSV's `status` column is a *validation* verdict, not our lifecycle
 * status. OK/REPAIRED/blank become `active`; anything else (DEAD, ERROR) is
 * imported as `dead` so it is on record without being polled.
 */
export function toFeedInput(row: Record<string, string>) {
  const validation = (row.status ?? '').toUpperCase();
  const status = validation === '' || validation === 'OK' || validation === 'REPAIRED'
    ? 'active'
    : 'dead';
  return {
    category: row.category,
    source_name: row.source_name,
    feed_url: row.feed_url,
    region: row.region || null,
    notes: row.notes || null,
    status,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args[args.indexOf('--file') + 1];
  const baseArg = args[args.indexOf('--base') + 1];
  const file = args.includes('--file') && fileArg ? fileArg : DEFAULT_FILE;
  const base = args.includes('--base') && baseArg ? baseArg : 'http://localhost:3000';

  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error('ADMIN_SECRET is required to call the admin import endpoint');

  const csv = readFileSync(resolve(process.cwd(), file), 'utf8');
  const feeds = parseCsv(csv).map(toFeedInput);
  console.log(`parsed ${feeds.length} feeds from ${file}`);

  const res = await fetch(`${base}/api/auth/rss-feeds/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': secret },
    body: JSON.stringify({ feeds }),
  });
  const payload = (await res.json()) as {
    data?: { imported: number; skipped: { index: number; reason: string }[] };
    error?: string;
  };
  if (!res.ok) throw new Error(payload.error ?? `import failed (${res.status})`);

  const { imported = 0, skipped = [] } = payload.data ?? {};
  console.log(`✓ imported ${imported} feeds`);
  if (skipped.length > 0) {
    console.log(`  skipped ${skipped.length}:`);
    for (const s of skipped.slice(0, 20)) console.log(`    row ${s.index}: ${s.reason}`);
  }
}

// Guard so importing parseCsv/toFeedInput for unit tests doesn't also trigger
// a live main() run (and its process.exit) as a side effect of the import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('import failed:', err);
    process.exit(1);
  });
}
