/**
 * Local dev seed. Idempotent: re-running wipes prior seed rows (tagged by
 * entry_id in the 9001–9999 range and the fixed test-user email) and reinserts.
 * Not for production.
 *
 * Usage: pnpm db:seed
 */
import { config } from 'dotenv';
import { pathToFileURL } from 'node:url';
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import {
  companies,
  companyFinancials,
  correspondents,
  criterias,
  emailParticipants,
  emails,
  employerNotes,
  employerRelatedCompanies,
  employerTeamMembers,
  employerTopics,
  employers,
  featureFlags,
  files,
  investmentThesis,
  roles,
  rssFeeds,
  rssItems,
  topics,
  users,
  userWorkspaces,
  workspaceCorrespondents,
  workspaces,
  flInvestors,
  flFunds,
  flAssets,
  flFundingSources,
  flInvestmentTypes,
  insightTemplates,
  bots,
  routines,
  insights,
  insightVersions,
} from '../src/lib/db/schema';
import { RSS_CATEGORIES, type RssCategory } from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/services/password';
import { createContainer } from '../src/lib/services/container';
import { DEFAULT_INVESTMENT_TYPES } from '../src/lib/services';
import type { DbClient } from '../src/lib/server/db';
import type { DealType } from '../src/lib/companies/dealTypes';
// Type-only: keeps the (heavy, LangChain-pulling) agent module out of the
// seed's runtime graph while still checking each workspace's flavor.
import type { CopilotAgentType } from '../src/lib/agents/analysis';
import { MNA_WORKSPACE_ID, ROLE_ADMIN_ID, ROLE_EDITOR_ID, ROLE_VIEWER_ID } from '../src/lib/constants';
import { normalizeCompanyName } from '../src/lib/crm/normalizeCompanyName';
import { computeNextFireAt, normalizeSchedule } from '../src/lib/routines/schedule';
import { normalizeCanonicalName } from '../src/lib/fundLedger/normalizeIdentity';
import { insightContentHash } from '../src/lib/insights/contentHash';

const SEED_USER_EMAIL = 'test@sqe.co.id';
const SEED_USER_PASSWORD = 'password';
const SEED_USER_ROLE = 'admin';
const SEED_ENTRY_ID_MIN = 9001;
const SEED_ENTRY_ID_MAX = 9999;

// Extra workspaces + users for exercising multi-tenant switching locally
// (login → picker with 1 vs. several options → switcher). Hardcoded ids so
// they're stable across reseeds, same convention as MNA_WORKSPACE_ID.
//
// There is exactly one workspace per AI Copilot flavor, named after that
// flavor, so switching workspaces also switches Copilot and the feature set
// that comes with it (see SEED_WORKSPACES).
const TEST_WORKSPACE_2_ID = '00000000-0000-0000-0000-000000000002'; // M&A / Acquisitions
const TEST_WORKSPACE_3_ID = '00000000-0000-0000-0000-000000000003'; // Funds & Investing
// Seeded before the one-workspace-per-Copilot mapping ("Aeliana VCC"), which
// left it without a flavor of its own. Deleted on every seed so a local DB
// from an older seed converges instead of keeping a fourth, unmapped tenant.
const RETIRED_WORKSPACE_4_ID = '00000000-0000-0000-0000-000000000004';


/**
 * One workspace per AI Copilot flavor, so a single seeded DB covers all three
 * without touching the admin portal.
 *
 * `name`/`slug` mirror the admin portal's AI Copilot labels
 * (COPILOT_AGENT_OPTIONS) one-to-one — the workspace switcher then tells you
 * which agent a workspace talks to. This deliberately renames the
 * MNA_WORKSPACE_ID row away from the migration's prod backfill ('MnA'/'mna'):
 * it's the 'combined' workspace here because it carries the full fixture set
 * (deal pipeline *and* Fund Management). Funds & Investing gets the same
 * Fund Management portfolio under a separate UUID namespace.
 *
 * `features` are written as real `feature_flags` override rows rather than
 * left to the catalog/env defaults, so each flavor only exposes the surfaces
 * it can actually use and a reseed always lands on the same state:
 *  - M&A / Acquisitions has no Fund Management — it doesn't run funds.
 *  - Funds & Investing has no Dashboard or Pipeline — both are deal-flow
 *    surfaces with nothing to show for a fund manager.
 *  - Combined gets Dashboard, Pipeline, and Fund Management.
 *  - Company Graph and Insights Dashboard are on for every workspace
 *    (catalog default is off for both).
 *  - Any workspace with Fund Management on also gets the Ledger (derived
 *    below — see the loop right after this array).
 */
/**
 * Feature overrides written for EVERY seeded workspace, before that
 * workspace's own `features` map is layered on top.
 *
 * `DATA_NAVIGATOR_ENABLED` defaults to `false` in `FEATURE_CATALOG` (it is an
 * opt-in nav feature in production), which meant a freshly seeded local DB had
 * news data in `rss.items` but no way to reach it — the sidebar entry was
 * hidden in all three workspaces. Seeding the override ON here keeps the demo
 * data reachable everywhere without changing the production default. A
 * workspace can still opt out by setting the key `false` in its own `features`.
 */
const SEED_WORKSPACE_DEFAULT_FEATURES: Record<string, boolean> = {
  DATA_NAVIGATOR_ENABLED: true,
};

const SEED_WORKSPACES: Array<{
  id: string;
  name: string;
  slug: string;
  copilotAgent: CopilotAgentType;
  /** Layered over `SEED_WORKSPACE_DEFAULT_FEATURES`; same key here wins. */
  features: Record<string, boolean>;
}> = [
  {
    id: MNA_WORKSPACE_ID,
    name: 'Combined (M&A + Investment)',
    slug: 'combined',
    copilotAgent: 'combined',
    features: {
      DASHBOARD_ENABLED: true,
      PIPELINE_ENABLED: true,
      FUND_MANAGEMENT_ENABLED: true,
      COMPANY_GRAPH_ENABLED: true,
      INSIGHTS_DASHBOARD_ENABLED: true,
    },
  },
  {
    id: TEST_WORKSPACE_2_ID,
    name: 'M&A / Acquisitions',
    slug: 'mna-acquisitions',
    copilotAgent: 'mna',
    features: {
      DASHBOARD_ENABLED: true,
      PIPELINE_ENABLED: true,
      FUND_MANAGEMENT_ENABLED: false,
      COMPANY_GRAPH_ENABLED: true,
      INSIGHTS_DASHBOARD_ENABLED: true,
    },
  },
  {
    id: TEST_WORKSPACE_3_ID,
    name: 'Funds & Investing',
    slug: 'funds-investing',
    copilotAgent: 'investment',
    features: {
      DASHBOARD_ENABLED: false,
      PIPELINE_ENABLED: false,
      FUND_MANAGEMENT_ENABLED: true,
      COMPANY_GRAPH_ENABLED: true,
      INSIGHTS_DASHBOARD_ENABLED: true,
    },
  },
];

// The fund ledger only makes sense where Fund Management is on, so keep it
// derived from FUND_MANAGEMENT_ENABLED rather than a third hardcoded flag per
// workspace that could drift out of sync. Written both true and false (not a
// one-sided `if`) so a reseed still converges and clears any stale
// LEDGER_ENABLED override left over from the admin portal.
for (const ws of SEED_WORKSPACES) {
  ws.features.LEDGER_ENABLED = Boolean(ws.features.FUND_MANAGEMENT_ENABLED);
}

const SEED_EXTRA_USERS = [
  { email: 'test2@sqe.co.id', name: 'Test User 2' },
  { email: 'test3@sqe.co.id', name: 'Test User 3' },
  { email: 'test4@sqe.co.id', name: 'Test User 4' },
];

// test2 and test3 each belong to exactly one workspace (auto-skip path);
// test4 belongs to two (picker + switcher path), which also puts a
// single-flavor pair — M&A-only and Investment-only — behind one login.
const SEED_EXTRA_MEMBERSHIPS: Array<{ email: string; workspaceId: string }> = [
  { email: 'test2@sqe.co.id', workspaceId: TEST_WORKSPACE_2_ID },
  { email: 'test3@sqe.co.id', workspaceId: TEST_WORKSPACE_3_ID },
  { email: 'test4@sqe.co.id', workspaceId: TEST_WORKSPACE_2_ID },
  { email: 'test4@sqe.co.id', workspaceId: TEST_WORKSPACE_3_ID },
];

const seedThesis = {
  title: 'Seed: SEA Industrial Tech Roll-Up',
  content:
    'Roll-up thesis targeting industrial automation and logistics tech across Southeast Asia. Focused on EBITDA-positive companies with $10–50M revenue, family- or PE-owned, with regional expansion potential.',
  is_active: true,
  scan_frequency: 'weekly',
  sources_count: 5,
};

const seedCriterias = [
  {
    name: 'Seed: Revenue $10M–$50M',
    prompt:
      'Does the company report annual revenue between USD $10M and USD $50M in the most recent fiscal year?',
  },
  {
    name: 'Seed: EBITDA-positive',
    prompt:
      'Is the company EBITDA-positive in the most recent fiscal year reported?',
  },
  {
    name: 'Seed: Headquartered in Southeast Asia',
    prompt:
      'Is the company headquartered in Southeast Asia (Indonesia, Malaysia, Philippines, Singapore, Thailand, or Vietnam)?',
  },
];

type SeedContact = {
  name: string;
  email: string;
  phone?: string;
  /** Firm the contact works for — becomes an `employers` row. */
  company: string;
  title: string;
  /** Free-text classification (e.g. Bankers, Advisors, Internal). */
  type: string;
  /** Desk — e.g. 'M&A', 'ECM'. Editable in the CRM contact dialog. */
  department?: string;
  /** Sector / product focus, free text. */
  specialization?: string;
  /** Rank — coarser than the free-text `title`. */
  seniority?: string;
  /** Geography covered. */
  coverage_region?: string;
  linkedin_url?: string;
  /** Free-text background, shown under the contact in the CRM card. */
  bio?: string;
  notes?: string;
};

const seedContacts: SeedContact[] = [
  {
    name: 'Jimmy Sprinkles',
    email: 'jimmy.sprinkles@goldensacks.example',
    phone: '+1 212 555 0101',
    company: 'Golden Sacks',
    title: 'Managing Director',
    type: 'external',
    department: 'M&A',
    specialization: 'Technology, semiconductors',
    seniority: 'Managing Director',
    coverage_region: 'Asia Pacific',
    linkedin_url: 'https://www.linkedin.com/in/jimmy-sprinkles-example',
    bio: 'Runs the APAC tech M&A desk; has brought us three semiconductor carve-outs.',
    notes: 'Primary contact for tech M&A deals in Asia',
  },
  {
    name: 'Sally Bubbles',
    email: 'sally.bubbles@jporgan.example',
    phone: '+1 212 555 0102',
    company: 'JP Organ',
    title: 'Executive Director',
    type: 'external',
    department: 'Sector Coverage',
    specialization: 'Industrials, specialty chemicals',
    seniority: 'Executive Director',
    coverage_region: 'Global',
    linkedin_url: 'https://www.linkedin.com/in/sally-bubbles-example',
    bio: 'Industrials coverage banker; strongest source of chemicals teasers.',
    notes: 'Specializes in industrial sector transactions',
  },
  {
    name: 'Mikey Noodle',
    email: 'mikey.noodle@organstanley.example',
    phone: '+65 6555 0103',
    company: 'Organ Stanley',
    title: 'Vice President',
    type: 'external',
    department: 'M&A',
    specialization: 'Consumer, industrial tech',
    seniority: 'Vice President',
    coverage_region: 'Southeast Asia',
    linkedin_url: 'https://www.linkedin.com/in/mikey-noodle-example',
    bio: 'Leads the SEA coverage team out of Singapore.',
    notes: 'SEA coverage team lead',
  },
  {
    name: 'Wendy Wobble',
    email: 'wendy.wobble@sparklecapital.example',
    phone: '+62 21 555 0104',
    company: 'SparkleCapital',
    title: 'Investment Director',
    type: 'internal',
    department: 'Investment Team',
    specialization: 'Industrial tech roll-ups',
    seniority: 'Director',
    coverage_region: 'Southeast Asia',
    bio: 'Internal deal lead for the SEA industrial tech thesis.',
    notes: 'Internal deal team lead',
  },
  {
    name: 'Davey Pickles',
    email: 'davey.pickles@sparklecapital.example',
    phone: '+62 21 555 0105',
    company: 'SparkleCapital',
    title: 'Associate',
    type: 'internal',
    department: 'Investment Team',
    specialization: 'Financial analysis, due diligence',
    seniority: 'Associate',
    coverage_region: 'Southeast Asia',
    bio: 'Internal — models and diligence support across live mandates.',
    notes: 'Financial analysis and due diligence',
  },
  {
    name: 'Bobby Waffles',
    email: 'bobby.waffles@creditsweets.example',
    phone: '+852 3988 0106',
    company: 'Credit Sweets',
    title: 'Director',
    type: 'external',
    department: 'Leveraged Finance',
    specialization: 'Cross-border M&A financing',
    seniority: 'Director',
    coverage_region: 'Greater China',
    linkedin_url: 'https://www.linkedin.com/in/bobby-waffles-example',
    bio: 'Lev-fin contact for cross-border structures out of Hong Kong.',
    notes: 'Cross-border M&A specialist',
  },
  {
    name: 'Lizzy Doodle',
    email: 'lizzy.doodle@atlantis.example',
    phone: '+1 646 555 0107',
    company: 'Bank of Atlantis Marble Lynx',
    title: 'Managing Director',
    type: 'external',
    department: 'Sector Coverage',
    specialization: 'Healthcare, life sciences',
    seniority: 'Managing Director',
    coverage_region: 'North America',
    linkedin_url: 'https://www.linkedin.com/in/lizzy-doodle-example',
    bio: 'Healthcare coverage MD; mostly US assets, occasional APAC crossover.',
    notes: 'Healthcare and life sciences focus',
  },
  {
    name: 'Andy Pancake',
    email: 'andy.pancake@kitti.example',
    phone: '+65 6225 0108',
    company: 'Kittygroup',
    title: 'Director',
    type: 'external',
    department: 'ECM',
    specialization: 'Consumer, retail',
    seniority: 'Director',
    coverage_region: 'Southeast Asia',
    linkedin_url: 'https://www.linkedin.com/in/andy-pancake-example',
    bio: 'Consumer/retail ECM; good read on pre-IPO sellers in Indonesia.',
    notes: 'Consumer and retail sector coverage',
  },
];

// ─── CRM enrichment (topics, team, notes) ────────────────────────────────────
// Folded in from the former scripts/seed-crm.ts. The employers above (derived
// from seedContacts) are the source of truth; this layer attaches topic tags,
// internal team coverage, and relationship notes on top of them.

/** Internal team members (Investment Brain staff) — power the team-coverage filter. */
const SEED_TEAM_USERS = [
  { name: 'Alvin Wobblebottom', email: 'alvin.wobblebottom@sparklecapital.example', role: 'analyst' },
  { name: 'Sandy Sparkle', email: 'sandy.sparkle@sparklecapital.example', role: 'analyst' },
  { name: 'Danny Pebble', email: 'danny.pebble@sparklecapital.example', role: 'analyst' },
  { name: 'Mara Puddle', email: 'mara.puddle@sparklecapital.example', role: 'director' },
  { name: 'Jamie Tangerine', email: 'jamie.tangerine@sparklecapital.example', role: 'partner' },
] as const;

/**
 * Topic dictionary with the deal/non-deal classification (MB-271).
 * Deal-related = transaction terms, mechanics, stages, deal codenames.
 * Non-deal     = sectors, materials, geographies.
 */
const SEED_TOPICS: Array<{ name: string; is_deal_related: boolean }> = [
  // Deal-related
  { name: 'acquisition', is_deal_related: true },
  { name: 'mandate', is_deal_related: true },
  { name: 'carve-out', is_deal_related: true },
  { name: 'financing', is_deal_related: true },
  { name: 'buy-side', is_deal_related: true },
  { name: 'PE exit', is_deal_related: true },
  { name: 'deal flow', is_deal_related: true },
  { name: 'sourcing', is_deal_related: true },
  { name: 'TIM', is_deal_related: true },
  { name: 'term sheet', is_deal_related: true },
  { name: 'due diligence', is_deal_related: true },
  { name: 'divestiture', is_deal_related: true },
  // Non-deal (sector / material / geography)
  { name: 'CMP slurry', is_deal_related: false },
  { name: 'lithography', is_deal_related: false },
  { name: 'wet processing', is_deal_related: false },
  { name: 'packaging', is_deal_related: false },
  { name: 'advanced packaging', is_deal_related: false },
  { name: 'semiconductors', is_deal_related: false },
  { name: 'specialty chem', is_deal_related: false },
  { name: 'wafer', is_deal_related: false },
  { name: 'Korea', is_deal_related: false },
  { name: 'Japan', is_deal_related: false },
  { name: 'APAC', is_deal_related: false },
];

/** Per-firm topic assignments, team coverage, and notes, keyed by firm name. */
type CrmEnrichment = {
  topics: Array<{ name: string; source: 'auto' | 'manual'; highlight?: boolean }>;
  team: string[]; // internal user emails
  notes?: string[];
};

const CRM_ENRICHMENT: Record<string, CrmEnrichment> = {
  'Golden Sacks': {
    topics: [
      { name: 'CMP slurry', source: 'auto', highlight: true },
      { name: 'acquisition', source: 'auto' },
      { name: 'semiconductors', source: 'auto' },
      { name: 'financing', source: 'auto' },
      { name: 'lithography', source: 'auto' },
      { name: 'mandate', source: 'manual' },
    ],
    team: ['alvin.wobblebottom@sparklecapital.example', 'sandy.sparkle@sparklecapital.example'],
    notes: [
      'Key relationship. James is primary deal flow for semicon materials at GS. Prefers email. Connected us to TechSlurry in May.',
    ],
  },
  'JP Organ': {
    topics: [
      { name: 'lithography', source: 'auto', highlight: true },
      { name: 'mandate', source: 'auto' },
      { name: 'specialty chem', source: 'manual' },
      { name: 'APAC', source: 'manual' },
      { name: 'acquisition', source: 'auto' },
    ],
    team: ['alvin.wobblebottom@sparklecapital.example'],
    notes: ['Good source for lithography deal flow. Sarah well-connected in APAC.'],
  },
  'Organ Stanley': {
    topics: [
      { name: 'TIM', source: 'auto', highlight: true },
      { name: 'carve-out', source: 'auto' },
    ],
    team: ['jamie.tangerine@sparklecapital.example'],
    notes: ['Dormant relationship. Reconnect before next weekly meeting.'],
  },
  'Credit Sweets': {
    topics: [
      { name: 'financing', source: 'manual', highlight: true },
      { name: 'due diligence', source: 'auto' },
    ],
    team: ['mara.puddle@sparklecapital.example'],
    notes: ['Cross-border M&A. Reached out re: financing for Project Cobalt.'],
  },
  'Bank of Atlantis Marble Lynx': {
    topics: [
      { name: 'packaging', source: 'auto', highlight: true },
      { name: 'PE exit', source: 'auto' },
      { name: 'advanced packaging', source: 'auto' },
      { name: 'APAC', source: 'manual' },
      { name: 'deal flow', source: 'manual' },
      { name: 'carve-out', source: 'auto' },
      { name: 'financing', source: 'auto' },
    ],
    team: [
      'sandy.sparkle@sparklecapital.example',
      'alvin.wobblebottom@sparklecapital.example',
      'danny.pebble@sparklecapital.example',
      'jamie.tangerine@sparklecapital.example',
      'mara.puddle@sparklecapital.example',
    ],
    notes: ['Key APAC relationship. Lisa covers advanced packaging extensively.'],
  },
  Kittygroup: {
    topics: [
      { name: 'wet processing', source: 'auto', highlight: true },
      { name: 'Korea', source: 'auto' },
      { name: 'semiconductors', source: 'auto' },
      { name: 'sourcing', source: 'manual' },
      { name: 'deal flow', source: 'manual' },
      { name: 'APAC', source: 'auto' },
    ],
    team: ['jamie.tangerine@sparklecapital.example', 'alvin.wobblebottom@sparklecapital.example'],
    notes: ['Strong Korea network. Useful for APAC wet processing sourcing.'],
  },
};

type SeedCompany = {
  entry_id: number;
  target?: string;
  project_name?: string;
  segment: string;
  company_focus: string;
  website: string;
  geography: string;
  ownership: string;
  pipeline_stage: 'discovered' | 'market_screening' | 'unreviewed' | 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  status: 'active' | 'dropped';
  source?: 'inbound' | 'outbound';

  doc_type?:
    | 'prospectus'
    | 'im'
    | 'teaser'
    | 'mom'
    | 'financial_model'
    | 'financial_statement'
    | 'shopping_list'
    | 'market_study';
  banker_source?: string;
  remarks?: string;
  /** Free-form markdown background shown on the company card's Context tab. */
  context?: string;
  possible_duplicate_entry_id?: number;
  watchlist_status: string;
  dropped_reason?: string;
  dropped_at?: string;
  // Pipeline (HTML-parity) fields
  deal_type?: DealType;
  /**
   * Email of a user upserted before companies (the seed user or a
   * SEED_EXTRA_USERS entry). `companies.entered_by` is a users.id FK, so this
   * is resolved to that user's id at insert time — never put a display name
   * here.
   */
  entered_by_email?: string;
  originator?: string;
  last_activity_at?: string;
  banker?: string;
  /** Deal advisor (banker engaged on the deal). Non-empty ⇒ the deal is live. */
  advisor?: string;
  stake?: string;
  deal_size?: string;
  workflow_status?: string;
  key_rationale?: string;
  financials: Array<{
    fiscal_year: number;
    revenue_usd_mn?: number;
    ebitda_usd_mn?: number;
    ev_usd_mn?: number;
  }>;
};

