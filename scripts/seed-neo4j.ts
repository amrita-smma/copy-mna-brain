/**
 * Seeds company relationships into Neo4j, synced to the Postgres dev seed.
 *
 * Nodes are NOT hardcoded here — they are loaded from the companies Postgres
 * seed (`scripts/seed.ts`, entry_id range 9001–9999) and keyed by the same
 * Postgres UUID that `CompanyGraphService.syncFromDatabase` uses. That keeps the
 * graph consistent with a database→graph reconciliation: the nodes this seeder
 * writes line up with the nodes the sync job would upsert, so edges survive a
 * later sync instead of being pruned.
 *
 * Edges are declared against stable `entry_id`s (below) and resolved to UUIDs at
 * runtime. Run the Postgres seed first, then this script:
 *
 *   pnpm db:seed
 *   pnpm db:seed:neo4j
 *
 * Idempotent: clears all nodes/relations before inserting.
 */
import { config } from 'dotenv';
// Must call config() before dynamically importing db.ts — static imports are
// hoisted in CJS output, so db.ts's module-level client creation would run
// before dotenv if we used a static import here.
config({ path: '.env.local' });
config();

import neo4j from 'neo4j-driver';
import { and, gte, lte } from 'drizzle-orm';
import {
  companyRowToGraphNode,
  type CompanyNode,
  type RelationType,
} from '../src/lib/repositories/companyRelationRepository';

const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
const user = process.env.NEO4J_USER ?? 'neo4j';
const password = process.env.NEO4J_PASSWORD ?? 'password';

// Mirror of seed.ts's tagged range so we only pull the dev-seed companies.
const SEED_ENTRY_ID_MIN = 9001;
const SEED_ENTRY_ID_MAX = 9999;

/**
 * Relationships declared against the Postgres seed's stable `entry_id`s. These
 * are resolved to company UUIDs at runtime; any edge whose endpoints aren't in
 * the seed is skipped with a warning. Topology follows the seeded companies:
 * a semiconductor supply chain (9015–9030) plus the general pipeline (9001–9014).
 */
type SeedRelation = {
  sourceEntryId: number;
  targetEntryId: number;
  type: RelationType;
  notes?: string;
  evidence?: string;
  date?: string;
};

const seedRelations: SeedRelation[] = [
  // ── Semiconductor materials & equipment → UMC foundry (9027) ──────────────
  {
    sourceEntryId: 9029, // Shin-Etsu Chemical
    targetEntryId: 9027, // UMC
    type: 'SUPPLIER',
    notes: 'Long-term 300mm silicon wafer supply agreement',
    evidence: 'Master supply agreement, 5-year term',
    date: '2024-02-15',
  },
  {
    sourceEntryId: 9015, // Soulbrain
    targetEntryId: 9027, // UMC
    type: 'SUPPLIER',
    notes: 'Ultra-pure wet process chemicals for advanced nodes',
    date: '2023-09-01',
  },
  {
    sourceEntryId: 9016, // Stella Chemifa
    targetEntryId: 9027, // UMC
    type: 'SUPPLIER',
    notes: 'High-purity hydrofluoric acid for etch processes',
    date: '2023-11-20',
  },
  {
    sourceEntryId: 9018, // ENF Technology
    targetEntryId: 9027, // UMC
    type: 'SUPPLIER',
    notes: 'ArF/KrF photoresist and thinner supply',
    date: '2024-01-10',
  },
  {
    sourceEntryId: 9019, // Kanto Denka Kogyo
    targetEntryId: 9027, // UMC
    type: 'SUPPLIER',
    notes: 'WF6 and NF3 electronic specialty gas supply',
    date: '2023-06-05',
  },
  {
    sourceEntryId: 9022, // Wonik IPS
    targetEntryId: 9027, // UMC
    type: 'SUPPLIER',
    notes: 'CVD/ALD deposition tool installation',
    evidence: 'Equipment PO #WIP-2024-117',
    date: '2024-03-22',
  },

  // ── Foundry → OSAT, and materials/inspection → OSAT ───────────────────────
  {
    sourceEntryId: 9027, // UMC
    targetEntryId: 9024, // ASE
    type: 'SUPPLIER',
    notes: 'Fabricated wafers feeding assembly & test',
    date: '2024-04-01',
  },
  {
    sourceEntryId: 9017, // Fuji Electronic Materials
    targetEntryId: 9024, // ASE
    type: 'SUPPLIER',
    notes: 'CMP slurries for advanced packaging',
    date: '2023-08-14',
  },
  {
    sourceEntryId: 9028, // ViTrox
    targetEntryId: 9024, // ASE
    type: 'SUPPLIER',
    notes: 'Automated optical inspection systems',
    date: '2024-02-28',
  },
  {
    sourceEntryId: 9023, // Daejoo Electronic Materials
    targetEntryId: 9030, // Powertech
    type: 'SUPPLIER',
    notes: 'CMP slurry and conductive paste materials',
    date: '2023-10-30',
  },

  // ── Partnerships & investments across the semiconductor cluster ───────────
  {
    sourceEntryId: 9024, // ASE
    targetEntryId: 9025, // Greatek
    type: 'PARTNER',
    notes: 'Joint advanced packaging capacity development',
    evidence: 'https://example.com/ase-greatek-jv',
    date: '2024-05-12',
  },
  {
    sourceEntryId: 9024, // ASE
    targetEntryId: 9030, // Powertech
    type: 'INVESTED_IN',
    notes: 'Strategic minority stake in memory packaging capacity',
    evidence: 'Deal memo #2024-204',
    date: '2024-06-01',
  },
  {
    sourceEntryId: 9026, // Inari Amertron
    targetEntryId: 9024, // ASE
    type: 'PARTNER',
    notes: 'RF assembly capacity sharing for mobile',
    date: '2024-03-05',
  },
  {
    sourceEntryId: 9020, // PT INTI
    targetEntryId: 9021, // Polytron
    type: 'PARTNER',
    notes: 'Indonesian electronics manufacturing collaboration',
    date: '2024-04-18',
  },

  // ── General pipeline cluster (9001–9014) ──────────────────────────────────
  {
    sourceEntryId: 9001, // Project Atlas
    targetEntryId: 9014, // Northwind Robotics
    type: 'INVESTED_IN',
    notes: 'Strategic stake in warehouse robotics arm',
    evidence: 'Internal deal memo #2024-031',
    date: '2024-02-20',
  },
  {
    sourceEntryId: 9002, // Blue Harbor Logistics
    targetEntryId: 9011, // Kestrel Cold Chain
    type: 'PARTNER',
    notes: 'Cold-chain last-mile co-distribution',
    date: '2024-01-15',
  },
  {
    sourceEntryId: 9005, // Ember Renewables
    targetEntryId: 9013, // Meridian Packaging
    type: 'SUPPLIER',
    notes: 'Rooftop solar power purchase agreement for packaging plants',
    evidence: '15-year power purchase agreement',
    date: '2023-12-01',
  },
  {
    sourceEntryId: 9007, // Project Gemini
    targetEntryId: 9012, // Lumen Diagnostics
    type: 'PARTNER',
    notes: 'Shared lab-as-a-service diagnostics network',
    date: '2024-03-30',
  },
];

