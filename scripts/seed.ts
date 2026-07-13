/**
 * Local dev seed. Idempotent: re-running wipes prior seed rows (tagged by
 * entry_id in the 9001–9999 range and the fixed test-user email) and reinserts.
 * Not for production.
 *
 * Usage: pnpm db:seed
 */
import { config } from 'dotenv';
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
  files,
  fundAssets,
  fundAssetTransactions,
  fundAssetValuations,
  fundHoldingEntityStakes,
  fundingSources,
  funds,
  investmentThesis,
  holdingEntities,
  mboxFiles,
  rawEmails,
  roles,
  topics,
  users,
  userWorkspaces,
  workspaceCorrespondents,
  workspaces,
} from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/services/password';
import { createContainer } from '../src/lib/services';
import type { DbClient } from '../src/lib/server/db';
import { MNA_WORKSPACE_ID, ROLE_ADMIN_ID, ROLE_EDITOR_ID, ROLE_VIEWER_ID } from '../src/lib/constants';
import { normalizeCompanyName } from '../src/lib/crm/normalizeCompanyName';

const SEED_USER_EMAIL = 'test@sqe.co.id';
const SEED_USER_PASSWORD = 'password';
const SEED_USER_ROLE = 'admin';
const SEED_ENTRY_ID_MIN = 9001;
const SEED_ENTRY_ID_MAX = 9999;

// Extra workspaces + users for exercising multi-tenant switching locally
// (login → picker with 1 vs. several options → switcher). Hardcoded ids so
// they're stable across reseeds, same convention as MNA_WORKSPACE_ID.
const TEST_WORKSPACE_2_ID = '00000000-0000-0000-0000-000000000002'; // Starhouse Prime VCC
const TEST_WORKSPACE_3_ID = '00000000-0000-0000-0000-000000000003'; // Togan VCC
const TEST_WORKSPACE_4_ID = '00000000-0000-0000-0000-000000000004'; // Aeliana VCC

// Fund Management (Confluence 2641362965) — fixed ids so a reseed deletes and
// reinserts the same rows (fund_assets/transactions/valuations cascade off
// the fund delete).
const SEED_FUND_1_ID = '00000000-0000-0000-0000-0000000f0001'; // Direct Investments
const SEED_FUND_2_ID = '00000000-0000-0000-0000-0000000f0002'; // Growth Fund II
const SEED_FUND_3_ID = '00000000-0000-0000-0000-0000000f0003'; // Legacy Fund I
const SEED_ASSET_1_ID = '00000000-0000-0000-0000-0000000f0011'; // Acme Robotics (fund 1, Equity)
const SEED_ASSET_2_ID = '00000000-0000-0000-0000-0000000f0021'; // Meridian Growth Partners III (fund 2, FoF)
const SEED_ASSET_3_ID = '00000000-0000-0000-0000-0000000f0012'; // Horizon Reserve (fund 1, Cash)
const SEED_ASSET_4_ID = '00000000-0000-0000-0000-0000000f0013'; // Meridian Bridge Note (fund 1, Obligation)
const SEED_ASSET_5_ID = '00000000-0000-0000-0000-0000000f0022'; // Helios Public Holdings (fund 2, Shares)
const SEED_ASSET_6_ID = '00000000-0000-0000-0000-0000000f0031'; // Kairos Semiconductor (fund 3, Equity, exited)
const SEED_ASSET_7_ID = '00000000-0000-0000-0000-0000000f0032'; // NovaSilica Materials (fund 3, Equity, exiting)
const SEED_ASSET_8_ID = '00000000-0000-0000-0000-0000000f0033'; // Chem Partners Note (fund 3, Obligation)
const SEED_ASSET_9_ID = '00000000-0000-0000-0000-0000000f0034'; // Cash Reserve (fund 3, Cash)

// Investment Entities (investors) + Sources of Fund (funding_sources) — the
// managed picker lists behind the by-investment-entity / by-source-of-fund
// views and the Add Asset comboboxes. Non-cash seed assets reference these
// entities via type_details.investingEntity so the grouped views populate.
const ENTITY_STARTECH_1 = 'Startech Growth Fund 1';
const ENTITY_STARTECH_2 = 'Startech Growth Fund 2';
const ENTITY_STARTECH_3 = 'Startech Growth Fund 3';
const ENTITY_MERANTI = 'Meranti Global Investment Ltd';
// The four canonical entities keep their own row in the by-investment-entity
// tab; the trailing two (non-canonical) fold into the "Others" group so it has
// data to render and break down by fund.
const SEED_INVESTORS = [
  { id: '00000000-0000-0000-0000-0000000f0101', name: ENTITY_STARTECH_1, type: 'Fund' },
  { id: '00000000-0000-0000-0000-0000000f0102', name: ENTITY_STARTECH_2, type: 'Fund' },
  { id: '00000000-0000-0000-0000-0000000f0103', name: ENTITY_STARTECH_3, type: 'Fund' },
  { id: '00000000-0000-0000-0000-0000000f0104', name: ENTITY_MERANTI, type: 'Corporate' },
  { id: '00000000-0000-0000-0000-0000000f0105', name: 'PT Sinar Mas Multiartha Tbk', type: 'Corporate' },
  { id: '00000000-0000-0000-0000-0000000f0106', name: 'Co-invest Partners', type: 'Co-invest' },
];
const SEED_FUND_SOURCES = [
  { id: '00000000-0000-0000-0000-0000000f0201', name: 'Series B' },
  { id: '00000000-0000-0000-0000-0000000f0202', name: 'Commitment' },
  { id: '00000000-0000-0000-0000-0000000f0203', name: 'Retained earnings' },
  { id: '00000000-0000-0000-0000-0000000f0204', name: 'Bank facility' },
];
const INVESTOR_STARTECH_1 = SEED_INVESTORS[0].id;
const INVESTOR_STARTECH_2 = SEED_INVESTORS[1].id;
const INVESTOR_STARTECH_3 = SEED_INVESTORS[2].id;
const INVESTOR_MERANTI = SEED_INVESTORS[3].id;
const INVESTOR_SINARMAS = SEED_INVESTORS[4].id;
const INVESTOR_COINVEST = SEED_INVESTORS[5].id;
// LP / investment-entity commitment stakes in each fund — back the
// by-investment-entity view. Each fund's stakes sum to its commitment size so
// derived fractional ownership (commitment / fund size) lands on clean %s. The
// two non-canonical entities (Sinar Mas, Co-invest) give the "Others" group
// stakes across all three funds so its per-fund breakdown is populated.
const SEED_INVESTOR_STAKES = [
  // Fund 1 — Direct Investments ($5M commitment)
  { id: '00000000-0000-0000-0000-0000000f0301', fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, commitment_amount: 1_500_000, invested_amount: 1_200_000 },
  { id: '00000000-0000-0000-0000-0000000f0302', fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_MERANTI, commitment_amount: 1_000_000, invested_amount: 800_000 },
  { id: '00000000-0000-0000-0000-0000000f0303', fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_2, commitment_amount: 1_000_000, invested_amount: 700_000 },
  { id: '00000000-0000-0000-0000-0000000f0308', fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_SINARMAS, commitment_amount: 1_000_000, invested_amount: 800_000 },
  { id: '00000000-0000-0000-0000-0000000f0309', fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_COINVEST, commitment_amount: 500_000, invested_amount: 300_000 },
  // Fund 2 — Growth Fund II ($10M commitment)
  { id: '00000000-0000-0000-0000-0000000f0304', fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_STARTECH_3, commitment_amount: 5_000_000, invested_amount: 3_500_000 },
  { id: '00000000-0000-0000-0000-0000000f0305', fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_MERANTI, commitment_amount: 3_000_000, invested_amount: 2_200_000 },
  { id: '00000000-0000-0000-0000-0000000f030a', fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_SINARMAS, commitment_amount: 2_000_000, invested_amount: 1_500_000 },
  // Fund 3 — Legacy Fund I ($8M commitment)
  { id: '00000000-0000-0000-0000-0000000f0306', fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_1, commitment_amount: 3_000_000, invested_amount: 3_000_000 },
  { id: '00000000-0000-0000-0000-0000000f0307', fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_3, commitment_amount: 3_000_000, invested_amount: 2_500_000 },
  { id: '00000000-0000-0000-0000-0000000f030b', fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_COINVEST, commitment_amount: 2_000_000, invested_amount: 1_500_000 },
];