const seedCompanies: SeedCompany[] = [
  {
    entry_id: 9020,
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
    doc_type: 'teaser',
    banker_source: 'Golden Sacks',
    remarks: 'Seed triage: extracted from Golden Sacks teaser; complete 2024 financials.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 42.0, ebitda_usd_mn: 7.4, ev_usd_mn: 128 },
    ],
  },
  {
    entry_id: 9021,
    target: 'Mega Retail Group',
    project_name: 'Project Mega',
    segment: 'Retail',
    company_focus: 'Multi-format specialty retail chain across Java',
    website: 'https://megaretail.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'JP Organ',
    remarks: 'Seed triage: missing financials path.',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9022,
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
    doc_type: 'shopping_list',
    banker_source: 'UBSnacks',
    remarks: 'Seed triage: target came from banker shopping list.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 31.5, ebitda_usd_mn: 4.8, ev_usd_mn: 96 },
    ],
  },
  {
    entry_id: 9023,
    target: 'Nusantara Health',
    project_name: 'Project Nusantara',
    segment: 'Healthcare',
    company_focus: 'Primary care clinic chain with employer contracts',
    website: 'https://nusantarahealth.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'shopping_list',
    banker_source: 'Kitti',
    remarks: 'Seed triage: possible duplicate flag points to Lumen Diagnostics.',
    possible_duplicate_entry_id: 9012,
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 25.1, ebitda_usd_mn: 3.2, ev_usd_mn: 82 },
    ],
  },
  {
    entry_id: 9033,
    target: '',
    project_name: 'Project Nameless Teaser',
    segment: 'Industrial Services',
    company_focus: 'Predictive maintenance services for heavy equipment fleets',
    website: 'https://namelessteaser.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Organ Stanley',
    remarks:
      'Seed coverage: company target name intentionally empty; UI should display the project name.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 18.6, ebitda_usd_mn: 2.7, ev_usd_mn: 54 },
    ],
  },
  {
    entry_id: 9024,
    target: 'Pacific Chemicals Ltd',
    project_name: 'Project Pacific',
    segment: 'Chemicals',
    company_focus: 'Specialty additives and packaging chemicals across APAC',
    website: 'https://pacificchemicals.example',
    geography: 'Asia Pacific',
    ownership: 'Corporate carve-out',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'market_study',
    banker_source: 'Doodle Bank',
    remarks: 'Seed triage: inbound market study case, actively pitched by banker.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 88.4, ebitda_usd_mn: 13.5, ev_usd_mn: 280 },
    ],
  },
  {
    entry_id: 9025,
    target: 'ASEAN Plastics Co',
    project_name: 'Project ASEAN Plastics',
    segment: 'Chemicals',
    company_focus: 'Regional plastics compounding benchmark from market study',
    website: 'https://aseanplastics.example',
    geography: 'Southeast Asia',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    doc_type: 'market_study',
    banker_source: 'Doodle Bank',
    remarks: 'Seed triage: outbound market intel generated from market study.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 72.0, ebitda_usd_mn: 9.9, ev_usd_mn: 190 },
    ],
  },
  {
    entry_id: 9026,
    target: 'Reviewed Teaser Co',
    project_name: 'Project Reviewed Teaser',
    segment: 'Business Services',
    company_focus: 'B2B compliance workflow software',
    website: 'https://reviewedteaser.example',
    geography: 'Singapore',
    ownership: 'PE-backed',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Organ Stanley',
    remarks: 'Seed triage: already kept by analyst.',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 37.8, ebitda_usd_mn: 6.0, ev_usd_mn: 150 },
    ],
  },
  {
    entry_id: 9027,
    target: 'Reviewed Shopping List Co',
    project_name: 'Project Reviewed List',
    segment: 'Logistics',
    company_focus: 'Last-mile delivery route optimization provider',
    website: 'https://reviewedlist.example',
    geography: 'Malaysia',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    doc_type: 'shopping_list',
    banker_source: 'Kitti',
    remarks: 'Seed triage: reviewed inbound shopping-list-origin company.',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 22.6, ebitda_usd_mn: 2.9, ev_usd_mn: 68 },
    ],
  },
  {
    entry_id: 9028,
    target: 'Reviewed Market Intel Co',
    project_name: 'Project Reviewed Intel',
    segment: 'Infrastructure',
    company_focus: 'Data center services benchmark from market study',
    website: 'https://reviewedintel.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    doc_type: 'market_study',
    banker_source: 'HSBQ',
    remarks: 'Seed triage: reviewed outbound market-intel company.',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 56.2, ebitda_usd_mn: 8.1, ev_usd_mn: 210 },
    ],
  },
  {
    entry_id: 9029,
    target: 'Dropped Unreviewed Co',
    project_name: 'Project Dropped Seed',
    segment: 'Consumer',
    company_focus: 'Specialty retail concept below mandate size',
    website: 'https://droppedunreviewed.example',
    geography: 'Thailand',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'dropped',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Bank of Atlantis',
    remarks: 'Seed triage: dropped row for dropped-view coverage.',
    watchlist_status: 'Dropped',
    dropped_reason: 'Seed coverage: dropped before triage completion.',
    dropped_at: '2026-06-01T10:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 8.7, ebitda_usd_mn: 0.6, ev_usd_mn: 24 },
    ],
  },
  {
    entry_id: 9001,
    project_name: 'Project Atlas',
    segment: 'Industrial Automation',
    company_focus: 'Factory-floor robotic arms for SMB manufacturers',
    website: 'https://acme-robotics.example',
    geography: 'USA',
    ownership: 'Private',
    source: 'outbound',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 31.4, ebitda_usd_mn: 4.1 },
      { fiscal_year: 2023, revenue_usd_mn: 42.1, ebitda_usd_mn: 6.2 },
      { fiscal_year: 2024, revenue_usd_mn: 58.7, ebitda_usd_mn: 9.4, ev_usd_mn: 320 },
      { fiscal_year: 2025, revenue_usd_mn: 71.2, ebitda_usd_mn: 12.1, ev_usd_mn: 390 },
    ],
  },
  {
    entry_id: 9002,
    target: 'Blue Harbor Logistics',
    segment: 'Freight Forwarding',
    company_focus: 'Cross-border trucking aggregator in SEA',
    website: 'https://blueharbor.example',
    geography: 'Indonesia',
    ownership: 'PE-backed',
    source: 'inbound',
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
    banker_source: 'Golden Sacks',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 120.0, ebitda_usd_mn: 14.8 },
      { fiscal_year: 2024, revenue_usd_mn: 134.5, ebitda_usd_mn: 18.1, ev_usd_mn: 410 },
    ],
  },
  {
    entry_id: 9003,
    target: 'Cinder Foods',
    project_name: 'Project Cedar',
    segment: 'F&B / Packaged Goods',
    company_focus: 'Frozen ready-meals for urban retail',
    website: 'https://cinderfoods.example',
    geography: 'Singapore',
    ownership: 'Family-owned',
    source: 'outbound',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Monitoring',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 18.7, ebitda_usd_mn: 1.5, ev_usd_mn: 60 },
      { fiscal_year: 2023, revenue_usd_mn: 22.3, ebitda_usd_mn: 2.1 },
      { fiscal_year: 2024, revenue_usd_mn: 28.9, ebitda_usd_mn: 3.6, ev_usd_mn: 95 },
      { fiscal_year: 2025, revenue_usd_mn: 33.4 },
    ],
  },
  {
    entry_id: 9004,
    project_name: 'Project Delphi',
    segment: 'AI / SaaS',
    company_focus: 'Voice AI for call-center QA',
    website: 'https://deltaneural.example',
    geography: 'India',
    ownership: 'VC-backed',
    source: 'inbound',
    pipeline_stage: 'L2',
    status: 'active',
    watchlist_status: 'Active',
    banker_source: 'JP Organ',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 4.1 },
      { fiscal_year: 2023, revenue_usd_mn: 8.4, ebitda_usd_mn: -1.2 },
      { fiscal_year: 2024, revenue_usd_mn: 17.2, ebitda_usd_mn: 0.8, ev_usd_mn: 180 },
      { fiscal_year: 2025, revenue_usd_mn: 29.5, ebitda_usd_mn: 3.4, ev_usd_mn: 310 },
    ],
  },
  {
    entry_id: 9005,
    target: 'Ember Renewables',
    segment: 'Clean Energy',
    company_focus: 'Rooftop solar + storage for commercial estates',
    website: 'https://emberrenewables.example',
    geography: 'Vietnam',
    ownership: 'Private',
    source: 'inbound',
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
    banker_source: 'Kitti',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 48.2, ebitda_usd_mn: 6.9, ev_usd_mn: 190 },
      { fiscal_year: 2023, revenue_usd_mn: 61.0, ebitda_usd_mn: 9.1 },
      { fiscal_year: 2024, revenue_usd_mn: 74.3, ebitda_usd_mn: 12.4, ev_usd_mn: 280 },
    ],
  },
  {
    entry_id: 9006,
    target: 'Ferrous Metalworks',
    project_name: 'Project Forge',
    segment: 'Heavy Manufacturing',
    company_focus: 'Precision steel components for auto OEMs',
    website: 'https://ferrousmw.example',
    geography: 'Thailand',
    ownership: 'Listed',
    source: 'outbound',
    pipeline_stage: 'L0',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'Revenue declining YoY and customer base concentrated in legacy ICE auto OEMs; misaligned with thesis exposure to growth segments.',
    dropped_at: '2026-02-12T09:30:00Z',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 210.5, ebitda_usd_mn: 22.0 },
      { fiscal_year: 2024, revenue_usd_mn: 205.1, ebitda_usd_mn: 19.4, ev_usd_mn: 540 },
      { fiscal_year: 2025, revenue_usd_mn: 198.7, ebitda_usd_mn: 17.2 },
    ],
  },
  {
    entry_id: 9007,
    project_name: 'Project Gemini',
    segment: 'Healthcare Services',
    company_focus: 'Outpatient diagnostic chain',
    website: 'https://glacierhealth.example',
    geography: 'Philippines',
    ownership: 'Private',
    source: 'inbound',
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
    banker_source: 'Organ Stanley',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 37.2, ebitda_usd_mn: 5.9, ev_usd_mn: 195 },
      { fiscal_year: 2023, revenue_usd_mn: 44.7, ebitda_usd_mn: 7.8 },
      { fiscal_year: 2024, revenue_usd_mn: 53.8, ebitda_usd_mn: 10.9, ev_usd_mn: 260 },
      { fiscal_year: 2025, revenue_usd_mn: 61.0, ebitda_usd_mn: 13.2, ev_usd_mn: 310 },
    ],
  },
  {
    entry_id: 9008,
    target: 'Halcyon Media',
    segment: 'Digital Media',
    company_focus: 'Vertical publishing network for SEA SMBs',
    website: 'https://halcyonmedia.example',
    geography: 'Malaysia',
    ownership: 'Private',
    source: 'outbound',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Monitoring',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 9.3 },
      { fiscal_year: 2023, revenue_usd_mn: 11.2, ebitda_usd_mn: 1.4 },
      { fiscal_year: 2024, revenue_usd_mn: 14.6, ebitda_usd_mn: 2.2, ev_usd_mn: 72 },
      { fiscal_year: 2025, revenue_usd_mn: 16.1 },
    ],
  },
  {
    entry_id: 9009,
    target: 'Indigo Apparel',
    segment: 'Consumer / Apparel',
    company_focus: 'Boutique denim brand with regional retail footprint',
    website: 'https://indigoapparel.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    source: 'outbound',
    pipeline_stage: 'market_screening',
    status: 'active',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 6.2, ebitda_usd_mn: 0.4 },
      { fiscal_year: 2025, revenue_usd_mn: 7.1, ebitda_usd_mn: 0.6 },
    ],
  },
  {
    entry_id: 9010,
    target: 'Juniper AgriTech',
    project_name: 'Project Juniper',
    segment: 'AgriTech',
    company_focus: 'Precision irrigation systems for smallholder farms',
    website: 'https://juniperagri.example',
    geography: 'Vietnam',
    ownership: 'VC-backed',
    source: 'outbound',
    pipeline_stage: 'L1',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'EBITDA negative for three consecutive years with no clear path to profitability; founders unwilling to discuss control transactions.',
    dropped_at: '2026-03-18T14:42:00Z',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 11.5, ebitda_usd_mn: -3.2 },
      { fiscal_year: 2024, revenue_usd_mn: 14.8, ebitda_usd_mn: -2.7 },
      { fiscal_year: 2025, revenue_usd_mn: 18.6, ebitda_usd_mn: -1.9 },
    ],
  },
  {
    entry_id: 9011,
    target: 'Kestrel Cold Chain',
    project_name: 'Project Kestrel',
    segment: 'Logistics / Cold Chain',
    company_focus: 'Refrigerated warehousing and last-mile for pharma',
    website: 'https://kestrelcold.example',
    geography: 'Philippines',
    ownership: 'PE-backed',
    source: 'outbound',
    pipeline_stage: 'L2',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'Top customer concentration risk — single pharma client = 58% of revenue; renewal uncertain after 2026.',
    dropped_at: '2026-04-02T08:20:00Z',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 32.4, ebitda_usd_mn: 4.1 },
      { fiscal_year: 2024, revenue_usd_mn: 38.7, ebitda_usd_mn: 5.6, ev_usd_mn: 165 },
      { fiscal_year: 2025, revenue_usd_mn: 41.2, ebitda_usd_mn: 6.0 },
    ],
  },
  {
    entry_id: 9012,
    target: 'Lumen Diagnostics',
    project_name: 'Project Lumen',
    segment: 'Healthcare / Diagnostics',
    company_focus: 'Lab-as-a-service for hospital networks',
    website: 'https://lumendx.example',
    geography: 'Malaysia',
    ownership: 'Private',
    source: 'outbound',
    pipeline_stage: 'L3',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'Valuation expectations from sellers (>14x EV/EBITDA) materially above comparables; gap could not be bridged.',
    dropped_at: '2026-04-15T16:05:00Z',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 27.1, ebitda_usd_mn: 5.4 },
      { fiscal_year: 2024, revenue_usd_mn: 33.8, ebitda_usd_mn: 7.1, ev_usd_mn: 210 },
      { fiscal_year: 2025, revenue_usd_mn: 39.6, ebitda_usd_mn: 8.9, ev_usd_mn: 250 },
    ],
  },
  {
    entry_id: 9013,
    target: 'Meridian Packaging',
    project_name: 'Project Meridian',
    segment: 'Industrial / Packaging',
    company_focus: 'Sustainable corrugated packaging for e-commerce',
    website: 'https://meridianpkg.example',
    geography: 'Thailand',
    ownership: 'Family-owned',
    source: 'outbound',
    pipeline_stage: 'L4',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'QoE surfaced material revenue recognition adjustments (~12% of stated EBITDA); deal economics no longer support thesis.',
    dropped_at: '2026-04-22T10:48:00Z',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 64.0, ebitda_usd_mn: 9.8 },
      { fiscal_year: 2024, revenue_usd_mn: 71.5, ebitda_usd_mn: 11.4, ev_usd_mn: 295 },
      { fiscal_year: 2025, revenue_usd_mn: 78.2, ebitda_usd_mn: 12.6, ev_usd_mn: 320 },
    ],
  },
  {
    entry_id: 9014,
    target: 'Northwind Robotics',
    project_name: 'Project Northwind',
    segment: 'Industrial Automation',
    company_focus: 'Warehouse AGVs for 3PL operators',
    website: 'https://northwindrobotics.example',
    geography: 'Singapore',
    ownership: 'PE-backed',
    source: 'outbound',
    pipeline_stage: 'L5',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'Lost to competing strategic in final round; counterparty offered all-cash at premium valuation we declined to match.',
    dropped_at: '2026-05-01T13:11:00Z',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 45.6, ebitda_usd_mn: 7.2 },
      { fiscal_year: 2024, revenue_usd_mn: 58.9, ebitda_usd_mn: 10.1, ev_usd_mn: 340 },
      { fiscal_year: 2025, revenue_usd_mn: 72.4, ebitda_usd_mn: 13.8, ev_usd_mn: 420 },
    ],
  },

  // ── INBOUND companies (source = 'inbound') ───────────────────────────────
  {
    entry_id: 9015,
    target: 'Soulbrain Co., Ltd.',
    segment: 'Wet Process Chemicals — EUV Photoresist Solvents',
    company_focus: 'Ultra-pure process chemicals for advanced-node fabs',
    website: 'https://soulbrain.example',
    geography: 'South Korea',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Golden Sacks',
    originator: 'James Wong',
    doc_type: 'teaser',
    workflow_status: 'Unreviewed',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 340, ebitda_usd_mn: 62 }],
  },
  {
    entry_id: 9016,
    target: 'Stella Chemifa Corporation',
    segment: 'Ultra-High Purity Fluorine Chemicals',
    company_focus: 'High-purity hydrofluoric acid for semiconductor etching',
    website: 'https://stella-chemifa.example',
    geography: 'Japan',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'JP Organ',
    originator: 'Nur Khairusy',
    doc_type: 'teaser',
    workflow_status: 'Unreviewed',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 180, ebitda_usd_mn: 28 }],
  },
  {
    entry_id: 9017,
    target: 'Fuji Electronic Materials',
    segment: 'CMP Slurries — STI & Metal',
    company_focus: 'Chemical-mechanical planarization slurries',
    website: 'https://fuji-em.example',
    geography: 'Japan',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'minority',
    banker: 'Organ Stanley',
    originator: 'Reza Hakim',
    doc_type: 'shopping_list',
    workflow_status: 'Unreviewed',
    last_activity_at: '2026-06-11T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 95, ebitda_usd_mn: 14 }],
  },
  {
    entry_id: 9018,
    target: 'ENF Technology Co., Ltd.',
    segment: 'Photoresist — ArF & KrF',
    company_focus: 'Photoresist and thinner chemistries for lithography',
    website: 'https://enftech.example',
    geography: 'South Korea',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Evercore',
    originator: 'James Wong',
    doc_type: 'teaser',
    workflow_status: 'Teaser review',
    last_activity_at: '2026-06-09T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 78, ebitda_usd_mn: 11 }],
  },
  {
    entry_id: 9019,
    target: 'Kanto Denka Kogyo Co.',
    segment: 'Specialty Gases — WF6 & NF3',
    company_focus: 'Electronic specialty gases for deposition & etch',
    website: 'https://kantodenka.example',
    geography: 'Japan',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Kittygroup',
    originator: 'Nur Khairusy',
    doc_type: 'market_study',
    workflow_status: 'NDA pending',
    last_activity_at: '2026-06-05T00:00:00Z',
    financials: [{ fiscal_year: 2023, revenue_usd_mn: 260, ebitda_usd_mn: 38 }],
  },
  {
    entry_id: 9020,
    target: 'PT Industri Telekomunikasi Indonesia (INTI)',
    segment: 'Telecom Electronics Manufacturing & System Integration',
    company_focus: 'Telecom equipment manufacturing and system integration',
    website: 'https://inti.example',
    geography: 'Indonesia',
    ownership: 'State-owned',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'minority',
    banker: 'Mandarin Sekuritas',
    originator: 'Nur Khairusy',
    doc_type: 'teaser',
    workflow_status: 'NDA pending',
    stake: '30%',
    deal_size: '$22M',
    last_activity_at: '2026-06-08T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 45, ebitda_usd_mn: 6.8 }],
  },
  {
    entry_id: 9021,
    target: 'PT Hartono Istana Teknologi (Polytron)',
    segment: 'Consumer Electronics Manufacturing & Semiconductor Design',
    company_focus: 'Consumer electronics manufacturing with in-house IC design',
    website: 'https://polytron.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'DIMB',
    originator: 'James Wong',
    doc_type: 'teaser',
    workflow_status: 'NDA executed',
    stake: '60%',
    deal_size: '$95M',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 210, ebitda_usd_mn: 28 }],
  },
  {
    entry_id: 9022,
    target: 'Wonik IPS Co., Ltd.',
    segment: 'Semiconductor Equipment — CVD/ALD/Etch Systems',
    company_focus: 'Deposition and etch equipment for memory & logic fabs',
    website: 'https://wonikips.example',
    geography: 'South Korea',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'public_market',
    banker: 'Sundae Securities',
    originator: 'James Wong',
    doc_type: 'teaser',
    workflow_status: 'L1 prep',
    stake: '25%',
    deal_size: '$48M',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 92, ebitda_usd_mn: 14 }],
  },
  {
    entry_id: 9023,
    target: 'Doohickey Electronic Materials Co.',
    segment: 'Semiconductor Materials — CMP Slurry',
    company_focus: 'CMP slurries and conductive paste materials',
    website: 'https://daejoo.example',
    geography: 'South Korea',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'KB Securities',
    originator: 'Reza Hakim',
    doc_type: 'teaser',
    workflow_status: 'Teaser review',
    stake: '60%',
    deal_size: '$28M',
    dropped_reason: 'Valuation mismatch — sellers anchored well above comparable transactions.',
    dropped_at: '2026-05-20T09:30:00Z',
    last_activity_at: '2026-05-20T09:30:00Z',
    financials: [{ fiscal_year: 2023, revenue_usd_mn: 34, ebitda_usd_mn: 4.1 }],
  },

  // ── OUTBOUND companies (source = 'outbound') ─────────────────────────────
  {
    entry_id: 9024,
    target: 'Amazing Semiconductor Engineering (AZE)',
    segment: 'Semiconductor OSAT',
    company_focus: 'Largest outsourced assembly & test provider in Asia',
    website: 'https://aseglobal.example',
    geography: 'Taiwan',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'majority',
    originator: 'James Wong',
    workflow_status: 'First contact made',
    key_rationale:
      'Largest OSAT in Asia; strong fit with our semiconductor platform thesis. Listed on TWSE with known shareholders.',
    remarks: 'Warm intro via Golden Sacks; management receptive to PE conversations.',
    context: [
      '## Why we are looking',
      'Largest OSAT in Asia and the anchor asset for the semiconductor platform thesis — owning it would make every downstream packaging target easier to approach.',
      '',
      '## Situation',
      '- Listed on TWSE; the founding family still holds ~28% and has signalled it would consider a partner for the automotive-packaging arm.',
      '- Golden Sacks made the introduction in May 2026; management were receptive but have not run a process.',
      '- No NDA yet. Everything below FY2024 is from public filings.',
      '',
      '## Open questions',
      '- Would a carve-out of the automotive arm be entertained, or is it whole-company only?',
      '- Customer concentration: the top three account for more than half of revenue on our read of the filings.',
    ].join('\n'),
    last_activity_at: '2026-06-10T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 18000, ebitda_usd_mn: 3200, ev_usd_mn: 12000 },
    ],
  },
  {
    entry_id: 9025,
    target: 'Greattech Gizmos Inc.',
    segment: 'Semiconductor Packaging',
    company_focus: 'Niche IC packaging for automotive end markets',
    website: 'https://greatek.example',
    geography: 'Taiwan',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'bond_issuance',
    originator: 'Nur Khairusy',
    workflow_status: 'Target identified',
    key_rationale:
      'Niche IC packaging for automotive; high EBITDA margin. Underleveraged balance sheet, founder-owned, open to dilution.',
    remarks: 'No prior contact. Identified via Gartner supply chain report.',
    context: [
      '## Why we are looking',
      'Niche automotive IC packaging with best-in-class margins, founder-owned and underleveraged — the cleanest minority entry point we have seen in the segment.',
      '',
      '## Situation',
      'Cold. Surfaced from the Gartner supply-chain report, no contact made. The founder is reported to be in his late sixties with no succession plan announced, which is the whole reason this is on the list.',
      '',
      '## Caveats',
      'Every figure on this record is estimated from the Gartner report and trade press. Treat the FY2024 numbers as indicative until we see audited statements.',
    ].join('\n'),
    last_activity_at: '2026-05-30T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 320, ebitda_usd_mn: 58, ev_usd_mn: 480 },
    ],
  },
  {
    entry_id: 9026,
    target: 'Inori Amazertron Berhad',
    segment: 'Semiconductor RF Test & Assembly',
    company_focus: 'RF assembly partner for the Pineapple supply chain',
    website: 'https://inari-amertron.example',
    geography: 'Malaysia',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'majority',
    originator: 'Reza Hakim',
    workflow_status: 'Intermediary approach',
    key_rationale:
      'Leading RF assembly partner for Pineapple supply chain. Controlled by founder family; succession planning may create entry.',
    remarks: 'Banker intermediary (DIMB) made soft approach in Feb.',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 890, ebitda_usd_mn: 180, ev_usd_mn: 1200 },
    ],
  },
  {
    entry_id: 9027,
    target: 'UMW (Unicorn Microelectronics Corp)',
    segment: 'Foundry — Logic & Specialty',
    company_focus: 'Mature-node logic and specialty foundry',
    website: 'https://umc.example',
    geography: 'Taiwan',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'ma_advisory',
    originator: 'James Wong',
    workflow_status: 'Direct outreach',
    key_rationale:
      'Mature-node foundry leader; strategic adjacency to our existing portfolio. Not a full buyout — looking at JV or stake.',
    remarks: 'Corp Dev VP reached out via LinkedIn. Meeting being scheduled.',
    last_activity_at: '2026-06-06T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 7200, ebitda_usd_mn: 2100, ev_usd_mn: 15000 },
    ],
  },
  {
    entry_id: 9028,
    target: 'WizTrox Corporation Berhad',
    segment: 'Machine Vision & Automated Test Equipment',
    company_focus: 'Machine vision for PCB & semiconductor inspection',
    website: 'https://vitrox.example',
    geography: 'Malaysia',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'majority',
    originator: 'Reza Hakim',
    workflow_status: 'Teaser received',
    key_rationale:
      'Market leader in machine vision for PCB & semiconductor inspection. High R&D moat, recurring software revenue stream.',
    remarks: 'CFO Steven Cheah known to our advisor. Teaser obtained informally.',
    last_activity_at: '2026-06-11T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 210, ebitda_usd_mn: 55, ev_usd_mn: 420 },
    ],
  },
  {
    entry_id: 9029,
    target: 'Shinypants Chemical Co.',
    segment: 'Semiconductor Silicon Wafers & Photoresists',
    company_focus: 'Dominant global silicon wafer and photoresist supplier',
    website: 'https://shinetsu.example',
    geography: 'Japan',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    watchlist_status: 'Monitoring',
    source: 'outbound',
    deal_type: 'equity_crowdfunding',
    originator: 'Nur Khairusy',
    workflow_status: 'Market intel',
    key_rationale:
      'Dominant silicon wafer supplier globally; photoresist chemicals division is a strong strategic adjacency. Flagged as top consolidator in Japan.',
    remarks:
      'Extracted from JP Organ APAC Chemicals market study (May 2026). Not being pitched — referenced as market benchmark.',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 14000, ebitda_usd_mn: 3400, ev_usd_mn: 40000 },
    ],
  },
  {
    entry_id: 9030,
    target: 'Powerpuff Technology Inc.',
    segment: 'Semiconductor OSAT — Memory Packaging',
    company_focus: 'Memory packaging and test services',
    website: 'https://powertech.example',
    geography: 'Taiwan',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'outbound',
    deal_type: 'majority',
    originator: 'James Wong',
    workflow_status: 'Discussions ongoing',
    key_rationale:
      'Strong memory packaging play; overlap with existing portfolio.',
    remarks: 'Reached final discussion stage but owner unwilling to sell majority.',
    dropped_reason: 'Owner not interested in a majority sale.',
    dropped_at: '2026-05-15T10:00:00Z',
    last_activity_at: '2026-05-15T10:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 620, ebitda_usd_mn: 95, ev_usd_mn: 1100 },
    ],
  },

  // ── ADDITIONAL MARKET SCREENING (AI-discovered, outbound) ───────────────
  {
    entry_id: 9040,
    target: 'Edukita Learning Systems',
    segment: 'EdTech / Online Learning',
    company_focus: 'Adaptive K-12 learning platform serving schools across Java and Sumatra',
    website: 'https://edukita.example',
    geography: 'Indonesia',
    ownership: 'VC-backed',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 11.4, ebitda_usd_mn: 1.2 },
    ],
  },
  {
    entry_id: 9041,
    target: 'ColdLink Logistics',
    segment: 'Cold Chain / Logistics',
    company_focus: 'Temperature-controlled warehousing and last-mile for pharma and food in the Philippines',
    website: 'https://coldlink.example',
    geography: 'Philippines',
    ownership: 'Family-owned',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 28.7, ebitda_usd_mn: 4.1 },
      { fiscal_year: 2024, revenue_usd_mn: 34.2, ebitda_usd_mn: 5.0 },
    ],
  },
  {
    entry_id: 9042,
    target: 'AquaTech Solutions Vietnam',
    segment: 'Water Treatment / Environmental Services',
    company_focus: 'Industrial wastewater treatment plants and municipal water concessions across Vietnam',
    website: 'https://aquatech-vn.example',
    geography: 'Vietnam',
    ownership: 'Private',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 19.8, ebitda_usd_mn: 4.6, ev_usd_mn: 72 },
    ],
  },
  {
    entry_id: 9043,
    target: 'Mitra Auto Parts',
    segment: 'Automotive Components',
    company_focus: 'OEM-grade brake and suspension components for Japanese auto brands in Thailand',
    website: 'https://mitraauto.example',
    geography: 'Thailand',
    ownership: 'Family-owned',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 42.0, ebitda_usd_mn: 5.9 },
      { fiscal_year: 2024, revenue_usd_mn: 47.5, ebitda_usd_mn: 6.8, ev_usd_mn: 140 },
    ],
  },
  {
    entry_id: 9044,
    target: 'Apex MedDevices',
    segment: 'Medical Devices',
    company_focus: 'Diagnostic imaging equipment distributor and service network in Malaysia',
    website: 'https://apexmeddevices.example',
    geography: 'Malaysia',
    ownership: 'PE-backed',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 23.1, ebitda_usd_mn: 3.8 },
    ],
  },
  {
    entry_id: 9045,
    target: 'Ceria Digital Payments',
    segment: 'Fintech / Payments',
    company_focus: 'QR-based merchant payment acceptance and working capital for SMEs in Singapore',
    website: 'https://ceriadp.example',
    geography: 'Singapore',
    ownership: 'VC-backed',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 8.2, ebitda_usd_mn: -0.9 },
      { fiscal_year: 2024, revenue_usd_mn: 14.7, ebitda_usd_mn: 1.1 },
    ],
  },
  {
    entry_id: 9046,
    target: 'Surya Food Manufacturing',
    segment: 'F&B / Food Manufacturing',
    company_focus: 'Packaged snacks and instant noodle co-manufacturer for FMCG brands across Indonesia',
    website: 'https://suryafood.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 31.0, ebitda_usd_mn: 4.2 },
      { fiscal_year: 2023, revenue_usd_mn: 38.5, ebitda_usd_mn: 5.3 },
      { fiscal_year: 2024, revenue_usd_mn: 44.2, ebitda_usd_mn: 6.4, ev_usd_mn: 130 },
    ],
  },
  {
    entry_id: 9047,
    target: 'MineServ Equipment Rentals',
    segment: 'Mining Services / Equipment',
    company_focus: 'Heavy equipment rental and maintenance for coal and nickel mining operations in Kalimantan',
    website: 'https://mineserv.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'market_screening',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 56.0, ebitda_usd_mn: 9.8, ev_usd_mn: 185 },
    ],
  },

  // ── GRAPH DISCOVERED (Master Data) ─────────────────────────────────────────
  {
    entry_id: 9901,
    target: 'PT Sukses Makmur Abadi',
    segment: 'Industrial Manufacturing',
    company_focus: 'Precision machining for heavy industries',
    website: 'https://suksesmakmur.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9902,
    target: 'The PAN Group',
    segment: 'Agriculture / Food',
    company_focus: 'Integrated agriculture and food processing',
    website: 'https://thepangroup.example',
    geography: 'Vietnam',
    ownership: 'Listed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9903,
    target: 'Apex Engineering Solutions',
    segment: 'Industrial Services',
    company_focus: 'Industrial plant maintenance',
    website: 'https://apexeng.example',
    geography: 'Malaysia',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9904,
    target: 'Bintang Logistics',
    segment: 'Transportation',
    company_focus: 'Cold chain logistics',
    website: 'https://bintanglog.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9905,
    target: 'Lumina HealthTech',
    segment: 'Healthcare IT',
    company_focus: 'Hospital management software',
    website: 'https://luminahealth.example',
    geography: 'Singapore',
    ownership: 'VC-backed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9906,
    target: 'Maju Jaya Retail',
    segment: 'Retail',
    company_focus: 'Minimart chain',
    website: 'https://majuretail.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9907,
    target: 'Vanguard Renewables',
    segment: 'Clean Energy',
    company_focus: 'Solar farm operator',
    website: 'https://vanguardren.example',
    geography: 'Vietnam',
    ownership: 'PE-backed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9908,
    target: 'Siam Agro Holdings',
    segment: 'Agriculture',
    company_focus: 'Fertilizer production',
    website: 'https://siamagro.example',
    geography: 'Thailand',
    ownership: 'Listed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9909,
    target: 'Nusantara Data Centers',
    segment: 'Infrastructure',
    company_focus: 'Colocation services',
    website: 'https://nusantaradata.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9910,
    target: 'Pioneer Fintech',
    segment: 'Financial Services',
    company_focus: 'Payment gateway provider',
    website: 'https://pioneerfin.example',
    geography: 'Philippines',
    ownership: 'VC-backed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9911,
    target: 'Cahaya Electronics',
    segment: 'Manufacturing',
    company_focus: 'Consumer electronics assembly',
    website: 'https://cahayaelec.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9912,
    target: 'Merlion Marine Services',
    segment: 'Maritime',
    company_focus: 'Vessel maintenance',
    website: 'https://merlionmarine.example',
    geography: 'Singapore',
    ownership: 'Family-owned',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9913,
    target: 'Klang Valley Developers',
    segment: 'Real Estate',
    company_focus: 'Commercial property management',
    website: 'https://klangvalley.example',
    geography: 'Malaysia',
    ownership: 'Listed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9914,
    target: 'Vietnam Textiles Group',
    segment: 'Apparel',
    company_focus: 'Garment manufacturing',
    website: 'https://vntextiles.example',
    geography: 'Vietnam',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9915,
    target: 'IndoChem Specialties',
    segment: 'Chemicals',
    company_focus: 'Specialty chemical distribution',
    website: 'https://indochem.example',
    geography: 'Indonesia',
    ownership: 'PE-backed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9916,
    target: 'Golden Lotus Hospitality',
    segment: 'Hospitality',
    company_focus: 'Boutique hotel operator',
    website: 'https://goldenlotus.example',
    geography: 'Thailand',
    ownership: 'Private',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9917,
    target: 'Mabuhay Telco Infrastructure',
    segment: 'Telecommunications',
    company_focus: 'Cell tower operator',
    website: 'https://mabuhaytelco.example',
    geography: 'Philippines',
    ownership: 'Listed',
    pipeline_stage: 'discovered',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },

  // ── ADDITIONAL UNREVIEWED (inbound) ───────────────────────────────────────
  {
    entry_id: 9048,
    target: 'PT Graha Material Bangunan',
    project_name: 'Project Graha',
    segment: 'Building Materials',
    company_focus: 'Integrated roofing and wall system manufacturer serving residential developers',
    website: 'https://grahamaterial.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Mandarin Sekuritas',
    remarks: 'Seed: building materials teaser from Mandarin; strong order book from developer clients.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 33.5, ebitda_usd_mn: 5.1, ev_usd_mn: 105 },
    ],
  },
  {
    entry_id: 9049,
    target: 'Aqua Utilities Berhad',
    project_name: 'Project Aqua',
    segment: 'Water & Utilities',
    company_focus: 'Private water utility concessions in Selangor and Johor under 25-year state agreements',
    website: 'https://aquautilities.example',
    geography: 'Malaysia',
    ownership: 'PE-backed',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'shopping_list',
    banker_source: 'DIMB',
    remarks: 'Seed: concession-based utility; regulated tariff upside under next review cycle.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 48.0, ebitda_usd_mn: 18.2 },
      { fiscal_year: 2024, revenue_usd_mn: 52.3, ebitda_usd_mn: 19.8, ev_usd_mn: 280 },
    ],
  },
  {
    entry_id: 9050,
    target: 'InsureTech Asia',
    project_name: 'Project Shield',
    segment: 'Insurance Technology',
    company_focus: 'Digital MGA platform distributing micro-insurance via telecom and e-wallet channels',
    website: 'https://insuretech-asia.example',
    geography: 'Singapore',
    ownership: 'VC-backed',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'UBSnacks',
    remarks: 'Seed: insurtech MGA with strong GWP growth; EBITDA positive from 2024.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 16.9, ebitda_usd_mn: 2.1 },
    ],
  },
  {
    entry_id: 9051,
    target: 'Recyclo Metal Industries',
    project_name: 'Project Recycle',
    segment: 'Metal Recycling / Circular Economy',
    company_focus: 'Ferrous and non-ferrous scrap aggregation and processing for steel mills in Java',
    website: 'https://recyclometal.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'market_study',
    banker_source: 'Doodle Bank',
    remarks: 'Seed: circular metals play; strong ESG angle, EBITDA margin improving with scale.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 62.0, ebitda_usd_mn: 7.4 },
      { fiscal_year: 2024, revenue_usd_mn: 74.5, ebitda_usd_mn: 9.7, ev_usd_mn: 210 },
    ],
  },
  {
    entry_id: 9052,
    target: '',
    project_name: 'Project Harvest',
    segment: 'F&B Distribution',
    company_focus: 'Cold-chain distribution of chilled and frozen foods to modern trade in Luzon',
    website: 'https://project-harvest.example',
    geography: 'Philippines',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'JP Organ',
    remarks: 'Seed: company name withheld in teaser. Strong modern-trade customer list.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 27.3, ebitda_usd_mn: 3.6 },
    ],
  },
  {
    entry_id: 9053,
    target: 'PT Jasa Minyak Nusantara',
    project_name: 'Project Petroserv',
    segment: 'Oil & Gas Services',
    company_focus: 'Integrated oilfield services — workover rigs, wireline, and coiled tubing in East Kalimantan',
    website: 'https://jasaminyak.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Macaroni',
    remarks: 'Seed: upstream services with long-term NusantaraOil contracts; owner exploring exit.',
    watchlist_status: 'New',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 38.0, ebitda_usd_mn: 8.9 },
      { fiscal_year: 2024, revenue_usd_mn: 41.5, ebitda_usd_mn: 9.8, ev_usd_mn: 160 },
    ],
  },

  // ── ADDITIONAL L0 INBOUND ACTIVE (reviewed) ───────────────────────────────
  {
    entry_id: 9054,
    target: 'Medika Diagnostik Indonesia',
    project_name: 'Project Medika',
    segment: 'Healthcare / Diagnostics',
    company_focus: 'Lab-as-a-service network integrated with 120+ hospitals and clinics in Java',
    website: 'https://medikadiagnostik.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Organ Stanley',
    advisor: 'Organ Stanley',
    doc_type: 'teaser',
    workflow_status: 'NDA executed',
    stake: '65%',
    deal_size: '$85M',
    last_activity_at: '2026-06-20T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 29.4, ebitda_usd_mn: 6.1 },
      { fiscal_year: 2024, revenue_usd_mn: 36.8, ebitda_usd_mn: 8.0, ev_usd_mn: 195 },
    ],
  },
  {
    entry_id: 9055,
    target: 'PropSys Asia',
    project_name: 'Project PropSys',
    segment: 'Proptech / SaaS',
    company_focus: 'Property management platform serving 1,200+ strata buildings across Singapore and Malaysia',
    website: 'https://propsys.example',
    geography: 'Singapore',
    ownership: 'PE-backed',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Golden Sacks',
    advisor: 'Golden Sacks',
    doc_type: 'teaser',
    workflow_status: 'Teaser review',
    stake: '70%',
    deal_size: '$55M',
    last_activity_at: '2026-06-18T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 18.2, ebitda_usd_mn: 4.9, ev_usd_mn: 120 },
    ],
  },
  {
    entry_id: 9056,
    target: 'Tuna Prima Fisheries',
    project_name: 'Project Tuna',
    segment: 'Aquaculture / Fisheries',
    company_focus: 'Integrated tuna processing and export — catches, cold storage, and canning in Bitung',
    website: 'https://tunaprima.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Kittygroup',
    doc_type: 'shopping_list',
    workflow_status: 'Management meeting scheduled',
    stake: '60%',
    deal_size: '$45M',
    last_activity_at: '2026-06-15T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 54.0, ebitda_usd_mn: 7.8 },
      { fiscal_year: 2023, revenue_usd_mn: 61.5, ebitda_usd_mn: 9.1 },
      { fiscal_year: 2024, revenue_usd_mn: 68.0, ebitda_usd_mn: 10.6, ev_usd_mn: 220 },
    ],
  },
  {
    entry_id: 9057,
    target: 'Saigon Auto Dealers Network',
    project_name: 'Project Saigon',
    segment: 'Automotive Retail',
    company_focus: 'Multi-brand car dealership network with 18 showrooms across Ho Chi Minh City and Hanoi',
    website: 'https://saigonauto.example',
    geography: 'Vietnam',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'HSBQ',
    doc_type: 'teaser',
    workflow_status: 'Unreviewed',
    stake: '80%',
    deal_size: '$70M',
    last_activity_at: '2026-06-22T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 195.0, ebitda_usd_mn: 14.2, ev_usd_mn: 330 },
    ],
  },

  // ── ADDITIONAL L0 OUTBOUND ACTIVE (reviewed) ──────────────────────────────
  {
    entry_id: 9058,
    target: 'Pelican Freight Terminals',
    project_name: 'Project Port',
    segment: 'Port Logistics / Terminal Operations',
    company_focus: 'Container handling and port logistics at three secondary ports in Sulawesi and Kalimantan',
    website: 'https://pelindofreight.example',
    geography: 'Indonesia',
    ownership: 'State-owned',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    deal_type: 'minority',
    workflow_status: 'Government relations initiated',
    key_rationale: 'Infrastructure monopoly with 30-year concessions; underpenetrated secondary ports aligned with commodity export thesis.',
    remarks: 'Initiated via BKPM (Indonesia Investment Coordinating Board) introductory meeting.',
    last_activity_at: '2026-06-10T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 120.0, ebitda_usd_mn: 42.0, ev_usd_mn: 580 },
    ],
  },
  {
    entry_id: 9059,
    target: 'Wincem Cement Holdings',
    segment: 'Construction Materials / Cement',
    company_focus: 'Integrated cement producer with 8M-tonne capacity across central and southern Vietnam',
    website: 'https://vincemcement.example',
    geography: 'Vietnam',
    ownership: 'Listed',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    deal_type: 'ipo',
    workflow_status: 'Intermediary approach',
    key_rationale: 'Infrastructure supercycle beneficiary; government housing program drives multi-year volume growth. Attractive EV/ton vs peers.',
    remarks: 'Soft approach via Ho Chi Minh City IB contact. Board aware of PE interest.',
    last_activity_at: '2026-06-08T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 480.0, ebitda_usd_mn: 96.0 },
      { fiscal_year: 2024, revenue_usd_mn: 510.0, ebitda_usd_mn: 105.0, ev_usd_mn: 820 },
    ],
  },
  {
    entry_id: 9060,
    target: 'ThaiBio Medical',
    segment: 'Medical Devices / Life Sciences',
    company_focus: 'In-vitro diagnostics manufacturer with OEM contracts for Japanese and Korean buyers',
    website: 'https://thaibiomedical.example',
    geography: 'Thailand',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    deal_type: 'majority',
    workflow_status: 'Direct outreach',
    key_rationale: 'High-margin IVD manufacturer with sticky OEM relationships; founder family exploring succession.',
    remarks: 'CEO Marcus Tanaka visited our Singapore office in May for preliminary discussions.',
    last_activity_at: '2026-06-14T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 38.5, ebitda_usd_mn: 9.6 },
      { fiscal_year: 2024, revenue_usd_mn: 44.2, ebitda_usd_mn: 11.5, ev_usd_mn: 230 },
    ],
  },
  {
    entry_id: 9061,
    target: 'AgriInput Philippines Corp',
    segment: 'Agricultural Inputs / Distribution',
    company_focus: 'National distributor of seeds, fertilizers, and crop protection for smallholder rice and corn farmers',
    website: 'https://agriinput-ph.example',
    geography: 'Philippines',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    deal_type: 'majority',
    workflow_status: 'First contact made',
    key_rationale: 'Critical agri-input distribution backbone; 14,000 farmer touch-points. Consolidation play in fragmented market.',
    remarks: 'Introduced via our LP who is a co-investor in the founder\'s other business.',
    last_activity_at: '2026-06-19T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 87.0, ebitda_usd_mn: 8.5, ev_usd_mn: 175 },
    ],
  },
  {
    entry_id: 9062,
    target: 'AmSure Insurance Brokers',
    segment: 'Insurance Brokerage',
    company_focus: 'Commercial lines insurance broker with 600+ corporate clients across Malaysia and Brunei',
    website: 'https://amsure.example',
    geography: 'Malaysia',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    deal_type: 'majority',
    workflow_status: 'Target identified',
    key_rationale: 'Recurring fee-based revenue from captive commercial clients; asset-light model with 22% EBITDA margin.',
    remarks: 'Identified from BNM broker registry. No contact yet — outreach via alumni network planned.',
    last_activity_at: '2026-06-05T00:00:00Z',
    watchlist_status: 'Active',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 21.0, ebitda_usd_mn: 4.6, ev_usd_mn: 95 },
    ],
  },

  // ── ADDITIONAL DROPPED COMPANIES ──────────────────────────────────────────
  {
    entry_id: 9063,
    target: 'GameOn Studios',
    project_name: 'Project Game',
    segment: 'Gaming / Entertainment',
    company_focus: 'Mobile gaming studio — hypercasual titles with SEA user base',
    website: 'https://gameonstudios.example',
    geography: 'Indonesia',
    ownership: 'VC-backed',
    pipeline_stage: 'L0',
    status: 'dropped',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'CLSO',
    watchlist_status: 'Dropped',
    dropped_reason: 'Revenue highly lumpy; single hit title accounts for 80% of revenue with no pipeline visibility.',
    dropped_at: '2026-06-18T14:00:00Z',
    last_activity_at: '2026-06-18T14:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 14.5, ebitda_usd_mn: 1.8 },
    ],
  },
  {
    entry_id: 9064,
    target: 'BlockTrade Exchange',
    project_name: 'Project Block',
    segment: 'Crypto / Blockchain',
    company_focus: 'Regulated crypto asset exchange operating in Indonesia and Singapore',
    website: 'https://blocktrade.example',
    geography: 'Singapore',
    ownership: 'VC-backed',
    pipeline_stage: 'L0',
    status: 'dropped',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Liger Securities',
    watchlist_status: 'Dropped',
    dropped_reason: 'Outside mandate — crypto assets explicitly excluded from investment policy; regulatory risk too elevated.',
    dropped_at: '2026-06-14T11:30:00Z',
    last_activity_at: '2026-06-14T11:30:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 22.0, ebitda_usd_mn: 3.1 },
    ],
  },
  {
    entry_id: 9065,
    target: 'Metro Residences Developer',
    project_name: 'Project Metro',
    segment: 'Real Estate / Property Development',
    company_focus: 'Mid-rise residential condominium developer in Bangkok suburbs',
    website: 'https://metroresidences.example',
    geography: 'Thailand',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'dropped',
    source: 'outbound',
    watchlist_status: 'Dropped',
    dropped_reason: 'Geography mismatch — Thailand residential property outside core SEA industrial and services mandate.',
    dropped_at: '2026-06-20T09:00:00Z',
    last_activity_at: '2026-06-20T09:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 75.0, ebitda_usd_mn: 12.0 },
    ],
  },
  {
    entry_id: 9066,
    target: 'NusaPrint Media Group',
    segment: 'Publishing / Print Media',
    company_focus: 'Regional newspaper and magazine publisher across Sumatra with online transition',
    website: 'https://nusaprint.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'dropped',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Dinoreksa',
    watchlist_status: 'Dropped',
    dropped_reason: 'Structural revenue decline — print ad revenue falling 18% YoY with digital transition insufficient to offset.',
    dropped_at: '2026-06-22T08:00:00Z',
    last_activity_at: '2026-06-22T08:00:00Z',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 28.0, ebitda_usd_mn: 3.5 },
      { fiscal_year: 2023, revenue_usd_mn: 23.0, ebitda_usd_mn: 2.1 },
      { fiscal_year: 2024, revenue_usd_mn: 19.0, ebitda_usd_mn: 1.3 },
    ],
  },

  // ── LONG-SEGMENT worst cases (chip overflow validation) ───────────────────
  // Dropped within the last few days so they surface in the Dashboard "Dropped"
  // recap + feed (those filter on dropped_at within the 7/14-day window).
  {
    entry_id: 9031,
    target: 'C-Hawk Technology',
    segment: 'Semiconductor Equipment – OEM Sub-system & Component Manufacturing',
    company_focus: 'OEM sub-systems and precision components for fab equipment',
    website: 'https://c-hawk.example',
    geography: 'United States',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Golden Sacks',
    originator: 'James Wong',
    doc_type: 'teaser',
    workflow_status: 'Teaser review',
    dropped_reason:
      'Customer concentration in a single fab-equipment OEM; thesis fit limited.',
    dropped_at: '2026-06-16T09:30:00Z',
    last_activity_at: '2026-06-16T09:30:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 64, ebitda_usd_mn: 8.2 }],
  },
  {
    entry_id: 9032,
    project_name: 'Project Bold',
    segment: 'UHP Chemicals and Gases – Front End Semiconductor',
    company_focus: 'Ultra-high-purity process chemicals and gases for front-end fabs',
    website: 'https://project-bold.example',
    geography: 'South Korea',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'JP Organ',
    originator: 'Nur Khairusy',
    doc_type: 'teaser',
    workflow_status: 'Teaser review',
    dropped_reason:
      'Sellers anchored valuation materially above comparable UHP-chemicals transactions.',
    dropped_at: '2026-06-17T11:15:00Z',
    last_activity_at: '2026-06-17T11:15:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 19 }],
  },
  // ── Stage coverage cases ─────────────────────────────────────────────────
  // One deal for every stage × source × status combination the fixtures
  // above leave out, so each Pipeline tab, source filter and Active/Dropped
  // view has something to show. Pending Confirmation holds `unreviewed` deals
  // of either source; outbound ones never appear under All Stages or L0.
  {
    // Outbound pending, added from chat: missing Entered By and Majority/
    // Minority and has no financials, so triage Keep is blocked by the L0
    // required-field check and the row shows "Financials missing".
    entry_id: 9120,
    target: 'Dummy Pending Outbound Incomplete Co',
    segment: 'Healthcare Services',
    company_focus: 'Outpatient specialist clinics across Java',
    website: 'https://dummy-pending-outbound-incomplete.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    watchlist_status: 'New',
    source: 'outbound',
    financials: [],
  },
  {
    // Outbound pending with every L0 field filled: triage Keep promotes it.
    entry_id: 9121,
    target: 'Dummy Pending Outbound Ready Co',
    segment: 'E-commerce Enablement',
    company_focus: 'Storefront and fulfilment software for SME sellers',
    website: 'https://dummy-pending-outbound-ready.example',
    geography: 'Malaysia',
    ownership: 'VC-backed',
    pipeline_stage: 'unreviewed',
    status: 'active',
    watchlist_status: 'New',
    source: 'outbound',
    deal_type: 'minority',
    entered_by_email: SEED_USER_EMAIL,
    originator: 'Reza Hakim',
    workflow_status: 'Target identified',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 21.4, ebitda_usd_mn: 2.2 }],
  },
  {
    entry_id: 9122,
    target: 'Dummy Pending Inbound Dropped Co',
    segment: 'Water Treatment',
    company_focus: 'Industrial wastewater treatment plants on a BOT model',
    website: 'https://dummy-pending-inbound-dropped.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    doc_type: 'teaser',
    banker_source: 'Golden Sacks',
    dropped_reason: 'Dropped at triage: concession contracts expire before a 5-year hold.',
    dropped_at: '2026-09-02T08:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 38, ebitda_usd_mn: 7.5 }],
  },
  {
    entry_id: 9123,
    target: 'Dummy Pending Outbound Dropped Co',
    segment: 'Industrial Components',
    company_focus: 'Aerospace-grade fasteners for regional MRO shops',
    website: 'https://dummy-pending-outbound-dropped.example',
    geography: 'Thailand',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'outbound',
    dropped_reason: 'Dropped at triage: duplicate of a target already covered by the team.',
    dropped_at: '2026-09-04T10:30:00Z',
    financials: [],
  },
  {
    entry_id: 9124,
    target: 'Dummy L1 Outbound Co',
    segment: 'Cold Chain Logistics',
    company_focus: 'Temperature-controlled warehousing for seafood exporters',
    website: 'https://dummy-l1-outbound.example',
    geography: 'Vietnam',
    ownership: 'Private',
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'majority',
    entered_by_email: SEED_USER_EMAIL,
    originator: 'James Wong',
    workflow_status: 'NDA pending',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 46, ebitda_usd_mn: 9.1, ev_usd_mn: 120 }],
  },
  {
    entry_id: 9125,
    target: 'Dummy L1 Inbound Dropped Co',
    segment: 'Building Materials',
    company_focus: 'Engineered wood panels for residential construction',
    website: 'https://dummy-l1-inbound-dropped.example',
    geography: 'Malaysia',
    ownership: 'Family-owned',
    pipeline_stage: 'L1',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Kitti',
    dropped_reason: 'Sellers declined to sign the NDA on our terms.',
    dropped_at: '2026-08-20T09:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 72, ebitda_usd_mn: 8.4 }],
  },
  {
    entry_id: 9126,
    target: 'Dummy L2 Outbound Co',
    segment: 'Healthcare Services',
    company_focus: 'Chain of clinical laboratories in tier-2 cities',
    website: 'https://dummy-l2-outbound.example',
    geography: 'Indonesia',
    ownership: 'PE-backed',
    pipeline_stage: 'L2',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'minority',
    entered_by_email: SEED_USER_EMAIL,
    originator: 'Nur Khairusy',
    workflow_status: 'Management meeting scheduled',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 58, ebitda_usd_mn: 12.6, ev_usd_mn: 210 }],
  },
  {
    entry_id: 9127,
    target: 'Dummy L2 Inbound Dropped Co',
    segment: 'Specialty Chemicals',
    company_focus: 'Compounded engineering plastics for auto interiors',
    website: 'https://dummy-l2-inbound-dropped.example',
    geography: 'Thailand',
    ownership: 'Listed',
    pipeline_stage: 'L2',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'JP Organ',
    dropped_reason: 'Proposal rejected: valuation gap of more than 30%.',
    dropped_at: '2026-07-28T13:45:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 140, ebitda_usd_mn: 16 }],
  },
  {
    entry_id: 9128,
    target: 'Dummy L3 Inbound Co',
    segment: 'Aviation MRO',
    company_focus: 'Line maintenance and component repair for narrow-body fleets',
    website: 'https://dummy-l3-inbound.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'L3',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Golden Sacks',
    workflow_status: 'Discussions ongoing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 95, ebitda_usd_mn: 19.5, ev_usd_mn: 330 }],
  },
  {
    entry_id: 9129,
    target: 'Dummy L3 Outbound Co',
    segment: 'Aquaculture',
    company_focus: 'Integrated shrimp hatcheries and grow-out farms',
    website: 'https://dummy-l3-outbound.example',
    geography: 'Indonesia',
    ownership: 'Family-owned',
    pipeline_stage: 'L3',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'minority',
    entered_by_email: SEED_USER_EMAIL,
    originator: 'James Wong',
    workflow_status: 'Discussions ongoing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 64, ebitda_usd_mn: 11.2, ev_usd_mn: 190 }],
  },
  {
    entry_id: 9130,
    target: 'Dummy L3 Inbound Dropped Co',
    segment: 'Packaging',
    company_focus: 'Flexible packaging for FMCG brands',
    website: 'https://dummy-l3-inbound-dropped.example',
    geography: 'Philippines',
    ownership: 'PE-backed',
    pipeline_stage: 'L3',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Organ Stanley',
    dropped_reason: 'Term sheet stalled on the earn-out structure.',
    dropped_at: '2026-08-11T07:30:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 110, ebitda_usd_mn: 14.3 }],
  },
  {
    // Live: an advisor is engaged.
    entry_id: 9131,
    target: 'Dummy L4 Inbound Live Co',
    segment: 'Battery Materials',
    company_focus: 'HPAL nickel intermediates for EV battery makers',
    website: 'https://dummy-l4-inbound-live.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'L4',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'minority',
    banker: 'Organ Stanley',
    advisor: 'Organ Stanley',
    stake: '20%',
    deal_size: 'USD 250mn',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 420, ebitda_usd_mn: 96, ev_usd_mn: 1400 }],
  },
  {
    entry_id: 9132,
    target: 'Dummy L4 Outbound Live Co',
    segment: 'Digital Infrastructure',
    company_focus: 'Edge data centres for regional cloud providers',
    website: 'https://dummy-l4-outbound-live.example',
    geography: 'Philippines',
    ownership: 'PE-backed',
    pipeline_stage: 'L4',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'majority',
    entered_by_email: SEED_USER_EMAIL,
    originator: 'Nur Khairusy',
    advisor: 'Golden Sacks',
    stake: '51%',
    deal_size: 'USD 180mn',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 52, ebitda_usd_mn: 24, ev_usd_mn: 600 }],
  },
  {
    entry_id: 9133,
    target: 'Dummy L4 Inbound Dropped Co',
    segment: 'Transport Infrastructure',
    company_focus: 'Toll road concessions in East Java',
    website: 'https://dummy-l4-inbound-dropped.example',
    geography: 'Indonesia',
    ownership: 'Listed',
    pipeline_stage: 'L4',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'minority',
    banker: 'Golden Sacks',
    dropped_reason: 'Regulator signalled a tariff freeze during onboarding.',
    dropped_at: '2026-07-15T06:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 88, ebitda_usd_mn: 61 }],
  },
  {
    entry_id: 9134,
    target: 'Dummy L5 Inbound Co',
    segment: 'F&B / Packaged Goods',
    company_focus: 'UHT milk and yoghurt for modern trade',
    website: 'https://dummy-l5-inbound.example',
    geography: 'Vietnam',
    ownership: 'Family-owned',
    pipeline_stage: 'L5',
    status: 'active',
    watchlist_status: 'Active',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'UBSnacks',
    stake: '60%',
    deal_size: 'USD 95mn',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 130, ebitda_usd_mn: 17, ev_usd_mn: 160 }],
  },
  {
    entry_id: 9135,
    target: 'Dummy L5 Outbound Co',
    segment: 'Education',
    company_focus: 'Test-prep and tutoring platform for secondary students',
    website: 'https://dummy-l5-outbound.example',
    geography: 'Indonesia',
    ownership: 'VC-backed',
    pipeline_stage: 'L5',
    status: 'active',
    watchlist_status: 'Active',
    source: 'outbound',
    deal_type: 'minority',
    entered_by_email: SEED_USER_EMAIL,
    originator: 'Reza Hakim',
    stake: '15%',
    deal_size: 'USD 30mn',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 24, ebitda_usd_mn: 3.1, ev_usd_mn: 200 }],
  },
  {
    entry_id: 9136,
    target: 'Dummy L5 Inbound Dropped Co',
    segment: 'Hospitality',
    company_focus: 'Boutique beach resorts in Bali and Lombok',
    website: 'https://dummy-l5-inbound-dropped.example',
    geography: 'Indonesia',
    ownership: 'Private',
    pipeline_stage: 'L5',
    status: 'dropped',
    watchlist_status: 'Dropped',
    source: 'inbound',
    deal_type: 'majority',
    banker: 'Doodle Bank',
    dropped_reason: 'Closing conditions not met: land titles failed final diligence.',
    dropped_at: '2026-06-30T12:00:00Z',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 41, ebitda_usd_mn: 12 }],
  },
];

