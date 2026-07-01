/**
 * Pipeline demo runner — synthesizes fake emails, feeds them through crmIngest,
 * then prints the resulting employers + topics (with deal/non-deal flag).
 *
 * Uses @*.demo.test domains as a cleanup marker — all created rows can be found
 * and deleted by that pattern. Pass --keep to skip teardown and inspect the data.
 *
 * Usage:
 *   pnpm --filter data-pipeline pipeline-demo
 *   pnpm --filter data-pipeline pipeline-demo -- --keep
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql, inArray } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

// ── Synthetic data fixtures ────────────────────────────────────────────────

const MARKER = 'demo.test'; // all inserted domains end with this

interface FakeTopic {
  name: string;
  is_deal_related: boolean;
}

interface FakeEmail {
  message_id: string;
  from: string;
  from_name: string;
  to: string[];
  subject: string;
  body: string;
  topics: FakeTopic[];
}

const FAKE_EMAILS: FakeEmail[] = [
  // ── Goldensacks ───────────────────────────────────────────────────────────
  {
    message_id: '<demo-gs-1@goldensacks.demo.test>',
    from: 'alice.gold@goldensacks.demo.test',
    from_name: 'Alice Gold',
    to: ['analyst@sparklecapital.demo.test'],
    subject: 'Project Titanium — Term Sheet v3',
    body: 'Please find attached the revised term sheet for Project Titanium. NDA has been countersigned. Korea and APAC semis context attached.',
    topics: [
      { name: 'term-sheet', is_deal_related: true },
      { name: 'nda', is_deal_related: true },
      { name: 'semiconductors', is_deal_related: false },
      { name: 'korea', is_deal_related: false },
    ],
  },
  {
    message_id: '<demo-gs-2@goldensacks.demo.test>',
    from: 'bob.silver@goldensacks.demo.test',
    from_name: 'Bob Silver',
    to: ['analyst@sparklecapital.demo.test'],
    subject: 'Acquisition Target Update — Wafer Supply Co.',
    body: 'Buy-side mandate confirmed. Target is a wafer supply company in Taiwan. Beginning acquisition process this week.',
    topics: [
      { name: 'acquisition', is_deal_related: true },
      { name: 'buy-side', is_deal_related: true },
      { name: 'wafer', is_deal_related: false },
    ],
  },

  // ── JPOrgan ───────────────────────────────────────────────────────────────
  {
    message_id: '<demo-jp-1@jporgan.demo.test>',
    from: 'carol.cash@jporgan.demo.test',
    from_name: 'Carol Cash',
    to: ['analyst@sparklecapital.demo.test'],
    subject: 'Q1 Deal Flow — APAC Pipeline',
    body: 'Our APAC deal flow is strong this quarter. Due diligence on two semiconductor targets underway. Happy to set up a call.',
    topics: [
      { name: 'deal-flow', is_deal_related: true },
      { name: 'due-diligence', is_deal_related: true },
      { name: 'apac', is_deal_related: false },
      { name: 'semiconductors', is_deal_related: false },
    ],
  },
  {
    message_id: '<demo-jp-2@jporgan.demo.test>',
    from: 'dave.bond@jporgan.demo.test',
    from_name: 'Dave Bond',
    to: ['analyst@sparklecapital.demo.test'],
    subject: 'Mandate Discussion — Specialty Chemicals',
    body: 'Following up on our mandate discussion. The client operates in lithography chemicals and specialty chem segments.',
    topics: [
      { name: 'mandate', is_deal_related: true },
      { name: 'lithography', is_deal_related: false },
      { name: 'specialty-chem', is_deal_related: false },
    ],
  },

  // ── CreditSweets ──────────────────────────────────────────────────────────
  {
    message_id: '<demo-cs-1@creditsweets.demo.test>',
    from: 'eve.penny@creditsweets.demo.test',
    from_name: 'Eve Penny',
    to: ['analyst@sparklecapital.demo.test'],
    subject: 'TIM — PE Exit Opportunity',
    body: 'The PE sponsor is looking for an exit. Teaser Information Memorandum attached. Advanced semiconductor packaging is the core business.',
    topics: [
      { name: 'tim', is_deal_related: true },
      { name: 'pe-exit', is_deal_related: true },
      { name: 'packaging', is_deal_related: false },
    ],
  },
  {
    message_id: '<demo-cs-2@creditsweets.demo.test>',
    from: 'frank.note@creditsweets.demo.test',
    from_name: 'Frank Note',
    to: ['analyst@sparklecapital.demo.test'],
    subject: 'Divestiture of Japan JV',
    body: 'The parent is considering a carve-out of the Japan joint venture. Divestiture process expected to start next month.',
    topics: [
      { name: 'divestiture', is_deal_related: true },
      { name: 'carve-out', is_deal_related: true },
      { name: 'japan', is_deal_related: false },
    ],
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const NOW = new Date().toISOString();
  const TODAY = NOW.slice(0, 10);
  const keep = process.argv.includes('--keep');

  // All pipeline imports AFTER dotenv so module-level env reads see the values.
  // Placed inside main() to avoid top-level await (CJS compat).
  const { createLambdaDb } = await import('../src/db');
  const { withJob } = await import('../src/withJob');
  const { runCrmIngest } = await import('../src/handlers/crmIngest');
  const {
    mboxFiles,
    rawEmails,
    rawEmailEnrichments,
    employers,
    employerDomains,
    employerTopics,
    correspondents,
  } = await import('../../src/lib/db/schema');

  const { pgClient, db } = await createLambdaDb();

  try {
    // ── 1. Seed ─────────────────────────────────────────────────────────────
    console.log('\n▶ [1/3] Seeding synthetic emails...');

    const fileId = randomUUID();
    await db.insert(mboxFiles).values({
      id: fileId,
      source: 'demo',
      s3_bucket: 'demo-bucket',
      s3_key: `demo-pipeline/${TODAY}-demo.mbox`,
      size_bytes: 0,
      custodian_email: `demo@${MARKER}`,
      window_start: `${TODAY}T00:00:00Z`,
      window_end: `${TODAY}T23:59:59Z`,
      mode: 'demo',
      parse_status: 'parsed',
    });

    const rawEmailIds: string[] = [];

    for (const e of FAKE_EMAILS) {
      const rawId = randomUUID();
      rawEmailIds.push(rawId);

      await db.insert(rawEmails).values({
        id: rawId,
        file_id: fileId,
        custodian_email: `demo@${MARKER}`,
        message_id: e.message_id,
        from_address: e.from,
        from_display_name: e.from_name,
        to_addresses: e.to,
        cc_addresses: [],
        subject: e.subject,
        body_text: e.body,
        sent_at: NOW,
        has_attachments: false,
        llm_status: 'enriched',
        ingest_status: 'pending',
      });

      await db.insert(rawEmailEnrichments).values({
        raw_email_id: rawId,
        needs_llm: false,
        topics: e.topics as never,
        people: [],
        related_companies: [],
        body_snippet: e.body.slice(0, 200),
      });
    }

    console.log(`   Inserted ${FAKE_EMAILS.length} emails (file_id=${fileId})`);

    // ── 2. Ingest ────────────────────────────────────────────────────────────
    console.log('\n▶ [2/3] Running crmIngest...\n');

    const result = await withJob(db, 'crm_ingest', { rawEmailIds }, (deps) =>
      runCrmIngest({ rawEmailIds }, deps),
    );

    console.log('\n   ingest summary:', {
      topics_upserted: result.topics_upserted,
      employers_upserted: result.employers_upserted,
      correspondents_upserted: result.correspondents_upserted,
      emails_inserted: result.emails_inserted,
      employer_topics_inserted: result.employer_topics_inserted,
    });

    // ── 3. Print results ─────────────────────────────────────────────────────
    console.log('\n▶ [3/3] Results — employers + topics\n');

    const rows = await db.execute(sql`
      SELECT
        e.name             AS employer,
        t.name             AS topic,
        t.is_deal_related  AS deal
      FROM public.employers e
      JOIN public.employer_topics  et  ON et.employer_id = e.id
      JOIN public.topics           t   ON t.id = et.topic_id
      JOIN public.employer_domains ed  ON ed.employer_id = e.id
      WHERE ed.domain LIKE ${'%.' + MARKER}
      ORDER BY e.name, t.is_deal_related DESC, t.name
    `);

    if (!rows.length) {
      console.log('   (no topics found — check domain config or employer_overrides)');
    } else {
      const grouped: Record<string, { deal: string[]; nonDeal: string[] }> = {};
      for (const r of (rows as unknown) as Array<{ employer: string; topic: string; deal: boolean }>) {
        if (!grouped[r.employer]) grouped[r.employer] = { deal: [], nonDeal: [] };
        if (r.deal) grouped[r.employer].deal.push(r.topic);
        else grouped[r.employer].nonDeal.push(r.topic);
      }
      for (const [firm, { deal, nonDeal }] of Object.entries(grouped)) {
        console.log(`  ${firm}`);
        console.log(`    Deal Related:     ${deal.join(', ') || '(none)'}`);
        console.log(`    Non-Deal Related: ${nonDeal.join(', ') || '(none)'}`);
        console.log('');
      }
    }

    // ── 4. Cleanup ───────────────────────────────────────────────────────────
    if (keep) {
      console.log(`   --keep flag set, skipping cleanup.`);
      console.log(`   Remove with: WHERE domain LIKE '%.${MARKER}'\n`);
    } else {
      console.log('▶ Cleaning up demo rows...');

      // analytics.email_topics + email_participants reference analytics.emails
      await db.execute(sql`
        DELETE FROM analytics.email_topics
        WHERE email_id IN (
          SELECT id FROM analytics.emails WHERE from_address LIKE ${'%@%.' + MARKER}
        )
      `);
      await db.execute(sql`
        DELETE FROM analytics.email_participants
        WHERE email_id IN (
          SELECT id FROM analytics.emails WHERE from_address LIKE ${'%@%.' + MARKER}
        )
      `);
      await db.execute(sql`
        DELETE FROM analytics.emails WHERE from_address LIKE ${'%@%.' + MARKER}
      `);

      // Collect employer IDs before deleting employer_domains (FK order matters)
      const demoEmps = await db
        .select({ employer_id: employerDomains.employer_id })
        .from(employerDomains)
        .where(sql`${employerDomains.domain} LIKE ${'%.' + MARKER}`);

      const empIds = demoEmps.map((r) => r.employer_id);

      if (empIds.length > 0) {
        await db.delete(employerTopics).where(inArray(employerTopics.employer_id, empIds));
      }
      await db.execute(sql`
        DELETE FROM public.correspondents WHERE email LIKE ${'%@%.' + MARKER}
      `);
      await db.execute(sql`
        DELETE FROM public.employer_domains WHERE domain LIKE ${'%.' + MARKER}
      `);
      if (empIds.length > 0) {
        await db.delete(employers).where(inArray(employers.id, empIds));
      }

      // mbox_files cascade → raw_emails → raw_email_enrichments
      await db.delete(mboxFiles).where(sql`${mboxFiles.id} = ${fileId}::uuid`);

      console.log('   Done.\n');
    }
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('✗ demo failed:', err);
  process.exit(1);
});