const SEED_EXTRA_WORKSPACES = [
  { id: TEST_WORKSPACE_2_ID, name: 'Starhouse Prime VCC', slug: 'starhouse-prime-vcc' },
  { id: TEST_WORKSPACE_3_ID, name: 'Togan VCC', slug: 'togan-vcc' },
  { id: TEST_WORKSPACE_4_ID, name: 'Aeliana VCC', slug: 'aeliana-vcc' },
];

const SEED_EXTRA_USERS = [
  { email: 'test2@sqe.co.id', name: 'Test User 2' },
  { email: 'test3@sqe.co.id', name: 'Test User 3' },
  { email: 'test4@sqe.co.id', name: 'Test User 4' },
];

// test2 and test3 each belong to exactly one workspace (auto-skip path);
// test4 belongs to two (picker + switcher path).
const SEED_EXTRA_MEMBERSHIPS: Array<{ email: string; workspaceId: string }> = [
  { email: 'test2@sqe.co.id', workspaceId: TEST_WORKSPACE_2_ID },
  { email: 'test3@sqe.co.id', workspaceId: TEST_WORKSPACE_3_ID },
  { email: 'test4@sqe.co.id', workspaceId: TEST_WORKSPACE_3_ID },
  { email: 'test4@sqe.co.id', workspaceId: TEST_WORKSPACE_4_ID },
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
    notes: 'Primary contact for tech M&A deals in Asia',
  },
  {
    name: 'Sally Bubbles',
    email: 'sally.bubbles@jporgan.example',
    phone: '+1 212 555 0102',
    company: 'JP Organ',
    title: 'Executive Director',
    type: 'external',
    notes: 'Specializes in industrial sector transactions',
  },
  {
    name: 'Mikey Noodle',
    email: 'mikey.noodle@organstanley.example',
    phone: '+65 6555 0103',
    company: 'Organ Stanley',
    title: 'Vice President',
    type: 'external',
    notes: 'SEA coverage team lead',
  },
  {
    name: 'Wendy Wobble',
    email: 'wendy.wobble@sparklecapital.example',
    phone: '+62 21 555 0104',
    company: 'SparkleCapital',
    title: 'Investment Director',
    type: 'internal',
    notes: 'Internal deal team lead',
  },
  {
    name: 'Davey Pickles',
    email: 'davey.pickles@sparklecapital.example',
    phone: '+62 21 555 0105',
    company: 'SparkleCapital',
    title: 'Associate',
    type: 'internal',
    notes: 'Financial analysis and due diligence',
  },
  {
    name: 'Bobby Waffles',
    email: 'bobby.waffles@creditsweets.example',
    phone: '+852 3988 0106',
    company: 'Credit Sweets',
    title: 'Director',
    type: 'external',
    notes: 'Cross-border M&A specialist',
  },
  {
    name: 'Lizzy Doodle',
    email: 'lizzy.doodle@atlantis.example',
    phone: '+1 646 555 0107',
    company: 'Bank of Atlantis Marble Lynx',
    title: 'Managing Director',
    type: 'external',
    notes: 'Healthcare and life sciences focus',
  },
  {
    name: 'Andy Pancake',
    email: 'andy.pancake@kitti.example',
    phone: '+65 6225 0108',
    company: 'Kittygroup',
    title: 'Director',
    type: 'external',
    notes: 'Consumer and retail sector coverage',
  },
];

// ─── CRM enrichment (topics, team, notes) ────────────────────────────────────
// Folded in from the former scripts/seed-crm.ts. The employers above (derived
// from seedContacts) are the source of truth; this layer attaches topic tags,
// internal team coverage, and relationship notes on top of them.

/** Internal team members (Brain 2.0 staff) — power the team-coverage filter. */
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
  pipeline_stage: 'market_screening' | 'unreviewed' | 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
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
  possible_duplicate_entry_id?: number;
  watchlist_status: string;
  dropped_reason?: string;
  dropped_at?: string;
  // Pipeline (HTML-parity) fields
  deal_type?: 'majority' | 'minority';
  entered_by?: string;
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
    deal_type: 'minority',
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
    deal_type: 'minority',
    originator: 'Nur Khairusy',
    workflow_status: 'Target identified',
    key_rationale:
      'Niche IC packaging for automotive; high EBITDA margin. Underleveraged balance sheet, founder-owned, open to dilution.',
    remarks: 'No prior contact. Identified via Gartner supply chain report.',
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
    deal_type: 'minority',
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
    deal_type: 'minority',
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
    deal_type: 'minority',
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
];

type SeedAfdFile = {
  file_name: string;
  file_link: string;
  raw_notes: string;
  structured_notes: Record<string, unknown>;
  tags: string[];
  processing_status: 'completed' | 'awaiting_review';
  file_date: string;
  file_type: 'mom' | 'prospectus' | 'banker_communications' | 'other';
  matched_entry_ids: number[];
};

const seedAfdFiles: SeedAfdFile[] = [
  {
    file_name: 'Seed AFD - Project Nameless Teaser.pdf',
    file_link: 'seed/afd/project-nameless-teaser.pdf',
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
    file_name: 'Seed AFD - Blue Harbor IC Notes.docx',
    file_link: 'seed/afd/blue-harbor-ic-notes.docx',
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
    file_name: 'Seed AFD - Project Bold Banker Email.eml',
    file_link: 'seed/afd/project-bold-banker-email.eml',
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
  // pinned to top" sort is visible in the AI File Dump table.
  {
    file_name: 'Seed AFD - Aaa Completed Teaser.pdf',
    file_link: 'seed/afd/aaa-completed-teaser.pdf',
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
    file_name: 'Seed AFD - Zzz Awaiting Teaser.pdf',
    file_link: 'seed/afd/zzz-awaiting-teaser.pdf',
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
];

// Lightweight per-workspace company fixtures — enough to prove tenant
// isolation when switching workspaces, not a full replica of `seedCompanies`.
const starhouseCompanies: SeedCompany[] = [
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

const toganCompanies: SeedCompany[] = [
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

const aelianaCompanies: SeedCompany[] = [
  {
    entry_id: 9120,
    target: 'Meridian Subsea Cables',
    segment: 'Telecom Infrastructure',
    company_focus: 'Subsea fiber cable maintenance and installation',
    website: 'https://meridiansubsea.example',
    geography: 'Greece',
    ownership: 'PE-owned',
    pipeline_stage: 'L1',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'Reviewing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 29.8, ebitda_usd_mn: 8.1 }],
  },
  {
    entry_id: 9121,
    target: 'Aegean Olive Exports',
    segment: 'Agriculture',
    company_focus: 'Premium olive oil producer and EU/US export house',
    website: 'https://aegeanolive.example',
    geography: 'Greece',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [],
  },
  {
    entry_id: 9122,
    target: 'Delphi Shipping Analytics',
    segment: 'Maritime Software',
    company_focus: 'Fleet-routing and fuel-optimization SaaS for tanker operators',
    website: 'https://delphishipping.example',
    geography: 'Greece',
    ownership: 'Private',
    pipeline_stage: 'L0',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 8.9, ebitda_usd_mn: 1.6 }],
  },
  {
    entry_id: 9123,
    target: 'Ionian Solar Partners',
    segment: 'Renewable Energy',
    company_focus: 'Utility-scale solar developer across the Ionian islands',
    website: 'https://ioniansolar.example',
    geography: 'Greece',
    ownership: 'PE-owned',
    pipeline_stage: 'L3',
    status: 'active',
    source: 'outbound',
    watchlist_status: 'Reviewing',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 52.0, ebitda_usd_mn: 19.4 }],
  },
  {
    entry_id: 9124,
    target: 'Santorini Craft Distillers',
    segment: 'Consumer',
    company_focus: 'Premium spirits producer with growing export volumes',
    website: 'https://santorinidistillers.example',
    geography: 'Greece',
    ownership: 'Family-owned',
    pipeline_stage: 'unreviewed',
    status: 'active',
    source: 'inbound',
    watchlist_status: 'New',
    financials: [{ fiscal_year: 2024, revenue_usd_mn: 6.2, ebitda_usd_mn: 1.1 }],
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
    );
  }
  return inserted;
}

