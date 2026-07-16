/**
 * Partial staging seeder. Creates ONE fresh workspace and everything scoped to
 * it — a few shared employers, per-workspace correspondents, topic tags, team
 * coverage, relationship notes, and a handful of companies — all stamped with
 * the current timestamp so the new workspace sorts to the top of any
 * recently-created / recently-updated list.
 *
 * Unlike `scripts/seed.ts`, this script NEVER creates users. It attaches the
 * new workspace to users that already exist (resolved by email, superadmin, or
 * whoever is present) and reuses them for note authorship + team coverage. If
 * the target database has no users, the script aborts.
 *
 * Usage:
 *   pnpm db:seed:staging-partial
 *   SEED_WORKSPACE_USER_EMAIL=someone@real.co pnpm db:seed:staging-partial
 *
 * Not for production.
 */
import { config } from 'dotenv';
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();

import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import {
  companies,
  companyAnalyses,
  companyFinancials,
  correspondents,
  employerNotes,
  employerTeamMembers,
  employerTopics,
  employers,
  files,
  roles,
  topics,
  users,
  userWorkspaces,
  workspaceCorrespondents,
  workspaces,
} from '../src/lib/db/schema';
import { ROLE_ADMIN_ID, ROLE_EDITOR_ID, ROLE_VIEWER_ID } from '../src/lib/constants';

// How many existing users to pull into the workspace as members / team
// coverage. Kept small so a large staging user table doesn't all get attached.
const MAX_TEAM_USERS = 5;

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// ── Fixtures ────────────────────────────────────────────────────────────────
// A compact, self-contained slice of CRM data. Employers are shared identities
// (upserted by normalized_name); everything else is created fresh and scoped to
// the new workspace on each run.

type Contact = {
  name: string;
  email: string;
  phone: string;
  title: string;
  type: 'external' | 'internal';
};

type FirmFixture = {
  employer: string;
  industry: string;
  contacts: Contact[];
  topics: Array<{ name: string; source: 'auto' | 'manual'; highlight?: boolean }>;
  notes: string[];
};

const SEED_TOPICS: Array<{ name: string; is_deal_related: boolean }> = [
  { name: 'acquisition', is_deal_related: true },
  { name: 'mandate', is_deal_related: true },
  { name: 'financing', is_deal_related: true },
  { name: 'carve-out', is_deal_related: true },
  { name: 'due diligence', is_deal_related: true },
  { name: 'semiconductors', is_deal_related: false },
  { name: 'specialty chem', is_deal_related: false },
  { name: 'APAC', is_deal_related: false },
  { name: 'Korea', is_deal_related: false },
];

const FIRMS: FirmFixture[] = [
  {
    employer: 'Golden Sacks',
    industry: 'Investment Banking',
    contacts: [
      {
        name: 'Jimmy Sprinkles',
        email: 'jimmy.sprinkles@goldensacks.example',
        phone: '+1 212 555 0101',
        title: 'Managing Director',
        type: 'external',
      },
    ],
    topics: [
      { name: 'acquisition', source: 'auto', highlight: true },
      { name: 'semiconductors', source: 'auto' },
      { name: 'financing', source: 'auto' },
      { name: 'mandate', source: 'manual' },
    ],
    notes: ['Primary deal flow for semicon materials. Prefers email.'],
  },
  {
    employer: 'JP Organ',
    industry: 'Investment Banking',
    contacts: [
      {
        name: 'Sally Bubbles',
        email: 'sally.bubbles@jporgan.example',
        phone: '+1 212 555 0102',
        title: 'Executive Director',
        type: 'external',
      },
    ],
    topics: [
      { name: 'mandate', source: 'auto', highlight: true },
      { name: 'specialty chem', source: 'manual' },
      { name: 'APAC', source: 'manual' },
    ],
    notes: ['Good source for lithography deal flow. Well-connected in APAC.'],
  },
  {
    employer: 'Credit Sweets',
    industry: 'Investment Banking',
    contacts: [
      {
        name: 'Bobby Waffles',
        email: 'bobby.waffles@creditsweets.example',
        phone: '+852 3988 0106',
        title: 'Director',
        type: 'external',
      },
    ],
    topics: [
      { name: 'financing', source: 'manual', highlight: true },
      { name: 'due diligence', source: 'auto' },
    ],
    notes: ['Cross-border M&A. Reached out re: financing for Project Cobalt.'],
  },
  {
    employer: 'Kittygroup',
    industry: 'Investment Banking',
    contacts: [
      {
        name: 'Andy Pancake',
        email: 'andy.pancake@kitti.example',
        phone: '+65 6225 0108',
        title: 'Director',
        type: 'external',
      },
    ],
    topics: [
      { name: 'Korea', source: 'auto', highlight: true },
      { name: 'semiconductors', source: 'auto' },
      { name: 'APAC', source: 'auto' },
    ],
    notes: ['Strong Korea network. Useful for APAC sourcing.'],
  },
];