type SeedSmartFile = {
  file_name: string;
  file_link: string;
  raw_notes: string;
  structured_notes: Record<string, unknown>;
  tags: string[];
  processing_status: 'completed' | 'awaiting_review';
  file_date: string;
  file_type: 'mom' | 'prospectus' | 'banker_communications' | 'other';
  matched_entry_ids: number[];
  /** Name-only matches (id: null) — AI detected a name with no DB company. */
  null_id_matches?: Array<{ name: string }>;
};

const seedSmartFiles: SeedSmartFile[] = [
  {
    file_name: 'Seed Smart Files - Project Nameless Teaser.pdf',
    file_link: 'seed/smart-files/project-nameless-teaser.pdf',
    raw_notes:
      'Teaser for Project Nameless Teaser. Target name is intentionally omitted by the banker.',
    structured_notes: {
      file_type: 'prospectus',
      summary:
        'Seed prospectus where the company target name is empty but the project name is available.',
      prospectus_summary: {
        company_name: null,
        project_name: 'Project Nameless Teaser',
        segment: 'Industrial Services',
        geography: 'Indonesia',
      },
      tags: ['seed', 'prospectus', 'project-name-only'],
      matched_companies: [],
      file_date: '2026-06-18',
    },
    tags: ['seed', 'prospectus', 'project-name-only'],
    processing_status: 'awaiting_review',
    file_date: '2026-06-18',
    file_type: 'prospectus',
    matched_entry_ids: [9033],
  },
  {
    file_name: 'Seed Smart Files - Blue Harbor IC Notes.docx',
    file_link: 'seed/smart-files/blue-harbor-ic-notes.docx',
    raw_notes:
      'Investment committee notes for Blue Harbor Logistics, including diligence actions and banker follow-ups.',
    structured_notes: {
      file_type: 'mom',
      summary: 'Seed meeting note for Blue Harbor IC discussion.',
      key_points: [
        'Customer references are positive.',
        'Need to validate 2024 EBITDA bridge.',
      ],
      action_items: [
        'Request customer cohort data.',
        'Schedule technical diligence call.',
      ],
      tags: ['seed', 'meeting-note', 'ic'],
      matched_companies: [],
      file_date: '2026-06-19',
    },
    tags: ['seed', 'meeting-note', 'ic'],
    processing_status: 'completed',
    file_date: '2026-06-19',
    file_type: 'mom',
    matched_entry_ids: [9002],
  },
  {
    file_name: 'Seed Smart Files - Project Bold Banker Email.eml',
    file_link: 'seed/smart-files/project-bold-banker-email.eml',
    raw_notes:
      'Banker email from JP Organ on Project Bold valuation expectations and process timing.',
    structured_notes: {
      file_type: 'banker_communications',
      summary: 'Seed banker communication for Project Bold.',
      tags: ['seed', 'banker-communications'],
      matched_companies: [],
      file_date: '2026-06-17',
    },
    tags: ['seed', 'banker-communications'],
    processing_status: 'completed',
    file_date: '2026-06-17',
    file_type: 'banker_communications',
    matched_entry_ids: [9032],
  },
  // Extra prospectus rows with a mix of statuses so the "awaiting review
  // pinned to top" sort is visible in the Smart Files table.
  {
    file_name: 'Seed Smart Files - Aaa Completed Teaser.pdf',
    file_link: 'seed/smart-files/aaa-completed-teaser.pdf',
    raw_notes: 'Completed prospectus whose name sorts first alphabetically.',
    structured_notes: {
      file_type: 'prospectus',
      summary: 'Seed completed prospectus used to verify sort ordering.',
      prospectus_summary: {
        company_name: 'Aaa Completed Co',
        project_name: 'Project Aaa',
        segment: 'Industrial Services',
        geography: 'Indonesia',
      },
      tags: ['seed', 'prospectus', 'sort-check'],
      matched_companies: [],
      file_date: '2026-06-21',
    },
    tags: ['seed', 'prospectus', 'sort-check'],
    processing_status: 'completed',
    file_date: '2026-06-21',
    file_type: 'prospectus',
    matched_entry_ids: [],
  },
  {
    file_name: 'Seed Smart Files - Zzz Awaiting Teaser.pdf',
    file_link: 'seed/smart-files/zzz-awaiting-teaser.pdf',
    raw_notes: 'Awaiting-review prospectus whose name sorts last alphabetically.',
    structured_notes: {
      file_type: 'prospectus',
      summary: 'Seed awaiting-review prospectus used to verify sort ordering.',
      prospectus_summary: {
        company_name: 'Zzz Awaiting Co',
        project_name: 'Project Zzz',
        segment: 'Industrial Services',
        geography: 'Indonesia',
      },
      tags: ['seed', 'prospectus', 'sort-check'],
      matched_companies: [],
      file_date: '2026-06-20',
    },
    tags: ['seed', 'prospectus', 'sort-check'],
    processing_status: 'awaiting_review',
    file_date: '2026-06-20',
    file_type: 'prospectus',
    matched_entry_ids: [],
  },
  {
    file_name: 'Seed Smart Files - Null Id Match Teaser.pdf',
    file_link: 'seed/smart-files/null-id-match-teaser.pdf',
    raw_notes:
      'Teaser for Phantom Null Co — detected by AI but not matched to any existing company (id is null).',
    structured_notes: {
      file_type: 'prospectus',
      summary:
        'Seed awaiting-review prospectus with a null-id matched_companies entry for HITL create-from-AI testing.',
      prospectus_summary: {
        company_name: 'Phantom Null Co',
        project_name: 'Project Phantom Null',
        segment: 'Industrial Services',
        geography: 'Indonesia',
        company_focus: 'Seed fixture for null-id matched company review',
        website: 'https://phantom-null.example',
      },
      tags: ['seed', 'prospectus', 'null-id-match'],
      matched_companies: [],
      file_date: '2026-06-22',
    },
    tags: ['seed', 'prospectus', 'null-id-match'],
    processing_status: 'awaiting_review',
    file_date: '2026-06-22',
    file_type: 'prospectus',
    matched_entry_ids: [],
    null_id_matches: [{ name: 'Phantom Null Co' }],
  },
];

// Lightweight per-workspace company fixtures — enough to prove tenant
// isolation when switching workspaces, not a full replica of `seedCompanies`.
const acquisitionsWorkspaceCompanies: SeedCompany[] = [
  {
    entry_id: 9100,
    target: 'Nordfjord Robotics',
    segment: 'Robotics',
    company_focus: 'Warehouse automation robotics for Nordic 3PL operators',
    website: 'https://nordfjordrobotics.example',
    geography: 'Norway',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 18.5, ebitda_usd_mn: 3.1 }],
  },
  {
    entry_id: 9101,
    target: 'Baltic Cold Chain',
    segment: 'Logistics',
    company_focus: 'Temperature-controlled logistics network across the Baltics',
    website: 'https://balticcoldchain.example',
    geography: 'Latvia',
    ownership: 'Family-owned',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 32.0, ebitda_usd_mn: 5.8 }],
  },
  {
    entry_id: 9102,
    target: 'Alden Precision Optics',
    segment: 'Manufacturing',
    company_focus: 'Precision optics manufacturer for medical imaging OEMs',
    website: 'https://aldenoptics.example',
    geography: 'Sweden',
    ownership: 'PE-owned',
    pipeline_stage: 'L1',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'Reviewing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 27.4, ebitda_usd_mn: 6.2 }],
  },
  {
    entry_id: 9103,
    target: 'Fenwick Marine Services',
    segment: 'Maritime',
    company_focus: 'Offshore wind maintenance vessel operator',
    website: 'https://fenwickmarine.example',
    geography: 'Denmark',
    ownership: 'Private',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9104,
    target: 'Solvik Data Centers',
    segment: 'Infrastructure',
    company_focus: 'Renewable-powered edge data centers across Scandinavia',
    website: 'https://solvikdc.example',
    geography: 'Finland',
    ownership: 'PE-owned',
    pipeline_stage: 'L2',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'Reviewing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 41.2, ebitda_usd_mn: 12.7 }],
  },
];

// Reachable via Master Data / Copilot in this workspace — Dashboard and
// Pipeline are off for the Funds & Investing flavor.
const investingWorkspaceCompanies: SeedCompany[] = [
  {
    entry_id: 9110,
    target: 'Kestane Agri Processing',
    segment: 'Agriculture',
    company_focus: 'Nut and dried-fruit processing for European export',
    website: 'https://kestaneagri.example',
    geography: 'Turkey',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 22.1, ebitda_usd_mn: 4.0 }],
  },
  {
    entry_id: 9111,
    target: 'Bosphorus Fintech Rails',
    segment: 'Fintech',
    company_focus: 'Cross-border payment rails for SME exporters',
    website: 'https://bosphorusrails.example',
    geography: 'Turkey',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9112,
    target: 'Anadolu Ceramics Group',
    segment: 'Manufacturing',
    company_focus: 'Architectural ceramics manufacturer with EU distribution',
    website: 'https://anadoluceramics.example',
    geography: 'Turkey',
    ownership: 'Private',
    pipeline_stage: 'L1',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'Reviewing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 35.6, ebitda_usd_mn: 7.9 }],
  },
  {
    entry_id: 9113,
    target: 'Marmara Textile Labs',
    segment: 'Textiles',
    company_focus: 'Technical textile R&D and small-batch production',
    website: 'https://marmaratextile.example',
    geography: 'Turkey',
    ownership: 'PE-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9114,
    target: 'Cappadocia Tourism Holdings',
    segment: 'Hospitality',
    company_focus: 'Boutique hotel roll-up across Central Anatolia',
    website: 'https://cappadociath.example',
    geography: 'Turkey',
    ownership: 'Family-owned',
    pipeline_stage: 'L2',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'Reviewing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 15.3, ebitda_usd_mn: 3.4 }],
  },
];

