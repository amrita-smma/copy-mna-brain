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
import { and, eq, gte, inArray, like, lte } from 'drizzle-orm';
import {
  companies,
  companyFinancials,
  correspondents,
  criterias,
  emailParticipants,
  emails,
  employers,
  files,
  investmentThesis,
  userCompanyFavorites,
  users,
} from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/services/password';

const SEED_USER_EMAIL = 'test@sqe.co.id';
const SEED_USER_PASSWORD = 'password';
const SEED_USER_ROLE = 'admin';
const SEED_ENTRY_ID_MIN = 9001;
const SEED_ENTRY_ID_MAX = 9999;
// entry_ids that the seed user starts with as favorites (subset of seedCompanies).
const SEED_FAVORITE_ENTRY_IDS = [9001, 9002, 9004];

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
    name: 'James Chen',
    email: 'james.chen@goldmansachs.com',
    phone: '+1 212 555 0101',
    company: 'Goldman Sachs',
    title: 'Managing Director',
    type: 'external',
    notes: 'Primary contact for tech M&A deals in Asia',
  },
  {
    name: 'Sarah Thompson',
    email: 'sarah.thompson@jpmorgan.com',
    phone: '+1 212 555 0102',
    company: 'JP Morgan',
    title: 'Executive Director',
    type: 'external',
    notes: 'Specializes in industrial sector transactions',
  },
  {
    name: 'Michael Lee',
    email: 'michael.lee@morganstanley.com',
    phone: '+65 6555 0103',
    company: 'Morgan Stanley',
    title: 'Vice President',
    type: 'external',
    notes: 'SEA coverage team lead',
  },
  {
    name: 'Amanda Wijaya',
    email: 'amanda.wijaya@starcapital.com',
    phone: '+62 21 555 0104',
    company: 'StarCapital',
    title: 'Investment Director',
    type: 'internal',
    notes: 'Internal deal team lead',
  },
  {
    name: 'David Tan',
    email: 'david.tan@starcapital.com',
    phone: '+62 21 555 0105',
    company: 'StarCapital',
    title: 'Associate',
    type: 'internal',
    notes: 'Financial analysis and due diligence',
  },
  {
    name: 'Robert Kim',
    email: 'robert.kim@creditsuisse.com',
    phone: '+852 3988 0106',
    company: 'Credit Suisse',
    title: 'Director',
    type: 'external',
    notes: 'Cross-border M&A specialist',
  },
  {
    name: 'Lisa Wang',
    email: 'lisa.wang@baml.com',
    phone: '+1 646 555 0107',
    company: 'Bank of America Merrill Lynch',
    title: 'Managing Director',
    type: 'external',
    notes: 'Healthcare and life sciences focus',
  },
  {
    name: 'Andrew Hartono',
    email: 'andrew.hartono@citi.com',
    phone: '+65 6225 0108',
    company: 'Citigroup',
    title: 'Director',
    type: 'external',
    notes: 'Consumer and retail sector coverage',
  },
];

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
    banker_source: 'Goldman Sachs',
    remarks: 'Seed triage: extracted from Goldman Sachs teaser; complete 2024 financials.',
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
    banker_source: 'JP Morgan',
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
    banker_source: 'UBS',
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
    banker_source: 'Citi',
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
    banker_source: 'Morgan Stanley',
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
    banker_source: 'Deutsche Bank',
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
    banker_source: 'Deutsche Bank',
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
    banker_source: 'Morgan Stanley',
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
    banker_source: 'Citi',
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
    banker_source: 'HSBC',
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
    banker_source: 'Bank of America',
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
    banker_source: 'Goldman Sachs',
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
    banker_source: 'JP Morgan',
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
    banker_source: 'Citi',
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
    banker_source: 'Morgan Stanley',
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
    banker: 'Goldman Sachs',
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
    banker: 'JP Morgan',
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
    banker: 'Morgan Stanley',
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
    banker: 'Citigroup',
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
    banker: 'Mandiri Sekuritas',
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
    banker: 'CIMB',
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
    banker: 'Samsung Securities',
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
    target: 'Daejoo Electronic Materials Co.',
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
    target: 'Advanced Semiconductor Engineering (ASE)',
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
    remarks: 'Warm intro via Goldman; management receptive to PE conversations.',
    last_activity_at: '2026-06-10T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 18000, ebitda_usd_mn: 3200, ev_usd_mn: 12000 },
    ],
  },
  {
    entry_id: 9025,
    target: 'Greatek Electronics Inc.',
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
    target: 'Inari Amertron Berhad',
    segment: 'Semiconductor RF Test & Assembly',
    company_focus: 'RF assembly partner for the Apple supply chain',
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
      'Leading RF assembly partner for Apple supply chain. Controlled by founder family; succession planning may create entry.',
    remarks: 'Banker intermediary (CIMB) made soft approach in Feb.',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 890, ebitda_usd_mn: 180, ev_usd_mn: 1200 },
    ],
  },
  {
    entry_id: 9027,
    target: 'UMC (United Microelectronics Corp)',
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
    target: 'ViTrox Corporation Berhad',
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
    target: 'Shin-Etsu Chemical Co.',
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
      'Extracted from JP Morgan APAC Chemicals market study (May 2026). Not being pitched — referenced as market benchmark.',
    last_activity_at: '2026-06-12T00:00:00Z',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 14000, ebitda_usd_mn: 3400, ev_usd_mn: 40000 },
    ],
  },
  {
    entry_id: 9030,
    target: 'Powertech Technology Inc.',
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
    banker_source: 'Mandiri Sekuritas',
    remarks: 'Seed: building materials teaser from Mandiri; strong order book from developer clients.',
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
    banker_source: 'CIMB',
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
    banker_source: 'UBS',
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
    banker_source: 'Deutsche Bank',
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
    banker_source: 'JP Morgan',
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
    banker_source: 'Macquarie',
    remarks: 'Seed: upstream services with long-term Pertamina contracts; owner exploring exit.',
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
    banker: 'Morgan Stanley',
    advisor: 'Morgan Stanley',
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
    banker: 'Goldman Sachs',
    advisor: 'Goldman Sachs',
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
    banker: 'Citigroup',
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
    banker: 'HSBC',
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
    target: 'Pelindo Freight Terminals',
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
    target: 'Vincem Cement Holdings',
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
    banker_source: 'CLSA',
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
    banker_source: 'Tiger Securities',
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
    banker_source: 'Danareksa',
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
    banker: 'Goldman Sachs',
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
    banker: 'JP Morgan',
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
      'Banker email from JP Morgan on Project Bold valuation expectations and process timing.',
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
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: 'Test User', password: passwordHash, role: SEED_USER_ROLE },
      })
      .returning({ id: users.id });
    if (!seedUser) throw new Error('failed to upsert seed user');
    console.log(`  ✓ user ${SEED_USER_EMAIL} (password: ${SEED_USER_PASSWORD}, role: ${SEED_USER_ROLE})`);

    // Companies — clear prior seed rows (identified by entry_id range), re-insert.
    // company_financials and user_company_favorites rows cascade on company delete.
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
        })
        .returning({ id: companies.id });
      if (!inserted) continue;
      insertedCompanies.push({ entry_id: c.entry_id, id: inserted.id });
      if (c.financials.length > 0) {
        await db.insert(companyFinancials).values(
          c.financials.map((f) => ({
            company_id: inserted.id,
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
        };
      }),
    );
    console.log(`  ✓ ${seedAfdFiles.length} AI File Dump files`);

    // Favorites — link the seed user to a subset of the seeded companies via the
    // user_company_favorites join table (replaces the removed users.favorite_companies jsonb).
    const favoriteCompanyIds = insertedCompanies
      .filter((c) => SEED_FAVORITE_ENTRY_IDS.includes(c.entry_id))
      .map((c) => c.id);
    if (favoriteCompanyIds.length > 0) {
      await db
        .delete(userCompanyFavorites)
        .where(
          and(
            eq(userCompanyFavorites.user_id, seedUser.id),
            inArray(userCompanyFavorites.company_id, favoriteCompanyIds),
          ),
        );
      await db.insert(userCompanyFavorites).values(
        favoriteCompanyIds.map((company_id) => ({
          user_id: seedUser.id,
          company_id,
        })),
      );
      console.log(`  ✓ ${favoriteCompanyIds.length} user_company_favorites for seed user`);
    }

    // Investment thesis — single seed thesis, identified by title.
    await db
      .delete(investmentThesis)
      .where(eq(investmentThesis.title, seedThesis.title));
    const [insertedThesis] = await db
      .insert(investmentThesis)
      .values(seedThesis)
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

    await db.insert(correspondents).values(correspondentRows);
    console.log(
      `  ✓ ${insertedEmployers.length} employers + ${correspondentRows.length} correspondents`,
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
      .returning({ id: employers.id });
    if (!avEmployer) throw new Error('failed to insert AUTO VEHICLE employer');

    const avContacts = [
      {
        name: 'Ahmad Pratama',
        email: 'ahmad.pratama@autovehicle.co.id',
        title: 'Head of Corporate Development',
        phone: '+62 21 555 0201',
        is_primary: true,
      },
      {
        name: 'Siti Rahayu',
        email: 'siti.rahayu@autovehicle.co.id',
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

    const INTERNAL = { name: 'Amanda Wijaya', email: 'amanda.wijaya@starcapital.com' };
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
        body: 'Hi Amanda, Following up on our brief call last week, I would like to schedule a deeper conversation about strategic options for AUTO VEHICLE. Best, Ahmad.',
        from: { name: PIC.name, email: PIC.email },
        to: [INTERNAL],
        direction: 'inbound',
        daysOffset: 0,
      },
      {
        idx: 2,
        subject: 'RE: Introduction — AUTO VEHICLE × Star Capital',
        body: 'Hi Ahmad, Thanks for reaching out. Let us set up a call next Tuesday at 10am SGT. I will send an invite. — Amanda',
        from: INTERNAL,
        to: [{ name: PIC.name, email: PIC.email }],
        cc: [{ name: SECONDARY.name, email: SECONDARY.email }],
        direction: 'outbound',
        daysOffset: 1,
      },
      {
        idx: 3,
        subject: 'AUTO VEHICLE — FY2025 financials',
        body: 'Amanda, Please find attached our FY2025 financials (unaudited). Revenue grew 18% YoY to USD 42M. Happy to walk through. — Siti',
        from: { name: SECONDARY.name, email: SECONDARY.email },
        to: [INTERNAL],
        cc: [{ name: PIC.name, email: PIC.email }],
        direction: 'inbound',
        daysOffset: 5,
      },
      {
        idx: 4,
        subject: 'NDA draft for AUTO VEHICLE discussions',
        body: 'Ahmad, Attaching our standard NDA for your review. Once executed we can proceed to share the CIM. — Amanda',
        from: INTERNAL,
        to: [{ name: PIC.name, email: PIC.email }],
        direction: 'outbound',
        daysOffset: 9,
      },
      {
        idx: 5,
        subject: 'Signed NDA — AUTO VEHICLE',
        body: 'Amanda, Signed NDA attached. Looking forward to next steps. — Ahmad',
        from: { name: PIC.name, email: PIC.email },
        to: [INTERNAL],
        direction: 'inbound',
        daysOffset: 12,
      },
    ];

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
      `  ✓ AUTO VEHICLE: 1 employer + ${insertedAvCorrespondents.length} mbox correspondents + ${insertedAvEmails.length} emails + ${avParticipantRows.length} participants`,
    );

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
