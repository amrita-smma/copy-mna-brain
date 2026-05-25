/**
 * Revert the mbox ingest. Removes rows inserted by `pnpm mbox:ingest` using
 * the natural markers we set at insert time:
 *
 *   - emails           WHERE message_id IS NOT NULL  (mbox imports always set it)
 *                      → cascades email_participants + email_topics
 *   - correspondents   WHERE source = 'mbox'
 *   - employer_topics  WHERE source = 'auto'         (step 4g of the ingest)
 *
 * Defaults to DRY-RUN: counts what would be deleted but performs no writes.
 * Pass `--yes` to actually apply. Pass `--purge` to additionally drop any
 * employers that no longer have correspondents or emails, and topics that
 * have no email_topics / employer_topics references.
 *
 * Manually edited rows are preserved:
 *   - Correspondents with source != 'mbox' (e.g. UI-created) are kept.
 *   - Employer rows are kept by default — only --purge sweeps orphans.
 *   - Manually-set employer_topics (source != 'auto') are kept.
 *
 * `employers.industry` is NOT cleared because there's no way to distinguish
 * ingest-set values from manual edits after the fact. Clean up via UI / SQL
 * if you need to.
 *
 * Usage:
 *   pnpm mbox:ingest:revert            # dry-run
 *   pnpm mbox:ingest:revert --yes      # apply
 *   pnpm mbox:ingest:revert --yes --purge  # apply + sweep orphans
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

interface CliArgs {
  yes: boolean;
  purge: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, purge: false, help: false };
  for (const a of argv) {
    switch (a) {
      case '--yes':
      case '-y': args.yes = true; break;
      case '--purge': args.purge = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default: throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const help = readFileSync(new URL(import.meta.url), 'utf-8')
    .split('\n')
    .filter((l: string) => l.startsWith(' *') || l.startsWith('/**'))
    .map((l: string) => l.replace(/^ \*\/?|^\/\*\*/g, '').replace(/^ ?/, ''))
    .join('\n')
    .trim();
  console.log(help);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({ prepare: false });
  const db = drizzle(client);

  // Single value helper for COUNT(*) queries.
  const countOf = async (q: ReturnType<typeof sql>): Promise<number> => {
    const rows = (await db.execute(q)) as unknown as Array<{ count: string | number }>;
    return Number(rows[0]?.count ?? 0);
  };

  try {
    console.log(args.yes ? 'APPLYING revert.' : 'DRY-RUN (pass --yes to apply).');
    console.log();

    // ─── pre-counts ────────────────────────────────────────────────────────
    const beforeEmails = await countOf(
      sql`SELECT COUNT(*)::int AS count FROM emails WHERE message_id IS NOT NULL`,
    );
    const beforeParticipants = await countOf(
      sql`SELECT COUNT(*)::int AS count FROM email_participants WHERE email_id IN (SELECT id FROM emails WHERE message_id IS NOT NULL)`,
    );
    const beforeEmailTopics = await countOf(
      sql`SELECT COUNT(*)::int AS count FROM email_topics WHERE email_id IN (SELECT id FROM emails WHERE message_id IS NOT NULL)`,
    );
    const beforeCorrespondents = await countOf(
      sql`SELECT COUNT(*)::int AS count FROM correspondents WHERE source = 'mbox'`,
    );
    const beforeEmployerTopicsAuto = await countOf(
      sql`SELECT COUNT(*)::int AS count FROM employer_topics WHERE source = 'auto'`,
    );

    console.log('Rows that match the revert criteria:');
    console.log(`  emails (message_id IS NOT NULL):         ${beforeEmails}`);
    console.log(`    └─ email_participants (cascade):        ${beforeParticipants}`);
    console.log(`    └─ email_topics (cascade):              ${beforeEmailTopics}`);
    console.log(`  correspondents (source='mbox'):           ${beforeCorrespondents}`);
    console.log(`  employer_topics (source='auto'):          ${beforeEmployerTopicsAuto}`);

    if (args.purge) {
      const orphanEmployers = await countOf(sql`
        SELECT COUNT(*)::int AS count FROM employers e
        WHERE NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.employer_id = e.id AND c.source <> 'mbox')
          AND NOT EXISTS (SELECT 1 FROM emails em WHERE em.employer_id = e.id AND em.message_id IS NULL)
      `);
      const orphanTopics = await countOf(sql`
        SELECT COUNT(*)::int AS count FROM topics t
        WHERE NOT EXISTS (SELECT 1 FROM email_topics et WHERE et.topic_id = t.id AND et.email_id NOT IN (SELECT id FROM emails WHERE message_id IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM employer_topics ept WHERE ept.topic_id = t.id AND ept.source <> 'auto')
      `);
      console.log();
      console.log('Purge candidates (after revert applies):');
      console.log(`  orphan employers (no manual children):    ${orphanEmployers}`);
      console.log(`  orphan topics (no remaining references):  ${orphanTopics}`);
    }

    if (!args.yes) {
      console.log();
      console.log('No rows changed. Re-run with --yes to apply.');
      return;
    }

    // ─── apply ─────────────────────────────────────────────────────────────
    console.log();
    console.log('Deleting…');
    await db.transaction(async (tx) => {
      const r1 = (await tx.execute(
        sql`DELETE FROM emails WHERE message_id IS NOT NULL RETURNING id`,
      )) as unknown as unknown[];
      console.log(`  emails deleted:           ${r1.length} (cascaded participants + topics)`);

      const r2 = (await tx.execute(
        sql`DELETE FROM correspondents WHERE source = 'mbox' RETURNING id`,
      )) as unknown as unknown[];
      console.log(`  correspondents deleted:   ${r2.length}`);

      const r3 = (await tx.execute(
        sql`DELETE FROM employer_topics WHERE source = 'auto' RETURNING id`,
      )) as unknown as unknown[];
      console.log(`  employer_topics deleted:  ${r3.length}`);

      if (args.purge) {
        const r4 = (await tx.execute(sql`
          DELETE FROM employers e
          WHERE NOT EXISTS (SELECT 1 FROM correspondents c WHERE c.employer_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM emails em WHERE em.employer_id = e.id)
          RETURNING id
        `)) as unknown as unknown[];
        console.log(`  orphan employers purged:  ${r4.length}`);

        const r5 = (await tx.execute(sql`
          DELETE FROM topics t
          WHERE NOT EXISTS (SELECT 1 FROM email_topics et WHERE et.topic_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM employer_topics ept WHERE ept.topic_id = t.id)
          RETURNING id
        `)) as unknown as unknown[];
        console.log(`  orphan topics purged:     ${r5.length}`);
      }
    });

    console.log();
    console.log('Done.');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