/** Insert a batch of lightweight companies (+ financials) into one workspace. */
async function insertCompaniesForWorkspace(
  db: ReturnType<typeof drizzle>,
  workspaceId: string,
  list: SeedCompany[],
): Promise<Array<{ entry_id: number; id: string }>> {
  const inserted: Array<{ entry_id: number; id: string }> = [];
  for (const c of list) {
    const [row] = await db
      .insert(companies)
      .values({
        entry_id: c.entry_id,
        target: c.target ?? null,
        project_name: c.project_name ?? null,
        segment: c.segment,
        company_focus: c.company_focus,
        website: c.website,
        geography: c.geography,
        ownership: c.ownership,
        pipeline_stage: c.pipeline_stage,
        status: c.status,
        source: c.source ?? null,
        watchlist_status: c.watchlist_status,
        workspace_id: workspaceId,
      })
        .onConflictDoNothing()
      .returning({ id: companies.id });
    if (!row) continue;
    inserted.push({ entry_id: c.entry_id, id: row.id });
    if (c.financials.length === 0) continue;
    await db.insert(companyFinancials).values(
      c.financials.map((f) => ({
        company_id: row.id,
        fiscal_year: f.fiscal_year,
        revenue_usd_mn: f.revenue_usd_mn ?? null,
        ebitda_usd_mn: f.ebitda_usd_mn ?? null,
        ev_usd_mn: f.ev_usd_mn ?? null,
      })),
    ).onConflictDoNothing();
  }
  return inserted;
}

/**
 * A representative slice of the global RSS catalog (3 feeds per category) plus
 * a handful of items, so the Data Navigator page renders locally without
 * running the ingest Lambdas. The full 263-feed catalog is imported separately
 * with `pnpm rss:import-feeds`.
 */