// Fund Management (Confluence 2641362965) — one direct-equity fund
// (investing) and one fund-of-funds fund (harvesting), each with a couple of
// ledger transactions and a valuation snapshot so the UI has something to
// render/edit against. Rollups (gross_moic/dpi/called_amount/irr/...) are
// left for FundMetricsService to derive from the ledger after insert, same
// as a real create-fund flow — not hand-computed here.
const SEED_FUND_IDS = [SEED_FUND_1_ID, SEED_FUND_2_ID, SEED_FUND_3_ID];
const SEED_ASSET_IDS = [
  SEED_ASSET_1_ID,
  SEED_ASSET_2_ID,
  SEED_ASSET_3_ID,
  SEED_ASSET_4_ID,
  SEED_ASSET_5_ID,
  SEED_ASSET_6_ID,
  SEED_ASSET_7_ID,
  SEED_ASSET_8_ID,
  SEED_ASSET_9_ID,
];

async function seedFundManagement(db: DbClient, workspaceId: string) {
  await db.delete(funds).where(inArray(funds.id, SEED_FUND_IDS));

  // Investment Entities + Sources of Fund (idempotent by fixed id).
  await db.delete(holdingEntities).where(inArray(holdingEntities.id, SEED_INVESTORS.map((i) => i.id)));
  await db.insert(holdingEntities).values(
    SEED_INVESTORS.map((i) => ({
      id: i.id,
      workspace_id: workspaceId,
      name: i.name,
      entity_type: i.type,
    })),
  );
  await db.delete(fundingSources).where(inArray(fundingSources.id, SEED_FUND_SOURCES.map((s) => s.id)));
  await db.insert(fundingSources).values(
    SEED_FUND_SOURCES.map((s) => ({ id: s.id, workspace_id: workspaceId, name: s.name })),
  );

  await db.insert(funds).values([
    {
      id: SEED_FUND_1_ID,
      workspace_id: workspaceId,
      name: 'Direct Investments',
      description: 'Direct equity, credit, and cash positions taken outside a commingled vehicle.',
      vintage_year: 2023,
      commitment_size_amount: 5_000_000,
      status: 'investing',
      base_currency: 'USD',
    },
    {
      id: SEED_FUND_2_ID,
      workspace_id: workspaceId,
      name: 'Growth Fund II',
      description: 'Growth-stage fund-of-funds and public-market co-investment vehicle.',
      vintage_year: 2020,
      commitment_size_amount: 10_000_000,
      status: 'harvesting',
      base_currency: 'USD',
    },
    {
      id: SEED_FUND_3_ID,
      workspace_id: workspaceId,
      name: 'Legacy Fund I',
      description: 'Flagship 2018-vintage fund, now in harvest with two positions exited or exiting.',
      vintage_year: 2018,
      commitment_size_amount: 8_000_000,
      status: 'harvesting',
      base_currency: 'USD',
    },
  ]);

  // LP stakes (funds + holding entities now exist; the delete(funds) above already
  // cascade-removed any prior stakes for these funds).
  await db.insert(fundHoldingEntityStakes).values(
    SEED_INVESTOR_STAKES.map((s) => ({
      id: s.id,
      fund_id: s.fund_id,
      holding_entity_id: s.holding_entity_id,
      commitment_amount: s.commitment_amount,
      commitment_amount_currency: 'USD',
      invested_amount: s.invested_amount,
      invested_amount_currency: 'USD',
    })),
  );

  await db.insert(fundAssets).values([
    // ---- Fund 1: Direct Investments ----
    {
      id: SEED_ASSET_1_ID,
      workspace_id: workspaceId,
      asset_type: 'direct_investment',
      asset_name: 'Acme Robotics',
      legal_name: 'Acme Robotics Pte Ltd',
      country: 'Singapore',
      funding_source: 'Series B',
      investment_type: 'Direct Investment',
      entry_date: '2023-01-15',
      stake_pct: 14,
      sector: 'Robotics',
      investment_currency: 'USD',
      report_currency: 'USD',
      investment_description: 'Series B lead investment in an industrial robotics company.',
      key_rights: 'Board seat, pro-rata rights',
      mgmt_fee_rate_pct: 2,
      carry_rate_pct: 20,
      legal_fees_amount: 15000,
      type_details: { instrumentType: 'equity', dealType: 'Series B', entryEV: 40_000_000, holdYrs: 3, revenue: 8_000_000, ebitda: 1_200_000, investingEntity: ENTITY_STARTECH_1 },
      status: 'active',
      current_price_per_share: 12.5,
    },
    {
      id: SEED_ASSET_3_ID,
      workspace_id: workspaceId,
      asset_type: 'cash',
      asset_name: 'Horizon Reserve',
      country: 'Singapore',
      entry_date: '2024-11-01',
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: { institution: 'DBS Private Bank', yieldPct: 3.8 },
      status: 'active',
    },
    {
      id: SEED_ASSET_4_ID,
      workspace_id: workspaceId,
      asset_type: 'direct_investment',
      asset_name: 'Meridian Bridge Note',
      legal_name: 'Meridian Bridge Holdco',
      country: 'United States',
      investment_type: 'Direct Investment',
      entry_date: '2024-02-01',
      maturity_date: '2027-02-01',
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: { instrumentType: 'obligation', noteType: 'Bridge loan', coupon: 8, principal: 400_000, investingEntity: ENTITY_STARTECH_1 },
      status: 'active',
    },
    // ---- Fund 2: Growth Fund II ----
    {
      id: SEED_ASSET_2_ID,
      workspace_id: workspaceId,
      asset_type: 'fund_of_funds',
      asset_name: 'Meridian Growth Partners III',
      legal_name: 'Meridian Growth Partners III LP',
      country: 'United States',
      funding_source: 'Commitment',
      entry_date: '2021-03-01',
      commitment_amount: 3_000_000,
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: { targetFundName: 'Meridian Growth Partners III', fundManagerName: 'Meridian Capital', fundLifeYears: 10, investingEntity: ENTITY_MERANTI },
      status: 'active',
    },
    {
      id: SEED_ASSET_5_ID,
      workspace_id: workspaceId,
      asset_type: 'direct_investment',
      asset_name: 'Helios Public Holdings',
      legal_name: 'Helios Energy Corp',
      country: 'United States',
      investment_type: 'Direct Investment',
      entry_date: '2024-04-01',
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: { instrumentType: 'shares', exchange: 'NASDAQ', ticker: 'HELP', sharesOutstanding: 8_000, investingEntity: ENTITY_STARTECH_2 },
      status: 'active',
      current_price_per_share: 33,
    },
    // ---- Fund 3: Legacy Fund I ----
    {
      id: SEED_ASSET_6_ID,
      workspace_id: workspaceId,
      asset_type: 'direct_investment',
      asset_name: 'Kairos Semiconductor',
      legal_name: 'Kairos Semiconductor Inc.',
      country: 'Taiwan',
      investment_type: 'Direct Investment',
      entry_date: '2018-02-15',
      sector: 'Semiconductors',
      investment_currency: 'USD',
      report_currency: 'USD',
      investment_description: 'Fully exited fabless chip design position.',
      type_details: { instrumentType: 'equity', dealType: 'Majority', entryEV: 12_000_000, holdYrs: 7.7, investingEntity: ENTITY_STARTECH_3 },
      status: 'exited',
    },
    {
      id: SEED_ASSET_7_ID,
      workspace_id: workspaceId,
      asset_type: 'direct_investment',
      asset_name: 'NovaSilica Materials',
      legal_name: 'NovaSilica Materials Ltd',
      country: 'Taiwan',
      investment_type: 'Direct Investment',
      entry_date: '2019-05-01',
      sector: 'Specialty Materials',
      investment_currency: 'USD',
      report_currency: 'USD',
      investment_description: 'Partially exited advanced-materials supplier; remaining stake being wound down.',
      type_details: { instrumentType: 'equity', dealType: 'Minority', entryEV: 15_000_000, holdYrs: 7, investingEntity: ENTITY_STARTECH_3 },
      status: 'exiting',
    },
    {
      id: SEED_ASSET_8_ID,
      workspace_id: workspaceId,
      asset_type: 'direct_investment',
      asset_name: 'Chem Partners Note',
      legal_name: 'Chem Partners Holdco',
      country: 'United States',
      investment_type: 'Direct Investment',
      entry_date: '2020-06-01',
      maturity_date: '2027-06-01',
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: { instrumentType: 'obligation', noteType: 'Senior secured', coupon: 6, principal: 1_200_000, investingEntity: ENTITY_MERANTI },
      status: 'active',
    },
    {
      id: SEED_ASSET_9_ID,
      workspace_id: workspaceId,
      asset_type: 'cash',
      asset_name: 'Cash Reserve',
      country: 'United States',
      entry_date: '2018-01-01',
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: { institution: 'DBS', yieldPct: 2.5 },
      status: 'active',
    },
  ]);

  await db.insert(fundAssetTransactions).values([
    // Acme Robotics — initial round + a 2025 follow-on + a partial dividend.
    { fund_asset_id: SEED_ASSET_1_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2023-01-15', txn_type: 'contribution', price_per_share: 10, share_count: 50_000, value_amount: 500_000, txn_currency: 'USD', fx_rate: 1, notes: 'Initial investment' },
    { fund_asset_id: SEED_ASSET_1_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2024-06-01', txn_type: 'distribution', value_amount: 50_000, txn_currency: 'USD', fx_rate: 1, notes: 'Partial dividend' },
    { fund_asset_id: SEED_ASSET_1_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2025-03-01', txn_type: 'contribution', price_per_share: 12.5, share_count: 12_000, value_amount: 150_000, txn_currency: 'USD', fx_rate: 1, notes: 'Follow-on round' },

    // Horizon Reserve — single deposit, no further ledger activity (cash).
    { fund_asset_id: SEED_ASSET_3_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2024-11-01', txn_type: 'contribution', value_amount: 300_000, txn_currency: 'USD', fx_rate: 1, notes: 'Cash deposit' },

    // Meridian Bridge Note — principal disbursed, then quarterly interest.
    { fund_asset_id: SEED_ASSET_4_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2024-02-01', txn_type: 'contribution', value_amount: 400_000, txn_currency: 'USD', fx_rate: 1, notes: 'Principal disbursed' },
    { fund_asset_id: SEED_ASSET_4_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2025-09-30', txn_type: 'interest_income', value_amount: 8_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q3 2025 interest' },
    { fund_asset_id: SEED_ASSET_4_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2025-12-31', txn_type: 'interest_income', value_amount: 8_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q4 2025 interest' },
    { fund_asset_id: SEED_ASSET_4_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2026-03-31', txn_type: 'interest_income', value_amount: 8_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q1 2026 interest' },
    { fund_asset_id: SEED_ASSET_4_ID, fund_id: SEED_FUND_1_ID, holding_entity_id: INVESTOR_STARTECH_1, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2026-06-30', txn_type: 'interest_income', value_amount: 8_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q2 2026 interest' },

    // Meridian Growth Partners III — two capital calls + a distribution.
    { fund_asset_id: SEED_ASSET_2_ID, fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[1].id, txn_date: '2021-03-01', txn_type: 'contribution', value_amount: 2_000_000, txn_currency: 'USD', fx_rate: 1, notes: 'Initial capital call' },
    { fund_asset_id: SEED_ASSET_2_ID, fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[1].id, txn_date: '2023-06-01', txn_type: 'contribution', value_amount: 500_000, txn_currency: 'USD', fx_rate: 1, notes: 'Second capital call' },
    { fund_asset_id: SEED_ASSET_2_ID, fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[1].id, txn_date: '2025-09-01', txn_type: 'distribution', value_amount: 300_000, txn_currency: 'USD', fx_rate: 1, notes: 'Distribution from portfolio exit' },

    // Helios Public Holdings — purchase, then a partial sale.
    { fund_asset_id: SEED_ASSET_5_ID, fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_STARTECH_2, funding_source_id: SEED_FUND_SOURCES[1].id, txn_date: '2024-04-01', txn_type: 'contribution', price_per_share: 25, share_count: 10_000, value_amount: 250_000, txn_currency: 'USD', fx_rate: 1, notes: 'Open-market purchase' },
    { fund_asset_id: SEED_ASSET_5_ID, fund_id: SEED_FUND_2_ID, holding_entity_id: INVESTOR_STARTECH_2, funding_source_id: SEED_FUND_SOURCES[1].id, txn_date: '2026-02-01', txn_type: 'divestment', price_per_share: 30, share_count: 2_000, value_amount: 60_000, txn_currency: 'USD', fx_rate: 1, notes: 'Partial sell-down' },

    // Kairos Semiconductor — full exit (contribution then a complete divestment).
    { fund_asset_id: SEED_ASSET_6_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_3, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2018-02-15', txn_type: 'contribution', price_per_share: 10, share_count: 200_000, value_amount: 2_000_000, txn_currency: 'USD', fx_rate: 1, notes: 'Initial investment' },
    { fund_asset_id: SEED_ASSET_6_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_3, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2025-11-01', txn_type: 'divestment', price_per_share: 18.5, share_count: 200_000, value_amount: 3_700_000, txn_currency: 'USD', fx_rate: 1, notes: 'Full exit — strategic sale' },

    // NovaSilica Materials — partial exit, still winding down.
    { fund_asset_id: SEED_ASSET_7_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_3, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2019-05-01', txn_type: 'contribution', price_per_share: 12, share_count: 150_000, value_amount: 1_800_000, txn_currency: 'USD', fx_rate: 1, notes: 'Initial investment' },
    { fund_asset_id: SEED_ASSET_7_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_3, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2026-01-15', txn_type: 'divestment', price_per_share: 16, share_count: 60_000, value_amount: 960_000, txn_currency: 'USD', fx_rate: 1, notes: 'Partial secondary sale' },

    // Chem Partners Note — principal, then quarterly interest.
    { fund_asset_id: SEED_ASSET_8_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2020-06-01', txn_type: 'contribution', value_amount: 1_200_000, txn_currency: 'USD', fx_rate: 1, notes: 'Principal disbursed' },
    { fund_asset_id: SEED_ASSET_8_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2025-09-30', txn_type: 'interest_income', value_amount: 18_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q3 2025 interest' },
    { fund_asset_id: SEED_ASSET_8_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2025-12-31', txn_type: 'interest_income', value_amount: 18_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q4 2025 interest' },
    { fund_asset_id: SEED_ASSET_8_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2026-03-31', txn_type: 'interest_income', value_amount: 18_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q1 2026 interest' },
    { fund_asset_id: SEED_ASSET_8_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_MERANTI, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2026-06-30', txn_type: 'interest_income', value_amount: 18_000, txn_currency: 'USD', fx_rate: 1, notes: 'Q2 2026 interest' },

    // Cash Reserve — single deposit (cash).
    { fund_asset_id: SEED_ASSET_9_ID, fund_id: SEED_FUND_3_ID, holding_entity_id: INVESTOR_STARTECH_3, funding_source_id: SEED_FUND_SOURCES[0].id, txn_date: '2018-01-01', txn_type: 'contribution', value_amount: 640_000, txn_currency: 'USD', fx_rate: 1, notes: 'Initial cash allocation' },
  ]);

  await db.insert(fundAssetValuations).values([
    // Acme Robotics — quarterly comp marks.
    { fund_asset_id: SEED_ASSET_1_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'comparables', currency: 'USD', market_value_amount: 560_000, price_per_share: 11.2, shares_outstanding: 50_000, shareholding_pct: 14, notes: 'Comp-based mark using peer EV/EBITDA.' },
    { fund_asset_id: SEED_ASSET_1_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'comparables', currency: 'USD', market_value_amount: 690_000, price_per_share: 11.1, shares_outstanding: 62_000, shareholding_pct: 14, notes: 'Comp-based mark using peer EV/EBITDA.' },
    { fund_asset_id: SEED_ASSET_1_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'comparables', currency: 'USD', market_value_amount: 719_200, price_per_share: 11.6, shares_outstanding: 62_000, shareholding_pct: 14, notes: 'Comp-based mark using peer EV/EBITDA.' },
    { fund_asset_id: SEED_ASSET_1_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'comparables', currency: 'USD', market_value_amount: 775_000, price_per_share: 12.5, shares_outstanding: 62_000, shareholding_pct: 14, notes: 'Comp-based mark using peer EV/EBITDA.' },

    // Horizon Reserve — cash + modest accrued yield.
    { fund_asset_id: SEED_ASSET_3_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 305_000, notes: 'Cash balance plus accrued interest.' },
    { fund_asset_id: SEED_ASSET_3_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 308_000, notes: 'Cash balance plus accrued interest.' },
    { fund_asset_id: SEED_ASSET_3_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 311_000, notes: 'Cash balance plus accrued interest.' },
    { fund_asset_id: SEED_ASSET_3_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 314_000, notes: 'Cash balance plus accrued interest.' },

    // Meridian Bridge Note — held at par.
    { fund_asset_id: SEED_ASSET_4_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 400_000, notes: 'Held at par — no impairment indicators.' },
    { fund_asset_id: SEED_ASSET_4_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 400_000, notes: 'Held at par — no impairment indicators.' },
    { fund_asset_id: SEED_ASSET_4_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 400_000, notes: 'Held at par — no impairment indicators.' },
    { fund_asset_id: SEED_ASSET_4_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 400_000, notes: 'Held at par — no impairment indicators.' },

    // Meridian Growth Partners III — GP capital account statements.
    { fund_asset_id: SEED_ASSET_2_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'capital_account_statement', currency: 'USD', market_value_amount: 2_050_000, notes: 'Per GP capital account statement.' },
    { fund_asset_id: SEED_ASSET_2_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'capital_account_statement', currency: 'USD', market_value_amount: 2_080_000, notes: 'Per GP capital account statement.' },
    { fund_asset_id: SEED_ASSET_2_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'capital_account_statement', currency: 'USD', market_value_amount: 2_090_000, notes: 'Per GP capital account statement.' },
    { fund_asset_id: SEED_ASSET_2_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'capital_account_statement', currency: 'USD', market_value_amount: 2_100_000, notes: 'Per GP capital account statement.' },

    // Helios Public Holdings — public market close, share count drops after the Feb 2026 sell-down.
    { fund_asset_id: SEED_ASSET_5_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'stock_market_price', currency: 'USD', market_value_amount: 270_000, price_per_share: 27, shares_outstanding: 10_000, notes: 'NASDAQ closing price.' },
    { fund_asset_id: SEED_ASSET_5_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'stock_market_price', currency: 'USD', market_value_amount: 290_000, price_per_share: 29, shares_outstanding: 10_000, notes: 'NASDAQ closing price.' },
    { fund_asset_id: SEED_ASSET_5_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'stock_market_price', currency: 'USD', market_value_amount: 248_000, price_per_share: 31, shares_outstanding: 8_000, notes: 'NASDAQ closing price, post sell-down.' },
    { fund_asset_id: SEED_ASSET_5_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'stock_market_price', currency: 'USD', market_value_amount: 264_000, price_per_share: 33, shares_outstanding: 8_000, notes: 'NASDAQ closing price, post sell-down.' },

    // Kairos Semiconductor — fully exited Nov 2025; no valuation needed after
    // that (share_count is 0, so unrealized value is correctly $0 with no
    // stale mark to fall back on).
    { fund_asset_id: SEED_ASSET_6_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'comparables', currency: 'USD', market_value_amount: 3_500_000, price_per_share: 17.5, shares_outstanding: 200_000, notes: 'Last mark before the Nov 2025 exit.' },

    // NovaSilica Materials — winding down; share count drops after the Jan 2026 partial sale.
    { fund_asset_id: SEED_ASSET_7_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'comparables', currency: 'USD', market_value_amount: 2_250_000, price_per_share: 15, shares_outstanding: 150_000, notes: 'Comp-based mark ahead of the wind-down.' },
    { fund_asset_id: SEED_ASSET_7_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'comparables', currency: 'USD', market_value_amount: 2_325_000, price_per_share: 15.5, shares_outstanding: 150_000, notes: 'Comp-based mark ahead of the wind-down.' },
    { fund_asset_id: SEED_ASSET_7_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'comparables', currency: 'USD', market_value_amount: 1_485_000, price_per_share: 16.5, shares_outstanding: 90_000, notes: 'Post partial-sale mark.' },
    { fund_asset_id: SEED_ASSET_7_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'comparables', currency: 'USD', market_value_amount: 1_530_000, price_per_share: 17, shares_outstanding: 90_000, notes: 'Post partial-sale mark.' },

    // Chem Partners Note — held at par.
    { fund_asset_id: SEED_ASSET_8_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 1_200_000, notes: 'Held at par — no impairment indicators.' },
    { fund_asset_id: SEED_ASSET_8_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 1_200_000, notes: 'Held at par — no impairment indicators.' },
    { fund_asset_id: SEED_ASSET_8_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 1_200_000, notes: 'Held at par — no impairment indicators.' },
    { fund_asset_id: SEED_ASSET_8_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 1_200_000, notes: 'Held at par — no impairment indicators.' },

    // Cash Reserve — flat balance with modest yield.
    { fund_asset_id: SEED_ASSET_9_ID, as_of_date: '2025-09-30', period_label: 'Q3 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 660_000, notes: 'Cash balance plus accrued interest.' },
    { fund_asset_id: SEED_ASSET_9_ID, as_of_date: '2025-12-31', period_label: 'Q4 2025', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 662_000, notes: 'Cash balance plus accrued interest.' },
    { fund_asset_id: SEED_ASSET_9_ID, as_of_date: '2026-03-31', period_label: 'Q1 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 664_000, notes: 'Cash balance plus accrued interest.' },
    { fund_asset_id: SEED_ASSET_9_ID, as_of_date: '2026-06-30', period_label: 'Q2 2026', valuation_method: 'at_cost', currency: 'USD', market_value_amount: 666_000, notes: 'Cash balance plus accrued interest.' },
  ]);

  const { fundMetricsService } = createContainer(db, workspaceId);
  // recomputeAsset (not recomputeFund) — it persists the asset's own rollups
  // (gross_moic/invested_capital_amount/...) before cascading into the
  // fund-level aggregate; calling recomputeFund alone leaves every asset row
  // with null rollups even though the fund total comes out right.
  for (const assetId of SEED_ASSET_IDS) {
    await fundMetricsService.recomputeAsset(assetId);
  }

  console.log(
    `  ✓ Fund Management: ${SEED_FUND_IDS.length} funds, ${SEED_ASSET_IDS.length} assets across all 5 holding types, multi-year ledgers + quarterly valuations (rollups derived via FundMetricsService)`,
  );
}

async function main() {
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

    // Tenancy (MB-337) — hardcoded MNA workspace + the 3 roles, mirroring the
    // migration's prod backfill so local dev matches staging/prod exactly.
    await db
      .insert(workspaces)
      .values({ id: MNA_WORKSPACE_ID, name: 'MnA', slug: 'mna' })
      .onConflictDoNothing({ target: workspaces.id });
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
      .values({ user_id: seedUser.id, workspace_id: MNA_WORKSPACE_ID, role_id: ROLE_EDITOR_ID, is_email_synced: true })
      .onConflictDoUpdate({
        target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
        set: { is_email_synced: true },
      });
    console.log('  ✓ MNA workspace + roles + seed user membership (is_email_synced=true — toggle it in admin portal to test)');

    // Extra workspaces + test users (test2/test3/test4) — for exercising the
    // workspace picker/switcher locally: test2 and test3 each have exactly
    // one membership (auto-skip path), test4 has two (picker + switcher path).
    await db
      .insert(workspaces)
      .values(SEED_EXTRA_WORKSPACES)
      .onConflictDoNothing({ target: workspaces.id });

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
      `  ✓ ${SEED_EXTRA_WORKSPACES.length} extra workspaces + ${SEED_EXTRA_USERS.length} test users (password: ${SEED_USER_PASSWORD})`,
    );
    console.log('    test2@sqe.co.id -> Starhouse Prime VCC (1 workspace)');
    console.log('    test3@sqe.co.id -> Togan VCC (1 workspace)');
    console.log('    test4@sqe.co.id -> Togan VCC + Aeliana VCC (2 workspaces)');

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
    const insertedCompanies: Array<{ entry_id: number; id: string }> = [];
    for (const c of seedCompanies) {
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
          watchlist_status: c.watchlist_status,
          dropped_reason: c.dropped_reason ?? null,
          dropped_at: c.dropped_at ?? null,
          deal_type: c.deal_type ?? null,
          entered_by: c.entered_by ?? null,
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
        );
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

    // Populate each extra workspace with its own companies, so switching
    // workspaces actually shows different data (tenant isolation, not just
    // an empty screen).
    const insertedStarhouseCompanies = await insertCompaniesForWorkspace(
      db,
      TEST_WORKSPACE_2_ID,
      starhouseCompanies,
    );
    const insertedToganCompanies = await insertCompaniesForWorkspace(
      db,
      TEST_WORKSPACE_3_ID,
      toganCompanies,
    );
    const insertedAelianaCompanies = await insertCompaniesForWorkspace(
      db,
      TEST_WORKSPACE_4_ID,
      aelianaCompanies,
    );
    console.log(
      `  ✓ ${starhouseCompanies.length} companies in Starhouse Prime VCC, ${toganCompanies.length} in Togan VCC, ${aelianaCompanies.length} in Aeliana VCC`,
    );

    // AI File Dump — seed a few processed files, including one matched to a
    // project-name-only company. Identified by distinctive file names.
    const seedAfdFileNames = seedAfdFiles.map((file) => file.file_name);
    await db.delete(files).where(inArray(files.file_name, seedAfdFileNames));
    await db.insert(files).values(
      seedAfdFiles.map((file) => {
        const matchedCompanies = file.matched_entry_ids.flatMap((entryId) => {
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
        });
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
    console.log(`  ✓ ${seedAfdFiles.length} AI File Dump files`);

    // Investment thesis — single seed thesis, identified by title.
    await db
      .delete(investmentThesis)
      .where(eq(investmentThesis.title, seedThesis.title));
    const [insertedThesis] = await db
      .insert(investmentThesis)
      .values({ ...seedThesis, workspace_id: MNA_WORKSPACE_ID })
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
    );
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
      is_primary: false,
      source: 'manual',
    }));

    const insertedCorrespondents = await db
      .insert(correspondents)
      .values(correspondentRows)
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
        });
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
    // Wipe the matching raw_emails fixture (the ingest "source of truth" these
    // analytics.emails rows claim to have come from) and its mbox_files parent.
    await db
      .delete(rawEmails)
      .where(like(rawEmails.message_id, `${AV_MID_PREFIX}%${AV_MID_SUFFIX}`));
    await db
      .delete(mboxFiles)
      .where(eq(mboxFiles.s3_key, 'seed/auto-vehicle.mbox'));

    const [avEmployer] = await db
      .insert(employers)
      .values({
        name: AV_NAME,
        normalized_name: AV_NORM,
        industry: 'Automotive',
      })
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
    const avBase = new Date('2026-04-10T09:00:00Z').getTime();

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

    // Backing raw_emails/mbox_files fixture — MB-337 CRM follow-up: the
    // per-workspace marts (mart_crm/mart_mom/mart_topics) attribute an email
    // to a workspace via analytics.emails.message_id -> raw_emails.message_id
    // -> raw_emails.custodian_email -> a synced user_workspaces row (see
    // data-pipeline/migrations/20260705000004_workspace_scoped_marts.sql).
    // Without a matching raw_emails row, these seeded emails are invisible to
    // that bridge and every per-workspace KPI shows 0 for AUTO VEHICLE.
    // Wendy Wobble (the internal party on this thread) is the custodian
    // whose mailbox "received" these emails.
    const [avMboxFile] = await db
      .insert(mboxFiles)
      .values({
        source: 'seed',
        s3_bucket: 'seed-fixtures',
        s3_key: 'seed/auto-vehicle.mbox',
        size_bytes: 0,
        custodian_email: INTERNAL.email,
        window_start: new Date(avBase).toISOString(),
        window_end: new Date(avBase + 30 * dayMs).toISOString(),
        mode: 'incremental',
        parse_status: 'parsed',
        parsed_at: new Date().toISOString(),
        raw_email_count: avMails.length,
      })
      .returning({ id: mboxFiles.id });
    if (!avMboxFile) throw new Error('failed to insert AUTO VEHICLE mbox_files fixture');

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

    const avRawEmailRows = avMails.map((m) => ({
      file_id: avMboxFile.id,
      custodian_email: INTERNAL.email,
      message_id: `${AV_MID_PREFIX}${m.idx}${AV_MID_SUFFIX}`,
      from_address: m.from.email.toLowerCase(),
      from_display_name: m.from.name,
      to_addresses: m.to.map((r) => r.email.toLowerCase()),
      cc_addresses: (m.cc ?? []).map((r) => r.email.toLowerCase()),
      subject: m.subject,
      body_text: m.body,
      sent_at: new Date(avBase + m.daysOffset * dayMs).toISOString(),
      ingest_status: 'ingested',
      ingested_at: new Date().toISOString(),
      llm_status: 'enriched',
      llm_enriched_at: new Date().toISOString(),
    }));
    await db.insert(rawEmails).values(avRawEmailRows);

    const avEmailRows = avMails.map((m) => ({
      message_id: `${AV_MID_PREFIX}${m.idx}${AV_MID_SUFFIX}`,
      employer_id: avEmployer.id,
      from_address: m.from.email.toLowerCase(),
      from_display_name: m.from.name,
      subject: m.subject,
      body_text: m.body,
      sent_at: new Date(avBase + m.daysOffset * dayMs).toISOString(),
      direction: m.direction,
      filter_status: 'processed',
      processed_at: new Date().toISOString(),
    }));
    const insertedAvEmails = await db
      .insert(emails)
      .values(avEmailRows)
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
      await db.insert(emailParticipants).values(avParticipantRows);
    }
    console.log(
      `  ✓ AUTO VEHICLE: 1 employer + ${insertedAvCorrespondents.length} mbox correspondents + ${insertedAvEmails.length} emails + ${avParticipantRows.length} participants + ${avRawEmailRows.length} raw_emails (custodian: ${INTERNAL.email}, synced to MNA)`,
    );

    // ── Starhouse Prime VCC — CRM workspace-isolation fixture ─────────────────
    // MB-337 CRM follow-up. Layers Starhouse's own private CRM data onto the
    // SAME shared "Golden Sacks" employer MNA already has correspondents/
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
        .delete(rawEmails)
        .where(like(rawEmails.message_id, `${STARHOUSE_MID_PREFIX}%${STARHOUSE_MID_SUFFIX}`));
      await db
        .delete(mboxFiles)
        .where(eq(mboxFiles.s3_key, 'seed/starhouse-golden-sacks.mbox'));
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

      // Private contact: another banker at Golden Sacks that only Starhouse's
      // deal team has a relationship with — MNA must never see her.
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
          'Starhouse-only: Priya flagged Golden Sacks for a potential co-investment on Project Comet. Do not share outside Starhouse yet.',
      });

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

      // Private related-company link to one of Starhouse's own companies —
      // must not appear in MNA's related-companies tab for Golden Sacks.
      const nordfjord = insertedStarhouseCompanies.find((c) => c.entry_id === 9100);
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
        });
      }

      // Separate mailbox history: test2 (Starhouse's own user) is the synced
      // custodian, so mart_crm/mart_mom show Starhouse's OWN email KPIs for
      // Golden Sacks — distinct from MNA's numbers for the same employer.
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

        const shBase = new Date('2026-04-15T09:00:00Z').getTime();
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

        const [shMboxFile] = await db
          .insert(mboxFiles)
          .values({
            source: 'seed',
            s3_bucket: 'seed-fixtures',
            s3_key: 'seed/starhouse-golden-sacks.mbox',
            size_bytes: 0,
            custodian_email: 'test2@sqe.co.id',
            window_start: new Date(shBase).toISOString(),
            window_end: new Date(shBase + 7 * dayMs).toISOString(),
            mode: 'incremental',
            parse_status: 'parsed',
            parsed_at: new Date().toISOString(),
            raw_email_count: shMails.length,
          })
          .returning({ id: mboxFiles.id });

        if (shMboxFile) {
          await db.insert(rawEmails).values(
            shMails.map((m) => ({
              file_id: shMboxFile.id,
              custodian_email: 'test2@sqe.co.id',
              message_id: `${STARHOUSE_MID_PREFIX}${m.idx}${STARHOUSE_MID_SUFFIX}`,
              from_address: m.from.email.toLowerCase(),
              from_display_name: m.from.name,
              to_addresses: [m.to.email.toLowerCase()],
              cc_addresses: [],
              subject: m.subject,
              body_text: m.body,
              sent_at: new Date(shBase + m.daysOffset * dayMs).toISOString(),
              ingest_status: 'ingested',
              ingested_at: new Date().toISOString(),
              llm_status: 'enriched',
              llm_enriched_at: new Date().toISOString(),
            })),
          );

          const shEmailRows = shMails.map((m) => ({
            message_id: `${STARHOUSE_MID_PREFIX}${m.idx}${STARHOUSE_MID_SUFFIX}`,
            employer_id: isolationEmployerId,
            from_address: m.from.email.toLowerCase(),
            from_display_name: m.from.name,
            subject: m.subject,
            body_text: m.body,
            sent_at: new Date(shBase + m.daysOffset * dayMs).toISOString(),
            direction: m.direction,
            filter_status: 'processed',
            processed_at: new Date().toISOString(),
          }));
          const insertedShEmails = await db
            .insert(emails)
            .values(shEmailRows)
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
            await db.insert(emailParticipants).values(shParticipantRows);
          }
          console.log(
            `  ✓ Starhouse isolation fixture: 1 private contact + 1 private note + 1 private topic + 1 private related-company + ${insertedShEmails.length} emails (custodian: test2@sqe.co.id, synced to Starhouse Prime VCC)`,
          );
        }
      }
    }

    // ── Togan VCC — CRM workspace-isolation fixture ───────────────────────────
    // Same MB-337 demonstration as Starhouse above, layered onto the shared
    // "JP Organ" employer instead of "Golden Sacks" so the two fixtures don't
    // collide. test3 and test4 both belong to Togan VCC, so this also proves
    // workspace-scoped (not user-scoped) CRM data: either user sees it while
    // in the Togan workspace.
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
        .delete(rawEmails)
        .where(like(rawEmails.message_id, `${TOGAN_MID_PREFIX}%${TOGAN_MID_SUFFIX}`));
      await db
        .delete(mboxFiles)
        .where(eq(mboxFiles.s3_key, 'seed/togan-jp-organ.mbox'));
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
          'Togan-only: Deniz flagged JP Organ for a co-investment lead on Project Bosphorus. Do not share outside Togan yet.',
      });

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

      const kestane = insertedToganCompanies.find((c) => c.entry_id === 9110);
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
        });
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

        const tgBase = new Date('2026-04-20T09:00:00Z').getTime();
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

        const [tgMboxFile] = await db
          .insert(mboxFiles)
          .values({
            source: 'seed',
            s3_bucket: 'seed-fixtures',
            s3_key: 'seed/togan-jp-organ.mbox',
            size_bytes: 0,
            custodian_email: 'test3@sqe.co.id',
            window_start: new Date(tgBase).toISOString(),
            window_end: new Date(tgBase + 7 * dayMs).toISOString(),
            mode: 'incremental',
            parse_status: 'parsed',
            parsed_at: new Date().toISOString(),
            raw_email_count: tgMails.length,
          })
          .returning({ id: mboxFiles.id });

        if (tgMboxFile) {
          await db.insert(rawEmails).values(
            tgMails.map((m) => ({
              file_id: tgMboxFile.id,
              custodian_email: 'test3@sqe.co.id',
              message_id: `${TOGAN_MID_PREFIX}${m.idx}${TOGAN_MID_SUFFIX}`,
              from_address: m.from.email.toLowerCase(),
              from_display_name: m.from.name,
              to_addresses: [m.to.email.toLowerCase()],
              cc_addresses: [],
              subject: m.subject,
              body_text: m.body,
              sent_at: new Date(tgBase + m.daysOffset * dayMs).toISOString(),
              ingest_status: 'ingested',
              ingested_at: new Date().toISOString(),
              llm_status: 'enriched',
              llm_enriched_at: new Date().toISOString(),
            })),
          );

          const tgEmailRows = tgMails.map((m) => ({
            message_id: `${TOGAN_MID_PREFIX}${m.idx}${TOGAN_MID_SUFFIX}`,
            employer_id: toganIsolationEmployerId,
            from_address: m.from.email.toLowerCase(),
            from_display_name: m.from.name,
            subject: m.subject,
            body_text: m.body,
            sent_at: new Date(tgBase + m.daysOffset * dayMs).toISOString(),
            direction: m.direction,
            filter_status: 'processed',
            processed_at: new Date().toISOString(),
          }));
          const insertedTgEmails = await db
            .insert(emails)
            .values(tgEmailRows)
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
            await db.insert(emailParticipants).values(tgParticipantRows);
          }
          console.log(
            `  ✓ Togan isolation fixture: 1 private contact + 1 private note + 1 private topic + 1 private related-company + ${insertedTgEmails.length} emails (custodian: test3@sqe.co.id, synced to Togan VCC)`,
          );
        }
      }
    }

    // ── Aeliana VCC — CRM workspace-isolation fixture ─────────────────────────
    // Same pattern again, layered onto the shared "Credit Sweets" employer.
    // test4's second membership (alongside Togan VCC) — exercises the
    // workspace switcher with genuinely different CRM data per workspace.
    const aelianaIsolationEmployerId = firmIdByName.get(normalize('Credit Sweets'));
    if (aelianaIsolationEmployerId) {
      const AELIANA_CONTACT_EMAIL = 'elena.papadopoulos@aeliana-vcc.example';
      const AELIANA_MID_PREFIX = 'seed-aeliana-cs-';
      const AELIANA_MID_SUFFIX = '@seed.local';
      const test4UserId = extraUserIdByEmail.get('test4@sqe.co.id');

      await db
        .delete(emails)
        .where(like(emails.message_id, `${AELIANA_MID_PREFIX}%${AELIANA_MID_SUFFIX}`));
      await db
        .delete(rawEmails)
        .where(like(rawEmails.message_id, `${AELIANA_MID_PREFIX}%${AELIANA_MID_SUFFIX}`));
      await db
        .delete(mboxFiles)
        .where(eq(mboxFiles.s3_key, 'seed/aeliana-credit-sweets.mbox'));
      await db
        .delete(employerNotes)
        .where(
          and(
            eq(employerNotes.employer_id, aelianaIsolationEmployerId),
            eq(employerNotes.workspace_id, TEST_WORKSPACE_4_ID),
          ),
        );
      await db
        .delete(employerRelatedCompanies)
        .where(
          and(
            eq(employerRelatedCompanies.employer_id, aelianaIsolationEmployerId),
            eq(employerRelatedCompanies.workspace_id, TEST_WORKSPACE_4_ID),
          ),
        );
      await db.delete(correspondents).where(eq(correspondents.email, AELIANA_CONTACT_EMAIL));

      const [elena] = await db
        .insert(correspondents)
        .values({
          employer_id: aelianaIsolationEmployerId,
          name: 'Elena Papadopoulos',
          email: AELIANA_CONTACT_EMAIL,
          title: 'Partner',
          type: 'external',
          is_primary: false,
          source: 'manual',
          origin: 'manual',
        })
        .returning({ id: correspondents.id });
      if (elena) {
        await db
          .insert(workspaceCorrespondents)
          .values({ workspace_id: TEST_WORKSPACE_4_ID, correspondent_id: elena.id, source: 'manual' })
          .onConflictDoNothing();
      }

      await db.insert(employerNotes).values({
        employer_id: aelianaIsolationEmployerId,
        workspace_id: TEST_WORKSPACE_4_ID,
        content:
          'Aeliana-only: Elena connected us to a private credit desk at Credit Sweets for Project Meridian financing. Keep within Aeliana team.',
      });

      const [aelianaTopic] = await db
        .insert(topics)
        .values({
          name: 'Project Meridian',
          slug: 'project-meridian',
          workspace_id: TEST_WORKSPACE_4_ID,
          is_deal_related: true,
        })
        .onConflictDoUpdate({
          target: [topics.workspace_id, topics.name],
          targetWhere: sql`workspace_id IS NOT NULL`,
          set: { slug: 'project-meridian' },
        })
        .returning({ id: topics.id });
      if (aelianaTopic) {
        await db
          .insert(employerTopics)
          .values({
            employer_id: aelianaIsolationEmployerId,
            topic_id: aelianaTopic.id,
            source: 'manual',
            is_highlight: true,
          })
          .onConflictDoNothing();
      }

      const meridian = insertedAelianaCompanies.find((c) => c.entry_id === 9120);
      if (meridian) {
        await db.insert(employerRelatedCompanies).values({
          employer_id: aelianaIsolationEmployerId,
          workspace_id: TEST_WORKSPACE_4_ID,
          company_id: meridian.id,
          company_name: 'Meridian Subsea Cables',
          normalized_company_name: normalizeCompanyName('Meridian Subsea Cables'),
          source: 'manual',
          reason: 'manual',
          reason_summary: 'Added manually',
          confidence: 'high',
          evidence_count: 0,
        });
      }

      if (test4UserId && elena) {
        await db
          .insert(userWorkspaces)
          .values({
            user_id: test4UserId,
            workspace_id: TEST_WORKSPACE_4_ID,
            role_id: ROLE_EDITOR_ID,
            is_email_synced: true,
          })
          .onConflictDoUpdate({
            target: [userWorkspaces.user_id, userWorkspaces.workspace_id],
            set: { is_email_synced: true },
          });

        const aeBase = new Date('2026-04-25T09:00:00Z').getTime();
        const aeMails = [
          {
            idx: 1,
            subject: 'Credit Sweets — Introduction (Aeliana)',
            body: 'Hi team, introducing myself as your Aeliana contact at Credit Sweets. Keen to discuss Project Meridian financing. — Elena',
            from: { name: 'Elena Papadopoulos', email: AELIANA_CONTACT_EMAIL, correspondentId: elena.id },
            to: { name: 'Test User 4', email: 'test4@sqe.co.id' },
            direction: 'inbound' as const,
            daysOffset: 0,
          },
          {
            idx: 2,
            subject: 'RE: Credit Sweets — Introduction (Aeliana)',
            body: 'Hi Elena, thanks for reaching out — happy to set up a call this week. — Aeliana',
            from: { name: 'Test User 4', email: 'test4@sqe.co.id', correspondentId: null },
            to: { name: 'Elena Papadopoulos', email: AELIANA_CONTACT_EMAIL, correspondentId: elena.id },
            direction: 'outbound' as const,
            daysOffset: 2,
          },
        ];

        const [aeMboxFile] = await db
          .insert(mboxFiles)
          .values({
            source: 'seed',
            s3_bucket: 'seed-fixtures',
            s3_key: 'seed/aeliana-credit-sweets.mbox',
            size_bytes: 0,
            custodian_email: 'test4@sqe.co.id',
            window_start: new Date(aeBase).toISOString(),
            window_end: new Date(aeBase + 7 * dayMs).toISOString(),
            mode: 'incremental',
            parse_status: 'parsed',
            parsed_at: new Date().toISOString(),
            raw_email_count: aeMails.length,
          })
          .returning({ id: mboxFiles.id });

        if (aeMboxFile) {
          await db.insert(rawEmails).values(
            aeMails.map((m) => ({
              file_id: aeMboxFile.id,
              custodian_email: 'test4@sqe.co.id',
              message_id: `${AELIANA_MID_PREFIX}${m.idx}${AELIANA_MID_SUFFIX}`,
              from_address: m.from.email.toLowerCase(),
              from_display_name: m.from.name,
              to_addresses: [m.to.email.toLowerCase()],
              cc_addresses: [],
              subject: m.subject,
              body_text: m.body,
              sent_at: new Date(aeBase + m.daysOffset * dayMs).toISOString(),
              ingest_status: 'ingested',
              ingested_at: new Date().toISOString(),
              llm_status: 'enriched',
              llm_enriched_at: new Date().toISOString(),
            })),
          );

          const aeEmailRows = aeMails.map((m) => ({
            message_id: `${AELIANA_MID_PREFIX}${m.idx}${AELIANA_MID_SUFFIX}`,
            employer_id: aelianaIsolationEmployerId,
            from_address: m.from.email.toLowerCase(),
            from_display_name: m.from.name,
            subject: m.subject,
            body_text: m.body,
            sent_at: new Date(aeBase + m.daysOffset * dayMs).toISOString(),
            direction: m.direction,
            filter_status: 'processed',
            processed_at: new Date().toISOString(),
          }));
          const insertedAeEmails = await db
            .insert(emails)
            .values(aeEmailRows)
            .returning({ id: emails.id, message_id: emails.message_id });
          const aeEmailIdByMid = new Map(insertedAeEmails.map((r) => [r.message_id!, r.id]));

          const aeParticipantRows: (typeof emailParticipants.$inferInsert)[] = [];
          for (const m of aeMails) {
            const mid = `${AELIANA_MID_PREFIX}${m.idx}${AELIANA_MID_SUFFIX}`;
            const emailId = aeEmailIdByMid.get(mid);
            if (!emailId) continue;
            aeParticipantRows.push({
              email_id: emailId,
              correspondent_id: m.from.correspondentId,
              address: m.from.email.toLowerCase(),
              display_name: m.from.name,
              role: 'from',
            });
            aeParticipantRows.push({
              email_id: emailId,
              correspondent_id: m.to.correspondentId,
              address: m.to.email.toLowerCase(),
              display_name: m.to.name,
              role: 'to',
            });
          }
          if (aeParticipantRows.length > 0) {
            await db.insert(emailParticipants).values(aeParticipantRows);
          }
          console.log(
            `  ✓ Aeliana isolation fixture: 1 private contact + 1 private note + 1 private topic + 1 private related-company + ${insertedAeEmails.length} emails (custodian: test4@sqe.co.id, synced to Aeliana VCC)`,
          );
        }
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
      const RT_MBOX_KEY = 'seed/response-times.mbox';
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

      // Wipe prior fixture emails/raw_emails/mbox (idempotent). Employers are
      // upserted (never deleted) so we don't drop a real CRM firm.
      await db.delete(emails).where(like(emails.message_id, `${RT_MID_PREFIX}%${RT_MID_SUFFIX}`));
      await db.delete(rawEmails).where(like(rawEmails.message_id, `${RT_MID_PREFIX}%${RT_MID_SUFFIX}`));
      await db.delete(mboxFiles).where(eq(mboxFiles.s3_key, RT_MBOX_KEY));

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
      const rtBase = new Date('2026-05-02T09:00:00Z').getTime();
      const nowIso = new Date().toISOString();

      const [rtMbox] = await db
        .insert(mboxFiles)
        .values({
          source: 'seed',
          s3_bucket: 'seed-fixtures',
          s3_key: RT_MBOX_KEY,
          size_bytes: 0,
          custodian_email: RT_CUSTODIAN.email,
          window_start: new Date(rtBase).toISOString(),
          window_end: new Date(rtBase + 90 * rtDayMs).toISOString(),
          mode: 'incremental',
          parse_status: 'parsed',
          parsed_at: nowIso,
          raw_email_count: RT_FIRMS.length * RT_MULTIPLIERS.length,
        })
        .returning({ id: mboxFiles.id });
      if (!rtMbox) throw new Error('failed to insert response-time mbox_files fixture');

      const rtRawRows: (typeof rawEmails.$inferInsert)[] = [];
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
            employer_id: rtEmployer.id,
            from_address: contactEmail,
            from_display_name: contactName,
            subject: `Deal intro — ${firm.banker}`,
            body_text: `Sharing an opportunity from ${firm.banker}. Keen to discuss.`,
            sent_at: inSentAt,
            direction: 'inbound',
            filter_status: 'processed',
            processed_at: nowIso,
          });
          rtEmailRows.push({
            message_id: outMid,
            in_reply_to: inMid,
            employer_id: rtEmployer.id,
            from_address: RT_CUSTODIAN.email,
            from_display_name: RT_CUSTODIAN.name,
            subject: `RE: Deal intro — ${firm.banker}`,
            body_text: `Thanks — let us set up a call to review the materials.`,
            sent_at: outSentAt,
            direction: 'outbound',
            filter_status: 'processed',
            processed_at: nowIso,
          });
          rtCorrByInMid.set(inMid, { corrId, email: contactEmail, name: contactName });

          // Only the inbound parent needs the raw_emails → workspace bridge (the
          // response p50 is attributed to the inbound email's workspace).
          rtRawRows.push({
            file_id: rtMbox.id,
            custodian_email: RT_CUSTODIAN.email,
            message_id: inMid,
            from_address: contactEmail.toLowerCase(),
            from_display_name: contactName,
            to_addresses: [RT_CUSTODIAN.email.toLowerCase()],
            cc_addresses: [],
            subject: `Deal intro — ${firm.banker}`,
            body_text: '',
            sent_at: inSentAt,
            ingest_status: 'ingested',
            ingested_at: nowIso,
            llm_status: 'enriched',
            llm_enriched_at: nowIso,
          });
        }
      }

      if (rtRawRows.length > 0) await db.insert(rawEmails).values(rtRawRows);
      const rtInsertedEmails =
        rtEmailRows.length > 0
          ? await db
              .insert(emails)
              .values(rtEmailRows)
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
        await db.insert(emailParticipants).values(rtParticipantRows);
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

    await seedFundManagement(db as unknown as DbClient, MNA_WORKSPACE_ID);

    console.log('done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('seed failed:');
  console.error(err);
  process.exit(1);
});
