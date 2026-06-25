/**
 * Backfill agent-driven track matching for companies already in L0.
 *
 * Matching normally runs once when a company *enters* L0. This one-off populates
 * `companies.matched_track_ids` for the existing L0 backlog. Runs the same
 * `runTrackMatching` handler (LLM agent, with keyword-heuristic fallback) per
 * company, sequentially.
 *
 *   pnpm tsx scripts/backfill-track-matching.ts          # all L0 companies
 *   pnpm tsx scripts/backfill-track-matching.ts --only-empty   # skip ones already matched
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql as dsql } from 'drizzle-orm';

async function main() {
  const onlyEmpty = process.argv.includes('--only-empty');
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const { companies } = await import('../src/lib/db/schema');
  const { runTrackMatching } = await import('../src/lib/jobs/handlers/trackMatching');

  const client = createPostgresClientFromEnv({ prepare: false, onnotice: () => {} });
  const db = drizzle(client);

  console.log(`backfilling track matching on ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}...`);

  try {
    const where = onlyEmpty
      ? and(
          eq(companies.pipeline_stage, 'L0'),
          dsql`(${companies.matched_track_ids} IS NULL OR ${companies.matched_track_ids}::text = '[]')`,
        )
      : eq(companies.pipeline_stage, 'L0');

    const rows = await db
      .select({ id: companies.id, target: companies.target })
      .from(companies)
      .where(where);

    console.log(`found ${rows.length} L0 companies to match\n`);

    let matched = 0;
    for (const [i, row] of rows.entries()) {
      try {
        const result = await runTrackMatching({ companyId: row.id }, { db: db as never });
        if (result.matchedTrackIds.length > 0) matched++;
        console.log(
          `[${i + 1}/${rows.length}] ${row.target ?? row.id} → ${result.matchedTrackIds.length} track(s) via ${result.via}`,
        );
      } catch (err) {
        console.error(`[${i + 1}/${rows.length}] ${row.target ?? row.id} FAILED:`, (err as Error).message);
      }
    }

    console.log(`\ndone — ${matched}/${rows.length} companies matched at least one track`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