// UUIDs must be valid hex — the `f` prefix below is just a readable marker for
// "RSS feed seed row", not arbitrary text.
const SEED_RSS_FEEDS = [
  { id: '00000000-0000-0000-0000-0000000f0001', category: 'expert_insights', source_name: 'AEI', feed_url: 'https://www.aei.org/feed/', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0002', category: 'expert_insights', source_name: 'Bank Underground (BoE)', feed_url: 'https://bankunderground.co.uk/feed/', region: 'UK', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0003', category: 'expert_insights', source_name: 'Bruegel', feed_url: 'https://www.bruegel.org/rss.xml', region: 'EU', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0004', category: 'market_assessment', source_name: 'SEC Press Releases', feed_url: 'https://www.sec.gov/news/pressreleases.rss', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0005', category: 'market_assessment', source_name: 'BusinessWire Markets', feed_url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeGVtRVQ==', region: 'Global', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0006', category: 'market_assessment', source_name: 'Google News: market share report', feed_url: 'https://news.google.com/rss/search?q=%22market+share%22+report', region: 'Global', tier: 'query' },
  { id: '00000000-0000-0000-0000-0000000f0007', category: 'new_funding', source_name: 'DealStreetAsia', feed_url: 'https://www.dealstreetasia.com/feed', region: 'APAC', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0008', category: 'new_funding', source_name: 'Mint Companies', feed_url: 'https://www.livemint.com/rss/companies', region: 'India', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0009', category: 'new_funding', source_name: 'Google News: raises series', feed_url: 'https://news.google.com/rss/search?q=raises+%22series+a%22', region: 'Global', tier: 'query' },
  { id: '00000000-0000-0000-0000-0000000f000a', category: 'ma_partnerships', source_name: 'MarketBeat M&A', feed_url: 'https://www.marketbeat.com/feed/', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000b', category: 'ma_partnerships', source_name: 'PR Newswire M&A', feed_url: 'https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000c', category: 'ma_partnerships', source_name: 'Google News: acquires stake', feed_url: 'https://news.google.com/rss/search?q=acquires+stake', region: 'Global', tier: 'query' },
  { id: '00000000-0000-0000-0000-0000000f000d', category: 'industry_reports', source_name: 'IMF Publications', feed_url: 'https://www.imf.org/en/Publications/RSS', region: 'Global', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000e', category: 'industry_reports', source_name: 'BIS Research', feed_url: 'https://www.bis.org/doclist/all_rss.rss', region: 'Global', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000f', category: 'industry_reports', source_name: 'Google News: initiates coverage', feed_url: 'https://news.google.com/rss/search?q=%22initiates+coverage%22', region: 'Global', tier: 'query' },
] as const;

interface SeedRssStory {
  title: string;
  summary: string;
  /** Extracted article body, one entry per paragraph. */
  body: string[];
  authors?: string;
  tags?: string;
  /**
   * Present only on the non-English fixtures. When set, the story's
   * `title`/`summary`/`body` above are seeded as the ENGLISH TRANSLATION
   * (`*_en` columns, `translation_status = 'translated'`) and the text here is
   * seeded as the original the publisher shipped — which is exactly the shape
   * the enrich pipeline's translate stage produces.
   *
   * Without at least one of these in the fixture, the Data Navigator's
   * "display in original language" toggle is unreachable from a fresh seed.
   */
  original?: {
    /** ISO 639-1 code, as `detectLanguage` would report it. */
    language: string;
    title: string;
    summary: string;
    body: string[];
  };
}

/**
 * The local Data Navigator corpus, twelve stories per category.
 *
 * Every company, fund and person below is invented. That is deliberate: this
 * fixture renders as finished market copy, and inventing the entities keeps it
 * from reading as a factual claim about a real firm the moment someone
 * screenshots a demo. Feeds keep their real `source_name`, since those are just
 * the publications the poller is configured against.
 *
 * Twelve per category × five categories = 60 items, which is deliberately
 * above the Data Navigator's 50-row page size so a fresh seed exercises the
 * keyset cursor and the infinite-scroll sentinel rather than fitting on page
 * one.
 */
const SEED_RSS_STORIES: Record<RssCategory, SeedRssStory[]> = {
  expert_insights: [
    {
      title: 'The productivity gap between mid-market acquirers and their sponsors is widening',
      summary:
        'Mid-market operators are closing deals faster than their sponsors can integrate them, and the drag is showing up in year-two margins rather than at the deal table.',
      body: [
        'Integration capacity, not deal supply, has become the binding constraint for mid-market acquirers. Firms closing four or more bolt-ons a year are reporting that the finance function absorbs the first two cleanly and then degrades sharply, with month-end close slipping by a week or more for each subsequent transaction.',
        'The pattern argues for staging acquisitions against integration throughput rather than against the pipeline. Acquirers that capped themselves at three deals a year held their close calendar and, on our sample, recovered synergy targets roughly two quarters earlier than peers who front-loaded.',
      ],
      authors: 'Dr. Helena Marsh',
      tags: 'integration, mid-market, operating leverage',
    },
    {
      title: 'Why earn-outs keep failing the sellers who negotiate them hardest',
      summary:
        'Sellers who win aggressive earn-out ceilings routinely collect less than those who accept lower caps tied to metrics they still control post-close.',
      body: [
        'The mechanics are unforgiving. An earn-out indexed to consolidated EBITDA hands the buyer every lever that determines the payout — allocation of shared costs, timing of capex, the pace at which the acquired brand is folded into a group structure. Sellers routinely accept this in exchange for a headline number they then fail to reach.',
        'Ceilings tied to revenue in the seller’s own book, or to a retained-customer count, pay out far more reliably. The headline is smaller and the realised proceeds are larger, which is an uncomfortable trade to put in front of a founder in the last week of a negotiation.',
      ],
      authors: 'Priya Raghunathan',
      tags: 'earn-outs, deal structure',
    },
    {
      title: 'Diligence teams are over-indexing on churn and under-reading expansion',
      summary:
        'A retention number that looks stable can hide a book where expansion revenue has quietly stopped covering contraction.',
      body: [
        'Net revenue retention flatters a business whenever a handful of large accounts are still expanding. Strip out the top decile and many targets that present at 108 percent land closer to 94, which is a materially different asset and usually a materially different price.',
        'The fix is unglamorous: ask for the retention bridge by cohort and by decile before the management presentation, not after. Targets that decline to produce it are telling you something about the shape of the book.',
      ],
      authors: 'Marcus Feld',
      tags: 'diligence, retention, saas',
    },
    {
      title: 'Rate expectations have stopped driving mid-market entry multiples',
      summary:
        'The correlation between forward rate curves and observed entry multiples in the sub-$200m bracket has broken down over the last four quarters.',
      body: [
        'Through the tightening cycle, mid-market multiples tracked the forward curve closely enough that sponsors could underwrite off it. That relationship has decoupled. Entry multiples in the bracket have held within a narrow band while the curve moved substantially in both directions.',
        'The most plausible explanation is supply. Sale processes in the bracket are being run by a smaller cohort of sellers with genuine optionality, and those sellers are simply not clearing at the prices a rate-driven model implies.',
      ],
      authors: 'Dr. Helena Marsh',
      tags: 'valuation, rates, mid-market',
    },
    {
      title: 'The case against buying your way into an adjacent vertical',
      summary:
        'Cross-vertical acquisitions underperform same-vertical bolt-ons on almost every measure except the one that gets presented to investment committees.',
      body: [
        'Adjacency is easy to argue and hard to realise. The shared-infrastructure thesis assumes the two businesses sell to buyers with comparable procurement cycles; in practice the sales motions diverge enough that the combined entity runs two go-to-market organisations while paying for one.',
        'Where cross-vertical deals do work, the acquirer has usually bought a capability rather than a customer base, and has been willing to leave the acquired commercial team entirely alone for eighteen months.',
      ],
      tags: 'strategy, adjacency',
    },
    {
      title: 'Founder retention clauses are being priced too cheaply',
      summary:
        'Two-year founder lock-ups clear at a fraction of what the departure risk is actually worth to the acquirer.',
      body: [
        'The standard two-year lock-up is priced as a formality. It should be priced as an option the acquirer is buying, because in owner-operated businesses the founder frequently is the customer relationship, the pricing authority and the institutional memory of why the product is built the way it is.',
        'Acquirers who have modelled the replacement cost honestly — recruitment, ramp, the revenue that leaves with the relationship — generally conclude they should have paid materially more for a longer commitment.',
      ],
      authors: 'Priya Raghunathan',
      tags: 'founders, retention, deal structure',
    },
    {
      title: 'Working-capital adjustments are where mid-market value quietly leaks',
      summary:
        'A poorly specified working-capital peg transfers more value at completion than most of the terms the parties spent their time arguing about.',
      body: [
        'The peg is usually set from a twelve-month average that includes a seasonal trough the buyer will never actually operate through. The result is a completion adjustment that flows to the seller for reasons unrelated to performance.',
        'Setting the peg from a normalised operating cycle, and agreeing the normalisation before exclusivity rather than during completion accounts, removes an argument that reliably sours the first month of ownership.',
      ],
      tags: 'completion accounts, working capital',
    },
    {
      title: 'Sponsors are rediscovering the operating partner, on very different terms',
      summary:
        'The operating-partner model is being rebuilt around a smaller number of deeply embedded specialists rather than a broad bench of generalists.',
      body: [
        'The generalist operating bench proved expensive to carry and difficult to deploy against portfolio companies whose problems were specific rather than structural. Several mid-market sponsors have cut the bench and replaced it with two or three specialists who sit inside a single portfolio company for a year at a time.',
        'The economics are better and the outcomes are more legible, though the model concentrates risk on the sponsor’s ability to hire the right two or three people.',
      ],
      authors: 'Marcus Feld',
      tags: 'operating partners, private equity',
    },
    {
      title: 'What a decade of failed roll-ups says about sequencing',
      summary:
        'The roll-ups that failed did not buy the wrong assets; they bought the right assets in an order that made the platform unmanageable.',
      body: [
        'Reviewing a decade of unwound roll-ups, the common failure is sequencing rather than selection. Acquirers bought the largest available target first, which set the platform’s systems and culture around a business that was never intended to be the operating core.',
        'The durable platforms bought a small, clean, well-instrumented business first and used it to define the operating standard everything else was migrated onto. It is a slower start and a much shorter integration tail.',
      ],
      tags: 'roll-ups, platform strategy',
    },
    {
      title: 'Management presentations have stopped being a source of information',
      summary:
        'The management presentation has converged on a template so tightly that it now discriminates poorly between good and mediocre targets.',
      body: [
        'When every target arrives with the same forty slides prepared by the same handful of advisers, the deck stops carrying signal. Buyers increasingly treat it as a formality and move their real diligence into unstructured sessions with second-line management.',
        'The targets that still differentiate themselves do so by volunteering the parts of the business that are not working, which remains rare enough to be genuinely informative.',
      ],
      authors: 'Marcus Feld',
      tags: 'diligence, process',
    },
    {
      title: 'Carve-outs are getting cheaper and considerably harder',
      summary:
        'Corporate sellers are accepting lower prices for non-core divisions while transferring more separation risk to the buyer than they did three years ago.',
      body: [
        'Transitional service agreements have shortened and narrowed. Buyers who assumed an eighteen-month runway to stand up independent finance and IT functions are being offered nine months, and are pricing the gap into the headline rather than walking.',
        'That trade works for acquirers with genuine separation capability in-house and punishes those relying on the seller’s goodwill after completion.',
      ],
      tags: 'carve-outs, separation',
    },
    {
      title: 'The quiet return of the minority stake',
      summary:
        'Sponsors unable to agree control valuations are taking structured minority positions at a rate not seen since the last cycle.',
      body: [
        'Where buyer and seller cannot bridge a control valuation, a structured minority with defined governance and a path to control is re-emerging as the compromise. It clears the immediate liquidity need without forcing a price the seller believes is wrong.',
        'The risk sits in the governance package. Minority positions negotiated without genuine information rights have a long history of becoming very difficult to exit.',
      ],
      authors: 'Priya Raghunathan',
      tags: 'minority stakes, structuring',
    },
  ],
  market_assessment: [
    {
      title: 'Southeast Asian logistics software consolidates around three regional platforms',
      summary:
        'Fragmented national vendors are being absorbed into a small number of cross-border platforms, compressing the addressable market for new entrants.',
      body: [
        'Three platforms now account for an estimated two-thirds of licensed freight-management seats across the region, up from roughly a third two years ago. The consolidation has been driven by acquirers buying national incumbents for their regulatory integrations rather than their technology.',
        'For new entrants the practical consequence is that a competitive product is no longer sufficient. Distribution now runs through customs and port integrations that take years to accredit, which is precisely what the consolidators have been buying.',
      ],
      authors: 'Amara Sitepu',
      tags: 'logistics, southeast asia, consolidation',
    },
    {
      title: 'Enterprise procurement cycles lengthen for the fourth consecutive quarter',
      summary:
        'Median time from qualified opportunity to signed contract has extended again, with the additional delay concentrated in security and legal review.',
      body: [
        'The extension is not a demand signal. Pipeline volume and win rates have held; what has changed is the number of internal approvals a contract passes through, with security review now the single longest stage in a majority of enterprise deals.',
        'Vendors that pre-clear security documentation are closing materially faster than those that begin the process after commercial agreement, which is turning compliance readiness into a genuine commercial advantage.',
      ],
      tags: 'enterprise, procurement, sales cycles',
    },
    {
      title: 'Specialty chemicals capacity additions outpace demand into next year',
      summary:
        'Announced capacity in the specialty segment exceeds credible demand growth, pointing to margin pressure once the new lines commission.',
      body: [
        'Capacity announced over the last eighteen months implies supply growth well ahead of any reasonable demand case. Most of the additions are concentrated in a narrow band of intermediates where the marginal producer already operates on thin spreads.',
        'The likely outcome is a period of utilisation discipline followed by consolidation among sub-scale producers, a pattern the segment has run through twice before.',
      ],
      authors: 'Dr. Ingrid Sollberg',
      tags: 'chemicals, capacity, margins',
    },
    {
      title: 'Regional banks retreat from equipment finance, opening a gap for specialists',
      summary:
        'Balance-sheet pressure has pushed regional lenders out of mid-ticket equipment finance, and independent specialists are repricing accordingly.',
      body: [
        'Regional banks have withdrawn from mid-ticket equipment lending faster than independents can absorb the volume, leaving borrowers with fewer options and specialists with pricing power they have not had for years.',
        'The gap is unlikely to persist. Spreads at current levels will attract capital, and the specialists best positioned are those already holding origination relationships rather than those raising a fund against the opportunity.',
      ],
      tags: 'equipment finance, banking',
    },
    {
      title: 'Industrial automation demand splits sharply by end market',
      summary:
        'Aggregate automation demand looks flat, but the aggregate conceals a pronounced divergence between discrete and process end markets.',
      body: [
        'Headline automation orders have been broadly flat, which has been read as a plateau. Disaggregated, discrete manufacturing has contracted while process industries have grown at a healthy clip, leaving the aggregate misleading in both directions.',
        'Suppliers weighted to process end markets are compounding through what looks from the outside like a flat market, and are being valued as though they are not.',
      ],
      authors: 'Dr. Ingrid Sollberg',
      tags: 'automation, industrials',
    },
    {
      title: 'Data-centre power constraints move from a coastal problem to a national one',
      summary:
        'Interconnection queues that were a coastal bottleneck now bind in inland markets that were the designated overflow.',
      body: [
        'The relocation strategy assumed inland grids had headroom. Queue data suggests that assumption has expired, with interconnection timelines in the primary overflow markets now approaching those of the coastal regions operators left.',
        'Site selection is consequently being driven by generation adjacency rather than land cost or latency, which changes the economics of a large share of announced projects.',
      ],
      tags: 'data centres, power, infrastructure',
    },
    {
      title: 'Private credit spreads compress as competition returns to the upper mid-market',
      summary:
        'Spreads in the upper mid-market have tightened materially as capital returns, while the lower mid-market holds its premium.',
      body: [
        'The upper mid-market is again competitive enough that pricing has moved back toward pre-tightening levels, with covenant packages loosening alongside. The lower mid-market has not followed, and the spread between the two brackets is unusually wide.',
        'For lenders with the origination capacity to work smaller cheques, the risk-adjusted case currently sits well below the bracket where most capital is being deployed.',
      ],
      authors: 'Tomás Berenguer',
      tags: 'private credit, spreads',
    },
    {
      title: 'Aftermarket parts distribution proves more defensible than the equipment it serves',
      summary:
        'Distribution margins in aftermarket parts have held through a cycle that compressed original-equipment margins substantially.',
      body: [
        'Original-equipment margins have compressed through the cycle while aftermarket distribution has held, a divergence explained less by pricing power than by the switching cost embedded in a service technician’s parts catalogue.',
        'Acquirers have noticed. Distribution assets in the segment are transacting at premiums that would have looked indefensible against the equipment manufacturers three years ago.',
      ],
      tags: 'aftermarket, distribution',
    },
    {
      title: 'Healthcare staffing normalises, but not back to where it started',
      summary:
        'Contract labour rates have fallen from their peak and settled well above the pre-disruption baseline, resetting provider cost structures permanently.',
      body: [
        'Rates have come down substantially from peak but have stabilised at a level that leaves provider cost structures permanently reset. Operators budgeting a return to the old baseline are, on current evidence, budgeting for something that is not going to happen.',
        'The staffing platforms that survived the correction are those that moved from spot placement into managed service arrangements, which price lower and retain far better.',
      ],
      authors: 'Amara Sitepu',
      tags: 'healthcare, staffing, labour',
    },
    {
      title: 'Consumer subscription churn stabilises at a structurally higher level',
      summary:
        'Monthly churn across consumer subscription categories has stopped rising and settled roughly two points above its historical band.',
      body: [
        'The stabilisation is real but the new level is not the old one. Households that learned to cycle subscriptions during the squeeze have not unlearned it, and reactivation campaigns are performing well precisely because cancellation is no longer treated as final.',
        'Operators are adapting by underwriting to a shorter expected life and a higher reactivation rate, which produces similar lifetime value through a very different mechanism.',
      ],
      tags: 'consumer, subscriptions, churn',
    },
    {
      title: 'European industrial energy costs stop being the decisive siting variable',
      summary:
        'The energy-cost gap that drove siting decisions has narrowed enough that labour availability is again the binding constraint.',
      body: [
        'For two years energy cost dominated European siting decisions. That gap has narrowed to the point where it no longer overrides other factors, and skilled labour availability has reasserted itself as the constraint that actually determines where a plant can run.',
        'Regions that used cheap power as their entire pitch are finding it insufficient, while those with established technical training pipelines are winning mandates they lost during the energy spike.',
      ],
      authors: 'Dr. Ingrid Sollberg',
      tags: 'europe, industrials, siting',
    },
    {
      title: 'Freight rates decouple from container volumes',
      summary:
        'Spot freight rates and underlying container volumes have moved in opposite directions for two consecutive quarters.',
      body: [
        'Rates have firmed while volumes softened, a combination that historically signals capacity withdrawal rather than demand strength. Idle tonnage and slower steaming account for most of the divergence.',
        'Shippers reading firm rates as a demand recovery are likely to be disappointed, and those locking long-term contracts at current levels are paying for a scarcity that is being managed rather than structural.',
      ],
      tags: 'freight, shipping, rates',
    },
  ],
  new_funding: [
    {
      title: 'Meridian Grid raises $84m Series B for industrial demand-response software',
      summary:
        'The round was led by Calderwood Partners with participation from existing backers, and will fund expansion into two new regional grid operators.',
      body: [
        'Meridian Grid has raised $84m in a Series B led by Calderwood Partners, taking total funding to roughly $130m. The company sells demand-response orchestration to industrial energy consumers and takes a share of the capacity payments it unlocks.',
        'Proceeds are earmarked for accreditation with two additional regional grid operators, a process management described as the primary gate on revenue rather than customer demand.',
      ],
      authors: 'Reuben Achterberg',
      tags: 'series b, energy, software',
    },
    {
      title: 'Sable Health closes $32m Series A for post-acute care coordination',
      summary:
        'The financing was led by Thornbury Ventures and brings a former hospital network operator onto the board.',
      body: [
        'Sable Health raised $32m in a Series A led by Thornbury Ventures. The platform coordinates discharge planning between acute hospitals and post-acute facilities, a handoff where avoidable readmissions concentrate.',
        'The company said the round will fund expansion from its initial two-state footprint into a further five, with a former hospital network chief operating officer joining the board as part of the transaction.',
      ],
      tags: 'series a, healthcare',
    },
    {
      title: 'Kestrel Materials secures $145m growth round for recycled aluminium capacity',
      summary:
        'The round combines equity and a project-finance facility to fund a second recycling line.',
      body: [
        'Kestrel Materials has secured $145m in a growth financing that pairs equity with a ring-fenced project-finance facility for its second recycled aluminium line. The structure keeps construction risk off the operating balance sheet.',
        'Management said offtake for the new line is substantially contracted ahead of commissioning, which was a condition of the debt package.',
      ],
      authors: 'Reuben Achterberg',
      tags: 'growth equity, materials, project finance',
      // Seeded as a German article with an English translation, so the
      // reading pane's language toggle is exercised by a fresh seed.
      original: {
        language: 'de',
        title: 'Kestrel Materials sichert sich 145 Mio. USD Wachstumsfinanzierung für Aluminium-Recyclingkapazität',
        summary:
          'Die Runde kombiniert Eigenkapital mit einer Projektfinanzierungslinie und finanziert eine zweite Recyclinglinie.',
        body: [
          'Kestrel Materials hat sich eine Wachstumsfinanzierung über 145 Mio. USD gesichert, die Eigenkapital mit einer abgegrenzten Projektfinanzierungslinie für die zweite Recyclinglinie für Aluminium verbindet. Die Struktur hält das Baurisiko von der operativen Bilanz fern.',
          'Das Management erklärte, die Abnahme für die neue Linie sei bereits vor der Inbetriebnahme weitgehend vertraglich gesichert, was eine Bedingung des Fremdkapitalpakets gewesen sei.',
        ],
      },
    },
    {
      title: 'Lanternfish raises $18m seed extension after tripling deployed volume',
      summary:
        'The unusually large seed extension was raised on the back of deployment growth rather than a new product cycle.',
      body: [
        'Lanternfish has raised an $18m seed extension, a size that would ordinarily indicate a Series A. The company deliberately avoided the round label, citing a preference to raise again on eighteen months of operating data.',
        'Deployed volume has roughly tripled over the period without a corresponding increase in headcount, which management presented as the case for the extension.',
      ],
      tags: 'seed, fintech',
    },
    {
      title: 'Orrin Robotics raises $60m Series C to move from pilot to production deployments',
      summary:
        'The company said the round funds a transition from pilot installations to multi-site production contracts with three existing customers.',
      body: [
        'Orrin Robotics closed a $60m Series C to fund the shift from pilots into production deployments. Three existing customers have signed multi-site agreements contingent on the company reaching a manufacturing rate it could not previously finance.',
        'The round was led by an existing investor, with management noting that outside interest was available at a lower price and was declined.',
      ],
      authors: 'Naomi Okafor',
      tags: 'series c, robotics',
    },
    {
      title: 'Threadmark lands $27m to build compliance tooling for mid-market lenders',
      summary:
        'The financing targets a segment large lenders build in-house and small lenders currently handle manually.',
      body: [
        'Threadmark raised $27m to build compliance automation aimed squarely at mid-market lenders — institutions too small to justify an in-house build and too regulated to continue with spreadsheets.',
        'The company said its early customers replaced between four and nine full-time compliance roles, which is the basis of a pricing model indexed to headcount displaced rather than seats sold.',
      ],
      tags: 'fintech, compliance, series a',
    },
    {
      title: 'Vantablue raises $210m for its second infrastructure software fund',
      summary:
        'The fund closed above target and will write cheques into a segment the manager says remains under-competed.',
      body: [
        'Vantablue has closed its second infrastructure software fund at $210m, above a $175m target. The manager invests in software serving physical infrastructure operators, a segment it argues remains under-competed relative to enterprise SaaS generally.',
        'Roughly two-thirds of commitments came from existing limited partners, with the balance from two institutions new to the manager.',
      ],
      authors: 'Naomi Okafor',
      tags: 'fund close, venture capital',
    },
    {
      title: 'Halvard Bio raises $46m Series B on manufacturing rather than clinical milestones',
      summary:
        'The round is explicitly structured around scaling manufacture of an approved product rather than advancing a pipeline.',
      body: [
        'Halvard Bio raised $46m in a Series B structured around manufacturing scale-up for an already-approved product, an unusual framing for a round at this stage and size.',
        'Management said demand has exceeded supply since approval and that the constraint is entirely production capacity, making the financing a capacity decision rather than a clinical one.',
      ],
      tags: 'series b, biotech, manufacturing',
    },
    {
      title: 'Coastline Freight raises $39m to expand cross-border brokerage',
      summary:
        'The round funds expansion of a digital brokerage into two additional border crossings.',
      body: [
        'Coastline Freight has raised $39m to extend its digital brokerage operation to two further border crossings. The company matches shippers with carriers holding the specific customs accreditations a given lane requires.',
        'Expansion economics depend on carrier density on each new lane, which management acknowledged takes roughly three quarters to reach a workable level.',
      ],
      authors: 'Reuben Achterberg',
      tags: 'logistics, series b',
    },
    {
      title: 'Piedmont Analytics closes $12m to serve regional insurers',
      summary:
        'A deliberately small round aimed at a customer segment the founders argue is too small for incumbent vendors to serve.',
      body: [
        'Piedmont Analytics raised $12m, a size the founders described as sufficient to reach profitability without a further round. The company sells underwriting analytics to regional insurers below the threshold at which incumbent vendors will engage.',
        'The segment is large in aggregate and fragmented in practice, which makes distribution the principal risk rather than product.',
      ],
      tags: 'insurtech, seed',
    },
    {
      title: 'Northfleet raises $95m to consolidate regional waste haulers',
      summary:
        'The vehicle will pursue a buy-and-build across regional waste collection, a strategy the team ran previously at a larger sponsor.',
      body: [
        'Northfleet has raised $95m to consolidate regional waste haulers, a strategy the founding team executed previously inside a larger sponsor before spinning out.',
        'The thesis rests on route density: acquiring adjacent haulers whose routes overlap allows collection frequency to be rationalised without service degradation, which is where the margin improvement sits.',
      ],
      authors: 'Naomi Okafor',
      tags: 'buy-and-build, environmental services',
    },
    {
      title: 'Aperture Labs raises $22m after two years without external capital',
      summary:
        'The company raised for the first time since inception, having reached meaningful scale on revenue alone.',
      body: [
        'Aperture Labs has taken $22m in its first external financing since founding, having previously funded growth from operations. The round was raised against an expansion opportunity management said could not be self-funded on an acceptable timeline.',
        'Founders retain majority control following the transaction, an outcome the company attributed directly to having deferred the raise.',
      ],
      tags: 'growth equity, bootstrapped',
    },
  ],
  ma_partnerships: [
    {
      title: 'Aldergate Industrial acquires Penvale Controls for $310m',
      summary:
        'The acquisition adds process-control instrumentation to Aldergate’s automation portfolio and closes an acknowledged product gap.',
      body: [
        'Aldergate Industrial has agreed to acquire Penvale Controls for $310m in cash. Penvale supplies process-control instrumentation into chemical and water-treatment end markets, filling a gap Aldergate has flagged to investors for several reporting periods.',
        'The companies said Penvale will continue to operate under its own brand, with integration limited to procurement and back-office functions for at least the first year.',
      ],
      authors: 'Clare Whittaker',
      tags: 'acquisition, industrials',
    },
    {
      title: 'Brightmoor Group and Sennen Partners form a joint venture for regional data centres',
      summary:
        'The venture pairs Brightmoor’s land bank with Sennen’s development capability under a shared-economics structure.',
      body: [
        'Brightmoor Group and Sennen Partners have formed a joint venture to develop regional data-centre capacity, contributing land holdings and development capability respectively. Economics are shared rather than split at a fixed ratio, with returns tiered against delivered capacity.',
        'The structure avoids Brightmoor selling land into a market it believes is undervalued while giving Sennen sites without a capital outlay it would struggle to justify.',
      ],
      tags: 'joint venture, data centres',
      // Seeded as a Japanese article with an English translation — a
      // non-Latin script, so it also exercises the script-census branch of
      // `detectLanguage` if this fixture is ever run back through the stage.
      original: {
        language: 'ja',
        title: 'ブライトムーア・グループとセネン・パートナーズ、地方データセンターの合弁会社を設立',
        summary:
          'この合弁事業は、ブライトムーアの保有地とセネンの開発力を、経済条件を共有する枠組みの下で組み合わせるものである。',
        body: [
          'ブライトムーア・グループとセネン・パートナーズは、地方データセンターの容量を開発するための合弁会社を設立した。ブライトムーアが保有地を、セネンが開発能力をそれぞれ拠出する。経済条件は固定比率で分割するのではなく共有され、リターンは引き渡された容量に応じて段階的に設定される。',
          'この枠組みにより、ブライトムーアは過小評価されていると考える市場に土地を売却する必要がなくなり、セネンは自社では正当化しがたい資本支出なしに用地を確保できる。',
        ],
      },
    },
    {
      title: 'Corvid Software acquires Tessellate for $88m to enter the public sector',
      summary:
        'The deal buys accreditation and existing government contracts rather than technology.',
      body: [
        'Corvid Software will acquire Tessellate for $88m, a price management acknowledged is well above what the target’s technology alone would command. The rationale is Tessellate’s public-sector accreditations and contract vehicles, which take years to obtain independently.',
        'Corvid said it expects to migrate Tessellate customers onto its own platform over eighteen months while retaining the acquired contracting entity.',
      ],
      authors: 'Clare Whittaker',
      tags: 'acquisition, software, public sector',
    },
    {
      title: 'Harlow Foods divests its ambient division to Kettleby Capital',
      summary:
        'The carve-out completes a portfolio reshaping Harlow announced two years ago.',
      body: [
        'Harlow Foods has agreed to sell its ambient division to Kettleby Capital, completing a reshaping announced two years ago. The division has been the group’s slowest-growing but most cash-generative segment.',
        'Transitional services run for twelve months, notably shorter than the eighteen to twenty-four the market has come to expect on carve-outs of this size.',
      ],
      tags: 'carve-out, food and beverage',
    },
    {
      title: 'Ravensworth Logistics acquires two regional hauliers in a single transaction',
      summary:
        'Both targets were bought from the same family holding company, allowing a single set of completion mechanics.',
      body: [
        'Ravensworth Logistics has acquired two regional hauliers held under one family holding company, structuring the purchase as a single transaction with one set of completion accounts.',
        'Route overlap between the two targets is substantial, which Ravensworth said would allow depot consolidation without reducing service frequency on any served lane.',
      ],
      authors: 'Desmond Iyer',
      tags: 'acquisition, logistics',
    },
    {
      title: 'Fennimore Health partners with Larkspur Clinics on outcome-based contracting',
      summary:
        'A commercial partnership rather than an acquisition, structured around shared outcome risk.',
      body: [
        'Fennimore Health and Larkspur Clinics have entered a commercial partnership under which both parties share financial exposure to patient outcomes across an initial cohort of chronic-care patients.',
        'Neither party took equity in the other. Both described the arrangement as a precursor to a deeper transaction should the initial cohort perform.',
      ],
      tags: 'partnership, healthcare',
    },
    {
      title: 'Quillon Capital takes a 34% stake in Ashgrove Manufacturing',
      summary:
        'A structured minority with defined governance rights and a contractual path to control.',
      body: [
        'Quillon Capital has taken a 34 percent stake in Ashgrove Manufacturing, having failed to agree a control valuation with the founding family. The package includes board representation, information rights and a defined mechanism to move to control at a formula price.',
        'The family retains operational control and has committed to remain for a minimum of four years under the agreement.',
      ],
      authors: 'Desmond Iyer',
      tags: 'minority stake, manufacturing',
    },
    {
      title: 'Marbrook Insurance acquires Stancliffe Brokers to expand specialty lines',
      summary:
        'The acquisition adds specialty broking capability in marine and energy risk.',
      body: [
        'Marbrook Insurance has agreed to acquire Stancliffe Brokers, adding specialty broking in marine and energy risk to a book weighted toward commercial property.',
        'Marbrook said the acquired team will be left structurally intact, citing the concentration of client relationships in a small number of individual brokers.',
      ],
      tags: 'acquisition, insurance',
    },
    {
      title: 'Petrel Energy and Ashcombe Renewables agree a development partnership',
      summary:
        'The partnership gives Petrel a renewables development pipeline without an outright acquisition.',
      body: [
        'Petrel Energy has agreed a development partnership with Ashcombe Renewables, funding project development in exchange for offtake rights and an option over completed assets.',
        'The structure lets Petrel build exposure without consolidating development risk onto its balance sheet, and gives Ashcombe capital it could not raise on comparable terms independently.',
      ],
      authors: 'Clare Whittaker',
      tags: 'partnership, energy',
    },
    {
      title: 'Underhill Group acquires Fairweather Testing for $54m',
      summary:
        'A bolt-on adding laboratory capacity in a geography Underhill had been serving from out of region.',
      body: [
        'Underhill Group will acquire Fairweather Testing for $54m, adding laboratory capacity in a region Underhill has been serving through sample transport from neighbouring facilities.',
        'The transaction removes a logistics cost and a turnaround-time disadvantage that Underhill said had cost it several tenders in the region over the past two years.',
      ],
      tags: 'acquisition, testing and inspection',
    },
    {
      title: 'Sturmont Retail sells its distribution arm in a management buyout',
      summary:
        'The incumbent management team acquired the division with backing from a mid-market sponsor.',
      body: [
        'Sturmont Retail has sold its distribution arm to the incumbent management team, backed by a mid-market sponsor. The division had been run at arm’s length from the retail operation for some years.',
        'A long-term supply agreement between the two entities was signed alongside the transaction, which was a condition of the sponsor’s financing.',
      ],
      authors: 'Desmond Iyer',
      tags: 'mbo, retail',
    },
    {
      title: 'Calder & Voss merges with Pemberton Advisory',
      summary:
        'Two mid-market advisory firms combine, citing client demand for sector coverage neither could sustain alone.',
      body: [
        'Calder & Voss and Pemberton Advisory have agreed to merge, creating a mid-market advisory firm with combined coverage across industrials, healthcare and business services.',
        'Both firms cited client pressure for sector depth neither could fund independently. Leadership will be shared for an initial two-year period before consolidating.',
      ],
      tags: 'merger, professional services',
    },
  ],
  industry_reports: [
    {
      title: 'Annual mid-market M&A review: volumes flat, structures more complex',
      summary:
        'Deal count was broadly unchanged year on year while the share of transactions carrying contingent consideration rose sharply.',
      body: [
        'Mid-market deal count finished the year broadly flat, an outcome that conceals a pronounced shift in how transactions were structured. The proportion including earn-outs, vendor loans or deferred consideration rose by more than a third.',
        'The shift reflects a persistent valuation gap that parties are bridging through structure rather than price, which pushes the real economics of the current vintage several years out.',
      ],
      authors: 'Research Desk',
      tags: 'annual review, m&a',
    },
    {
      title: 'Sector outlook: business services faces a labour cost reset',
      summary:
        'A structural wage reset is compressing margins in labour-intensive business services faster than pricing can respond.',
      body: [
        'Labour-intensive business services are absorbing a wage reset that pricing has not caught up with. Contracts written on multi-year terms without indexation are the principal source of the compression.',
        'Operators with indexed contracts have held margin. The dispersion between the two groups is now wide enough to be the dominant variable in sector valuations.',
      ],
      tags: 'sector outlook, business services',
    },
    {
      title: 'Quarterly credit conditions: covenant packages loosen at the top of the market',
      summary:
        'Documentation quality has deteriorated in the upper mid-market while holding firm below it.',
      body: [
        'Covenant packages in the upper mid-market have loosened materially over the quarter, with maintenance covenants disappearing from a rising share of documentation. The lower mid-market has not followed.',
        'The divergence tracks competitive intensity rather than credit quality, which is the familiar precondition for a period of poor vintage performance.',
      ],
      authors: 'Research Desk',
      tags: 'credit, quarterly',
    },
    {
      title: 'Technology adoption survey: automation budgets shift from pilots to production',
      summary:
        'A majority of surveyed enterprises moved automation spending out of innovation budgets and into operating budgets.',
      body: [
        'For the first time in the survey’s history, a majority of respondents reported funding automation from operating rather than innovation budgets. The shift matters because operating budgets demand a payback case that innovation budgets do not.',
        'Vendors reporting lengthening sales cycles are, on this evidence, encountering a different buyer rather than weaker demand.',
      ],
      tags: 'survey, automation, enterprise',
    },
    {
      title: 'Fund performance review: dispersion widens between top and median managers',
      summary:
        'The gap between top-quartile and median mid-market managers has widened to its largest in the dataset.',
      body: [
        'Dispersion between top-quartile and median mid-market managers has reached its widest level in the series. The widening is driven by the bottom of the distribution deteriorating rather than the top improving.',
        'Manager selection consequently carries more weight in expected outcomes than allocation between strategies, reversing the relationship that held through the previous cycle.',
      ],
      authors: 'Research Desk',
      tags: 'fund performance, private equity',
    },
    {
      title: 'Regional economic assessment: inland manufacturing corridors outperform',
      summary:
        'Inland manufacturing regions recorded employment and output growth ahead of coastal metropolitan areas.',
      body: [
        'Inland manufacturing corridors outperformed coastal metropolitan areas on both employment and industrial output over the assessment period, continuing a reversal that began two years ago.',
        'Power availability and industrial land cost account for most of the differential, both of which have become binding constraints in coastal markets.',
      ],
      tags: 'regional, manufacturing',
    },
    {
      title: 'Supply chain resilience index falls for the second straight period',
      summary:
        'Measured resilience declined again as firms unwound the inventory buffers built during the disruption cycle.',
      body: [
        'The resilience index declined for a second consecutive period as firms released inventory buffers accumulated during the disruption cycle. Working-capital pressure, not restored confidence in supply, appears to be the driver.',
        'The unwind leaves the measured supply base more exposed than at any point since the index was rebased, without a corresponding improvement in supplier diversification.',
      ],
      authors: 'Research Desk',
      tags: 'supply chain, index',
    },
    {
      title: 'Valuation benchmarks: software multiples stratify by growth durability',
      summary:
        'Multiples have separated according to growth durability rather than growth rate, a change from prior periods.',
      body: [
        'Software valuation multiples have re-stratified around the durability of growth rather than its rate. Businesses growing moderately for many consecutive periods now command premiums over faster-growing but more volatile peers.',
        'The change is consistent with a buyer base weighted toward strategic acquirers and control investors rather than growth funds, and is unlikely to reverse while that composition holds.',
      ],
      tags: 'valuation, software',
    },
    {
      title: 'Labour market study: technical training pipelines determine industrial siting',
      summary:
        'Access to trained technical labour has overtaken wage cost as the primary industrial siting determinant.',
      body: [
        'Across surveyed siting decisions, availability of trained technical labour outranked wage cost as the determining factor for the first time in the study’s history.',
        'Regions with established apprenticeship and technical training infrastructure are capturing investment from lower-wage regions without it, a reversal of the pattern that held for most of the previous decade.',
      ],
      authors: 'Research Desk',
      tags: 'labour, industrial policy',
    },
    {
      title: 'ESG reporting review: assurance costs rise faster than reporting scope',
      summary:
        'The cost of assuring sustainability disclosures has grown faster than the disclosures themselves.',
      body: [
        'Assurance costs for sustainability reporting have risen faster than the scope of what is being reported, driven by a shortage of qualified assurance providers rather than by expanding requirements.',
        'Mid-market issuers are disproportionately affected, facing broadly fixed assurance costs against a much smaller revenue base than large-cap peers.',
      ],
      tags: 'esg, reporting',
    },
    {
      title: 'Insolvency trends: distress concentrates in leveraged services roll-ups',
      summary:
        'Insolvency filings are concentrated in leveraged roll-ups assembled during the low-rate period.',
      body: [
        'Filings have concentrated markedly in leveraged services roll-ups assembled during the low-rate period. The common profile is a platform that completed several acquisitions without integrating the acquired finance functions.',
        'Distress in these cases has generally been triggered by an inability to produce reliable consolidated reporting for lenders rather than by underlying trading performance.',
      ],
      authors: 'Research Desk',
      tags: 'insolvency, distress',
    },
    {
      title: 'Cross-border deal survey: regulatory timelines lengthen in every surveyed jurisdiction',
      summary:
        'Median regulatory clearance timelines extended across all surveyed jurisdictions, with foreign-investment review the largest contributor.',
      body: [
        'Median clearance timelines lengthened in every surveyed jurisdiction, with foreign-investment review accounting for the majority of the extension. No jurisdiction in the survey recorded a reduction.',
        'Acquirers are responding by pricing longer exclusivity periods and, in several observed cases, by declining cross-border processes entirely in favour of domestic targets.',
      ],
      tags: 'cross-border, regulatory',
    },
  ],
};

/**
 * Stories whose feed `<pubDate>` is deliberately wrong — stamped in the future
 * relative to when the row was ingested. `RssItemRepository`'s trusted-date
 * expression should fall back to `ingested_at` for these, so they must appear
 * in date order among their neighbours rather than pinned to the top of the
 * feed. Keyed by title so the fixture stays readable.
 */
const MISATTRIBUTED_PUBLISH_DATES = new Set<string>([
  'Rate expectations have stopped driving mid-market entry multiples',
  'Coastline Freight raises $39m to expand cross-border brokerage',
]);

async function seedRssFeeds(db: DbClient) {
  const ids = SEED_RSS_FEEDS.map((f) => f.id);
  // Items cascade from feeds; delete children first anyway so a partial
  // previous seed can't leave orphans behind.
  await db.delete(rssItems).where(inArray(rssItems.feed_id, ids));
  await db.delete(rssFeeds).where(inArray(rssFeeds.id, ids));
  await db.insert(rssFeeds).values(SEED_RSS_FEEDS.map((f) => ({ ...f })));

  const now = Date.now();
  const HOUR = 3_600_000;
  /** Spacing between consecutive items, so 60 stories span roughly 12 days. */
  const STORY_INTERVAL_MS = 5 * HOUR;

  const feedsByCategory = new Map<RssCategory, typeof SEED_RSS_FEEDS[number][]>();
  for (const feed of SEED_RSS_FEEDS) {
    const list = feedsByCategory.get(feed.category) ?? [];
    list.push(feed);
    feedsByCategory.set(feed.category, list);
  }

  // Interleave the categories rather than emitting one category at a time:
  // the feed is ordered by date, so a category-major walk would produce a
  // list that reads as five contiguous blocks instead of a mixed news feed.
  const ordered: Array<{ story: SeedRssStory; category: RssCategory; slot: number }> = [];
  const deepest = Math.max(...RSS_CATEGORIES.map((c) => SEED_RSS_STORIES[c].length));
  for (let slot = 0; slot < deepest; slot++) {
    for (const category of RSS_CATEGORIES) {
      const story = SEED_RSS_STORIES[category][slot];
      if (story) ordered.push({ story, category, slot });
    }
  }

  const rows = ordered.map(({ story, category, slot }, index) => {
    const feeds = feedsByCategory.get(category)!;
    const feed = feeds[slot % feeds.length];

    // Rotate three content states so every branch of the reading pane is
    // reachable from a fresh seed: a fetched full article, an item that was
    // never queued for extraction, and one whose extraction terminally
    // failed (both of the latter render the "Summary only" fallback).
    //
    // Translated fixtures opt out of the rotation. The pipeline only ever
    // translates `relevance = 'selected'` items with a resolved content
    // fetch, so seeding a translated-but-rejected row would put a state in
    // the database that no run can actually produce.
    const state = story.original
      ? 'fetched'
      : index % 7 === 3
        ? 'none'
        : index % 7 === 5
          ? 'failed'
          : 'fetched';
    const ingestedAt = new Date(now - index * STORY_INTERVAL_MS);
    // The honest publish time sits a little before ingestion, as it would in
    // a real poll. The misattributed rows instead claim a future date; the
    // repository is expected to ignore it and fall back to `ingested_at`.
    const publishedAt = MISATTRIBUTED_PUBLISH_DATES.has(story.title)
      ? new Date(now + (index + 12) * HOUR)
      : new Date(ingestedAt.getTime() - 40 * 60_000);

    // For a translated fixture the ORIGINAL text is what the publisher
    // shipped and therefore what lands in `title`/`summary`/`content_text`;
    // the story's own English copy is the translation. For everything else
    // the story is already English and there is no translation at all.
    const source = story.original ?? story;
    const body = state === 'fetched' ? source.body.join('\n\n') : null;

    return {
      item_hash: `seed-${category}-${slot}`,
      feed_id: feed.id,
      category,
      source_name: feed.source_name,
      region: feed.region,
      feed_tier: feed.tier,
      title: source.title,
      link: `https://example.com/${category}/${slot}`,
      summary: source.summary,
      authors: story.authors ?? null,
      tags: story.tags ?? category,
      published_at: publishedAt.toISOString(),
      ingested_at: ingestedAt.toISOString(),
      relevance: state === 'none' ? ('rejected' as const) : ('selected' as const),
      relevance_score: state === 'none' ? 0.24 : 0.79,
      content_status: state as 'fetched' | 'none' | 'failed',
      content_text: body,
      content_fetched_at: state === 'fetched' ? ingestedAt.toISOString() : null,
      content_attempts: state === 'failed' ? 3 : 0,
      content_error: state === 'failed' ? 'content too short' : null,
      // `not_needed` for the English majority — the same verdict the
      // translate stage records once it has looked at an item and found
      // nothing to do. Leaving these `none` would put every seeded row in
      // the translate queue.
      language: story.original?.language ?? 'en',
      translation_status: story.original ? ('translated' as const) : ('not_needed' as const),
      title_en: story.original ? story.title : null,
      summary_en: story.original ? story.summary : null,
      content_text_en: story.original && state === 'fetched' ? story.body.join('\n\n') : null,
      translated_at: ingestedAt.toISOString(),
    };
  });

  await db.insert(rssItems).values(rows);

  console.log(
    `  seeded ${SEED_RSS_FEEDS.length} rss feeds + ${rows.length} news items ` +
      `(${rows.filter((r) => r.content_status === 'fetched').length} with full article text, ` +
      `${rows.filter((r) => r.translation_status === 'translated').length} non-English with an ` +
      `English translation to exercise the language toggle, ` +
      `${MISATTRIBUTED_PUBLISH_DATES.size} with a future publish date to exercise the ingest-date fallback)`,
  );
}

async function main() {
  const usersAndWorkspacesOnly = process.argv.includes('--users-workspaces-only');
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(client);

  console.log(`seeding ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}...`);

  try {
    // Users — upsert the seed user by email rather than delete+recreate. The
    // prior seed user may be referenced by app-created rows (routines,
    // ai_workforce_queue) whose FKs don't cascade, so a delete would fail;
    // upserting keeps the same id and sidesteps that chain entirely.
    const passwordHash = await hashPassword(SEED_USER_PASSWORD);
    const [seedUser] = await db
      .insert(users)
      .values({
        name: 'Test User',
        email: SEED_USER_EMAIL,
        password: passwordHash,
        role: SEED_USER_ROLE,
        is_superadmin: true,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: 'Test User', password: passwordHash, role: SEED_USER_ROLE, is_superadmin: true },
      })
      .returning({ id: users.id });
    if (!seedUser) throw new Error('failed to upsert seed user');
    console.log(`  ✓ user ${SEED_USER_EMAIL} (password: ${SEED_USER_PASSWORD}, role: ${SEED_USER_ROLE}, superadmin: true)`);

    // Deleting the retired workspace cascades everything scoped to it
    // (memberships, companies, notes, topics, correspondent links); its CRM
    // isolation fixture's correspondent and mailbox history are not
    // workspace-scoped, so they go explicitly.
    await db.delete(workspaces).where(eq(workspaces.id, RETIRED_WORKSPACE_4_ID));
    await db.delete(emails).where(like(emails.message_id, 'seed-aeliana-cs-%@seed.local'));
    await db
      .delete(correspondents)
      .where(eq(correspondents.email, 'elena.papadopoulos@aeliana-vcc.example'));

    // Tenancy (MB-337) — the hardcoded workspace ids from the migration's prod
    // backfill, plus the 3 roles. Name/slug/copilot_agent are upserted (rather
    // than left alone on conflict) so a reseed renames a DB still carrying the
    // pre-Copilot workspace names onto the current one-per-flavor mapping.
    for (const ws of SEED_WORKSPACES) {
      await db
        .insert(workspaces)
        .values({ id: ws.id, name: ws.name, slug: ws.slug, copilot_agent: ws.copilotAgent })
        .onConflictDoUpdate({
          target: workspaces.id,
          set: { name: ws.name, slug: ws.slug, copilot_agent: ws.copilotAgent },
        });
    }
    await db
      .insert(roles)
      .values([
        { id: ROLE_ADMIN_ID, name: 'admin' },
        { id: ROLE_EDITOR_ID, name: 'editor' },
        { id: ROLE_VIEWER_ID, name: 'viewer' },
      ])
      .onConflictDoNothing({ target: roles.id });
    await db
      .insert(userWorkspaces)
      .values({ user_id: seedUser.id, workspace_id: MNA_WORKSPACE_ID, role_id: ROLE_EDITOR_ID, is_email_synced: false })
      .onConflictDoUpdate({
        target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
        set: { is_email_synced: false },
      });
    console.log('  ✓ Combined workspace + roles + seed user membership (is_email_synced=false — toggle it in admin portal to test)');

    // Per-workspace feature overrides. Attributed to the seed superadmin so the
    // admin portal's "last changed by" reads like a real toggle.
    for (const ws of SEED_WORKSPACES) {
      const features = { ...SEED_WORKSPACE_DEFAULT_FEATURES, ...ws.features };
      for (const [featureKey, enabled] of Object.entries(features)) {
        await db
          .insert(featureFlags)
          .values({ workspace_id: ws.id, feature_key: featureKey, enabled, updated_by: seedUser.id })
          .onConflictDoUpdate({
            target: [featureFlags.workspace_id, featureFlags.feature_key],
            set: { enabled, updated_by: seedUser.id, updated_at: sql`now()` },
          });
      }
      console.log(
        `  ✓ ${ws.name} (/w/${ws.slug}) → Copilot '${ws.copilotAgent}', features: ${Object.entries(features)
          .map(([key, enabled]) => `${key}=${enabled}`)
          .join(', ')}`,
      );
    }

    // Test users (test2/test3/test4) — for exercising the workspace
    // picker/switcher locally: test2 and test3 each have exactly one
    // membership (auto-skip path), test4 has two (picker + switcher path).
    const extraUserIdByEmail = new Map<string, string>();
    for (const u of SEED_EXTRA_USERS) {
      const [row] = await db
        .insert(users)
        .values({ name: u.name, email: u.email, password: passwordHash, role: SEED_USER_ROLE })
        .onConflictDoUpdate({
          target: users.email,
          set: { name: u.name, password: passwordHash, role: SEED_USER_ROLE },
        })
        .returning({ id: users.id });
      if (row) extraUserIdByEmail.set(u.email, row.id);
    }

    for (const m of SEED_EXTRA_MEMBERSHIPS) {
      const userId = extraUserIdByEmail.get(m.email);
      if (!userId) continue;
      await db
        .insert(userWorkspaces)
        .values({ user_id: userId, workspace_id: m.workspaceId, role_id: ROLE_EDITOR_ID })
        .onConflictDoNothing({ target: [userWorkspaces.user_id, userWorkspaces.workspace_id] });
    }
    console.log(
      `  ✓ ${SEED_WORKSPACES.length} workspaces (one per Copilot flavor) + ${SEED_EXTRA_USERS.length} test users (password: ${SEED_USER_PASSWORD})`,
    );
    console.log(`    ${SEED_USER_EMAIL} -> Combined (M&A + Investment) (1 workspace)`);
    console.log('    test2@sqe.co.id -> M&A / Acquisitions (1 workspace)');
    console.log('    test3@sqe.co.id -> Funds & Investing (1 workspace)');
    console.log('    test4@sqe.co.id -> M&A / Acquisitions + Funds & Investing (2 workspaces)');

    if (usersAndWorkspacesOnly) {
      console.log('done (users and workspaces only).');
      return;
    }

    // Companies — clear prior seed rows (identified by entry_id range), re-insert.
    // company_financials rows cascade on company delete.
    await db
      .delete(companies)
      .where(
        and(
          gte(companies.entry_id, SEED_ENTRY_ID_MIN),
          lte(companies.entry_id, SEED_ENTRY_ID_MAX),
        ),
      );
    const userIdByEmail = new Map<string, string>([
      [SEED_USER_EMAIL, seedUser.id],
      ...extraUserIdByEmail,
    ]);
    const insertedCompanies: Array<{ entry_id: number; id: string }> = [];
    for (const c of seedCompanies) {
      const enteredBy = c.entered_by_email ? userIdByEmail.get(c.entered_by_email) : undefined;
      if (c.entered_by_email && !enteredBy) {
        throw new Error(`seed company ${c.entry_id}: entered_by_email ${c.entered_by_email} is not a seeded user`);
      }
      const [inserted] = await db
        .insert(companies)
        .values({
          entry_id: c.entry_id,
          target: c.target ?? null,
          project_name: c.project_name ?? null,
          segment: c.segment,
          company_focus: c.company_focus,
          website: c.website,
          geography: c.geography,
          ownership: c.ownership,
          pipeline_stage: c.pipeline_stage,
          status: c.status,
          source: c.source ?? null,
          doc_type: c.doc_type ?? null,
          banker_source: c.banker_source ?? null,
          remarks: c.remarks ?? null,
          context: c.context ?? null,
          watchlist_status: c.watchlist_status,
          dropped_reason: c.dropped_reason ?? null,
          dropped_at: c.dropped_at ?? null,
          deal_type: c.deal_type ?? null,
          entered_by: enteredBy ?? null,
          originator: c.originator ?? null,
          last_activity_at: c.last_activity_at ?? null,
          banker: c.banker ?? c.banker_source ?? null,
          advisor: c.advisor ?? null,
          stake: c.stake ?? null,
          deal_size: c.deal_size ?? null,
          workflow_status: c.workflow_status ?? null,
          key_rationale: c.key_rationale ?? null,
          workspace_id: MNA_WORKSPACE_ID,
        })
        .onConflictDoNothing()
        .returning({ id: companies.id });
      if (!inserted) continue;
      insertedCompanies.push({ entry_id: c.entry_id, id: inserted.id });
      if (c.financials.length > 0) {
        await db.insert(companyFinancials).values(
          c.financials.map((f) => ({
            company_id: inserted.id,
            workspace_id: MNA_WORKSPACE_ID,
            fiscal_year: f.fiscal_year,
            revenue_usd_mn: f.revenue_usd_mn ?? null,
            ebitda_usd_mn: f.ebitda_usd_mn ?? null,
            ev_usd_mn: f.ev_usd_mn ?? null,
            ebitda_margin: null,
            ev_ebitda: null,
            revenue_cagr_vs_prior: null,
          })),
        ).onConflictDoNothing();
      }
    }

    const companyIdByEntryId = new Map(
      insertedCompanies.map((c) => [c.entry_id, c.id]),
    );
    for (const c of seedCompanies) {
      if (!c.possible_duplicate_entry_id) continue;
      const id = companyIdByEntryId.get(c.entry_id);
      const possibleDuplicateId = companyIdByEntryId.get(
        c.possible_duplicate_entry_id,
      );
      if (!id || !possibleDuplicateId) continue;
      await db
        .update(companies)
        .set({ possible_duplicate_company_id: possibleDuplicateId })
        .where(eq(companies.id, id));
    }
    console.log(`  ✓ ${seedCompanies.length} companies (+ financials)`);

    // Populate each single-flavor workspace with its own companies, so
    // switching workspaces actually shows different data (tenant isolation,
    // not just an empty screen).
    const insertedAcquisitionsCompanies = await insertCompaniesForWorkspace(
      db,
      TEST_WORKSPACE_2_ID,
      acquisitionsWorkspaceCompanies,
    );
    const insertedInvestingCompanies = await insertCompaniesForWorkspace(
      db,
      TEST_WORKSPACE_3_ID,
      investingWorkspaceCompanies,
    );
    console.log(
      `  ✓ ${acquisitionsWorkspaceCompanies.length} companies in M&A / Acquisitions, ${investingWorkspaceCompanies.length} in Funds & Investing`,
    );

    // Smart Files — seed a few processed files, including one matched to a
    // project-name-only company. Identified by distinctive file names.
    const seedSmartFileNames = seedSmartFiles.map((file) => file.file_name);
    await db.delete(files).where(inArray(files.file_name, seedSmartFileNames));
    // Legacy prefix from before the "AI File Dump" → "Smart Files" rename, so
    // re-seeding an older DB doesn't leave the previous fixture rows behind.
    await db.delete(files).where(like(files.file_name, 'Seed AFD - %'));
    await db.insert(files).values(
      seedSmartFiles.map((file) => {
        const matchedCompanies = [
          ...file.matched_entry_ids.flatMap((entryId) => {
            const id = companyIdByEntryId.get(entryId);
            const company = seedCompanies.find((c) => c.entry_id === entryId);
            if (!id || !company) return [];
            const name = company.target?.trim() || company.project_name?.trim() || `entry_id ${entryId}`;
            return [{
              id,
              target: company.target || undefined,
              name,
              type: 'company',
              similarity: 1,
            }];
          }),
          ...(file.null_id_matches ?? []).map((m) => ({
            id: null,
            name: m.name,
            type: 'company',
            similarity: 1,
          })),
        ];
        const structuredNotes = {
          ...file.structured_notes,
          matched_companies: matchedCompanies,
        };
        return {
          file_name: file.file_name,
          file_link: file.file_link,
          raw_notes: file.raw_notes,
          structured_notes: JSON.stringify(structuredNotes, null, 2),
          tags: file.tags,
          processing_status: file.processing_status,
          matched_companies: matchedCompanies,
          file_date: file.file_date,
          file_type: file.file_type,
          origin_email: false,
          workspace_id: MNA_WORKSPACE_ID,
        };
      }),
    );
    console.log(`  ✓ ${seedSmartFiles.length} Smart Files rows`);

    // Investment thesis — single seed thesis, identified by title.
    await db
      .delete(investmentThesis)
      .where(eq(investmentThesis.title, seedThesis.title));
    const [insertedThesis] = await db
      .insert(investmentThesis)
      .values({ ...seedThesis, workspace_id: MNA_WORKSPACE_ID })
        .onConflictDoNothing()
      .returning({ id: investmentThesis.id });
    console.log(`  ✓ investment_thesis "${seedThesis.title}"`);

    // Criterias — three seed criterias (owned by the seed Track), by name.
    const seedCriteriaNames = seedCriterias.map((c) => c.name);
    await db
      .delete(criterias)
      .where(inArray(criterias.name, seedCriteriaNames));
    await db.insert(criterias).values(
      seedCriterias.map((c) => ({
        ...c,
        investment_thesis_id: insertedThesis.id,
        workspace_id: MNA_WORKSPACE_ID,
      })),
    ).onConflictDoNothing();
    console.log(`  ✓ ${seedCriterias.length} criterias`);

    // CRM seed — one employer per unique company name + one correspondent per
    // SeedContact. Identified by `correspondents.email` for re-runs.
    const seedFirms = Array.from(
      new Set(seedContacts.map((c) => c.company.trim())),
    );
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

    const seedContactEmails = seedContacts.map((c) => c.email);
    await db
      .delete(correspondents)
      .where(inArray(correspondents.email, seedContactEmails));

    const insertedEmployers = await db
      .insert(employers)
      .values(
        seedFirms.map((name) => ({
          name,
          normalized_name: normalize(name),
        })),
      )
      .onConflictDoUpdate({
        target: employers.normalized_name,
        set: { updated_at: new Date().toISOString() },
      })
      .returning();

    const firmIdByName = new Map(
      insertedEmployers.map((e) => [normalize(e.name), e.id]),
    );

    const correspondentRows = seedContacts.map((c) => ({
      employer_id: firmIdByName.get(normalize(c.company))!,
      name: c.name,
      email: c.email,
      phone: c.phone,
      title: c.title,
      type: c.type,
      department: c.department,
      specialization: c.specialization,
      seniority: c.seniority,
      coverage_region: c.coverage_region,
      linkedin_url: c.linkedin_url,
      bio: c.bio,
      is_primary: false,
      source: 'manual',
    }));

    const insertedCorrespondents = await db
      .insert(correspondents)
      .values(correspondentRows)
        .onConflictDoNothing()
      .returning({ id: correspondents.id });

    // Every seeded correspondent must be visible to MNA — the migration
    // backfill only covered rows that existed at migration time, and this
    // script deletes+reinserts seed correspondents on every run.
    if (insertedCorrespondents.length > 0) {
      await db
        .insert(workspaceCorrespondents)
        .values(
          insertedCorrespondents.map((c) => ({
            workspace_id: MNA_WORKSPACE_ID,
            correspondent_id: c.id,
            source: 'ingest' as const,
          })),
        )
        .onConflictDoNothing();
    }
    console.log(
      `  ✓ ${insertedEmployers.length} employers + ${correspondentRows.length} correspondents`,
    );

    // ── CRM enrichment: internal team, topics, assignments, notes ────────────
    const slugify = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    // Internal team members (upsert by email; keep ids stable across re-runs).
    const teamUserIdByEmail = new Map<string, string>();
    for (const u of SEED_TEAM_USERS) {
      const [row] = await db
        .insert(users)
        .values({ name: u.name, email: u.email, password: passwordHash, role: u.role })
        .onConflictDoUpdate({
          target: users.email,
          set: { name: u.name, role: u.role },
        })
        .returning({ id: users.id, email: users.email });
      if (row.email) teamUserIdByEmail.set(row.email, row.id);
    }
    console.log(`  ✓ ${SEED_TEAM_USERS.length} internal team users`);

    // Topic dictionary (with deal/non-deal classification). Upgrade-only on the
    // flag mirrors the ingest pipeline: never demote a topic on re-seed.
    const topicIdByName = new Map<string, string>();
    for (const t of SEED_TOPICS) {
      const [row] = await db
        .insert(topics)
        .values({ name: t.name, slug: slugify(t.name), is_deal_related: t.is_deal_related })
        .onConflictDoUpdate({
          // Seed topics are all shared vocabulary (workspace_id stays NULL) —
          // must match topics_name_global_key exactly, see
          // 20260705000003_topics_workspace_id.sql.
          target: topics.name,
          targetWhere: sql`workspace_id IS NULL`,
          set: {
            slug: slugify(t.name),
            is_deal_related: sql`${topics.is_deal_related} OR ${t.is_deal_related}`,
          },
        })
        .returning({ id: topics.id, name: topics.name });
      topicIdByName.set(row.name, row.id);
    }
    const dealCount = SEED_TOPICS.filter((t) => t.is_deal_related).length;
    console.log(
      `  ✓ ${SEED_TOPICS.length} topics (${dealCount} deal / ${SEED_TOPICS.length - dealCount} non-deal)`,
    );

    // Per-firm topic assignments, team coverage, and notes. Idempotent: topics
    // and team rows use ON CONFLICT DO NOTHING; notes are wiped per-employer
    // first (no natural unique key).
    const enrichedEmployerIds = Object.keys(CRM_ENRICHMENT)
      .map((name) => firmIdByName.get(normalize(name)))
      .filter((id): id is string => !!id);
    if (enrichedEmployerIds.length > 0) {
      await db
        .delete(employerNotes)
        .where(inArray(employerNotes.employer_id, enrichedEmployerIds));
    }

    let topicAssigns = 0;
    let teamRows = 0;
    let noteRows = 0;
    for (const [firmName, enrich] of Object.entries(CRM_ENRICHMENT)) {
      const employerId = firmIdByName.get(normalize(firmName));
      if (!employerId) continue;

      for (const t of enrich.topics) {
        const topicId = topicIdByName.get(t.name);
        if (!topicId) continue;
        await db
          .insert(employerTopics)
          .values({
            employer_id: employerId,
            topic_id: topicId,
            source: t.source,
            is_highlight: !!t.highlight,
          })
          .onConflictDoNothing();
        topicAssigns++;
      }

      for (const userEmail of enrich.team) {
        const userId = teamUserIdByEmail.get(userEmail);
        if (!userId) continue;
        await db
          .insert(employerTeamMembers)
          .values({ employer_id: employerId, user_id: userId })
          .onConflictDoNothing();
        teamRows++;
      }

      for (const note of enrich.notes ?? []) {
        await db.insert(employerNotes).values({
          employer_id: employerId,
          workspace_id: MNA_WORKSPACE_ID,
          content: note,
          author_user_id: teamUserIdByEmail.get('alvin.wobblebottom@sparklecapital.example') ?? null,
        }).onConflictDoNothing();
        noteRows++;
      }
    }
    console.log(
      `  ✓ ${topicAssigns} topic assignments + ${teamRows} team rows + ${noteRows} notes`,
    );

    // ── AUTO VEHICLE ─────────────────────────────────────────────────────────
    // Simulates a CRM employer that originated from an mbox ingest. Surfaces
    // the AUTO badge in the CRM card because employerRepository.list flips to
    // "auto" when the first correspondent's source = 'mbox'. Idempotent via a
    // stable message_id prefix (emails) and normalized_name (employer).
    const AV_NAME = 'AUTO VEHICLE';
    const AV_NORM = 'auto-vehicle';
    const AV_MID_PREFIX = 'seed-auto-vehicle-';
    const AV_MID_SUFFIX = '@seed.local';

    // Wipe seed emails first (cascades email_participants), then employer
    // (cascades correspondents). Doing emails first avoids leaving orphan
    // emails with employer_id set null on the second delete.
    await db
      .delete(emails)
      .where(like(emails.message_id, `${AV_MID_PREFIX}%${AV_MID_SUFFIX}`));
    await db.delete(employers).where(eq(employers.normalized_name, AV_NORM));
    const [avEmployer] = await db
      .insert(employers)
      .values({
        name: AV_NAME,
        normalized_name: AV_NORM,
        industry: 'Automotive',
      })
        .onConflictDoNothing()
      .returning({ id: employers.id });
    if (!avEmployer) throw new Error('failed to insert AUTO VEHICLE employer');

    const avContacts = [
      {
        name: 'Apu Pratfall',
        email: 'apu.pratfall@autowobble.example',
        title: 'Head of Corporate Development',
        phone: '+62 21 555 0201',
        is_primary: true,
      },
      {
        name: 'Sisi Rainbow',
        email: 'sisi.rainbow@autowobble.example',
        title: 'CFO',
        phone: '+62 21 555 0202',
        is_primary: false,
      },
    ];
    const insertedAvCorrespondents = await db
      .insert(correspondents)
      .values(
        avContacts.map((c) => ({
          employer_id: avEmployer.id,
          name: c.name,
          email: c.email,
          title: c.title,
          phone: c.phone,
          type: 'external',
          is_primary: c.is_primary,
          source: 'mbox',
        })),
      )
        .onConflictDoNothing()
      .returning({ id: correspondents.id, email: correspondents.email });
    const avCorrIdByEmail = new Map(
      insertedAvCorrespondents.map((r) => [r.email!.toLowerCase(), r.id]),
    );
    if (insertedAvCorrespondents.length > 0) {
      await db
        .insert(workspaceCorrespondents)
        .values(
          insertedAvCorrespondents.map((c) => ({
            workspace_id: MNA_WORKSPACE_ID,
            correspondent_id: c.id,
            source: 'ingest' as const,
          })),
        )
        .onConflictDoNothing();
    }

    const INTERNAL = { name: 'Wendy Wobble', email: 'wendy.wobble@sparklecapital.example' };
    const PIC = avContacts[0]!;
    const SECONDARY = avContacts[1]!;
    const dayMs = 24 * 60 * 60 * 1000;
    const avBase = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).getTime();

    type AvMail = {
      idx: number;
      subject: string;
      body: string;
      from: { name: string; email: string };
      to: Array<{ name: string; email: string }>;
      cc?: Array<{ name: string; email: string }>;
      direction: 'inbound' | 'outbound';
      daysOffset: number;
    };

    const avMails: AvMail[] = [
      {
        idx: 1,
        subject: 'Introduction — AUTO VEHICLE × Star Capital',
        body: 'Hi Wendy, Following up on our brief call last week, I would like to schedule a deeper conversation about strategic options for AUTO VEHICLE. Best, Apu.',
        from: { name: PIC.name, email: PIC.email },
        to: [INTERNAL],
        direction: 'inbound',
        daysOffset: 0,
      },
      {
        idx: 2,
        subject: 'RE: Introduction — AUTO VEHICLE × Star Capital',
        body: 'Hi Apu, Thanks for reaching out. Let us set up a call next Tuesday at 10am SGT. I will send an invite. — Wendy',
        from: INTERNAL,
        to: [{ name: PIC.name, email: PIC.email }],
        cc: [{ name: SECONDARY.name, email: SECONDARY.email }],
        direction: 'outbound',
        daysOffset: 1,
      },
      {
        idx: 3,
        subject: 'AUTO VEHICLE — FY2025 financials',
        body: 'Wendy, Please find attached our FY2025 financials (unaudited). Revenue grew 18% YoY to USD 42M. Happy to walk through. — Sisi',
        from: { name: SECONDARY.name, email: SECONDARY.email },
        to: [INTERNAL],
        cc: [{ name: PIC.name, email: PIC.email }],
        direction: 'inbound',
        daysOffset: 5,
      },
      {
        idx: 4,
        subject: 'NDA draft for AUTO VEHICLE discussions',
        body: 'Apu, Attaching our standard NDA for your review. Once executed we can proceed to share the CIM. — Wendy',
        from: INTERNAL,
        to: [{ name: PIC.name, email: PIC.email }],
        direction: 'outbound',
        daysOffset: 9,
      },
      {
        idx: 5,
        subject: 'Signed NDA — AUTO VEHICLE',
        body: 'Wendy, Signed NDA attached. Looking forward to next steps. — Apu',
        from: { name: PIC.name, email: PIC.email },
        to: [INTERNAL],
        direction: 'inbound',
        daysOffset: 12,
      },
    ];

    const [wendyUser] = await db
      .insert(users)
      .values({ name: INTERNAL.name, email: INTERNAL.email, password: passwordHash })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: INTERNAL.name },
      })
      .returning({ id: users.id });
    if (!wendyUser) throw new Error('failed to upsert Wendy Wobble (AUTO VEHICLE custodian)');
    await db
      .insert(userWorkspaces)
      .values({
        user_id: wendyUser.id,
        workspace_id: MNA_WORKSPACE_ID,
        role_id: ROLE_EDITOR_ID,
        is_email_synced: true,
      })
      .onConflictDoUpdate({
        target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
        set: { is_email_synced: true },
      });

    const avEmailRows = avMails.map((m) => ({
      message_id: `${AV_MID_PREFIX}${m.idx}${AV_MID_SUFFIX}`,
      custodian_email: INTERNAL.email,
      employer_id: avEmployer.id,
      from_address: m.from.email.toLowerCase(),
      from_display_name: m.from.name,
      sent_at: new Date(avBase + m.daysOffset * dayMs).toISOString(),
      direction: m.direction,
      filter_status: 'processed',
      processed_at: new Date().toISOString(),
    }));
    const insertedAvEmails = await db
      .insert(emails)
      .values(avEmailRows)
        .onConflictDoNothing()
      .returning({ id: emails.id, message_id: emails.message_id });
    const avEmailIdByMid = new Map(
      insertedAvEmails.map((r) => [r.message_id!, r.id]),
    );

    const avParticipantRows: (typeof emailParticipants.$inferInsert)[] = [];
    for (const m of avMails) {
      const mid = `${AV_MID_PREFIX}${m.idx}${AV_MID_SUFFIX}`;
      const emailId = avEmailIdByMid.get(mid);
      if (!emailId) continue;
      avParticipantRows.push({
        email_id: emailId,
        correspondent_id: avCorrIdByEmail.get(m.from.email.toLowerCase()) ?? null,
        address: m.from.email.toLowerCase(),
        display_name: m.from.name,
        role: 'from',
      });
      for (const r of m.to) {
        avParticipantRows.push({
          email_id: emailId,
          correspondent_id: avCorrIdByEmail.get(r.email.toLowerCase()) ?? null,
          address: r.email.toLowerCase(),
          display_name: r.name,
          role: 'to',
        });
      }
      for (const r of m.cc ?? []) {
        avParticipantRows.push({
          email_id: emailId,
          correspondent_id: avCorrIdByEmail.get(r.email.toLowerCase()) ?? null,
          address: r.email.toLowerCase(),
          display_name: r.name,
          role: 'cc',
        });
      }
    }
    if (avParticipantRows.length > 0) {
      await db.insert(emailParticipants).values(avParticipantRows).onConflictDoNothing();
    }
    console.log(
      `  ✓ AUTO VEHICLE: 1 employer + ${insertedAvCorrespondents.length} mbox correspondents + ${insertedAvEmails.length} emails + ${avParticipantRows.length} participants (custodian: ${INTERNAL.email}, synced to MNA)`,
    );

    // ── M&A / Acquisitions — CRM workspace-isolation fixture ──────────────────
    // MB-337 CRM follow-up. Layers this workspace's own private CRM data onto
    // the SAME shared "Golden Sacks" employer MNA already has correspondents/
    // notes/topics for — demonstrates that employer *identity* stays shared
    // while contacts/notes/topics/related-companies/KPIs are workspace-scoped.
    // Everything here is wiped and reinserted by stable identifiers, same
    // idempotency discipline as the AUTO VEHICLE fixture above.
    const isolationEmployerId = firmIdByName.get(normalize('Golden Sacks'));
    if (isolationEmployerId) {
      const STARHOUSE_CONTACT_EMAIL = 'priya.kapoor@starhouseprime.example';
      const STARHOUSE_MID_PREFIX = 'seed-starhouse-gs-';
      const STARHOUSE_MID_SUFFIX = '@seed.local';
      const test2UserId = extraUserIdByEmail.get('test2@sqe.co.id');

      // Wipe prior fixture rows.
      await db
        .delete(emails)
        .where(like(emails.message_id, `${STARHOUSE_MID_PREFIX}%${STARHOUSE_MID_SUFFIX}`));
      await db
        .delete(employerNotes)
        .where(
          and(
            eq(employerNotes.employer_id, isolationEmployerId),
            eq(employerNotes.workspace_id, TEST_WORKSPACE_2_ID),
          ),
        );
      await db
        .delete(employerRelatedCompanies)
        .where(
          and(
            eq(employerRelatedCompanies.employer_id, isolationEmployerId),
            eq(employerRelatedCompanies.workspace_id, TEST_WORKSPACE_2_ID),
          ),
        );
      await db.delete(correspondents).where(eq(correspondents.email, STARHOUSE_CONTACT_EMAIL));

      // Private contact: another banker at Golden Sacks that only the
      // M&A workspace's deal team knows — the Combined workspace must never
      // see her.
      const [priya] = await db
        .insert(correspondents)
        .values({
          employer_id: isolationEmployerId,
          name: 'Priya Kapoor',
          email: STARHOUSE_CONTACT_EMAIL,
          title: 'Principal',
          type: 'external',
          is_primary: false,
          source: 'manual',
          origin: 'manual',
        })
        .onConflictDoNothing()
        .returning({ id: correspondents.id });
      if (priya) {
        await db
          .insert(workspaceCorrespondents)
          .values({ workspace_id: TEST_WORKSPACE_2_ID, correspondent_id: priya.id, source: 'manual' })
          .onConflictDoNothing();
      }

      // Private note — must not appear in MNA's notes list for Golden Sacks.
      await db.insert(employerNotes).values({
        employer_id: isolationEmployerId,
        workspace_id: TEST_WORKSPACE_2_ID,
        content:
          'M&A workspace only: Priya flagged Golden Sacks for a potential co-investment on Project Comet. Do not share outside this workspace yet.',
      }).onConflictDoNothing();

      // Private topic + tag — must not appear in MNA's topic list (global or
      // per-employer) for Golden Sacks.
      const [starhouseTopic] = await db
        .insert(topics)
        .values({
          name: 'Project Comet',
          slug: 'project-comet',
          workspace_id: TEST_WORKSPACE_2_ID,
          is_deal_related: true,
        })
        .onConflictDoUpdate({
          target: [topics.workspace_id, topics.name],
          targetWhere: sql`workspace_id IS NOT NULL`,
          set: { slug: 'project-comet' },
        })
        .returning({ id: topics.id });
      if (starhouseTopic) {
        await db
          .insert(employerTopics)
          .values({
            employer_id: isolationEmployerId,
            topic_id: starhouseTopic.id,
            source: 'manual',
            is_highlight: true,
          })
          .onConflictDoNothing();
      }

      // Private related-company link to one of this workspace's own companies —
      // must not appear in MNA's related-companies tab for Golden Sacks.
      const nordfjord = insertedAcquisitionsCompanies.find((c) => c.entry_id === 9100);
      if (nordfjord) {
        await db.insert(employerRelatedCompanies).values({
          employer_id: isolationEmployerId,
          workspace_id: TEST_WORKSPACE_2_ID,
          company_id: nordfjord.id,
          company_name: 'Nordfjord Robotics',
          normalized_company_name: normalizeCompanyName('Nordfjord Robotics'),
          source: 'manual',
          reason: 'manual',
          reason_summary: 'Added manually',
          confidence: 'high',
          evidence_count: 0,
        }).onConflictDoNothing();
      }

      // Separate mailbox history: test2 (this workspace's own user) is the
      // synced custodian, so mart_crm/mart_mom show the M&A workspace's OWN
      // email KPIs for Golden Sacks — distinct from the Combined workspace's
      // numbers for the same employer.
      if (test2UserId && priya) {
        await db
          .insert(userWorkspaces)
          .values({
            user_id: test2UserId,
            workspace_id: TEST_WORKSPACE_2_ID,
            role_id: ROLE_EDITOR_ID,
            is_email_synced: true,
          })
          .onConflictDoUpdate({
            target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
            set: { is_email_synced: true },
          });

        const shBase = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).getTime();
        const shMails = [
          {
            idx: 1,
            subject: 'Golden Sacks — Introduction (Starhouse)',
            body: 'Hi team, introducing myself as your Starhouse contact at Golden Sacks. Keen to discuss Project Comet. — Priya',
            from: { name: 'Priya Kapoor', email: STARHOUSE_CONTACT_EMAIL, correspondentId: priya.id },
            to: { name: 'Test User 2', email: 'test2@sqe.co.id' },
            direction: 'inbound' as const,
            daysOffset: 0,
          },
          {
            idx: 2,
            subject: 'RE: Golden Sacks — Introduction (Starhouse)',
            body: 'Hi Priya, thanks for reaching out — happy to set up a call this week. — Starhouse',
            from: { name: 'Test User 2', email: 'test2@sqe.co.id', correspondentId: null },
            to: { name: 'Priya Kapoor', email: STARHOUSE_CONTACT_EMAIL, correspondentId: priya.id },
            direction: 'outbound' as const,
            daysOffset: 2,
          },
        ];

          const shEmailRows = shMails.map((m) => ({
            message_id: `${STARHOUSE_MID_PREFIX}${m.idx}${STARHOUSE_MID_SUFFIX}`,
            custodian_email: 'test2@sqe.co.id',
            employer_id: isolationEmployerId,
            from_address: m.from.email.toLowerCase(),
            from_display_name: m.from.name,
            sent_at: new Date(shBase + m.daysOffset * dayMs).toISOString(),
            direction: m.direction,
            filter_status: 'processed',
            processed_at: new Date().toISOString(),
          }));
          const insertedShEmails = await db
            .insert(emails)
            .values(shEmailRows)
        .onConflictDoNothing()
            .returning({ id: emails.id, message_id: emails.message_id });
          const shEmailIdByMid = new Map(insertedShEmails.map((r) => [r.message_id!, r.id]));

          const shParticipantRows: (typeof emailParticipants.$inferInsert)[] = [];
          for (const m of shMails) {
            const mid = `${STARHOUSE_MID_PREFIX}${m.idx}${STARHOUSE_MID_SUFFIX}`;
            const emailId = shEmailIdByMid.get(mid);
            if (!emailId) continue;
            shParticipantRows.push({
              email_id: emailId,
              correspondent_id: m.from.correspondentId,
              address: m.from.email.toLowerCase(),
              display_name: m.from.name,
              role: 'from',
            });
            shParticipantRows.push({
              email_id: emailId,
              correspondent_id: m.to.correspondentId,
              address: m.to.email.toLowerCase(),
              display_name: m.to.name,
              role: 'to',
            });
          }
          if (shParticipantRows.length > 0) {
            await db.insert(emailParticipants).values(shParticipantRows).onConflictDoNothing();
          }
          console.log(
            `  ✓ M&A / Acquisitions isolation fixture: 1 private contact + 1 private note + 1 private topic + 1 private related-company + ${insertedShEmails.length} emails (custodian: test2@sqe.co.id)`,
          );
      }
    }

    // ── Funds & Investing — CRM workspace-isolation fixture ───────────────────
    // Same MB-337 demonstration as the M&A workspace above, layered onto the
    // shared "JP Organ" employer instead of "Golden Sacks" so the two fixtures
    // don't collide. test3 and test4 both belong to Funds & Investing, so this
    // also proves workspace-scoped (not user-scoped) CRM data: either user sees
    // it while in that workspace.
    const toganIsolationEmployerId = firmIdByName.get(normalize('JP Organ'));
    if (toganIsolationEmployerId) {
      const TOGAN_CONTACT_EMAIL = 'deniz.aydin@togan-vcc.example';
      const TOGAN_MID_PREFIX = 'seed-togan-jp-';
      const TOGAN_MID_SUFFIX = '@seed.local';
      const test3UserId = extraUserIdByEmail.get('test3@sqe.co.id');

      await db
        .delete(emails)
        .where(like(emails.message_id, `${TOGAN_MID_PREFIX}%${TOGAN_MID_SUFFIX}`));
      await db
        .delete(employerNotes)
        .where(
          and(
            eq(employerNotes.employer_id, toganIsolationEmployerId),
            eq(employerNotes.workspace_id, TEST_WORKSPACE_3_ID),
          ),
        );
      await db
        .delete(employerRelatedCompanies)
        .where(
          and(
            eq(employerRelatedCompanies.employer_id, toganIsolationEmployerId),
            eq(employerRelatedCompanies.workspace_id, TEST_WORKSPACE_3_ID),
          ),
        );
      await db.delete(correspondents).where(eq(correspondents.email, TOGAN_CONTACT_EMAIL));

      const [deniz] = await db
        .insert(correspondents)
        .values({
          employer_id: toganIsolationEmployerId,
          name: 'Deniz Aydın',
          email: TOGAN_CONTACT_EMAIL,
          title: 'Managing Director',
          type: 'external',
          is_primary: false,
          source: 'manual',
          origin: 'manual',
        })
        .onConflictDoNothing()
        .returning({ id: correspondents.id });
      if (deniz) {
        await db
          .insert(workspaceCorrespondents)
          .values({ workspace_id: TEST_WORKSPACE_3_ID, correspondent_id: deniz.id, source: 'manual' })
          .onConflictDoNothing();
      }

      await db.insert(employerNotes).values({
        employer_id: toganIsolationEmployerId,
        workspace_id: TEST_WORKSPACE_3_ID,
        content:
          'Funds & Investing only: Deniz flagged JP Organ for a co-investment lead on Project Bosphorus. Do not share outside this workspace yet.',
      }).onConflictDoNothing();

      const [toganTopic] = await db
        .insert(topics)
        .values({
          name: 'Project Bosphorus',
          slug: 'project-bosphorus',
          workspace_id: TEST_WORKSPACE_3_ID,
          is_deal_related: true,
        })
        .onConflictDoUpdate({
          target: [topics.workspace_id, topics.name],
          targetWhere: sql`workspace_id IS NOT NULL`,
          set: { slug: 'project-bosphorus' },
        })
        .returning({ id: topics.id });
      if (toganTopic) {
        await db
          .insert(employerTopics)
          .values({
            employer_id: toganIsolationEmployerId,
            topic_id: toganTopic.id,
            source: 'manual',
            is_highlight: true,
          })
          .onConflictDoNothing();
      }

      const kestane = insertedInvestingCompanies.find((c) => c.entry_id === 9110);
      if (kestane) {
        await db.insert(employerRelatedCompanies).values({
          employer_id: toganIsolationEmployerId,
          workspace_id: TEST_WORKSPACE_3_ID,
          company_id: kestane.id,
          company_name: 'Kestane Agri Processing',
          normalized_company_name: normalizeCompanyName('Kestane Agri Processing'),
          source: 'manual',
          reason: 'manual',
          reason_summary: 'Added manually',
          confidence: 'high',
          evidence_count: 0,
        }).onConflictDoNothing();
      }

      if (test3UserId && deniz) {
        await db
          .insert(userWorkspaces)
          .values({
            user_id: test3UserId,
            workspace_id: TEST_WORKSPACE_3_ID,
            role_id: ROLE_EDITOR_ID,
            is_email_synced: true,
          })
          .onConflictDoUpdate({
            target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
            set: { is_email_synced: true },
          });

        const tgBase = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).getTime();
        const tgMails = [
          {
            idx: 1,
            subject: 'JP Organ — Introduction (Togan)',
            body: 'Hi team, introducing myself as your Togan contact at JP Organ. Keen to discuss Project Bosphorus. — Deniz',
            from: { name: 'Deniz Aydın', email: TOGAN_CONTACT_EMAIL, correspondentId: deniz.id },
            to: { name: 'Test User 3', email: 'test3@sqe.co.id' },
            direction: 'inbound' as const,
            daysOffset: 0,
          },
          {
            idx: 2,
            subject: 'RE: JP Organ — Introduction (Togan)',
            body: 'Hi Deniz, thanks for reaching out — happy to set up a call this week. — Togan',
            from: { name: 'Test User 3', email: 'test3@sqe.co.id', correspondentId: null },
            to: { name: 'Deniz Aydın', email: TOGAN_CONTACT_EMAIL, correspondentId: deniz.id },
            direction: 'outbound' as const,
            daysOffset: 2,
          },
        ];

          const tgEmailRows = tgMails.map((m) => ({
            message_id: `${TOGAN_MID_PREFIX}${m.idx}${TOGAN_MID_SUFFIX}`,
            custodian_email: 'test3@sqe.co.id',
            employer_id: toganIsolationEmployerId,
            from_address: m.from.email.toLowerCase(),
            from_display_name: m.from.name,
            sent_at: new Date(tgBase + m.daysOffset * dayMs).toISOString(),
            direction: m.direction,
            filter_status: 'processed',
            processed_at: new Date().toISOString(),
          }));
          const insertedTgEmails = await db
            .insert(emails)
            .values(tgEmailRows)
        .onConflictDoNothing()
            .returning({ id: emails.id, message_id: emails.message_id });
          const tgEmailIdByMid = new Map(insertedTgEmails.map((r) => [r.message_id!, r.id]));

          const tgParticipantRows: (typeof emailParticipants.$inferInsert)[] = [];
          for (const m of tgMails) {
            const mid = `${TOGAN_MID_PREFIX}${m.idx}${TOGAN_MID_SUFFIX}`;
            const emailId = tgEmailIdByMid.get(mid);
            if (!emailId) continue;
            tgParticipantRows.push({
              email_id: emailId,
              correspondent_id: m.from.correspondentId,
              address: m.from.email.toLowerCase(),
              display_name: m.from.name,
              role: 'from',
            });
            tgParticipantRows.push({
              email_id: emailId,
              correspondent_id: m.to.correspondentId,
              address: m.to.email.toLowerCase(),
              display_name: m.to.name,
              role: 'to',
            });
          }
          if (tgParticipantRows.length > 0) {
            await db.insert(emailParticipants).values(tgParticipantRows).onConflictDoNothing();
          }
          console.log(
            `  ✓ Funds & Investing isolation fixture: 1 private contact + 1 private note + 1 private topic + 1 private related-company + ${insertedTgEmails.length} emails (custodian: test3@sqe.co.id)`,
          );
      }
    }

    // ── Banker response-time distributions ───────────────────────────────────
    // Gives the banker firms that source deals a real spread of email response
    // times, so the Insights → "Banker source quality" table can show each
    // banker's response-time bell curve + p50 (matched to the firm by name).
    // Each firm gets several inbound emails, each answered by our earliest
    // outbound reply; the reply gaps are sampled around a per-firm centre so the
    // firm's own gaps form a mini distribution and its median (p50) sits near
    // that centre. Firm names mirror the `companies.banker` values above so the
    // dashboard can match them. Idempotent via a stable message_id prefix; the
    // employer is upserted by normalized_name (reusing the existing CRM firm
    // when one already exists — e.g. Golden Sacks — rather than duplicating it).
    // Bankers omitted here (e.g. Evercore) intentionally render "—".
    {
      const RT_MID_PREFIX = 'seed-rt-dist-';
      const RT_MID_SUFFIX = '@seed.local';
      const RT_CUSTODIAN = {
        name: 'Wendy Wobble',
        email: 'wendy.wobble@sparklecapital.example',
      };

      // Banker (matches companies.banker / banker_source) + the median hours we
      // take to reply. Centres are spread across the histogram bands so the
      // per-firm sparklines look distinct.
      const RT_FIRMS: Array<{ banker: string; centreHours: number }> = [
        { banker: 'Kitti', centreHours: 3 },
        { banker: 'Golden Sacks', centreHours: 6 },
        { banker: 'Organ Stanley', centreHours: 14 },
        { banker: 'UBSnacks', centreHours: 20 },
        { banker: 'JP Organ', centreHours: 30 },
        { banker: 'HSBQ', centreHours: 44 },
        { banker: 'Kittygroup', centreHours: 60 },
        { banker: 'Doodle Bank', centreHours: 90 },
      ];

      // Multipliers applied to each firm's centre — one inbound/reply pair each.
      // Symmetric-ish around 1.0 so the median ≈ the centre and the gaps span
      // ~3–4 adjacent (log-scaled) bands, giving a bell-ish per-firm shape.
      const RT_MULTIPLIERS = [0.3, 0.5, 0.7, 0.85, 1.0, 1.15, 1.4, 1.8, 2.4];

      const rtSlug = (name: string) =>
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Wipe prior fixture emails. Employers are upserted (never deleted) so
      // we don't drop a real CRM firm.
      await db.delete(emails).where(like(emails.message_id, `${RT_MID_PREFIX}%${RT_MID_SUFFIX}`));

      // Custodian mailbox synced to MNA — the workspace bridge for every inbound
      // email below (idempotent; AUTO VEHICLE also sets this up).
      const [rtCustodian] = await db
        .insert(users)
        .values({ name: RT_CUSTODIAN.name, email: RT_CUSTODIAN.email, password: passwordHash })
        .onConflictDoUpdate({ target: users.email, set: { name: RT_CUSTODIAN.name } })
        .returning({ id: users.id });
      if (rtCustodian) {
        await db
          .insert(userWorkspaces)
          .values({
            user_id: rtCustodian.id,
            workspace_id: MNA_WORKSPACE_ID,
            role_id: ROLE_EDITOR_ID,
            is_email_synced: true,
          })
          .onConflictDoUpdate({
            target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
            set: { is_email_synced: true },
          });
      }

      const rtDayMs = 24 * 60 * 60 * 1000;
      const rtBase = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).getTime();
      const nowIso = new Date().toISOString();

      const rtEmailRows: (typeof emails.$inferInsert)[] = [];
      // inbound message_id → firm correspondent, for participants after insert.
      const rtCorrByInMid = new Map<string, { corrId: string; email: string; name: string }>();

      for (let fi = 0; fi < RT_FIRMS.length; fi++) {
        const firm = RT_FIRMS[fi]!;
        const slug = rtSlug(firm.banker);
        const contactName = `${firm.banker} Coverage`;
        const contactEmail = `banker@${slug}.example`;

        // Reuse the existing CRM firm when one already carries this name;
        // otherwise create it. `normalized_name` is unique, so the upsert is
        // idempotent and never duplicates a firm across re-runs.
        const [rtEmployer] = await db
          .insert(employers)
          .values({ name: firm.banker, normalized_name: normalize(firm.banker), industry: 'Financial Services' })
          .onConflictDoUpdate({
            target: employers.normalized_name,
            set: { updated_at: nowIso },
          })
          .returning({ id: employers.id });
        if (!rtEmployer) continue;

        const [rtCorr] = await db
          .insert(correspondents)
          .values({
            employer_id: rtEmployer.id,
            name: contactName,
            email: contactEmail,
            title: 'Coverage Banker',
            type: 'external',
            is_primary: false,
            source: 'mbox',
          })
          .onConflictDoNothing()
          .returning({ id: correspondents.id });
        // On re-run the correspondent already exists (onConflictDoNothing → no
        // row returned); look it up so participants still link.
        const corrId =
          rtCorr?.id ??
          (
            await db
              .select({ id: correspondents.id })
              .from(correspondents)
              .where(eq(correspondents.email, contactEmail))
              .limit(1)
          )[0]?.id;
        if (!corrId) continue;
        await db
          .insert(workspaceCorrespondents)
          .values({ workspace_id: MNA_WORKSPACE_ID, correspondent_id: corrId, source: 'ingest' as const })
          .onConflictDoNothing();

        for (let pi = 0; pi < RT_MULTIPLIERS.length; pi++) {
          const gapHours = firm.centreHours * RT_MULTIPLIERS[pi]!;
          const inMid = `${RT_MID_PREFIX}${fi}-${pi}-in${RT_MID_SUFFIX}`;
          const outMid = `${RT_MID_PREFIX}${fi}-${pi}-out${RT_MID_SUFFIX}`;
          // Space inbound emails a day apart so they don't collide.
          const inSentAt = new Date(rtBase + (fi * RT_MULTIPLIERS.length + pi) * rtDayMs).toISOString();
          const outSentAt = new Date(
            new Date(inSentAt).getTime() + gapHours * 60 * 60 * 1000,
          ).toISOString();

          rtEmailRows.push({
            message_id: inMid,
            custodian_email: RT_CUSTODIAN.email,
            employer_id: rtEmployer.id,
            from_address: contactEmail,
            from_display_name: contactName,
            sent_at: inSentAt,
            direction: 'inbound',
            filter_status: 'processed',
            processed_at: nowIso,
          });
          rtEmailRows.push({
            message_id: outMid,
            custodian_email: RT_CUSTODIAN.email,
            in_reply_to: inMid,
            employer_id: rtEmployer.id,
            from_address: RT_CUSTODIAN.email,
            from_display_name: RT_CUSTODIAN.name,
            sent_at: outSentAt,
            direction: 'outbound',
            filter_status: 'processed',
            processed_at: nowIso,
          });
          rtCorrByInMid.set(inMid, { corrId, email: contactEmail, name: contactName });

        }
      }

      const rtInsertedEmails =
        rtEmailRows.length > 0
          ? await db
              .insert(emails)
              .values(rtEmailRows)
        .onConflictDoNothing()
              .returning({ id: emails.id, message_id: emails.message_id })
          : [];

      // Participants: the firm contact is the 'from' on each inbound email (this
      // is what ties email volume to the employer); the custodian is the 'to'.
      const rtParticipantRows: (typeof emailParticipants.$inferInsert)[] = [];
      for (const e of rtInsertedEmails) {
        const contact = e.message_id ? rtCorrByInMid.get(e.message_id) : undefined;
        if (!contact) continue; // outbound replies carry no firm participant
        rtParticipantRows.push(
          {
            email_id: e.id,
            correspondent_id: contact.corrId,
            address: contact.email.toLowerCase(),
            display_name: contact.name,
            role: 'from',
          },
          {
            email_id: e.id,
            correspondent_id: null,
            address: RT_CUSTODIAN.email.toLowerCase(),
            display_name: RT_CUSTODIAN.name,
            role: 'to',
          },
        );
      }
      if (rtParticipantRows.length > 0) {
        await db.insert(emailParticipants).values(rtParticipantRows).onConflictDoNothing();
      }

      console.log(
        `  ✓ Banker response times: ${RT_FIRMS.length} firms × ${RT_MULTIPLIERS.length} reply pairs (${rtInsertedEmails.length} emails, custodian: ${RT_CUSTODIAN.email})`,
      );
    }

    // Refresh the CRM marts so the seeded email activity is reflected in the
    // CRM cards' KPIs (email_count / last_contact / response p50), which read
    // from the precomputed analytics.mart_crm — otherwise only refreshed by the
    // ingest pipeline. (The Insights banker bell curve computes response times
    // live from analytics.emails and does not depend on this refresh.)
    // Best-effort: the analytics marts may be absent where the data-pipeline
    // migrations haven't run.
    try {
      await db.execute(sql`REFRESH MATERIALIZED VIEW analytics.mart_crm`);
      console.log('  ✓ refreshed analytics.mart_crm');
    } catch (err) {
      console.warn('  ⚠ skipped analytics.mart_crm refresh (marts unavailable):', err);
    }

    await seedRssFeeds(db as unknown as DbClient);
    await seedFundLedger(db as unknown as DbClient, MNA_WORKSPACE_ID);
    await seedFofPortfolio(db as unknown as DbClient, MNA_WORKSPACE_ID);
    await seedInsightTemplates(db as unknown as DbClient, MNA_WORKSPACE_ID);
    await seedInsights(db as unknown as DbClient, MNA_WORKSPACE_ID, seedUser.id);
    await seedBots(db as unknown as DbClient, MNA_WORKSPACE_ID, seedUser.id);

    console.log('done.');
  } finally {
    await client.end();
  }
}

