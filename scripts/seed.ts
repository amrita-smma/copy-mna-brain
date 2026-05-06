/**
 * Local dev seed. Idempotent: re-running wipes prior seed rows (tagged by
 * entry_id in the 9001–9999 range and the fixed test-user email) and reinserts.
 * Not for production.
 *
 * Usage: pnpm db:seed
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import postgres from 'postgres';
import {
  companies,
  companyFinancials,
  contacts,
  criterias,
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
  company: string;
  title: string;
  type: 'internal' | 'external';
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
  pipeline_stage: 'market_screening' | 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  status: 'active' | 'dropped';
  watchlist_status: string;
  dropped_reason?: string;
  dropped_at?: string;
  financials: Array<{
    fiscal_year: number;
    revenue_usd_mn?: number;
    ebitda_usd_mn?: number;
    ev_usd_mn?: number;
  }>;
};

const seedCompanies: SeedCompany[] = [
  {
    entry_id: 9001,
    project_name: 'Project Atlas',
    segment: 'Industrial Automation',
    company_focus: 'Factory-floor robotic arms for SMB manufacturers',
    website: 'https://acme-robotics.example',
    geography: 'USA',
    ownership: 'Private',
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
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
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
    pipeline_stage: 'L2',
    status: 'active',
    watchlist_status: 'Active',
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
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
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
    pipeline_stage: 'L1',
    status: 'active',
    watchlist_status: 'Active',
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
    pipeline_stage: 'market_screening',
    status: 'dropped',
    watchlist_status: 'Dropped',
    dropped_reason:
      'Revenue below thesis floor (<$10M) and consumer apparel sits outside our industrial/logistics focus.',
    dropped_at: '2026-03-04T11:15:00Z',
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
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const isLocal = /127\.0\.0\.1|localhost/.test(url);
  const client = postgres(url, {
    max: 1,
    prepare: false,
    ssl: isLocal ? false : 'require',
    onnotice: () => {},
  });
  const db = drizzle(client);

  console.log(`seeding ${new URL(url).host}...`);

  try {
    // Users — remove any prior seed user (cascades favorites/assignees), then insert fresh.
    await db.delete(users).where(eq(users.email, SEED_USER_EMAIL));
    const passwordHash = await hashPassword(SEED_USER_PASSWORD);
    const [seedUser] = await db
      .insert(users)
      .values({
        name: 'Test User',
        email: SEED_USER_EMAIL,
        password: passwordHash,
        role: SEED_USER_ROLE,
      })
      .returning({ id: users.id });
    if (!seedUser) throw new Error('failed to insert seed user');
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
          watchlist_status: c.watchlist_status,
          dropped_reason: c.dropped_reason ?? null,
          dropped_at: c.dropped_at ?? null,
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
    console.log(`  ✓ ${seedCompanies.length} companies (+ financials)`);

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
    await db.insert(investmentThesis).values(seedThesis);
    console.log(`  ✓ investment_thesis "${seedThesis.title}"`);

    // Criterias — three seed criterias, identified by name.
    const seedCriteriaNames = seedCriterias.map((c) => c.name);
    await db
      .delete(criterias)
      .where(inArray(criterias.name, seedCriteriaNames));
    await db.insert(criterias).values(seedCriterias);
    console.log(`  ✓ ${seedCriterias.length} criterias`);

    // Contacts — seed contacts, identified by email.
    const seedContactEmails = seedContacts.map((c) => c.email);
    await db
      .delete(contacts)
      .where(inArray(contacts.email, seedContactEmails));
    await db.insert(contacts).values(seedContacts);
    console.log(`  ✓ ${seedContacts.length} contacts`);

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
