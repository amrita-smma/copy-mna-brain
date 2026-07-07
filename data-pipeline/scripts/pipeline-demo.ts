/**
 * Pipeline demo runner. Two modes:
 *
 *  - default: MB-337 CRM workspace-scoping demo. Creates two demo workspaces
 *    ("Demo Alpha Capital", "Demo Beta Partners"), each with its own synced
 *    custodian mailbox, seeds a richer batch of synthetic emails split
 *    across them (plus one firm and one correspondent deliberately emailed
 *    by BOTH custodians), feeds everything through the real crmIngest
 *    handler, refreshes the analytics marts, then prints: employers +
 *    topics, per-workspace correspondent *visibility* (proving the
 *    workspace_correspondents membership fan-out — same shared employer,
 *    different people/numbers per workspace), workspace-scoped
 *    employer_related_companies links, and side-by-side per-workspace
 *    mart_crm KPIs for the one employer both custodians touched.
 *  - --fanout: proves the attachment pipeline's multi-workspace fan-out.
 *    Creates two demo workspaces sharing one custodian mailbox
 *    (is_email_synced=true on both), seeds one inbound attachment, runs the
 *    real attachmentUpload handler (which calls the live app's
 *    /api/ai-file-dump over HTTP, same as production), then checks that a
 *    `files` row landed in BOTH workspaces. Requires the app server to be
 *    reachable at INTERNAL_API_URL (default http://localhost:3000) with
 *    ADMIN_SECRET set, and S3/MinIO reachable for the attachment bytes.
 *
 * Uses @*.demo.test domains/emails as a cleanup marker — all created rows can
 * be found and deleted by that pattern. Pass --keep to skip teardown and
 * inspect the data.
 *
 * Usage:
 *   pnpm --filter data-pipeline pipeline-demo
 *   pnpm --filter data-pipeline pipeline-demo -- --keep
 *   pnpm --filter data-pipeline pipeline-demo -- --fanout
 *   pnpm --filter data-pipeline pipeline-demo -- --fanout --keep
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql, inArray, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/repositories';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

// ── Synthetic data fixtures ────────────────────────────────────────────────

const MARKER = 'demo.test'; // all inserted domains end with this

const DEMO_ALPHA_SLUG = 'demo-alpha-capital';
const DEMO_BETA_SLUG = 'demo-beta-partners';
// Subdomain matters here: cleanup below matches emails/correspondents via
// `LIKE '%@%.${MARKER}'`, which (like every other address in FAKE_EMAILS)
// requires a subdomain before the marker — a bare `@demo.test` address
// would silently survive cleanup.
const ALPHA_CUSTODIAN = `analyst.alpha@internal.${MARKER}`;
const BETA_CUSTODIAN = `analyst.beta@internal.${MARKER}`;

// MB-337 CRM workspace-scoping demo: two workspaces, each with its own
// synced custodian mailbox. Emails route through one custodian or the
// other — that routing is what workspace_correspondents visibility derives
// from, not anything about the employer/correspondent identity itself
// (which stays shared, see the migrations under drizzle/migrations/
// 20260705*). ALPHA_CUSTODIAN / BETA_CUSTODIAN below are the two mailboxes.
type Custodian = 'alpha' | 'beta';

interface FakeTopic {
  name: string;
  is_deal_related: boolean;
}

interface FakeRelatedCompany {
  company_name: string;
  matched_text: string;
  reason: 'explicit_pitch' | 'company_mention' | 'deal_keyword_context' | 'process_reference' | 'other';
  reason_summary: string;
  keywords: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface FakeEmail {
  message_id: string;
  from: string;
  from_name: string;
  to: string[];
  subject: string;
  body: string;
  topics: FakeTopic[];
  custodian: Custodian;
  relatedCompanies?: FakeRelatedCompany[];
}

const FAKE_EMAILS: FakeEmail[] = [
  // ── Goldensacks — emailed by BOTH custodians ────────────────────────────
  // Alice only ever emails Alpha; Zoe only ever emails Beta (two different
  // real bankers at the same firm — Alpha and Beta build separate contact
  // lists there). Bob emails BOTH custodians — the same real person, so his
  // correspondent identity stays a single shared row, but he ends up with a
  // workspace_correspondents membership row for EACH workspace, because both
  // deal teams have genuinely corresponded with him.
  {
    message_id: '<demo-gs-1@goldensacks.demo.test>',
    from: 'alice.gold@goldensacks.demo.test',
    from_name: 'Alice Gold',
    to: [ALPHA_CUSTODIAN],
    subject: 'Project Titanium — Term Sheet v3',
    body: 'Please find attached the revised term sheet for Project Titanium. NDA has been countersigned. Korea and APAC semis context attached.',
    topics: [
      { name: 'term-sheet', is_deal_related: true },
      { name: 'nda', is_deal_related: true },
      { name: 'semiconductors', is_deal_related: false },
      { name: 'korea', is_deal_related: false },
    ],
    custodian: 'alpha',
  },
  {
    message_id: '<demo-gs-2@goldensacks.demo.test>',
    from: 'bob.silver@goldensacks.demo.test',
    from_name: 'Bob Silver',
    to: [ALPHA_CUSTODIAN],
    subject: 'Acquisition Target Update — Wafer Supply Co.',
    body: 'Buy-side mandate confirmed. Target is a wafer supply company in Taiwan. Beginning acquisition process this week. We are also pitching Nordfjord Robotics as a potential add-on.',
    topics: [
      { name: 'acquisition', is_deal_related: true },
      { name: 'buy-side', is_deal_related: true },
      { name: 'wafer', is_deal_related: false },
    ],
    custodian: 'alpha',
    relatedCompanies: [
      {
        company_name: 'Nordfjord Robotics',
        matched_text: 'pitching Nordfjord Robotics as a potential add-on',
        reason: 'explicit_pitch',
        reason_summary: 'Explicitly pitched as an add-on acquisition target',
        keywords: ['add-on', 'acquisition'],
        confidence: 'high',
      },
    ],
  },
  {
    message_id: '<demo-gs-3@goldensacks.demo.test>',
    from: 'bob.silver@goldensacks.demo.test',
    from_name: 'Bob Silver',
    to: [BETA_CUSTODIAN],
    subject: 'Re: Introduction — Beta Partners coverage',
    body: 'Good to connect. Beta Partners deal flow for semiconductor carve-outs is exactly our wheelhouse — let us set up a call this week.',
    topics: [
      { name: 'deal-flow', is_deal_related: true },
      { name: 'carve-out', is_deal_related: true },
      { name: 'semiconductors', is_deal_related: false },
    ],
    custodian: 'beta',
  },
  {
    message_id: '<demo-gs-4@goldensacks.demo.test>',
    from: 'zoe.platinum@goldensacks.demo.test',
    from_name: 'Zoe Platinum',
    to: [BETA_CUSTODIAN],
    subject: 'Divestiture Mandate — Specialty Materials Unit',
    body: 'We have been mandated to run a divestiture process for a specialty materials unit. Advanced packaging and wet processing exposure throughout.',
    topics: [
      { name: 'divestiture', is_deal_related: true },
      { name: 'mandate', is_deal_related: true },
      { name: 'advanced-packaging', is_deal_related: false },
      { name: 'wet-processing', is_deal_related: false },
    ],
    custodian: 'beta',
  },

  // ── JPOrgan — Alpha only ─────────────────────────────────────────────────
  {
    message_id: '<demo-jp-1@jporgan.demo.test>',
    from: 'carol.cash@jporgan.demo.test',
    from_name: 'Carol Cash',
    to: [ALPHA_CUSTODIAN],
    subject: 'Q1 Deal Flow — APAC Pipeline',
    body: 'Our APAC deal flow is strong this quarter. Due diligence on two semiconductor targets underway. Happy to set up a call.',
    topics: [
      { name: 'deal-flow', is_deal_related: true },
      { name: 'due-diligence', is_deal_related: true },
      { name: 'apac', is_deal_related: false },
      { name: 'semiconductors', is_deal_related: false },
    ],
    custodian: 'alpha',
  },
  {
    message_id: '<demo-jp-2@jporgan.demo.test>',
    from: 'dave.bond@jporgan.demo.test',
    from_name: 'Dave Bond',
    to: [ALPHA_CUSTODIAN],
    subject: 'Mandate Discussion — Specialty Chemicals',
    body: 'Following up on our mandate discussion. The client operates in lithography chemicals and specialty chem segments.',
    topics: [
      { name: 'mandate', is_deal_related: true },
      { name: 'lithography', is_deal_related: false },
      { name: 'specialty-chem', is_deal_related: false },
    ],
    custodian: 'alpha',
  },
  {
    message_id: '<demo-jp-3@jporgan.demo.test>',
    from: 'dave.bond@jporgan.demo.test',
    from_name: 'Dave Bond',
    to: [ALPHA_CUSTODIAN],
    subject: 'TIM — Lithography Chemicals Carve-out',
    body: 'Attaching the Teaser Information Memorandum for the lithography chemicals carve-out. PE sponsor is targeting a Q3 exit.',
    topics: [
      { name: 'tim', is_deal_related: true },
      { name: 'carve-out', is_deal_related: true },
      { name: 'pe-exit', is_deal_related: true },
      { name: 'lithography', is_deal_related: false },
    ],
    custodian: 'alpha',
  },

  // ── CreditSweets — Beta only ─────────────────────────────────────────────
  {
    message_id: '<demo-cs-1@creditsweets.demo.test>',
    from: 'eve.penny@creditsweets.demo.test',
    from_name: 'Eve Penny',
    to: [BETA_CUSTODIAN],
    subject: 'TIM — PE Exit Opportunity',
    body: 'The PE sponsor is looking for an exit. Teaser Information Memorandum attached. Advanced semiconductor packaging is the core business. Baltic Cold Chain has expressed interest as a strategic buyer.',
    topics: [
      { name: 'tim', is_deal_related: true },
      { name: 'pe-exit', is_deal_related: true },
      { name: 'packaging', is_deal_related: false },
    ],
    custodian: 'beta',
    relatedCompanies: [
      {
        company_name: 'Baltic Cold Chain',
        matched_text: 'Baltic Cold Chain has expressed interest as a strategic buyer',
        reason: 'company_mention',
        reason_summary: 'Mentioned as an interested strategic buyer',
        keywords: ['strategic buyer'],
        confidence: 'medium',
      },
    ],
  },
  {
    message_id: '<demo-cs-2@creditsweets.demo.test>',
    from: 'frank.note@creditsweets.demo.test',
    from_name: 'Frank Note',
    to: [BETA_CUSTODIAN],
    subject: 'Divestiture of Japan JV',
    body: 'The parent is considering a carve-out of the Japan joint venture. Divestiture process expected to start next month.',
    topics: [
      { name: 'divestiture', is_deal_related: true },
      { name: 'carve-out', is_deal_related: true },
      { name: 'japan', is_deal_related: false },
    ],
    custodian: 'beta',
  },
  {
    message_id: '<demo-cs-3@creditsweets.demo.test>',
    from: 'frank.note@creditsweets.demo.test',
    from_name: 'Frank Note',
    to: [BETA_CUSTODIAN],
    subject: 'Re: Divestiture of Japan JV — financing options',
    body: 'Following up with financing options for the Japan JV divestiture. Buy-side financing package attached for review.',
    topics: [
      { name: 'financing', is_deal_related: true },
      { name: 'buy-side', is_deal_related: true },
      { name: 'japan', is_deal_related: false },
    ],
    custodian: 'beta',
  },

  // ── Kittygroup — Alpha only, new firm ────────────────────────────────────
  {
    message_id: '<demo-kg-1@kittygroup.demo.test>',
    from: 'grace.holt@kittygroup.demo.test',
    from_name: 'Grace Holt',
    to: [ALPHA_CUSTODIAN],
    subject: 'Sourcing Update — Korea Wet Processing Assets',
    body: 'Strong sourcing pipeline in Korea for wet processing assets this quarter. CMP slurry supplier list attached.',
    topics: [
      { name: 'sourcing', is_deal_related: true },
      { name: 'deal-flow', is_deal_related: true },
      { name: 'wet-processing', is_deal_related: false },
      { name: 'korea', is_deal_related: false },
      { name: 'cmp-slurry', is_deal_related: false },
    ],
    custodian: 'alpha',
  },
  {
    message_id: '<demo-kg-2@kittygroup.demo.test>',
    from: 'henry.park@kittygroup.demo.test',
    from_name: 'Henry Park',
    to: [ALPHA_CUSTODIAN],
    subject: 'Due Diligence Data Room — Now Open',
    body: 'The data room for the wet processing roll-up is now open. Due diligence period runs three weeks from today.',
    topics: [
      { name: 'due-diligence', is_deal_related: true },
      { name: 'wet-processing', is_deal_related: false },
    ],
    custodian: 'alpha',
  },

  // ── Atlantis Bank — Beta only, new firm ──────────────────────────────────
  {
    message_id: '<demo-ab-1@atlantisbank.demo.test>',
    from: 'ivy.chen@atlantisbank.demo.test',
    from_name: 'Ivy Chen',
    to: [BETA_CUSTODIAN],
    subject: 'Healthcare Roll-up — Term Sheet Draft',
    body: 'Draft term sheet attached for the healthcare services roll-up. NDA already executed by all parties.',
    topics: [
      { name: 'term-sheet', is_deal_related: true },
      { name: 'nda', is_deal_related: true },
    ],
    custodian: 'beta',
  },
  {
    message_id: '<demo-ab-2@atlantisbank.demo.test>',
    from: 'ivy.chen@atlantisbank.demo.test',
    from_name: 'Ivy Chen',
    to: [BETA_CUSTODIAN],
    subject: 'Re: Healthcare Roll-up — APAC expansion angle',
    body: 'Adding APAC expansion context — the platform is evaluating Japan and Korea entry within 18 months.',
    topics: [
      { name: 'apac', is_deal_related: false },
      { name: 'japan', is_deal_related: false },
      { name: 'korea', is_deal_related: false },
    ],
    custodian: 'beta',
  },
];

// ── CRM ingest demo ─────────────────────────────────────────────────────────

async function runCrmDemo(db: DbClient, keep: boolean) {
  const NOW = new Date().toISOString();
  const TODAY = NOW.slice(0, 10);

  // All pipeline imports AFTER dotenv so module-level env reads see the values.
  const { withJob } = await import('../src/withJob');
  const { runCrmIngest } = await import('../src/handlers/crmIngest');
  const { MartRepository } = await import('../src/repositories');
  const {
    mboxFiles,
    rawEmails,
    rawEmailEnrichments,
    employers,
    employerDomains,
    employerTopics,
    employerRelatedCompanies,
    correspondents,
    workspaceCorrespondents,
    workspaces,
    roles,
    users,
    userWorkspaces,
  } = await import('../../src/lib/db/schema');

  {
    // ── 1. Two demo workspaces, each with its own synced custodian ──────────
    console.log('\n▶ [1/5] Setting up two demo workspaces with separate synced custodians...');

    await db
      .insert(workspaces)
      .values([
        { name: 'Demo Alpha Capital', slug: DEMO_ALPHA_SLUG },
        { name: 'Demo Beta Partners', slug: DEMO_BETA_SLUG },
      ])
      .onConflictDoNothing({ target: workspaces.slug });
    const [alphaWs] = await db.select().from(workspaces).where(eq(workspaces.slug, DEMO_ALPHA_SLUG));
    const [betaWs] = await db.select().from(workspaces).where(eq(workspaces.slug, DEMO_BETA_SLUG));
    if (!alphaWs || !betaWs) throw new Error('failed to set up demo workspaces');

    const [anyRole] = await db.select().from(roles).limit(1);
    if (!anyRole) {
      throw new Error('No roles found — run `pnpm db:seed` (or the app migrations) first.');
    }

    const [alphaUser] = await db
      .insert(users)
      .values({ name: 'Demo Alpha Analyst', email: ALPHA_CUSTODIAN, password: 'demo-not-a-real-hash', role: 'analyst' })
      .onConflictDoUpdate({ target: users.email, set: { name: 'Demo Alpha Analyst' } })
      .returning({ id: users.id });
    const [betaUser] = await db
      .insert(users)
      .values({ name: 'Demo Beta Analyst', email: BETA_CUSTODIAN, password: 'demo-not-a-real-hash', role: 'analyst' })
      .onConflictDoUpdate({ target: users.email, set: { name: 'Demo Beta Analyst' } })
      .returning({ id: users.id });
    if (!alphaUser || !betaUser) throw new Error('failed to set up demo custodian users');

    await db
      .insert(userWorkspaces)
      .values([
        { user_id: alphaUser.id, workspace_id: alphaWs.id, role_id: anyRole.id, is_email_synced: true },
        { user_id: betaUser.id, workspace_id: betaWs.id, role_id: anyRole.id, is_email_synced: true },
      ])
      .onConflictDoUpdate({
        target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
        set: { is_email_synced: true },
      });

    console.log(`   Alpha: ${alphaWs.name} (${alphaWs.id}) — custodian ${ALPHA_CUSTODIAN}`);
    console.log(`   Beta:  ${betaWs.name} (${betaWs.id}) — custodian ${BETA_CUSTODIAN}`);

    // ── 2. Seed ──────────────────────────────────────────────────────────────
    console.log(`\n▶ [2/5] Seeding ${FAKE_EMAILS.length} synthetic emails across both custodians...`);

    const custodianEmailOf: Record<Custodian, string> = {
      alpha: ALPHA_CUSTODIAN,
      beta: BETA_CUSTODIAN,
    };

    // Wipe any leftover mbox_files from a prior run that crashed before
    // reaching cleanup (cascades raw_emails -> raw_email_enrichments) — the
    // s3_key below is deterministic per day, so a stale row would otherwise
    // collide on mbox_files_s3_key_unique.
    await db.execute(sql`DELETE FROM analytics.mbox_files WHERE s3_key LIKE 'demo-pipeline/%'`);

    const fileIdByCustodian: Record<Custodian, string> = {
      alpha: randomUUID(),
      beta: randomUUID(),
    };
    for (const custodian of ['alpha', 'beta'] as const) {
      await db.insert(mboxFiles).values({
        id: fileIdByCustodian[custodian],
        source: 'demo',
        s3_bucket: 'demo-bucket',
        s3_key: `demo-pipeline/${TODAY}-${custodian}.mbox`,
        size_bytes: 0,
        custodian_email: custodianEmailOf[custodian],
        window_start: `${TODAY}T00:00:00Z`,
        window_end: `${TODAY}T23:59:59Z`,
        mode: 'demo',
        parse_status: 'parsed',
      });
    }

    const rawEmailIds: string[] = [];

    for (const e of FAKE_EMAILS) {
      const rawId = randomUUID();
      rawEmailIds.push(rawId);

      await db.insert(rawEmails).values({
        id: rawId,
        file_id: fileIdByCustodian[e.custodian],
        custodian_email: custodianEmailOf[e.custodian],
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
        related_companies: (e.relatedCompanies ?? []) as never,
        body_snippet: e.body.slice(0, 200),
      });
    }

    console.log(`   Inserted ${FAKE_EMAILS.length} emails across 2 mbox_files`);

    // ── 3. Ingest ────────────────────────────────────────────────────────────
    console.log('\n▶ [3/5] Running crmIngest...\n');

    const result = await withJob(db, 'crm_ingest', { rawEmailIds }, (deps) =>
      runCrmIngest({ rawEmailIds }, deps),
    );

    console.log('\n   ingest summary:', {
      topics_upserted: result.topics_upserted,
      employers_upserted: result.employers_upserted,
      correspondents_upserted: result.correspondents_upserted,
      emails_inserted: result.emails_inserted,
      employer_topics_inserted: result.employer_topics_inserted,
      related_companies_evidence_inserted: result.related_companies_evidence_inserted,
    });

    console.log('\n▶ [4/5] Refreshing analytics marts...');
    const refreshed = await new MartRepository(db).refreshAll();
    console.log(`   Refreshed: ${refreshed.join(', ') || '(none)'}`);

    // ── 5. Print results ─────────────────────────────────────────────────────
    console.log('\n▶ [5/5] Results\n');

    console.log('── Employers + topics (shared identity — same for every workspace) ──');
    const topicRows = await db.execute(sql`
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

    if (!topicRows.length) {
      console.log('   (no topics found — check domain config or employer_overrides)');
    } else {
      const grouped: Record<string, { deal: string[]; nonDeal: string[] }> = {};
      for (const r of (topicRows as unknown) as Array<{ employer: string; topic: string; deal: boolean }>) {
        if (!grouped[r.employer]) grouped[r.employer] = { deal: [], nonDeal: [] };
        if (r.deal) grouped[r.employer].deal.push(r.topic);
        else grouped[r.employer].nonDeal.push(r.topic);
      }
      for (const [firm, { deal, nonDeal }] of Object.entries(grouped)) {
        console.log(`  ${firm}`);
        console.log(`    Deal Related:     ${deal.join(', ') || '(none)'}`);
        console.log(`    Non-Deal Related: ${nonDeal.join(', ') || '(none)'}`);
      }
    }

    console.log('\n── Correspondent VISIBILITY per workspace (the fan-out this feature adds) ──');
    const visibilityRows = await db.execute(sql`
      SELECT w.name AS workspace, e.name AS employer, c.name AS correspondent, c.email
      FROM workspace_correspondents wc
      JOIN correspondents c ON c.id = wc.correspondent_id
      JOIN employers e      ON e.id = c.employer_id
      JOIN workspaces w     ON w.id = wc.workspace_id
      WHERE wc.workspace_id IN (${alphaWs.id}::uuid, ${betaWs.id}::uuid)
      ORDER BY w.name, e.name, c.name
    `);
    const byWorkspace: Record<string, string[]> = {};
    for (const r of (visibilityRows as unknown) as Array<{ workspace: string; employer: string; correspondent: string; email: string }>) {
      const key = r.workspace;
      (byWorkspace[key] ??= []).push(`${r.employer} — ${r.correspondent} <${r.email}>`);
    }
    for (const [ws, lines] of Object.entries(byWorkspace)) {
      console.log(`  ${ws}:`);
      for (const line of lines) console.log(`    ${line}`);
    }
    console.log(
      '  (Bob Silver should appear under BOTH — same shared correspondent, corresponded with both deal teams.',
    );
    console.log('   Alice Gold appears only under Alpha, Zoe Platinum only under Beta.)');

    console.log('\n── employer_related_companies (workspace-scoped links) ──');
    const relatedRows = await db.execute(sql`
      SELECT w.name AS workspace, e.name AS employer, erc.company_name, erc.source, erc.confidence
      FROM employer_related_companies erc
      JOIN employers e  ON e.id = erc.employer_id
      JOIN workspaces w ON w.id = erc.workspace_id
      WHERE erc.workspace_id IN (${alphaWs.id}::uuid, ${betaWs.id}::uuid)
      ORDER BY w.name, e.name
    `);
    if (!relatedRows.length) {
      console.log('   (none matched)');
    } else {
      for (const r of (relatedRows as unknown) as Array<{ workspace: string; employer: string; company_name: string; source: string; confidence: string }>) {
        console.log(`   ${r.workspace} — ${r.employer} → ${r.company_name} (${r.source}, ${r.confidence})`);
      }
    }

    console.log('\n── mart_crm: Goldensacks KPIs, side by side per workspace ──');
    const martRows = await db.execute(sql`
      SELECT w.name AS workspace, mc.email_count, mc.last_contact_at
      FROM analytics.mart_crm mc
      JOIN employers e  ON e.id = mc.employer_id
      JOIN workspaces w ON w.id = mc.workspace_id
      WHERE e.normalized_name = 'goldensacks'
        AND mc.workspace_id IN (${alphaWs.id}::uuid, ${betaWs.id}::uuid)
      ORDER BY w.name
    `);
    if (!martRows.length) {
      console.log('   (no mart_crm rows yet — marts may need another refresh)');
    } else {
      for (const r of (martRows as unknown) as Array<{ workspace: string; email_count: number; last_contact_at: string | null }>) {
        console.log(`   ${r.workspace}: ${r.email_count} email(s), last contact ${r.last_contact_at ?? 'n/a'}`);
      }
      console.log('   Same shared employer, two independent KPI numbers — this is the whole point of the mart re-key.');
    }

    // ── 6. Cleanup ───────────────────────────────────────────────────────────
    if (keep) {
      console.log(`\n   --keep flag set, skipping cleanup.`);
      console.log(`   Remove emails/employers with: WHERE domain LIKE '%.${MARKER}'`);
      console.log(`   Remove workspaces: ${alphaWs.id} (Alpha), ${betaWs.id} (Beta)\n`);
    } else {
      console.log('\n▶ Cleaning up demo rows...');

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

      // Workspace-scoped rows must go before the employers/correspondents they
      // reference, and before the workspaces themselves (no ON DELETE CASCADE
      // on employer_related_companies.workspace_id — see schema.ts).
      if (empIds.length > 0) {
        await db.delete(employerTopics).where(inArray(employerTopics.employer_id, empIds));
        await db.delete(employerRelatedCompanies).where(inArray(employerRelatedCompanies.employer_id, empIds));
      }
      await db.execute(sql`
        DELETE FROM workspace_correspondents
        WHERE correspondent_id IN (
          SELECT id FROM public.correspondents WHERE email LIKE ${'%@%.' + MARKER}
        )
      `);
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
      await db.delete(mboxFiles).where(inArray(mboxFiles.id, [fileIdByCustodian.alpha, fileIdByCustodian.beta]));

      // Demo workspaces/custodians — user_workspaces cascades on workspace delete.
      await db.delete(users).where(inArray(users.id, [alphaUser.id, betaUser.id]));
      await db.delete(workspaces).where(inArray(workspaces.id, [alphaWs.id, betaWs.id]));

      // Re-refresh so no ghost rows for the now-deleted employer/workspace ids
      // linger in the materialized views.
      await new MartRepository(db).refreshAll();

      console.log('   Done.\n');
    }
  }
}

// ── Attachment fan-out demo ──────────────────────────────────────────────────
//
// Proves the claim in fileService.ts's resolveTargetWorkspaceIds(): one
// custodian mailbox watched by N workspaces (is_email_synced=true on each of
// their user_workspaces rows) fans one inbound attachment out to a `files`
// row in every one of them. Drives the real attachmentUpload handler, which
// calls the live app's /api/ai-file-dump over HTTP — same code path
// production uses, not a simulation of it.

async function runFanoutDemo(db: DbClient, keep: boolean) {
  const NOW = new Date().toISOString();
  const TODAY = NOW.slice(0, 10);

  const { withJob } = await import('../src/withJob');
  const { runAttachmentUpload } = await import('../src/handlers/attachmentUpload');
  const { uploadFile, deleteFile, S3_MBOX_BUCKET } = await import('../../src/lib/s3');
  const {
    workspaces,
    roles,
    userWorkspaces,
    users,
    files,
    mboxFiles,
    emailAttachments,
    rawEmails,
  } = await import('../../src/lib/db/schema');

  const suffix = randomUUID().slice(0, 8);
  const custodianEmail = `fanout-custodian-${suffix}@${MARKER}`;
  const messageId = `<demo-fanout-${suffix}@${MARKER}>`;
  const contentHash = randomUUID().replace(/-/g, '');
  const s3Key = `demo-pipeline/fanout/${TODAY}-${contentHash}.txt`;
  const uniqueMarker = `fanout-demo-${suffix}`;
  const fileBytes = Buffer.from(`Demo fan-out attachment body — ${NOW}`, 'utf-8');

  console.log('\n▶ [1/4] Setting up two workspaces sharing one custodian mailbox...');

  const [wsA] = await db
    .insert(workspaces)
    .values({ name: `Demo Fan-out A ${suffix}`, slug: `demo-fanout-a-${suffix}` })
    .returning();
  const [wsB] = await db
    .insert(workspaces)
    .values({ name: `Demo Fan-out B ${suffix}`, slug: `demo-fanout-b-${suffix}` })
    .returning();

  const [anyRole] = await db.select().from(roles).limit(1);
  if (!anyRole) {
    throw new Error('No roles found — run `pnpm db:seed` (or the app migrations) first.');
  }

  const [custodian] = await db
    .insert(users)
    .values({
      name: 'Demo Fan-out Custodian',
      email: custodianEmail,
      password: 'demo-not-a-real-hash',
      role: 'analyst',
    })
    .returning();

  await db.insert(userWorkspaces).values([
    { user_id: custodian.id, workspace_id: wsA.id, role_id: anyRole.id, is_email_synced: true },
    { user_id: custodian.id, workspace_id: wsB.id, role_id: anyRole.id, is_email_synced: true },
  ]);

  console.log(`   Workspace A: ${wsA.name} (${wsA.id})`);
  console.log(`   Workspace B: ${wsB.name} (${wsB.id})`);
  console.log(`   Custodian:   ${custodianEmail} — is_email_synced=true on both`);

  console.log('\n▶ [2/4] Seeding one inbound email + one attachment ready for upload...');

  const fileId = randomUUID();
  await db.insert(mboxFiles).values({
    id: fileId,
    source: 'demo',
    s3_bucket: 'demo-bucket',
    s3_key: `demo-pipeline/${TODAY}-fanout-${suffix}.mbox`,
    size_bytes: 0,
    custodian_email: custodianEmail,
    window_start: `${TODAY}T00:00:00Z`,
    window_end: `${TODAY}T23:59:59Z`,
    mode: 'demo',
    parse_status: 'parsed',
  });

  await db.insert(rawEmails).values({
    id: randomUUID(),
    file_id: fileId,
    custodian_email: custodianEmail,
    message_id: messageId,
    from_address: `sender@bank.${MARKER}`,
    from_display_name: 'Demo Banker',
    to_addresses: [custodianEmail],
    cc_addresses: [],
    subject: 'Fan-out demo attachment',
    body_text: 'See attached.',
    sent_at: NOW,
    has_attachments: true,
    llm_status: 'enriched',
    ingest_status: 'pending',
  });

  await uploadFile(fileBytes, s3Key, 'text/plain', S3_MBOX_BUCKET);

  await db.insert(emailAttachments).values({
    file_id: fileId,
    message_id: messageId,
    part_index: 0,
    filename: `${uniqueMarker}.txt`,
    mime_type: 'text/plain',
    size_bytes: fileBytes.length,
    content_hash: contentHash,
    state: 'needs_extract',
    s3_bucket: S3_MBOX_BUCKET,
    s3_key: s3Key,
    doc_type: 'other',
  });

  console.log(`   Seeded 1 attachment (hash=${contentHash.slice(0, 8)}) at s3://${S3_MBOX_BUCKET}/${s3Key}`);

  console.log('\n▶ [3/4] Running attachmentUpload against the live app (INTERNAL_API_URL)...\n');

  const result = await withJob(db, 'attachment_upload', {}, (deps) =>
    runAttachmentUpload({ limit: 10 }, deps),
  );
  console.log('   upload result:', result);

  console.log('\n▶ [4/4] Checking `files` rows per workspace...\n');

  const [rowsA, rowsB] = await Promise.all([
    db.select().from(files).where(eq(files.workspace_id, wsA.id)),
    db.select().from(files).where(eq(files.workspace_id, wsB.id)),
  ]);
  const matchA = rowsA.filter((f) => f.file_name.includes(uniqueMarker));
  const matchB = rowsB.filter((f) => f.file_name.includes(uniqueMarker));

  console.log(`   Workspace A: ${matchA.length} matching file row(s) — ${matchA.map((f) => f.processing_status).join(', ') || 'none'}`);
  console.log(`   Workspace B: ${matchB.length} matching file row(s) — ${matchB.map((f) => f.processing_status).join(', ') || 'none'}`);

  if (matchA.length > 0 && matchB.length > 0) {
    console.log('\n   ✓ Fan-out confirmed: one custodian mailbox synced to two workspaces produced a file row in EACH.');
  } else {
    console.log('\n   ✗ Fan-out did NOT happen — check INTERNAL_API_URL/ADMIN_SECRET and that the app server + S3/MinIO are reachable.');
  }

  if (keep) {
    console.log(`\n   --keep flag set, skipping cleanup.`);
    console.log(`   Workspaces: ${wsA.id} (A), ${wsB.id} (B). Custodian: ${custodianEmail}\n`);
    return;
  }

  console.log('\n▶ Cleaning up fan-out demo rows...');

  const matched = [...matchA, ...matchB];
  await Promise.all(matched.map((f) => deleteFile(f.file_link).catch(() => {})));
  if (matched.length > 0) {
    await db.delete(files).where(inArray(files.id, matched.map((f) => f.id)));
  }
  await deleteFile(s3Key, S3_MBOX_BUCKET).catch(() => {});
  // mbox_files cascade → raw_emails, email_attachments
  await db.delete(mboxFiles).where(eq(mboxFiles.id, fileId));
  await db.delete(userWorkspaces).where(inArray(userWorkspaces.workspace_id, [wsA.id, wsB.id]));
  await db.delete(users).where(eq(users.id, custodian.id));
  await db.delete(workspaces).where(inArray(workspaces.id, [wsA.id, wsB.id]));

  console.log('   Done.\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const keep = process.argv.includes('--keep');
  const fanout = process.argv.includes('--fanout');

  // Placed inside main() to avoid top-level await (CJS compat).
  const { createLambdaDb } = await import('../src/db');
  const { pgClient, db } = await createLambdaDb();

  try {
    if (fanout) {
      await runFanoutDemo(db, keep);
    } else {
      await runCrmDemo(db, keep);
    }
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('✗ demo failed:', err);
  process.exit(1);
});