// ============================================================================
// DEV ONLY — FULL RESET ESCAPE HATCH (DO NOT AUTOMATE OR EXECUTE IN SCRIPTS):
// The row-level trigger blocks DELETE on fl_ledger_entries, but TRUNCATE is permitted:
// TRUNCATE fl_ledger_entry_funding_allocations, fl_ledger_entries, fl_business_events, fl_positions, fl_valuations CASCADE;
// ============================================================================

export const SEED_FL_FUND_COMMITMENT_ID = '00000000-0000-0000-0000-00000000f101';
export const SEED_FL_FUND_UNITIZED_ID = '00000000-0000-0000-0000-00000000f102';
export const SEED_FL_FUND_EXTERNAL_ID = '00000000-0000-0000-0000-00000000f103';

export const SEED_FL_INVESTOR_1_ID = '00000000-0000-0000-0000-00000000f201';
export const SEED_FL_INVESTOR_2_ID = '00000000-0000-0000-0000-00000000f202';

export const SEED_FL_ASSET_EQUITY_ID = '00000000-0000-0000-0000-00000000f401';
export const SEED_FL_ASSET_LOAN_ID = '00000000-0000-0000-0000-00000000f402';

export const SEED_FL_FUNDING_SOURCE_1_ID = '00000000-0000-0000-0000-00000000f501';
export const SEED_FL_FUNDING_SOURCE_2_ID = '00000000-0000-0000-0000-00000000f502';

