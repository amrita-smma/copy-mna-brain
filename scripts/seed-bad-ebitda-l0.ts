/**
 * Local dev seeder for L0 companies with clearly bad EBITDA profiles — the
 * kind a reviewer should REJECT when the workforce agent proposes a promotion
 * to L1. Used to manually test the HITL "Why" block (see promote_to_l1 tool
 * + traceMapper.deriveInterventionProposal).
 *
 * Each profile is intentionally distinct so a single test session can exercise
 * multiple rejection signals (negative EBITDA, margin collapse, revenue
 * decline, sub-scale, one-time-gain mask).
 *
 * Idempotent: re-running wipes prior bad-EBITDA rows (tagged by entry_id in
 * the 8901–8999 range) and reinserts. Lives outside the main seed.ts range
 * (9001–9999) so `pnpm db:seed` does NOT wipe these — run this script
 * separately to refresh the test set.
 *
 * Usage: pnpm db:seed:bad-ebitda
 */
import { config } from 'dotenv';
// Must call config() before dynamically importing db.ts — see seed.ts.
config({ path: '.env.local' });
config();

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, gte, lte } from 'drizzle-orm';
import { companies, companyFinancials } from '../src/lib/db/schema';

const SEED_ENTRY_ID_MIN = 8901;
const SEED_ENTRY_ID_MAX = 8999;

type BadEbitdaCompany = {
  entry_id: number;
  target?: string;
  project_name?: string;
  segment: string;
  company_focus: string;
  website: string;
  geography: string;
  ownership: string;
  watchlist_status: string;
  // One-line summary of WHY a reviewer should reject this promotion. Not
  // persisted on the row itself — purely for whoever's reading this file.
  rejection_signal: string;
  financials: Array<{
    fiscal_year: number;
    revenue_usd_mn?: number;
    ebitda_usd_mn?: number;
    ev_usd_mn?: number;
  }>;
};

