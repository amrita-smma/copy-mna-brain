/**
 * Simulate Vercel Cron Jobs locally.
 *
 * Reads the `crons` array from vercel.json and fires each `path` as a GET
 * request — exactly as Vercel does in production — against a running dev
 * server (default http://localhost:3000). Adds the
 * `Authorization: Bearer $CRON_SECRET` header when CRON_SECRET is set, matching
 * the auth check the cron routes perform.
 *
 * Usage:
 *   pnpm cron:sim                       Watch mode — fires crons at their
 *                                       scheduled minute boundaries forever.
 *   pnpm cron:sim --once                Fire every configured cron once, now.
 *   pnpm cron:sim --path /api/cron/...  Fire a single cron once, now.
 *   pnpm cron:sim --list                Print the cron table and next fire
 *                                       times, then exit.
 *
 * Flags:
 *   --base <url>   Override the target base URL (default $CRON_SIM_BASE_URL or
 *                  http://localhost:3000).
 *
 * Notes:
 *   - Run your dev server (`vercel dev`) in another terminal first.
 *   - Schedules are evaluated in UTC, the same as Vercel Cron.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { CronExpressionParser } from 'cron-parser';

// Match other scripts: .env.local takes precedence, then .env.
config({ path: '.env.local' });
config();

interface CronEntry {
  path: string;
  schedule: string;
}

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const baseUrl = (
  flagValue('--base') ??
  process.env.CRON_SIM_BASE_URL ??
  'http://localhost:3000'
).replace(/\/$/, '');

const secret = process.env.CRON_SECRET;

function loadCrons(): CronEntry[] {
  const raw = readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8');
  const parsed = JSON.parse(raw) as { crons?: CronEntry[] };
  if (!parsed.crons?.length) {
    throw new Error('No `crons` array found in vercel.json');
  }
  return parsed.crons;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

async function fire(entry: CronEntry): Promise<void> {
  const url = `${baseUrl}${entry.path}`;
  const headers: Record<string, string> = {
    'user-agent': 'vercel-cron/1.0 (cron-sim)',
  };
  if (secret) headers.authorization = `Bearer ${secret}`;

  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers });
    const ms = Date.now() - start;
    const body = await res.text();
    const preview = body.replace(/\s+/g, ' ').slice(0, 200);
    const mark = res.ok ? '✓' : '✗';
    console.log(`[${ts()}] ${mark} ${res.status} ${entry.path} (${ms}ms) ${preview}`);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[${ts()}] ✗ ERR ${entry.path} (${ms}ms) ${msg}`);
  }
}

function listCrons(crons: CronEntry[]): void {
  console.log(`Target: ${baseUrl}`);
  console.log(`CRON_SECRET: ${secret ? 'set (sending Bearer auth)' : 'unset (no auth header)'}`);
  console.log('');
  for (const c of crons) {
    const next = CronExpressionParser.parse(c.schedule, { tz: 'UTC' })
      .next()
      .toISOString();
    console.log(`  ${c.schedule.padEnd(12)} ${c.path.padEnd(40)} next: ${next}`);
  }
}

async function watch(crons: CronEntry[]): Promise<void> {
  console.log(`Simulating ${crons.length} Vercel cron(s) against ${baseUrl}`);
  console.log(`CRON_SECRET: ${secret ? 'set' : 'unset'} — Ctrl+C to stop\n`);

  // Track the last minute we evaluated so each cron fires at most once per
  // minute boundary, mirroring Vercel's 1-minute granularity.
  let lastMinute = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    if (minuteKey !== lastMinute) {
      lastMinute = minuteKey;
      // A cron is "due" this minute if its previous scheduled fire equals the
      // current minute boundary (seconds/ms zeroed).
      const boundary = new Date(now);
      boundary.setUTCSeconds(0, 0);
      for (const c of crons) {
        const prev = CronExpressionParser.parse(c.schedule, {
          tz: 'UTC',
          currentDate: new Date(boundary.getTime() + 1000),
        })
          .prev()
          .toDate();
        if (prev.getTime() === boundary.getTime()) {
          void fire(c);
        }
      }
    }
    // Sleep until just past the next minute boundary.
    const msToNextMinute = 60_000 - (Date.now() % 60_000) + 250;
    await new Promise((r) => setTimeout(r, msToNextMinute));
  }
}

async function main(): Promise<void> {
  const crons = loadCrons();

  if (args.includes('--list')) {
    listCrons(crons);
    return;
  }

  const onePath = flagValue('--path');
  if (onePath) {
    const entry = crons.find((c) => c.path === onePath);
    if (!entry) {
      console.error(`No cron with path "${onePath}" in vercel.json. Known paths:`);
      for (const c of crons) console.error(`  ${c.path}`);
      process.exit(1);
    }
    await fire(entry);
    return;
  }

  if (args.includes('--once')) {
    console.log(`Firing ${crons.length} cron(s) once against ${baseUrl}\n`);
    for (const c of crons) await fire(c);
    return;
  }

  await watch(crons);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