export const SEED_FL_POS_LP1_COMMIT_ID = '00000000-0000-0000-0000-00000000f601';
export const SEED_FL_POS_LP2_COMMIT_ID = '00000000-0000-0000-0000-00000000f602';
export const SEED_FL_POS_LP1_UNIT_ID = '00000000-0000-0000-0000-00000000f603';
export const SEED_FL_POS_FUND1_EXT_ID = '00000000-0000-0000-0000-00000000f604';
export const SEED_FL_POS_FUND1_EQUITY_ID = '00000000-0000-0000-0000-00000000f605';
export const SEED_FL_POS_FUND1_LOAN_ID = '00000000-0000-0000-0000-00000000f606';

export const SEED_FL_EVENT_1_ID = '00000000-0000-0000-0000-00000000f701';
export const SEED_FL_EVENT_2_ID = '00000000-0000-0000-0000-00000000f702';
export const SEED_FL_EVENT_3_ID = '00000000-0000-0000-0000-00000000f703';
export const SEED_FL_EVENT_4_ID = '00000000-0000-0000-0000-00000000f704';
export const SEED_FL_EVENT_5_ID = '00000000-0000-0000-0000-00000000f705';
export const SEED_FL_EVENT_6_ID = '00000000-0000-0000-0000-00000000f706';
export const SEED_FL_EVENT_7_REVERSAL_ID = '00000000-0000-0000-0000-00000000f707';

export const SEED_FL_VAL_ASSET_1_ID = '00000000-0000-0000-0000-00000000f801';
export const SEED_FL_VAL_ASSET_2_ID = '00000000-0000-0000-0000-00000000f802';
export const SEED_FL_VAL_ASSET_3_ID = '00000000-0000-0000-0000-00000000f803';
export const SEED_FL_VAL_FUND_1_ID = '00000000-0000-0000-0000-00000000f804';
export const SEED_FL_VAL_FUND_2_ID = '00000000-0000-0000-0000-00000000f805';
export const SEED_FL_VAL_POS_1_ID = '00000000-0000-0000-0000-00000000f806';
export const SEED_FL_VAL_POS_2_ID = '00000000-0000-0000-0000-00000000f807';

export async function seedFundLedger(db: DbClient, workspaceId: string): Promise<void> {
  const container = createContainer(db, workspaceId);

  await (db as any).transaction(async (tx: any) => {
    const txDb = tx as unknown as DbClient;

    // 1. Skip guard: check if the first deterministic event exists
    const existingEvent = await container.flLedgerService.getEventById(
      workspaceId,
      SEED_FL_EVENT_1_ID,
      txDb,
    );
    if (existingEvent) {
      console.log('  ✓ fund ledger fixtures already seeded — skipping');
      return;
    }

    // 2. Master roots: insert using onConflictDoNothing on deterministic IDs
    await tx
      .insert(flInvestors)
      .values([
        {
          id: SEED_FL_INVESTOR_1_ID,
          workspace_id: workspaceId,
          name: 'Acme Institutional Partners',
          canonical_name: normalizeCanonicalName('Acme Institutional Partners'),
          legal_name: 'Acme Institutional Partners LP',
          investor_type: 'institution',
          country: 'USA',
        },
        {
          id: SEED_FL_INVESTOR_2_ID,
          workspace_id: workspaceId,
          name: 'Jane Doe Family Office',
          canonical_name: normalizeCanonicalName('Jane Doe Family Office'),
          legal_name: 'Jane Doe Family Trust LLC',
          investor_type: 'individual',
          country: 'USA',
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(flFunds)
      .values([
        {
          id: SEED_FL_FUND_COMMITMENT_ID,
          workspace_id: workspaceId,
          name: 'Apex Ventures I',
          canonical_name: normalizeCanonicalName('Apex Ventures I'),
          legal_name: 'Apex Ventures Fund I LP',
          managed: true,
          ownership_basis: 'commitment',
          base_currency: 'USD',
          vintage_year: 2026,
          status: 'investing',
          mgmt_fee_rate: '0.02000000',
          carry_rate: '0.20000000',
        },
        {
          id: SEED_FL_FUND_UNITIZED_ID,
          workspace_id: workspaceId,
          name: 'Horizon Liquid Fund',
          canonical_name: normalizeCanonicalName('Horizon Liquid Fund'),
          legal_name: 'Horizon Liquid Fund Ltd',
          managed: true,
          ownership_basis: 'units',
          base_currency: 'USD',
          vintage_year: 2026,
          status: 'investing',
        },
        {
          id: SEED_FL_FUND_EXTERNAL_ID,
          workspace_id: workspaceId,
          name: 'Beacon Global Fund',
          canonical_name: normalizeCanonicalName('Beacon Global Fund'),
          legal_name: 'Beacon Global Fund LLC',
          managed: false,
          ownership_basis: 'capital_account',
          base_currency: 'USD',
          vintage_year: 2025,
          status: 'investing',
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(flAssets)
      .values([
        {
          id: SEED_FL_ASSET_EQUITY_ID,
          workspace_id: workspaceId,
          name: 'TechCorp Global Equity',
          canonical_name: normalizeCanonicalName('TechCorp Global Equity'),
          legal_name: 'TechCorp Global Inc.',
          asset_kind: 'equity',
          country: 'USA',
          sector: 'Technology',
        },
        {
          id: SEED_FL_ASSET_LOAN_ID,
          workspace_id: workspaceId,
          name: 'FinTech Senior Secured Loan',
          canonical_name: normalizeCanonicalName('FinTech Senior Secured Loan'),
          legal_name: 'FinTech Growth Note Facility',
          asset_kind: 'loan',
          country: 'USA',
          sector: 'Financials',
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(flFundingSources)
      .values([
        {
          id: SEED_FL_FUNDING_SOURCE_1_ID,
          workspace_id: workspaceId,
          name: 'Apex Capital Pool Primary',
          canonical_name: normalizeCanonicalName('Apex Capital Pool Primary'),
          source_type: 'bank_account',
          currency: 'USD',
        },
        {
          id: SEED_FL_FUNDING_SOURCE_2_ID,
          workspace_id: workspaceId,
          name: 'Apex Credit Facility',
          canonical_name: normalizeCanonicalName('Apex Credit Facility'),
          source_type: 'credit_line',
          currency: 'USD',
        },
      ])
      .onConflictDoNothing();

    // Investment types for the "by investment type" asset grouping.
    await tx
      .insert(flInvestmentTypes)
      .values(
        DEFAULT_INVESTMENT_TYPES.map((name, sort_order) => ({
          workspace_id: workspaceId,
          name,
          sort_order,
        })),
      )
      .onConflictDoNothing();

    // 3. Positions: open via FlPositionService (all with deterministic IDs and txDb executor)
    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_POS_LP1_COMMIT_ID,
        holder_investor_id: SEED_FL_INVESTOR_1_ID,
        fund_id: SEED_FL_FUND_COMMITMENT_ID,
        opened_at: '2026-01-01',
      },
      txDb,
    );

    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_POS_LP2_COMMIT_ID,
        holder_investor_id: SEED_FL_INVESTOR_2_ID,
        fund_id: SEED_FL_FUND_COMMITMENT_ID,
        opened_at: '2026-01-01',
      },
      txDb,
    );

    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_POS_LP1_UNIT_ID,
        holder_investor_id: SEED_FL_INVESTOR_1_ID,
        fund_id: SEED_FL_FUND_UNITIZED_ID,
        opened_at: '2026-01-01',
      },
      txDb,
    );

    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_POS_FUND1_EXT_ID,
        holder_fund_id: SEED_FL_FUND_COMMITMENT_ID,
        fund_id: SEED_FL_FUND_EXTERNAL_ID,
        opened_at: '2026-01-01',
      },
      txDb,
    );

    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_POS_FUND1_EQUITY_ID,
        holder_fund_id: SEED_FL_FUND_COMMITMENT_ID,
        asset_id: SEED_FL_ASSET_EQUITY_ID,
        opened_at: '2026-01-01',
      },
      txDb,
    );

    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_POS_FUND1_LOAN_ID,
        holder_fund_id: SEED_FL_FUND_COMMITMENT_ID,
        asset_id: SEED_FL_ASSET_LOAN_ID,
        opened_at: '2026-01-01',
      },
      txDb,
    );

    // 4. Ledger Events via FlLedgerService.postEvent (never raw insert)
    // Event 1: Initial Commitments to Apex Ventures I
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_EVENT_1_ID,
        event_date: '2026-01-15',
        description: 'Initial LP commitments to Apex Ventures I',
        entries: [
          {
            position_id: SEED_FL_POS_LP1_COMMIT_ID,
            entry_type: 'commitment',
            commitment_delta: '10000000.00000000',
            currency: 'USD',
          },
          {
            position_id: SEED_FL_POS_LP2_COMMIT_ID,
            entry_type: 'commitment',
            commitment_delta: '5000000.00000000',
            currency: 'USD',
          },
        ],
      },
      txDb,
    );

    // Event 2: Capital Call #1 (Paid-ins with funding allocations)
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_EVENT_2_ID,
        event_date: '2026-02-01',
        description: 'Capital Call #1 contribution',
        entries: [
          {
            position_id: SEED_FL_POS_LP1_COMMIT_ID,
            entry_type: 'paid_in',
            cash_delta: '-5000000.00000000',
            currency: 'USD',
            allocations: [
              {
                funding_source_id: SEED_FL_FUNDING_SOURCE_1_ID,
                amount: '5000000.00000000',
              },
            ],
          },
          {
            position_id: SEED_FL_POS_LP2_COMMIT_ID,
            entry_type: 'paid_in',
            cash_delta: '-2500000.00000000',
            currency: 'USD',
            allocations: [
              {
                funding_source_id: SEED_FL_FUNDING_SOURCE_1_ID,
                amount: '2500000.00000000',
              },
            ],
          },
        ],
      },
      txDb,
    );

    // Event 3: Buy with two-source allocation split
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_EVENT_3_ID,
        event_date: '2026-03-01',
        description:
          'Investment in TechCorp Global Series B',
        entries: [
          {
            position_id: SEED_FL_POS_FUND1_EQUITY_ID,
            entry_type: 'buy',
            quantity_delta: '40000.00000000',
            cash_delta: '-4000000.00000000',
            price_per_unit: '100.00000000',
            currency: 'USD',
            allocations: [
              {
                funding_source_id: SEED_FL_FUNDING_SOURCE_1_ID,
                amount: '2500000.00000000',
              },
              {
                funding_source_id: SEED_FL_FUNDING_SOURCE_2_ID,
                amount: '1500000.00000000',
              },
            ],
          },
        ],
      },
      txDb,
    );

    // Event 4: Distribution to LP 1 & 2
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_EVENT_4_ID,
        event_date: '2026-06-01',
        description: 'Q2 Dividend Distribution',
        entries: [
          {
            position_id: SEED_FL_POS_LP1_COMMIT_ID,
            entry_type: 'distribution',
            cash_delta: '500000.00000000',
            currency: 'USD',
          },
          {
            position_id: SEED_FL_POS_LP2_COMMIT_ID,
            entry_type: 'distribution',
            cash_delta: '250000.00000000',
            currency: 'USD',
          },
        ],
      },
      txDb,
    );

    // Event 5: Secondary commitment transfer ($1M from LP1 to LP2)
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_EVENT_5_ID,
        event_date: '2026-07-01',
        description:
          'Secondary transfer of $1M commitment from Acme to Jane Doe FO',
        entries: [
          {
            position_id: SEED_FL_POS_LP1_COMMIT_ID,
            counterparty_position_id: SEED_FL_POS_LP2_COMMIT_ID,
            entry_type: 'commitment_transfer',
            commitment_delta: '-1000000.00000000',
            currency: 'USD',
          },
          {
            position_id: SEED_FL_POS_LP2_COMMIT_ID,
            counterparty_position_id: SEED_FL_POS_LP1_COMMIT_ID,
            entry_type: 'commitment_transfer',
            commitment_delta: '1000000.00000000',
            currency: 'USD',
          },
        ],
      },
      txDb,
    );

    // Event 6: Capital Call deposit to be reversed
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_EVENT_6_ID,
        event_date: '2026-08-01',
        description: 'Erroneous capital call contribution',
        entries: [
          {
            position_id: SEED_FL_POS_LP2_COMMIT_ID,
            entry_type: 'paid_in',
            cash_delta: '-100000.00000000',
            currency: 'USD',
            allocations: [
              {
                funding_source_id: SEED_FL_FUNDING_SOURCE_1_ID,
                amount: '100000.00000000',
              },
            ],
          },
        ],
      },
      txDb,
    );

    // Event 7: Reversal of Event 6
    await container.flLedgerService.reverseEvent(
      workspaceId,
      SEED_FL_EVENT_6_ID,
      {
        business_event_id: SEED_FL_EVENT_7_REVERSAL_ID,
        event_date: '2026-08-05',
        description: 'Reversal of erroneous capital call contribution',
      },
      txDb,
    );

    // 5. Valuations (2-3 per target kind) via FlValuationService.record
    // Asset Valuations
    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_ASSET_1_ID,
        asset_id: SEED_FL_ASSET_EQUITY_ID,
        as_of_date: '2026-03-01',
        valuation_method: 'at_cost',
        price_per_unit: '100.00000000',
        market_value: '4000000.00000000',
      },
      txDb,
    );

    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_ASSET_2_ID,
        asset_id: SEED_FL_ASSET_EQUITY_ID,
        as_of_date: '2026-06-30',
        valuation_method: 'fundraise_round',
        price_per_unit: '125.00000000',
        market_value: '5000000.00000000',
      },
      txDb,
    );

    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_ASSET_3_ID,
        asset_id: SEED_FL_ASSET_LOAN_ID,
        as_of_date: '2026-06-30',
        valuation_method: 'at_cost',
        market_value: '2000000.00000000',
      },
      txDb,
    );

    // Fund Valuations
    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_FUND_1_ID,
        fund_id: SEED_FL_FUND_COMMITMENT_ID,
        as_of_date: '2026-03-31',
        valuation_method: 'appraisal',
        net_value: '7500000.00000000',
      },
      txDb,
    );

    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_FUND_2_ID,
        fund_id: SEED_FL_FUND_COMMITMENT_ID,
        as_of_date: '2026-06-30',
        valuation_method: 'capital_account_statement',
        net_value: '8250000.00000000',
      },
      txDb,
    );

    // Position Valuations (CAS)
    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_POS_1_ID,
        position_id: SEED_FL_POS_LP1_COMMIT_ID,
        as_of_date: '2026-06-30',
        valuation_method: 'capital_account_statement',
        net_value: '5500000.00000000',
      },
      txDb,
    );

    await container.flValuationService.record(
      workspaceId,
      {
        id: SEED_FL_VAL_POS_2_ID,
        position_id: SEED_FL_POS_LP2_COMMIT_ID,
        as_of_date: '2026-06-30',
        valuation_method: 'capital_account_statement',
        net_value: '2750000.00000000',
      },
      txDb,
    );

    console.log('  ✓ Fund Ledger v2 fixtures seeded successfully');
  });
}

// ---------------------------------------------------------------------------
// Fund-of-funds portfolio for the Fund Management "Present" report: a managed
// fund holding 34 fund interests across every default investment type, each
// with capital calls, distributions and two quarterly marks, so the report has
// realistic commitment / MOIC / IRR / DPI figures in every section.
// ---------------------------------------------------------------------------

export const SEED_FL_FOF_FUND_ID = '00000000-0000-0000-0001-00000000f001';
export const SEED_FL_FOF_LP_POS_ID = '00000000-0000-0000-0001-00000000f002';
export const SEED_FL_FOF_LP_EVENT_ID = '00000000-0000-0000-0001-00000000f003';

/** Deterministic id `00000000-0000-0000-00<kind>-<n>` for the FoF seed rows. */
function fofSeedId(kind: number, n: number): string {
  return `00000000-0000-0000-00${kind.toString(16).padStart(2, '0')}-${n.toString(16).padStart(12, '0')}`;
}

interface FofSeedInterest {
  name: string;
  type: (typeof DEFAULT_INVESTMENT_TYPES)[number];
  entryDate: string;
  fundLifeYears: number;
  /** Amounts in USD millions. */
  commitment: number;
  invested: number;
  distributed: number;
  marketValue: number;
}

/** Fictional fund interests. Realized funds are fully distributed and marked at zero. */
export const SEED_FOF_INTERESTS: FofSeedInterest[] = [
  // Realized Funds
  { name: 'Ideo Harbor Fund I', type: 'Realized Funds', entryDate: '2017-12-15', fundLifeYears: 4, commitment: 2.0, invested: 2.0, distributed: 2.4, marketValue: 0 },
  { name: 'Lumen Growth Partners I', type: 'Realized Funds', entryDate: '2015-06-01', fundLifeYears: 7, commitment: 3.0, invested: 3.0, distributed: 4.6, marketValue: 0 },
  { name: 'Cobalt Seed Fund I', type: 'Realized Funds', entryDate: '2014-03-10', fundLifeYears: 8, commitment: 1.5, invested: 1.5, distributed: 1.1, marketValue: 0 },
  { name: 'Northwind Opportunities I', type: 'Realized Funds', entryDate: '2016-09-01', fundLifeYears: 6, commitment: 2.5, invested: 2.5, distributed: 3.9, marketValue: 0 },
  // Venture Capital
  { name: 'Alpha Orchard Fund I', type: 'Venture Capital', entryDate: '2016-05-02', fundLifeYears: 12, commitment: 5.0, invested: 5.0, distributed: 2.3, marketValue: 13.8 },
  { name: 'Alpha Orchard Fund II', type: 'Venture Capital', entryDate: '2018-08-01', fundLifeYears: 10, commitment: 5.0, invested: 4.9, distributed: 1.6, marketValue: 12.0 },
  { name: 'Nusantara Digital Fund II', type: 'Venture Capital', entryDate: '2019-07-01', fundLifeYears: 10, commitment: 4.0, invested: 3.8, distributed: 1.0, marketValue: 5.6 },
  { name: 'Archipelago Tech Fund I', type: 'Venture Capital', entryDate: '2021-08-02', fundLifeYears: 8, commitment: 3.4, invested: 1.7, distributed: 0, marketValue: 1.2 },
  { name: 'Archipelago Tech Fund II', type: 'Venture Capital', entryDate: '2021-08-16', fundLifeYears: 10, commitment: 2.0, invested: 1.7, distributed: 0, marketValue: 1.2 },
  { name: 'Alpha Orchard Fund III', type: 'Venture Capital', entryDate: '2021-09-01', fundLifeYears: 10, commitment: 5.0, invested: 4.6, distributed: 0, marketValue: 4.1 },
  { name: 'Kestrel Fund I', type: 'Venture Capital', entryDate: '2021-12-01', fundLifeYears: 10, commitment: 2.0, invested: 2.0, distributed: 0, marketValue: 3.3 },
  { name: 'Banyan Ventures Fund II', type: 'Venture Capital', entryDate: '2022-09-01', fundLifeYears: 10, commitment: 2.0, invested: 1.4, distributed: 0, marketValue: 1.6 },
  { name: 'Monsoon Ventures Fund V', type: 'Venture Capital', entryDate: '2022-11-01', fundLifeYears: 10, commitment: 2.0, invested: 1.0, distributed: 0, marketValue: 1.2 },
  { name: 'Ledgerline Fintech Fund', type: 'Venture Capital', entryDate: '2023-12-01', fundLifeYears: 10, commitment: 5.0, invested: 3.0, distributed: 0, marketValue: 3.0 },
  { name: 'Tidewater Climate Fund I', type: 'Venture Capital', entryDate: '2024-03-01', fundLifeYears: 10, commitment: 3.0, invested: 1.2, distributed: 0, marketValue: 1.1 },
  { name: 'Fortress Bay Seed Fund', type: 'Venture Capital', entryDate: '2025-04-01', fundLifeYears: 10, commitment: 1.0, invested: 0.4, distributed: 0, marketValue: 0.5 },
  // Private Equity
  { name: 'Harbor Point Consumer Fund', type: 'Private Equity', entryDate: '2018-04-02', fundLifeYears: 10, commitment: 2.5, invested: 2.5, distributed: 1.9, marketValue: 1.8 },
  { name: 'Granite Peak Capital III', type: 'Private Equity', entryDate: '2019-02-01', fundLifeYears: 10, commitment: 6.0, invested: 5.6, distributed: 2.1, marketValue: 6.4 },
  { name: 'Equator Mid-Market Fund II', type: 'Private Equity', entryDate: '2020-10-01', fundLifeYears: 10, commitment: 4.0, invested: 3.2, distributed: 0.8, marketValue: 3.6 },
  { name: 'Sylvanus Buyout Fund', type: 'Private Equity', entryDate: '2021-08-02', fundLifeYears: 10, commitment: 5.0, invested: 4.5, distributed: 0, marketValue: 5.7 },
  { name: 'Cedar Ridge Growth Equity', type: 'Private Equity', entryDate: '2023-05-02', fundLifeYears: 10, commitment: 3.0, invested: 1.5, distributed: 0, marketValue: 1.7 },
  // Private Credit
  { name: 'Indus Special Opportunity II', type: 'Private Credit', entryDate: '2018-05-02', fundLifeYears: 13, commitment: 5.0, invested: 4.4, distributed: 5.1, marketValue: 1.2 },
  { name: 'Meranti Senior Debt Fund', type: 'Private Credit', entryDate: '2020-06-01', fundLifeYears: 7, commitment: 3.0, invested: 2.8, distributed: 1.4, marketValue: 1.9 },
  { name: 'Keystone Venture Debt I', type: 'Private Credit', entryDate: '2022-02-01', fundLifeYears: 6, commitment: 2.0, invested: 1.6, distributed: 0.5, marketValue: 1.3 },
  { name: 'Pinnacle Asia Credit Fund', type: 'Private Credit', entryDate: '2024-01-02', fundLifeYears: 6, commitment: 4.0, invested: 2.2, distributed: 0.3, marketValue: 2.1 },
  // Others
  { name: 'Orchid Real Estate Fund', type: 'Others', entryDate: '2019-11-01', fundLifeYears: 8, commitment: 1.5, invested: 1.5, distributed: 0.6, marketValue: 1.2 },
  { name: 'Jarvis Fund I', type: 'Others', entryDate: '2021-08-02', fundLifeYears: 10, commitment: 0.7, invested: 0.7, distributed: 0, marketValue: 0.6 },
  { name: 'Jarvis Fund II', type: 'Others', entryDate: '2021-08-16', fundLifeYears: 10, commitment: 1.1, invested: 1.1, distributed: 0.9, marketValue: 0.05 },
  { name: 'Gan Samudra Infrastructure', type: 'Others', entryDate: '2021-09-01', fundLifeYears: 10, commitment: 0.4, invested: 0.4, distributed: 0, marketValue: 0.3 },
  { name: 'Coral Reef Secondaries', type: 'Others', entryDate: '2023-03-01', fundLifeYears: 8, commitment: 1.2, invested: 0.9, distributed: 0.2, marketValue: 0.9 },
  // Realized and Partially Realized
  { name: 'Bluewater Partners IV', type: 'Realized and Partially Realized', entryDate: '2016-02-01', fundLifeYears: 10, commitment: 2.0, invested: 2.0, distributed: 1.8, marketValue: 0.9 },
  { name: 'Silverline Growth Fund II', type: 'Realized and Partially Realized', entryDate: '2017-03-01', fundLifeYears: 10, commitment: 3.0, invested: 3.0, distributed: 3.4, marketValue: 1.5 },
  // Unrealized
  { name: 'Horizon Frontier Fund I', type: 'Unrealized', entryDate: '2025-01-15', fundLifeYears: 10, commitment: 2.0, invested: 0.6, distributed: 0, marketValue: 0.6 },
  { name: 'Quantum Seed Fund', type: 'Unrealized', entryDate: '2025-06-02', fundLifeYears: 10, commitment: 1.0, invested: 0.3, distributed: 0, marketValue: 0.3 },
];