const badEbitdaCompanies: BadEbitdaCompany[] = [
  {
    entry_id: 8901,
    target: 'Aether Robotics',
    project_name: 'Project Aether',
    segment: 'Industrial Automation',
    company_focus: 'Collaborative robots for SMB metalworking shops',
    website: 'https://aether-robotics.example',
    geography: 'Indonesia',
    ownership: 'VC-backed',
    watchlist_status: 'Monitoring',
    rejection_signal:
      'Negative EBITDA across all 4 years and widening — losses growing faster than revenue.',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 8.2, ebitda_usd_mn: -1.2 },
      { fiscal_year: 2023, revenue_usd_mn: 12.4, ebitda_usd_mn: -2.4 },
      { fiscal_year: 2024, revenue_usd_mn: 18.1, ebitda_usd_mn: -4.1, ev_usd_mn: 95 },
      { fiscal_year: 2025, revenue_usd_mn: 24.3, ebitda_usd_mn: -5.8 },
    ],
  },
  {
    entry_id: 8902,
    target: 'Bramble Foods',
    segment: 'F&B / Packaged Goods',
    company_focus: 'Shelf-stable ready meals for convenience retail',
    website: 'https://bramblefoods.example',
    geography: 'Malaysia',
    ownership: 'Family-owned',
    watchlist_status: 'Active',
    rejection_signal:
      'EBITDA margin collapsing — 12% → 7% → 3% → 0.4% over 4 years despite flat revenue growth.',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 42.0, ebitda_usd_mn: 5.1, ev_usd_mn: 165 },
      { fiscal_year: 2023, revenue_usd_mn: 45.3, ebitda_usd_mn: 3.2 },
      { fiscal_year: 2024, revenue_usd_mn: 48.1, ebitda_usd_mn: 1.4, ev_usd_mn: 130 },
      { fiscal_year: 2025, revenue_usd_mn: 51.0, ebitda_usd_mn: 0.2 },
    ],
  },
  {
    entry_id: 8903,
    target: 'Cascade Freight',
    project_name: 'Project Cascade',
    segment: 'Freight Forwarding',
    company_focus: 'Domestic LTL trucking aggregator',
    website: 'https://cascadefreight.example',
    geography: 'Philippines',
    ownership: 'PE-backed',
    watchlist_status: 'Monitoring',
    rejection_signal:
      'Revenue declining YoY (-18% then -21%) and EBITDA flipped negative in FY2024 — wrong direction on both axes.',
    financials: [
      { fiscal_year: 2023, revenue_usd_mn: 34.2, ebitda_usd_mn: 2.1 },
      { fiscal_year: 2024, revenue_usd_mn: 28.1, ebitda_usd_mn: -0.8, ev_usd_mn: 78 },
      { fiscal_year: 2025, revenue_usd_mn: 22.3, ebitda_usd_mn: -2.9 },
    ],
  },
  {
    entry_id: 8904,
    target: 'Drift Apparel',
    segment: 'Consumer / Apparel',
    company_focus: 'DTC streetwear brand, single-channel online',
    website: 'https://driftapparel.example',
    geography: 'Vietnam',
    ownership: 'Founder-owned',
    watchlist_status: 'Monitoring',
    rejection_signal:
      'Sub-scale (<$10M revenue, well below thesis floor) and razor-thin margins (~3%) — no operating leverage at this size.',
    financials: [
      { fiscal_year: 2024, revenue_usd_mn: 4.2, ebitda_usd_mn: 0.1 },
      { fiscal_year: 2025, revenue_usd_mn: 5.8, ebitda_usd_mn: 0.2 },
    ],
  },
  {
    entry_id: 8905,
    target: 'Ember Labs',
    project_name: 'Project Ember',
    segment: 'Chemical / Specialty',
    company_focus: 'Contract R&D services for specialty polymers',
    website: 'https://emberlabs.example',
    geography: 'Thailand',
    ownership: 'Private',
    watchlist_status: 'Active',
    rejection_signal:
      'FY2024 EBITDA bump ($2.9M) appears to mask the trend — other years cluster around break-even. Likely one-time gain on asset sale (per public filings); underlying business is not consistently profitable.',
    financials: [
      { fiscal_year: 2022, revenue_usd_mn: 19.4, ebitda_usd_mn: 0.4 },
      { fiscal_year: 2023, revenue_usd_mn: 21.1, ebitda_usd_mn: -0.3 },
      { fiscal_year: 2024, revenue_usd_mn: 23.2, ebitda_usd_mn: 2.9, ev_usd_mn: 110 },
      { fiscal_year: 2025, revenue_usd_mn: 25.0, ebitda_usd_mn: 0.1 },
    ],
  },
];

async function main() {
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(client);

  console.log(
    `seeding bad-EBITDA L0 companies → ${process.env.DB_HOST}:${
      process.env.DB_PORT ?? '5432'
    }`,
  );

  try {
    // Clear any prior bad-EBITDA seed rows (cascades wipe financials).
    await db
      .delete(companies)
      .where(
        and(
          gte(companies.entry_id, SEED_ENTRY_ID_MIN),
          lte(companies.entry_id, SEED_ENTRY_ID_MAX),
        ),
      );

    for (const c of badEbitdaCompanies) {
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
          pipeline_stage: 'L0',
          status: 'active',
          watchlist_status: c.watchlist_status,
        })
        .returning({ id: companies.id });
      if (!inserted) continue;
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
      const label = c.target ?? c.project_name ?? `entry_id ${c.entry_id}`;
      console.log(`  ✓ ${label} — ${c.rejection_signal}`);
    }

    console.log(
      `\nDone. ${badEbitdaCompanies.length} L0 companies inserted in entry_id range ${SEED_ENTRY_ID_MIN}-${SEED_ENTRY_ID_MAX}.`,
    );
    console.log(
      `Try promoting any of them from the CoPilot chat to exercise the HITL "Why" block.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