// Only L0–L5 count toward the dashboard funnel (Total Deals, Conversion,
// Pipeline Stages). The dashboard filters companies to these stages, status
// 'active' (except the Dropped card), and created_at within the selected range
// — everything below is stamped with `now` so it lands in the default 7-day
// window and tallies with the dashboard cards.
type PipelineStage = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
const PIPELINE_STAGES: PipelineStage[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

type CompanyFixture = {
  target: string;
  project_name: string;
  segment: string;
  company_focus: string;
  website: string;
  geography: string;
  ownership: string;
  pipeline_stage: PipelineStage | 'unreviewed';
  status: 'active' | 'dropped';
  source: 'inbound' | 'outbound';
  banker_source: string;
  dropped_reason?: string;
  financials: Array<{ fiscal_year: number; revenue_usd_mn: number; ebitda_usd_mn: number; ev_usd_mn: number }>;
};

const SEGMENTS = ['Technology', 'Healthcare', 'Consumer', 'Energy', 'Industrials'];
const GEOS = ['Indonesia', 'Singapore', 'Vietnam', 'Malaysia', 'Thailand'];
const OWNERSHIPS = ['Private', 'PE-backed', 'Family-owned', 'Listed'];
const BANKERS = ['Golden Sacks', 'JP Organ', 'Credit Sweets', 'Kittygroup', 'Organ Stanley'];
const CODENAMES = [
  'Aurora', 'Basalt', 'Cobalt', 'Delta', 'Ember', 'Flint', 'Granite', 'Harbor', 'Ionix', 'Jade',
  'Kestrel', 'Lumen', 'Marble', 'Nimbus', 'Onyx', 'Pinnacle', 'Quartz', 'Ridge', 'Summit', 'Talon',
  'Umbra', 'Vertex', 'Willow', 'Xenon', 'Yonder', 'Zephyr', 'Amber', 'Beacon', 'Cinder', 'Dune',
];

// 5 companies per L0–L5 stage: 2 inbound (active), 2 outbound (active), 1 dropped.
function buildStageCompanies(): CompanyFixture[] {
  const out: CompanyFixture[] = [];
  let i = 0;
  for (let si = 0; si < PIPELINE_STAGES.length; si++) {
    const stage = PIPELINE_STAGES[si];
    for (let ci = 0; ci < 5; ci++) {
      const dropped = ci === 4;
      const source: 'inbound' | 'outbound' = ci < 2 ? 'inbound' : ci < 4 ? 'outbound' : 'inbound';
      const segment = SEGMENTS[(si + ci) % SEGMENTS.length];
      const geo = GEOS[(si * 2 + ci) % GEOS.length];
      const ownership = OWNERSHIPS[(si + ci) % OWNERSHIPS.length];
      const banker = BANKERS[(si + ci) % BANKERS.length];
      const codename = CODENAMES[i % CODENAMES.length];
      const rev = 20 + ((i * 7) % 180);
      out.push({
        target: `${codename} ${segment} Group`,
        project_name: `Project ${codename}`,
        segment,
        company_focus: `${segment} platform operating across ${geo} and the broader APAC region`,
        website: `https://${codename.toLowerCase()}.example`,
        geography: geo,
        ownership,
        pipeline_stage: stage,
        status: dropped ? 'dropped' : 'active',
        source,
        banker_source: banker,
        dropped_reason: dropped ? 'Valuation gap — parked for future revisit' : undefined,
        financials: [
          {
            fiscal_year: 2024,
            revenue_usd_mn: rev,
            ebitda_usd_mn: Math.round(rev * 0.18 * 10) / 10,
            ev_usd_mn: rev * 3,
          },
        ],
      });
      i++;
    }
  }
  return out;
}

const COMPANIES: CompanyFixture[] = [
  {
    target: 'PT Sinar Teknologi',
    project_name: 'Project Sinar',
    segment: 'Technology',
    company_focus: 'Indonesian industrial IoT platform for plant operations',
    website: 'https://sinartech.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    banker_source: 'Golden Sacks',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 42.0, ebitda_usd_mn: 7.4, ev_usd_mn: 128 }],
  },
  {
    target: 'BrightStar Energy',
    project_name: 'Project BrightStar',
    segment: 'Energy',
    company_focus: 'Commercial solar EPC and maintenance platform',
    website: 'https://brightstarenergy.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    banker_source: 'JP Organ',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 61.2, ebitda_usd_mn: 12.1, ev_usd_mn: 210 }],
  },
  ...buildStageCompanies(),
];

// ── company_analyses template ─────────────────────────────────────────────────
// A completed AI analysis, applied to every seeded company (one row per company;
// company_id is uniquely constrained). Text fields are markdown; `sources` is
// jsonb.
const ANALYSIS_TEMPLATE = {
  business_overview: `- **Primary Products/Services**: Bleached Hardwood Kraft Pulp (BHKP) at USD 620/tonne and Coated Woodfree (CWF) Paper at USD 780/tonne; combined nameplate capacity of 380,000 ADMT/year from a single integrated greenfield mill
- **End Markets**: Global pulp and paper supply chain — BHKP feeds tissue, printing & writing, packaging, and specialty paper converters; CWF paper serves commercial printing, publishing, and office paper markets across Asia-Pacific
- **Customer Types**: B2B industrial offtakers under long-term take-or-pay contracts; 100% of output pre-sold to two anchor customers for a 25-year term from COD
- **Geographic Footprint**: Single production site in East Kalimantan, Indonesia (Borneo), leveraging established port infrastructure for export logistics; primary offtake markets are Indonesia and broader Asia-Pacific
- **Company Size**: Pre-revenue greenfield project; no employees or operating history as of the fundraising date; commercial operations scheduled to commence January 2029`,
  business_model_summary: `- **Core Focus**: Integrated, low-cost pulp and paper production leveraging captive plantation feedstock, established port logistics, and a BOO (Build-Own-Operate) structure to deliver contracted volumes under long-term take-or-pay agreements
- **Value Chain Position**: Midstream-to-downstream integrated producer; spans upstream plantation feedstock through pulping (kraft process, ECF bleaching) and paper converting (CWF), with direct offtake to downstream paper manufacturers
- **Revenue Model**: Fully contracted, take-or-pay revenue model for 25 years from COD; 100% of 380,000 ADMT/year output pre-sold at fixed reference prices; no spot market exposure at project inception
- **Competitive Dimension**: Cost competitiveness driven by captive plantation feedstock, port infrastructure, low-cost labor and energy, and world-class EPCC technology
- **Switching Costs**: Extremely high for offtakers — 25-year take-or-pay contracts with penalty provisions create near-permanent customer lock-in`,
  key_takeaways: `1. **100% Take-or-Pay Coverage Is the Defining Risk Mitigant** — The 25-year take-or-pay structure transforms what is typically a cyclical commodity business into a quasi-infrastructure cash flow stream, which is the central investment thesis.

2. **This Is a Pre-Revenue Construction-Stage Investment — Execution Risk Is the Primary Risk** — Investors are committing capital to a ~3.5-year construction phase; the key risks are cost overruns, timeline delays, and contractor performance — not market demand.

3. **Extreme Customer Concentration Warrants Scrutiny** — A single anchor offtaker accounts for the majority of total offtake; any credit deterioration or dispute would be catastrophic for project cash flows.

4. **RPS Structure Offers Yield but Carries Subordination Risk** — The RPS tranche ranks junior to senior debt; in a stress scenario, RPS holders absorb losses before senior lenders are impaired.

5. **Indonesia Policy Tailwind Is Real but Environmental Scrutiny Is Intensifying** — The project aligns with national industrial policy, but Kalimantan pulp expansion is under intense NGO scrutiny for deforestation.`,
  investment_highlights: `- **Market Position**: Indonesia is projected to record the fastest country-level expansion in the hardwood pulp market; the project enters a structurally growing market with captive offtake
- **Differentiation**: 100% take-or-pay offtake for 25 years, integrated plantation-to-mill model, established port infrastructure, and all major regulatory approvals secured
- **Strategic Fit**: Aligned with national forestry and industrial policy; senior debt validation from major banks signals strong institutional support
- **Growth Vectors**: Potential capacity expansion post-COD, product mix optimization, and long-term domestic paper demand growth
- **World-Class EPCC Consortium**: Global leader in pulp mill technology plus major state-linked construction and plantation management expertise reduce execution risk`,
  investment_risks: `- **Customer Concentration**: A single counterparty represents the majority of total offtake; failure, renegotiation, or force majeure would eliminate most project revenue
- **Construction & Completion Risk**: ~3.5-year construction phase exposes investors to cost overruns, timeline delays, and contractor insolvency
- **Price Volatility vs. Fixed Contract Pricing**: Reference prices are above current spot; if market prices remain depressed at COD, offtakers may seek renegotiation
- **Regulatory & Environmental Exposure**: Kalimantan pulp expansion is under intense NGO scrutiny; tightening ESG standards could restrict market access
- **Currency & Sovereign Risk**: IDR-denominated costs against USD-linked revenues; depreciation increases USD debt service
- **RPS Subordination**: The RPS tranche is junior to senior debt and faces full loss before senior lenders in any stress scenario
- **Data Gaps**: No audited financial statements exist; plantation yield and offtake contract terms remain unverified`,
  diligence_priorities: `1. **Offtaker Credit Quality**: Obtain audited financials and credit ratings for the anchor offtakers; assess their ability to honor 25-year take-or-pay obligations through commodity cycles.

2. **Offtake Contract Terms Review**: Full legal review of the take-or-pay agreements — price escalation, force majeure, termination rights, and governing law.

3. **EPCC Contract & Construction Risk**: Review the EPCC contract — fixed-price vs. cost-plus, liquidated damages, performance guarantees, and contractor balance-sheet strength.

4. **Plantation Feedstock Verification**: Independently verify the forestry concession, yield assumptions, wood cost projections, and sustainability certifications.

5. **Financial Model Stress Testing**: Stress-test the model under construction cost overrun, COD delay, price decline, and single-offtaker-default scenarios; confirm DSCR.

6. **Senior Debt Terms & Intercreditor Agreement**: Review senior debt term sheets, covenants, cash sweep mechanisms, and intercreditor terms governing RPS holder rights.

7. **Regulatory & Environmental Compliance**: Verify completeness of all regulatory approvals and assess EUDR compliance pathway.`,
  sources: [
    { type: 'database' },
    { type: 'files' },
    { url: 'https://web.kertas-nusantara.com/', type: 'web', title: 'PT Kertas Nusantara – ECF Bleached Acacia Pulp' },
    {
      url: 'https://dataintelo.com/report/global-bleached-hardwood-and-softwood-kraft-pulp-market',
      type: 'web',
      title: 'Bleached Hardwood and Softwood Kraft Pulp Market Research Report 2034',
    },
    {
      url: 'https://www.futuremarketinsights.com/reports/hardwood-pulp-market',
      type: 'web',
      title: 'Hardwood Pulp Market | Global Market Analysis Report – 2035',
    },
    { url: 'https://www.valmet.com/pulp/complete-pulp-mills/', type: 'web', title: 'Complete Pulp Mills from Valmet' },
    {
      url: 'https://en.wikipedia.org/wiki/Pulp_and_paper_industry_in_Indonesia',
      type: 'web',
      title: 'Pulp and paper industry in Indonesia – Wikipedia',
    },
  ] as unknown[],
};

// ── AI File Dump fixtures ─────────────────────────────────────────────────────
// 2 files per file_type. file_type is free varchar validated at the app layer;
// these are the types the file-processing agent recognizes.
const FILE_TYPES = [
  'mom',
  'prospectus',
  'financial_statement',
  'legal_document',
  'banker_communications',
  'shopping_list',
  'market_study',
  'other',
] as const;

const FILE_TYPE_LABEL: Record<string, string> = {
  mom: 'Minutes of Meeting',
  prospectus: 'Prospectus',
  financial_statement: 'Financial Statement',
  legal_document: 'Legal Document',
  banker_communications: 'Banker Communication',
  shopping_list: 'Shopping List',
  market_study: 'Market Study',
  other: 'Document',
};

async function main() {
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({ prepare: false, onnotice: () => {} });
  const db = drizzle(client);

  // Everything created in this run shares one "now" timestamp so the workspace
  // and its rows sort to the top of created/updated listings.
  const now = new Date().toISOString();

  console.log(`seeding partial workspace into ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}...`);

  try {
    // ── Resolve existing users (NEVER create) ────────────────────────────────
    const requestedEmail = process.env.SEED_WORKSPACE_USER_EMAIL?.trim();

    let ownerRow: { id: string; email: string | null } | undefined;
    if (requestedEmail) {
      [ownerRow] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, requestedEmail))
        .limit(1);
      if (!ownerRow) {
        throw new Error(
          `SEED_WORKSPACE_USER_EMAIL=${requestedEmail} not found. This script never creates users — pass an existing user's email.`,
        );
      }
    } else {
      // Prefer a superadmin so the seeded workspace lands with someone who can
      // administer it; fall back to the oldest user otherwise.
      [ownerRow] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.is_superadmin, true))
        .orderBy(asc(users.created_at))
        .limit(1);
      if (!ownerRow) {
        [ownerRow] = await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .orderBy(asc(users.created_at))
          .limit(1);
      }
      if (!ownerRow) {
        throw new Error('No users exist in the target database. This script never creates users — seed a user first.');
      }
    }
    const owner = ownerRow;
    console.log(`  ✓ owner: ${owner.email ?? owner.id} (existing user)`);

    // A small set of existing users to attach as members + team coverage.
    const teamUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .orderBy(asc(users.created_at))
      .limit(MAX_TEAM_USERS);
    const memberIds = Array.from(new Set([owner.id, ...teamUsers.map((u) => u.id)]));

    // ── Roles (required for memberships; safe no-op if they already exist) ────
    await db
      .insert(roles)
      .values([
        { id: ROLE_ADMIN_ID, name: 'admin' },
        { id: ROLE_EDITOR_ID, name: 'editor' },
        { id: ROLE_VIEWER_ID, name: 'viewer' },
      ])
      .onConflictDoNothing({ target: roles.id });

    // ── One fresh workspace ──────────────────────────────────────────────────
    const workspaceId = randomUUID();
    const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
    const workspaceName = `Staging Demo ${stamp}`;
    const workspaceSlug = slugify(`staging-demo-${stamp}-${workspaceId.slice(0, 8)}`);
    await db.insert(workspaces).values({
      id: workspaceId,
      name: workspaceName,
      slug: workspaceSlug,
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing();
    console.log(`  ✓ workspace "${workspaceName}" (${workspaceSlug})`);

    // Attach the existing users as editors of the new workspace.
    await db
      .insert(userWorkspaces)
      .values(
        memberIds.map((userId) => ({
          user_id: userId,
          workspace_id: workspaceId,
          role_id: ROLE_EDITOR_ID,
          is_email_synced: userId === owner.id,
          created_at: now,
          updated_at: now,
        })),
      )
      .onConflictDoNothing({ target: [userWorkspaces.user_id, userWorkspaces.workspace_id] });
    console.log(`  ✓ ${memberIds.length} existing users added as members`);

    // ── Topics (shared vocabulary, workspace_id NULL) ────────────────────────
    // Staging already has most of these, sometimes under a different casing, so
    // the same slug/name can collide on either unique constraint. Reuse an
    // existing global topic matched by name OR derived slug; only insert when
    // neither is present.
    const topicIdByName = new Map<string, string>();
    for (const t of SEED_TOPICS) {
      const slug = slugify(t.name);
      const findExisting = () =>
        db
          .select({ id: topics.id })
          .from(topics)
          .where(and(isNull(topics.workspace_id), or(eq(topics.name, t.name), eq(topics.slug, slug))))
          .limit(1);

      let [existing] = await findExisting();
      if (!existing) {
        [existing] = await db
          .insert(topics)
          .values({ name: t.name, slug, is_deal_related: t.is_deal_related })
          .onConflictDoNothing()
          .returning({ id: topics.id });
      }
      if (!existing) [existing] = await findExisting(); // conflict on a column we didn't match
      if (existing) topicIdByName.set(t.name, existing.id);
    }
    console.log(`  ✓ ${topicIdByName.size}/${SEED_TOPICS.length} topics resolved`);

    // ── Employers (shared identity, upsert by normalized_name) + per-workspace
    //    correspondents + topic tags + team coverage + notes ──────────────────
    let contactCount = 0;
    let topicAssigns = 0;
    let teamRows = 0;
    let noteRows = 0;

    for (const firm of FIRMS) {
      const [employer] = await db
        .insert(employers)
        .values({
          name: firm.employer,
          normalized_name: normalize(firm.employer),
          industry: firm.industry,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: employers.normalized_name,
          set: { updated_at: now },
        })
        .returning({ id: employers.id });
      if (!employer) continue;

      // Correspondents are shared with the employer and unique per
      // (employer_id, email) — but via a PARTIAL index (WHERE email IS NOT
      // NULL), which ON CONFLICT column inference can't match. Employers are
      // reused across runs, so check for an existing row first and reuse it;
      // only insert when absent, so re-runs never hit the duplicate-key error.
      const correspondentIds: string[] = [];
      for (const c of firm.contacts) {
        let [row] = await db
          .select({ id: correspondents.id })
          .from(correspondents)
          .where(and(eq(correspondents.employer_id, employer.id), eq(correspondents.email, c.email)))
          .limit(1);
        if (!row) {
          [row] = await db
            .insert(correspondents)
            .values({
              employer_id: employer.id,
              name: c.name,
              email: c.email,
              phone: c.phone,
              title: c.title,
              type: c.type,
              is_primary: false,
              source: 'manual',
              created_at: now,
              updated_at: now,
            })
        .onConflictDoNothing()
            .returning({ id: correspondents.id });
        }
        if (row) correspondentIds.push(row.id);
      }
      contactCount += correspondentIds.length;

      if (correspondentIds.length > 0) {
        await db
          .insert(workspaceCorrespondents)
          .values(
            correspondentIds.map((id) => ({
              workspace_id: workspaceId,
              correspondent_id: id,
              source: 'manual' as const,
              created_at: now,
            })),
          )
          .onConflictDoNothing();
      }

      for (const t of firm.topics) {
        const topicId = topicIdByName.get(t.name);
        if (!topicId) continue;
        await db
          .insert(employerTopics)
          .values({
            employer_id: employer.id,
            topic_id: topicId,
            source: t.source,
            is_highlight: !!t.highlight,
          })
          .onConflictDoNothing();
        topicAssigns++;
      }

      for (const userId of memberIds) {
        await db
          .insert(employerTeamMembers)
          .values({ employer_id: employer.id, user_id: userId, created_at: now })
          .onConflictDoNothing();
        teamRows++;
      }

      for (const note of firm.notes) {
        await db.insert(employerNotes).values({
          employer_id: employer.id,
          workspace_id: workspaceId,
          author_user_id: owner.id,
          content: note,
          created_at: now,
          updated_at: now,
        }).onConflictDoNothing();
        noteRows++;
      }
    }
    console.log(
      `  ✓ ${FIRMS.length} employers + ${contactCount} correspondents + ${topicAssigns} topic tags + ${teamRows} team rows + ${noteRows} notes`,
    );

    // ── Companies scoped to the new workspace ────────────────────────────────
    // created_at/updated_at = now so they fall inside the dashboard's window;
    // dropped rows carry dropped_at = now so the "Dropped" recap tallies too.
    const insertedCompanies: Array<{ id: string; target: string }> = [];
    for (const c of COMPANIES) {
      const [inserted] = await db
        .insert(companies)
        .values({
          target: c.target,
          project_name: c.project_name,
          segment: c.segment,
          company_focus: c.company_focus,
          website: c.website,
          geography: c.geography,
          ownership: c.ownership,
          pipeline_stage: c.pipeline_stage,
          status: c.status,
          source: c.source,
          banker_source: c.banker_source,
          banker: c.banker_source,
          watchlist_status: c.status === 'dropped' ? 'Dropped' : 'New',
          dropped_reason: c.status === 'dropped' ? c.dropped_reason ?? null : null,
          dropped_at: c.status === 'dropped' ? now : null,
          last_activity_at: now,
          workspace_id: workspaceId,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .returning({ id: companies.id });
      if (!inserted) continue;
      insertedCompanies.push({ id: inserted.id, target: c.target });
      if (c.financials.length > 0) {
        await db.insert(companyFinancials).values(
          c.financials.map((f) => ({
            company_id: inserted.id,
            fiscal_year: f.fiscal_year,
            revenue_usd_mn: f.revenue_usd_mn,
            ebitda_usd_mn: f.ebitda_usd_mn,
            ev_usd_mn: f.ev_usd_mn,
            created_at: now,
            updated_at: now,
          })),
        ).onConflictDoNothing();
      }
    }
    const droppedCount = COMPANIES.filter((c) => c.status === 'dropped').length;
    console.log(
      `  ✓ ${insertedCompanies.length} companies (+ financials) — ${insertedCompanies.length - droppedCount} active / ${droppedCount} dropped, 5 per L0–L5 stage`,
    );

    // ── company_analyses — one completed analysis per company ────────────────
    if (insertedCompanies.length > 0) {
      await db.insert(companyAnalyses).values(
        insertedCompanies.map((c) => ({
          company_id: c.id,
          status: 'completed' as const,
          business_overview: ANALYSIS_TEMPLATE.business_overview,
          business_model_summary: ANALYSIS_TEMPLATE.business_model_summary,
          key_takeaways: ANALYSIS_TEMPLATE.key_takeaways,
          investment_highlights: ANALYSIS_TEMPLATE.investment_highlights,
          investment_risks: ANALYSIS_TEMPLATE.investment_risks,
          diligence_priorities: ANALYSIS_TEMPLATE.diligence_priorities,
          sources: ANALYSIS_TEMPLATE.sources,
          created_at: now,
          updated_at: now,
        })),
      ).onConflictDoNothing();
    }
    console.log(`  ✓ ${insertedCompanies.length} company analyses (completed)`);

    // ── AI File Dump — 2 files per file_type ─────────────────────────────────
    const fileDate = now.slice(0, 10); // YYYY-MM-DD
    const fileRows = FILE_TYPES.flatMap((type, ti) =>
      [1, 2].map((n) => {
        const idx = ti * 2 + (n - 1);
        const codename = CODENAMES[idx % CODENAMES.length];
        const label = FILE_TYPE_LABEL[type] ?? 'Document';
        const matched = insertedCompanies.length > 0 ? insertedCompanies[idx % insertedCompanies.length] : null;
        return {
          file_name: `${label} — ${codename} (${n}).pdf`,
          file_link: `https://files.example/${type}/${codename.toLowerCase()}-${n}.pdf`,
          raw_notes: `Auto-extracted notes from a ${label.toLowerCase()} relating to ${codename}.`,
          structured_notes: JSON.stringify(
            { summary: `${label} for ${codename}`, matched_companies: matched ? [matched] : [] },
            null,
            2,
          ),
          tags: [type, codename],
          processing_status: 'completed',
          matched_companies: matched ? [{ id: matched.id, target: matched.target }] : [],
          file_date: fileDate,
          file_type: type,
          origin_email: type === 'banker_communications',
          workspace_id: workspaceId,
          created_at: now,
          updated_at: now,
        };
      }),
    );
    await db.insert(files).values(fileRows).onConflictDoNothing();
    console.log(`  ✓ ${fileRows.length} AI File Dump files (2 × ${FILE_TYPES.length} types)`);

    console.log(`\n✅ done — workspace "${workspaceName}" (${workspaceId})`);
    console.log(`   open it as ${owner.email ?? owner.id}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