/** Last date a seeded call or distribution may fall on (before the Q2'26 mark). */
const FOF_SEED_LAST_FLOW_DATE = '2026-06-15';

function addYearsIso(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

const minIso = (a: string, b: string) => (a < b ? a : b);

/** USD millions → ledger decimal string. */
const fofUsd = (m: number) => Math.round(m * 1_000_000).toFixed(8);

export async function seedFofPortfolio(db: DbClient, workspaceId: string): Promise<void> {
  const container = createContainer(db, workspaceId);

  await (db as any).transaction(async (tx: any) => {
    const txDb = tx as unknown as DbClient;

    const existing = await container.flLedgerService.getEventById(
      workspaceId,
      SEED_FL_FOF_LP_EVENT_ID,
      txDb,
    );
    if (existing) {
      console.log('  ✓ fund-of-funds portfolio already seeded — skipping');
      return;
    }

    await tx
      .insert(flInvestmentTypes)
      .values(
        DEFAULT_INVESTMENT_TYPES.map((name, sort_order) => ({
          workspace_id: workspaceId,
          name,
          sort_order,
        })),
      )
      .onConflictDoNothing();
    const typeRows: { id: string; name: string }[] = await tx
      .select({ id: flInvestmentTypes.id, name: flInvestmentTypes.name })
      .from(flInvestmentTypes)
      .where(eq(flInvestmentTypes.workspace_id, workspaceId));
    const typeIdByName = new Map(typeRows.map((t) => [t.name.toLowerCase(), t.id]));

    await tx
      .insert(flFunds)
      .values({
        id: SEED_FL_FOF_FUND_ID,
        workspace_id: workspaceId,
        name: 'Meridian Fund of Funds',
        canonical_name: normalizeCanonicalName('Meridian Fund of Funds'),
        legal_name: 'Meridian Fund of Funds LP',
        managed: true,
        ownership_basis: 'commitment',
        base_currency: 'USD',
        vintage_year: 2014,
        status: 'investing',
      })
      .onConflictDoNothing();

    // The LP side: one anchor LP commits and pays in enough to fund every call,
    // so the fund's cash never goes negative.
    const totalCommitment = SEED_FOF_INTERESTS.reduce((sum, a) => sum + a.commitment, 0);
    const totalInvested = SEED_FOF_INTERESTS.reduce((sum, a) => sum + a.invested, 0);
    await container.flPositionService.getOrOpenPosition(
      workspaceId,
      {
        id: SEED_FL_FOF_LP_POS_ID,
        holder_investor_id: SEED_FL_INVESTOR_1_ID,
        fund_id: SEED_FL_FOF_FUND_ID,
        opened_at: '2014-01-02',
      },
      txDb,
    );
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: SEED_FL_FOF_LP_EVENT_ID,
        event_date: '2014-01-02',
        description: 'Anchor LP commitment to Meridian Fund of Funds',
        entries: [
          {
            position_id: SEED_FL_FOF_LP_POS_ID,
            entry_type: 'commitment',
            commitment_delta: fofUsd(totalCommitment),
            currency: 'USD',
          },
        ],
      },
      txDb,
    );
    await container.flLedgerService.postEvent(
      workspaceId,
      {
        business_event_id: fofSeedId(1, 0xf004),
        event_date: '2014-01-03',
        description: 'Anchor LP paid-in capital',
        entries: [
          {
            position_id: SEED_FL_FOF_LP_POS_ID,
            entry_type: 'paid_in',
            cash_delta: `-${fofUsd(totalInvested)}`,
            currency: 'USD',
          },
        ],
      },
      txDb,
    );

    for (const [i, a] of SEED_FOF_INTERESTS.entries()) {
      const n = i + 1;
      const assetId = fofSeedId(2, n);
      const positionId = fofSeedId(3, n);

      await tx
        .insert(flAssets)
        .values({
          id: assetId,
          workspace_id: workspaceId,
          name: a.name,
          canonical_name: normalizeCanonicalName(a.name),
          legal_name: `${a.name} LP`,
          asset_kind: 'equity',
          country: 'Indonesia',
          investment_type_id: typeIdByName.get(a.type.toLowerCase()) ?? null,
          instrument_terms: {
            investmentTypeLabel: 'Fund of funds',
            commitmentAmount: fofUsd(a.commitment),
            fundLifeYears: a.fundLifeYears,
            entryDate: a.entryDate,
            currency: 'USD',
          },
        })
        .onConflictDoNothing();

      await container.flPositionService.getOrOpenPosition(
        workspaceId,
        {
          id: positionId,
          holder_fund_id: SEED_FL_FOF_FUND_ID,
          asset_id: assetId,
          opened_at: a.entryDate,
        },
        txDb,
      );

      // Capital calls: 60% at entry, the rest a year later (capped).
      const secondCallDate = minIso(addYearsIso(a.entryDate, 1), FOF_SEED_LAST_FLOW_DATE);
      const firstCall = Math.round(a.invested * 0.6 * 100) / 100;
      const calls: [string, number][] =
        a.invested <= 0
          ? []
          : secondCallDate > a.entryDate && a.invested - firstCall > 0
            ? [[a.entryDate, firstCall], [secondCallDate, a.invested - firstCall]]
            : [[a.entryDate, a.invested]];

      // Distributions: half three years in, the rest five years in (capped).
      const lastCallDate = calls.length ? calls[calls.length - 1][0] : a.entryDate;
      const firstDistDate = minIso(addYearsIso(a.entryDate, 3), FOF_SEED_LAST_FLOW_DATE);
      const secondDistDate = minIso(addYearsIso(a.entryDate, 5), FOF_SEED_LAST_FLOW_DATE);
      const halfDist = Math.round(a.distributed * 0.5 * 100) / 100;
      const distributions: [string, number][] =
        a.distributed <= 0 || firstDistDate <= lastCallDate
          ? []
          : secondDistDate > firstDistDate
            ? [[firstDistDate, halfDist], [secondDistDate, a.distributed - halfDist]]
            : [[firstDistDate, a.distributed]];

      const flows = [
        ...calls.map(([date, m]) => ({ date, entry_type: 'paid_in' as const, cash_delta: `-${fofUsd(m)}` })),
        ...distributions.map(([date, m]) => ({ date, entry_type: 'distribution' as const, cash_delta: fofUsd(m) })),
      ];
      for (const [j, flow] of flows.entries()) {
        await container.flLedgerService.postEvent(
          workspaceId,
          {
            business_event_id: fofSeedId(4, n * 16 + j),
            event_date: flow.date,
            description: `${a.name} — ${flow.entry_type === 'paid_in' ? 'capital call' : 'distribution'}`,
            entries: [
              {
                position_id: positionId,
                entry_type: flow.entry_type,
                cash_delta: flow.cash_delta,
                currency: 'USD',
              },
            ],
          },
          txDb,
        );
      }

      // Two quarterly marks so the asset shows a trend; the latest is the report's FMV.
      const marks: [string, number][] = [
        ['2026-03-31', Math.round(a.marketValue * 0.96 * 100) / 100],
        ['2026-06-30', a.marketValue],
      ];
      for (const [j, [asOf, mv]] of marks.entries()) {
        await container.flValuationService.record(
          workspaceId,
          {
            id: fofSeedId(5, n * 16 + j),
            asset_id: assetId,
            as_of_date: asOf,
            valuation_method: 'capital_account_statement',
            market_value: fofUsd(mv),
          },
          txDb,
        );
      }
    }

    console.log(`  ✓ seeded ${SEED_FOF_INTERESTS.length} fund-of-funds interests`);
  });
}

/**
 * Shared "paper" stylesheet for the seed insight templates below — a fixed
 * light card regardless of app theme (like a document preview), so the
 * hover-preview thumbnail always reads cleanly.
 */
const SEED_TEMPLATE_STYLE = `
  :root{--ink:#0f172a;--sub:#475569;--line:#e2e8f0;--accent:#2563eb;--bg:#f8fafc;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;}
  .doc{max-width:840px;margin:0 auto;padding:40px 48px;background:#fff;min-height:100vh;}
  .doc h1{font-size:26px;margin:0 0 4px;}
  .doc .meta{color:var(--sub);font-size:13px;margin-bottom:8px;}
  .doc h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);
    border-bottom:2px solid var(--accent);padding-bottom:6px;margin:32px 0 14px;}
  .doc h2:first-of-type{margin-top:28px;}
  .doc p{line-height:1.6;}
  .doc table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 4px;}
  .doc th{text-align:left;color:var(--sub);font-weight:600;border-bottom:1px solid var(--line);padding:8px 10px;}
  .doc td{padding:8px 10px;border-bottom:1px solid var(--line);}
  .doc ul{margin:6px 0;padding-left:20px;line-height:1.6;}
  .doc .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;}
  .tag-high{background:#fee2e2;color:#b91c1c;}
  .tag-medium{background:#fef3c7;color:#92400e;}
  .tag-low{background:#dcfce7;color:#166534;}
`;

/** Wraps a template's title/meta/body into a self-contained styled document. */
function seedTemplateDoc(title: string, meta: string, bodyHtml: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<title>${title}</title><style>${SEED_TEMPLATE_STYLE}</style></head>` +
    `<body><div class="doc"><h1>${title}</h1><div class="meta">${meta}</div>${bodyHtml}</div></body></html>`
  );
}

const SEED_TEMPLATE_PLACEHOLDERS: Record<string, string> = {
  '00000000-0000-0000-0000-00000000e001': seedTemplateDoc(
    'Market Brief',
    'Sector: Enterprise Software &middot; Region: Southeast Asia &middot; Prepared for internal review',
    `
    <section data-section="summary">
      <h2>Executive Summary</h2>
      <p>The sector continues to see active competitive tension, with three parties currently engaged across
      overlapping stages of diligence. Valuation benchmarks below suggest the market is pricing quality assets
      at a premium to the trailing five-year median.</p>
    </section>
    <section data-section="landscape">
      <h2>Deal Landscape &amp; Active Bidders</h2>
      <table>
        <tr><th>Bidder</th><th>Type</th><th>Stage</th><th>Indicative Offer</th></tr>
        <tr><td>Bidder A</td><td>Strategic</td><td>Exclusivity</td><td>$180&ndash;210M</td></tr>
        <tr><td>Bidder B</td><td>Financial Sponsor</td><td>First Round</td><td>$150&ndash;170M</td></tr>
        <tr><td>Bidder C</td><td>Strategic</td><td>Diligence</td><td>$195&ndash;220M</td></tr>
      </table>
    </section>
    <section data-section="valuation">
      <h2>Valuation Benchmarks</h2>
      <table>
        <tr><th>Comparable</th><th>EV / EBITDA</th><th>EV / Revenue</th></tr>
        <tr><td>Comparable 1</td><td>11.2x</td><td>3.4x</td></tr>
        <tr><td>Comparable 2</td><td>9.8x</td><td>2.9x</td></tr>
        <tr><td>Comparable 3</td><td>12.6x</td><td>3.8x</td></tr>
        <tr><td><strong>Sector Median</strong></td><td><strong>11.0x</strong></td><td><strong>3.3x</strong></td></tr>
      </table>
    </section>
    <section data-section="considerations">
      <h2>Key Considerations</h2>
      <ul>
        <li>Confirm whether any bidder holds a financing contingency that could slow signing.</li>
        <li>Cross-check management's growth case against the comparable set's realised multiples.</li>
        <li>Flag any regulatory approval that could extend timeline beyond the current process window.</li>
      </ul>
    </section>`,
  ),
  '00000000-0000-0000-0000-00000000e002': seedTemplateDoc(
    'Investment Memo',
    'Target: [Company Name] &middot; Stage: IC Review &middot; Analyst: [Name]',
    `
    <section data-section="thesis">
      <h2>Investment Thesis</h2>
      <p>[Company Name] is a category leader in its niche with durable unit economics and a clear path to
      margin expansion. The thesis rests on continued net revenue retention above 110% and a still-fragmented
      addressable market.</p>
    </section>
    <section data-section="overview">
      <h2>Company Overview</h2>
      <table>
        <tr><th>Founded</th><th>HQ</th><th>Employees</th><th>Revenue Model</th></tr>
        <tr><td>[Year]</td><td>[City, Country]</td><td>[Headcount]</td><td>Subscription / SaaS</td></tr>
      </table>
    </section>
    <section data-section="financials">
      <h2>Financial Review</h2>
      <table>
        <tr><th>Metric</th><th>FY24</th><th>FY25E</th><th>FY26E</th></tr>
        <tr><td>Revenue</td><td>$[X]M</td><td>$[X]M</td><td>$[X]M</td></tr>
        <tr><td>EBITDA</td><td>$[X]M</td><td>$[X]M</td><td>$[X]M</td></tr>
        <tr><td>EBITDA Margin</td><td>[X]%</td><td>[X]%</td><td>[X]%</td></tr>
        <tr><td>Net Debt / EBITDA</td><td>[X]x</td><td>[X]x</td><td>[X]x</td></tr>
      </table>
    </section>
    <section data-section="risks">
      <h2>Risk Matrix</h2>
      <table>
        <tr><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Mitigation</th></tr>
        <tr><td>Customer concentration</td><td><span class="tag tag-medium">Medium</span></td><td><span class="tag tag-high">High</span></td><td>Diversify top-10 accounts over 24 months</td></tr>
        <tr><td>Key-person dependency</td><td><span class="tag tag-low">Low</span></td><td><span class="tag tag-medium">Medium</span></td><td>Retention package + succession plan</td></tr>
        <tr><td>Competitive entry</td><td><span class="tag tag-medium">Medium</span></td><td><span class="tag tag-medium">Medium</span></td><td>Accelerate product roadmap in core segment</td></tr>
      </table>
    </section>
    <section data-section="recommendation">
      <h2>Recommendation</h2>
      <p><span class="tag tag-low">Recommendation: Proceed to IC</span></p>
      <p>Subject to confirmatory diligence on customer concentration and a final quality-of-earnings review.</p>
    </section>`,
  ),
  '00000000-0000-0000-0000-00000000e003': seedTemplateDoc(
    'Portfolio Exposure Review',
    'As of [Quarter] &middot; Fund: [Fund Name] &middot; NAV: $[X]M',
    `
    <section data-section="summary">
      <h2>Executive Summary</h2>
      <p>Portfolio concentration remains within policy limits, though two sectors are approaching their
      internal caps. Geographic exposure is broadly diversified, with no single region above 40% of NAV.</p>
    </section>
    <section data-section="sector">
      <h2>Sector Concentration</h2>
      <table>
        <tr><th>Sector</th><th>% of NAV</th><th>Positions</th></tr>
        <tr><td>Sector Alpha</td><td>28%</td><td>4</td></tr>
        <tr><td>Sector Beta</td><td>22%</td><td>3</td></tr>
        <tr><td>Sector Gamma</td><td>18%</td><td>5</td></tr>
        <tr><td>Other</td><td>32%</td><td>9</td></tr>
      </table>
    </section>
    <section data-section="geography">
      <h2>Geographic Exposure</h2>
      <table>
        <tr><th>Region</th><th>% of NAV</th></tr>
        <tr><td>Southeast Asia</td><td>38%</td></tr>
        <tr><td>Greater China</td><td>26%</td></tr>
        <tr><td>South Asia</td><td>19%</td></tr>
        <tr><td>Other</td><td>17%</td></tr>
      </table>
    </section>
    <section data-section="flags">
      <h2>Flagged Risks</h2>
      <ul>
        <li><span class="tag tag-high">High</span> Sector Alpha is 2pp from its internal concentration cap.</li>
        <li><span class="tag tag-medium">Medium</span> One position accounts for &gt;8% of NAV on a standalone basis.</li>
        <li><span class="tag tag-low">Low</span> FX exposure to a single currency has drifted up but remains hedged.</li>
      </ul>
    </section>`,
  ),
  '00000000-0000-0000-0000-00000000e004': seedTemplateDoc(
    'Regulatory Watch',
    'Coverage Period: [Date Range] &middot; Jurisdictions: Multiple',
    `
    <section data-section="summary">
      <h2>Executive Summary</h2>
      <p>No new merger-control filings were required this period. One existing antitrust review remains open
      and is tracking to its original timeline.</p>
    </section>
    <section data-section="matters">
      <h2>Active Matters</h2>
      <table>
        <tr><th>Jurisdiction</th><th>Matter</th><th>Status</th><th>Next Milestone</th></tr>
        <tr><td>[Jurisdiction A]</td><td>Merger clearance review</td><td>Phase 1</td><td>Decision expected [Date]</td></tr>
        <tr><td>[Jurisdiction B]</td><td>Sector licensing inquiry</td><td>Information request</td><td>Response due [Date]</td></tr>
      </table>
    </section>
    <section data-section="developments">
      <h2>Antitrust Developments</h2>
      <ul>
        <li>Regulator signalled closer scrutiny of roll-up strategies in adjacent sectors.</li>
        <li>No new guidance published affecting current deal structures this period.</li>
      </ul>
    </section>
    <section data-section="implications">
      <h2>Implications for Active Deals</h2>
      <ul>
        <li>Build an extra [X]-week buffer into signing-to-close timelines pending Phase 1 outcome.</li>
        <li>No changes required to current deal structuring or step plans.</li>
      </ul>
    </section>`,
  ),
};

export const SEED_INSIGHT_TEMPLATES = [
  {
    id: '00000000-0000-0000-0000-00000000e001',
    name: 'Market Brief',
    description: 'Deal landscape, active bidders and valuation benchmarks for a sector or region.',
    icon: 'chart-line',
    html: SEED_TEMPLATE_PLACEHOLDERS['00000000-0000-0000-0000-00000000e001'],
  },
  {
    id: '00000000-0000-0000-0000-00000000e002',
    name: 'Investment Memo',
    description: 'Comprehensive investment memo covering thesis, financial review, risk matrix and valuation.',
    icon: 'file-text',
    html: SEED_TEMPLATE_PLACEHOLDERS['00000000-0000-0000-0000-00000000e002'],
  },
  {
    id: '00000000-0000-0000-0000-00000000e003',
    name: 'Portfolio Exposure Review',
    description: 'Concentration, sector and geographic exposure across the portfolio with flagged risks.',
    icon: 'briefcase',
    html: SEED_TEMPLATE_PLACEHOLDERS['00000000-0000-0000-0000-00000000e003'],
  },
  {
    id: '00000000-0000-0000-0000-00000000e004',
    name: 'Regulatory Watch',
    description: 'Regulatory and antitrust developments affecting active deals and targets.',
    icon: 'scale',
    html: SEED_TEMPLATE_PLACEHOLDERS['00000000-0000-0000-0000-00000000e004'],
  },
];

export async function seedInsightTemplates(
  db: DbClient,
  workspaceId: string = MNA_WORKSPACE_ID,
): Promise<void> {
  const rows = SEED_INSIGHT_TEMPLATES.map((tpl) => ({
    id: tpl.id,
    workspace_id: workspaceId,
    name: tpl.name,
    description: tpl.description,
    icon: tpl.icon,
    html: tpl.html,
  }));

  await db
    .insert(insightTemplates)
    .values(rows)
    .onConflictDoUpdate({
      target: insightTemplates.id,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        icon: sql`excluded.icon`,
        html: sql`excluded.html`,
        deleted_at: null,
      },
    });

  console.log(`  ✓ seeded ${rows.length} insight templates`);
}

/**
 * Sample Copilot bots (RFC 02), shared with the workspace. Brain Bot (the
 * workspace default bot) is not seeded: the migrations backfill it for existing
 * workspaces and `BotService.list` creates it on first use for new ones.
 */
const SEED_BOTS = [
  {
    id: '00000000-0000-0000-0000-00000000b001',
    name: 'Deal Scout',
    persona:
      '## Focus\n\nYou hunt for new deals. Lead with what changed in the market this month, then which pipeline companies it affects.\n\n## Style\n\nKeep answers short and list sources.',
    base_flavor: 'mna',
    avatar: { hue: 152, eyes: 'sparkle' as const, mood: 'curious' as const, shape: 'orbit' as const },
  },
  {
    id: '00000000-0000-0000-0000-00000000b002',
    name: 'CRM Concierge',
    persona:
      '## Focus\n\nYou look after relationships. When asked about a firm or banker, summarise coverage, the last touchpoint and who on the team should follow up.',
    base_flavor: 'mna',
    avatar: { hue: 28, eyes: 'round' as const, mood: 'calm' as const, shape: 'hexa' as const },
  },
  {
    id: '00000000-0000-0000-0000-00000000b003',
    name: 'Market Watch',
    persona:
      '## Focus\n\nYou track sectors and comparables. Answer with the numbers first, then one line on what they mean for the pipeline.',
    base_flavor: 'mna',
    avatar: { hue: 268, eyes: 'mono' as const, mood: 'cheerful' as const, shape: 'nova' as const },
  },
];

export async function seedBots(
  db: DbClient,
  workspaceId: string = MNA_WORKSPACE_ID,
  ownerUserId: string,
): Promise<void> {
  // Every bot has every skill; a seeded bot is already set up, so it carries
  // a persona (a new one starts blank and asks its owner who it is).
  const rows = SEED_BOTS.map(({ persona, ...bot }) => ({
    ...bot,
    persona_md: persona,
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    visibility: 'workspace',
    is_default: false,
  }));

  await db
    .insert(bots)
    .values(rows)
    .onConflictDoUpdate({
      target: bots.id,
      set: {
        name: sql`excluded.name`,
        persona_md: sql`excluded.persona_md`,
        base_flavor: sql`excluded.base_flavor`,
        avatar: sql`excluded.avatar`,
        archived_at: null,
      },
    });

  // An example bot routine: Deal Scout's weekday-morning market check, run as
  // the seeding user in their chat with it.
  const schedule = normalizeSchedule('weekly', { time: '08:30', weekdays: [1, 2, 3, 4, 5] });
  await db
    .insert(routines)
    .values({
      id: SEED_BOT_ROUTINE_ID,
      workspace_id: workspaceId,
      bot_id: SEED_BOTS[0].id,
      title: 'Morning deal scan',
      prompt:
        'What changed in the market since yesterday that matters for my pipeline? List the three most relevant items with sources.',
      schedule_kind: 'weekly',
      schedule_spec: schedule.scheduleSpec,
      cron_expression: schedule.cronExpression,
      timezone: 'Asia/Jakarta',
      next_fire_at: computeNextFireAt(schedule.cronExpression, 'Asia/Jakarta'),
      enabled: false,
      created_by: ownerUserId,
      updated_by: ownerUserId,
    })
    .onConflictDoNothing({ target: routines.id });

  console.log(`  ✓ seeded ${rows.length} bots and a bot routine (paused)`);
}

const SEED_BOT_ROUTINE_ID = '00000000-0000-0000-0000-00000000b101';

export const SEED_INSIGHT_WEATHER_ID = '00000000-0000-0000-0000-00000000e101';
export const SEED_INSIGHT_WEATHER_VERSION_ID = '00000000-0000-0000-0000-00000000e201';

const SEED_WEATHER_FORECAST = [
  { day: 'Mon', condition: 'Sunny', icon: '&#9728;&#65039;', high: 33, low: 25, rain: 10 },
  { day: 'Tue', condition: 'Partly cloudy', icon: '&#9925;', high: 32, low: 25, rain: 20 },
  { day: 'Wed', condition: 'Thunderstorms', icon: '&#9928;&#65039;', high: 30, low: 24, rain: 80 },
  { day: 'Thu', condition: 'Showers', icon: '&#127783;&#65039;', high: 29, low: 24, rain: 65 },
  { day: 'Fri', condition: 'Partly cloudy', icon: '&#9925;', high: 31, low: 25, rain: 30 },
  { day: 'Sat', condition: 'Sunny', icon: '&#9728;&#65039;', high: 33, low: 26, rain: 10 },
  { day: 'Sun', condition: 'Sunny', icon: '&#9728;&#65039;', high: 34, low: 26, rain: 5 },
];

const SEED_INSIGHT_WEATHER_HTML = seedTemplateDoc(
  'Weekly Weather Forecast',
  'Location: Jakarta, Indonesia &middot; Week of 21 September 2026 &middot; Sample insight',
  `
    <section data-section="summary">
      <h2>Summary</h2>
      <p>A hot, humid week with a wet spell midweek. Expect afternoon thunderstorms on Wednesday and
      scattered showers on Thursday before conditions clear into a sunny weekend.</p>
    </section>
    <section data-section="forecast">
      <h2>7-Day Forecast</h2>
      <table>
        <tr><th>Day</th><th>Conditions</th><th>High</th><th>Low</th><th>Chance of Rain</th></tr>
        ${SEED_WEATHER_FORECAST.map(
          (d) =>
            `<tr><td>${d.day}</td><td>${d.icon} ${d.condition}</td><td>${d.high}&deg;C</td>` +
            `<td>${d.low}&deg;C</td><td>${d.rain}%</td></tr>`,
        ).join('\n        ')}
      </table>
    </section>
    <section data-section="advisories">
      <h2>Advisories</h2>
      <ul>
        <li><span class="tag tag-high">High</span> Localised flooding possible Wednesday afternoon; allow extra travel time.</li>
        <li><span class="tag tag-medium">Medium</span> UV index very high on Monday, Saturday and Sunday.</li>
        <li><span class="tag tag-low">Low</span> Light winds all week; no marine warnings in effect.</li>
      </ul>
    </section>`,
);

/**
 * Seeds a simple sample insight (a weekly weather forecast) with its version 1,
 * so the Insights list isn't empty on a fresh database. Fixed ids keep it
 * idempotent; later versions a user adds on top are left alone.
 */
export async function seedInsights(
  db: DbClient,
  workspaceId: string = MNA_WORKSPACE_ID,
  userId: string | null = null,
): Promise<void> {
  await db
    .insert(insights)
    .values({
      id: SEED_INSIGHT_WEATHER_ID,
      workspace_id: workspaceId,
      name: 'Weekly Weather Forecast',
      description: 'Sample insight: a 7-day weather forecast with advisories.',
      kind: 'document',
      created_by: userId,
      updated_by: userId,
    })
    .onConflictDoUpdate({
      target: insights.id,
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        archived_at: null,
      },
    });

  await db
    .insert(insightVersions)
    .values({
      id: SEED_INSIGHT_WEATHER_VERSION_ID,
      workspace_id: workspaceId,
      insight_id: SEED_INSIGHT_WEATHER_ID,
      version_no: 1,
      html: SEED_INSIGHT_WEATHER_HTML,
      trigger: 'seed',
      label: 'Seeded',
      created_by: userId,
      content_hash: insightContentHash(SEED_INSIGHT_WEATHER_HTML),
    })
    .onConflictDoUpdate({
      target: [insightVersions.insight_id, insightVersions.version_no],
      set: {
        html: sql`excluded.html`,
        content_hash: sql`excluded.content_hash`,
      },
    });
  console.log('  ✓ seeded 1 insight (Weekly Weather Forecast)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('seed failed:');
    console.error(err);
    process.exit(1);
  });
}