/** The columns companyRowToGraphNode needs, loaded from the Postgres seed. */
type SeedCompanyRow = {
  id: string;
  entry_id: number | null;
  target: string | null;
  project_name: string | null;
  segment: string | null;
  geography: string | null;
  ownership: string | null;
};

async function loadSeededCompanies(): Promise<SeedCompanyRow[]> {
  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { companies } = await import('../src/lib/db/schema');

  const client = createPostgresClientFromEnv({ prepare: false, onnotice: () => {} });
  try {
    const db = drizzle(client);
    return await db
      .select({
        id: companies.id,
        entry_id: companies.entry_id,
        target: companies.target,
        project_name: companies.project_name,
        segment: companies.segment,
        geography: companies.geography,
        ownership: companies.ownership,
      })
      .from(companies)
      .where(
        and(
          gte(companies.entry_id, SEED_ENTRY_ID_MIN),
          lte(companies.entry_id, SEED_ENTRY_ID_MAX),
        ),
      );
  } finally {
    await client.end();
  }
}

async function seed() {
  console.log(
    `Loading seeded companies from ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'}…`,
  );
  const rows = await loadSeededCompanies();
  if (rows.length === 0) {
    throw new Error(
      `No seeded companies found in entry_id range ${SEED_ENTRY_ID_MIN}-${SEED_ENTRY_ID_MAX}. ` +
        'Run `pnpm db:seed` before `pnpm db:seed:neo4j`.',
    );
  }
  console.log(`  ✓ loaded ${rows.length} companies`);

  // entry_id → Postgres UUID, used to resolve the declared edges. Rows without
  // an entry_id (shouldn't happen in-range) are simply not addressable by edge.
  const idByEntryId = new Map<number, string>();
  for (const row of rows) {
    if (row.entry_id != null) idByEntryId.set(row.entry_id, row.id);
  }

  // Nodes are produced by the SAME mapper the sync job uses, keyed by UUID.
  const nodes: CompanyNode[] = rows.map(companyRowToGraphNode);

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    await driver.verifyConnectivity();
    console.log('Connected to Neo4j at', uri);

    const session = driver.session();
    try {
      console.log('Clearing existing data…');
      await session.run('MATCH (n) DETACH DELETE n');

      console.log(`Inserting ${nodes.length} company nodes…`);
      await session.run(
        `UNWIND $rows AS row
         CREATE (c:Company {id: row.id, name: row.name, segment: row.segment,
                            industry: row.industry, geography: row.geography,
                            ownership: row.ownership})`,
        {
          rows: nodes.map((n) => ({
            id: n.id,
            name: n.name,
            segment: n.segment ?? null,
            industry: n.industry ?? null,
            geography: n.geography ?? null,
            ownership: n.ownership ?? null,
          })),
        },
      );

      console.log(`Inserting relations (from ${seedRelations.length} declared)…`);
      let inserted = 0;
      for (const rel of seedRelations) {
        const sourceId = idByEntryId.get(rel.sourceEntryId);
        const targetId = idByEntryId.get(rel.targetEntryId);
        if (!sourceId || !targetId) {
          console.warn(
            `  ⚠ skipped ${rel.sourceEntryId} -[${rel.type}]-> ${rel.targetEntryId} ` +
              '(endpoint not in seed)',
          );
          continue;
        }
        // Relation type is a controlled enum — safe to interpolate.
        await session.run(
          `MATCH (a:Company {id: $sourceId}), (b:Company {id: $targetId})
           CREATE (a)-[:${rel.type} {notes: $notes, evidence: $evidence, date: $date}]->(b)`,
          {
            sourceId,
            targetId,
            notes: rel.notes ?? null,
            evidence: rel.evidence ?? null,
            date: rel.date ?? null,
          },
        );
        inserted += 1;
        console.log(`  ${rel.sourceEntryId} -[${rel.type}]-> ${rel.targetEntryId}`);
      }

      console.log(`\nSeed complete. ${nodes.length} nodes, ${inserted} relations.`);
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
