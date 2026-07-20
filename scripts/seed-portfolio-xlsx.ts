/**
 * Portfolio seed from the STARTECH Quarterly Reporting workbook.
 *
 * Reads every per-company sheet in the workbook, and for each one injects a
 * fund_assets row plus its full fund_asset_transactions ledger, auto-wiring
 * each asset/transaction to:
 *   - a fund            (funds)            — derived from the holding entity:
 *                                            Meranti Global Investment Ltd -> Meranti 1,
 *                                            other Meranti -> Meranti 2,
 *                                            Startech Growth Fund VCC -> Startech Growth Fund 1,
 *                                            everything else -> Others
 *   - a holding entity  (holding_entities) — the sheet's "Investment Entity" (G8)
 *   - a source of funds (funding_sources)  — the sheet's "Funding Source"    (G9)
 *
 * The full 8-fund catalog (Startech Growth Fund 1-5, Meranti 1, Meranti 2,
 * Others) is always created, even when some funds end up empty.
 *
 * Funds / holding entities / funding sources are get-or-created by name within
 * the target workspace, so re-running (or running alongside `pnpm db:seed`)
 * reuses existing rows instead of duplicating them. Assets are keyed by a
 * deterministic UUID derived from the sheet code, so a re-run replaces the same
 * asset rows (cascading their transactions) rather than piling up duplicates.
 *
 * Rollups (gross_moic / invested_capital_amount / dpi / fund called_amount /
 * ...) are left for FundMetricsService to derive from the ledger after insert,
 * exactly like the create-asset flow in the app.
 *
 * The following sheets are skipped (non-asset tabs, per request):
 *   Output, PPT Tables, Structure, Master Data >>, Consolidated Data >>,
 *   Appendix, Portfolio Accts
 * plus the "Company A" template, the "40Strand" summary tab, and the "*X"
 * backup copies of each company sheet (identified by a broken Reporting Date).
 *
 * Usage:
 *   pnpm tsx scripts/seed-portfolio-xlsx.ts [path-to-xlsx]
 *   pnpm tsx scripts/seed-portfolio-xlsx.ts --dry-run
 *   pnpm tsx scripts/seed-portfolio-xlsx.ts --slug=<workspace-slug>
 *   pnpm tsx scripts/seed-portfolio-xlsx.ts --workspace-id=<uuid>
 *   PORTFOLIO_XLSX=/path/to/file.xlsx pnpm tsx scripts/seed-portfolio-xlsx.ts
 *   PORTFOLIO_WORKSPACE_SLUG=<slug> pnpm tsx scripts/seed-portfolio-xlsx.ts
 *   PORTFOLIO_WORKSPACE_ID=<uuid> pnpm tsx scripts/seed-portfolio-xlsx.ts
 *
 * Target workspace precedence: --slug / PORTFOLIO_WORKSPACE_SLUG (looked up in
 * the DB) > --workspace-id / PORTFOLIO_WORKSPACE_ID > MNA_WORKSPACE_ID.
 *
 * Not for production. Parsing lives in
 * `src/lib/fund_updates/parsers/startech_quarterly.ts` — this script is the
 * CLI + DB seed wrapper around that shared parser.
 */
import { config } from 'dotenv';
// Load env before importing db.ts (its module-level client reads process.env).
config({ path: '.env.local' });
config();

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';

import {
  fundAssetTransactions,
  fundAssetValuations,
  fundAssets,
  fundingSources,
  funds,
  holdingEntities,
  workspaces,
} from '../src/lib/db/schema';
import type { AssetTypeDetails } from '../src/lib/db/schema';
import { createContainer } from '../src/lib/services';
import type { DbClient } from '../src/lib/server/db';
import { MNA_WORKSPACE_ID } from '../src/lib/constants';
import {
  FUND_CATALOG,
  parseWorkbook,
  type ParsedAsset,
} from '../src/lib/fund_updates/parsers/startech_quarterly';


// ---- Config ----

const DEFAULT_XLSX = path.join(
  homedir(),
  'Documents',
  'STARTECH - 2Q26 Portfolio Database Quarterly Reporting v2.xlsx',
);
const ARGS = process.argv.slice(2);

/** Reads a `--name=value` flag (the `=` form avoids clashing with the
 * positional workbook path, which is the only non-`--` argument). */
function argValue(name: string): string | undefined {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const DRY_RUN = ARGS.includes('--dry-run') || process.env.PORTFOLIO_DRY_RUN === '1';
const XLSX_PATH =
  ARGS.find((a) => !a.startsWith('--')) ?? process.env.PORTFOLIO_XLSX ?? DEFAULT_XLSX;

// Target workspace, resolved in this order of precedence:
//   1. --slug=<slug>            / PORTFOLIO_WORKSPACE_SLUG  (looked up in the DB)
//   2. --workspace-id=<uuid>    / PORTFOLIO_WORKSPACE_ID
//   3. MNA_WORKSPACE_ID (default)
const WORKSPACE_SLUG = argValue('slug') ?? process.env.PORTFOLIO_WORKSPACE_SLUG ?? null;
const WORKSPACE_ID =
  argValue('workspace-id') ?? process.env.PORTFOLIO_WORKSPACE_ID ?? MNA_WORKSPACE_ID;

// Deterministic UUIDs so a re-run replaces the same rows. Not a real v5 UUID,
// just a stable, syntactically valid UUID derived from a namespaced key.
function detUuid(kind: string, key: string): string {
  const h = createHash('md5').update(`startech-portfolio:${kind}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---- Seeding ----

/** Case-insensitive get-or-create by name; reuses existing workspace rows. */
async function makeNameResolver(
  db: ReturnType<typeof drizzle>,
  table: typeof holdingEntities | typeof fundingSources | typeof funds,
  kind: string,
  workspaceId: string,
) {
  const existing = (await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(eq(table.workspace_id, workspaceId))) as Array<{ id: string; name: string }>;
  const byName = new Map<string, string>();
  for (const row of existing) byName.set(row.name.trim().toLowerCase(), row.id);

  const toInsert: Array<{ id: string; workspace_id: string; name: string }> = [];
  const resolve = (name: string): string => {
    const key = name.trim().toLowerCase();
    let id = byName.get(key);
    if (!id) {
      id = detUuid(kind, `${workspaceId}:${key}`);
      byName.set(key, id);
      toInsert.push({ id, workspace_id: workspaceId, name: name.trim() });
    }
    return id;
  };
  const flush = async () => {
    if (toInsert.length > 0) {
      await db.insert(table).values(toInsert as never).onConflictDoNothing();
    }
    return toInsert.length;
  };
  return { resolve, flush };
}

async function seedPortfolio(db: DbClient, workspaceId: string, assets: ParsedAsset[]) {
  const rawDb = db as unknown as ReturnType<typeof drizzle>;

  // Resolve funds / holding entities / funding sources (reuse or create).
  const fundResolver = await makeNameResolver(rawDb, funds, 'fund', workspaceId);
  const entityResolver = await makeNameResolver(rawDb, holdingEntities, 'holding_entity', workspaceId);
  const sourceResolver = await makeNameResolver(rawDb, fundingSources, 'funding_source', workspaceId);

  // Always materialize the full fund catalog (some may stay empty).
  const fundIdByName = new Map<string, string>();
  for (const name of FUND_CATALOG) fundIdByName.set(name, fundResolver.resolve(name));

  for (const a of assets) {
    if (a.entity) entityResolver.resolve(a.entity);
    if (a.fundingSource) sourceResolver.resolve(a.fundingSource);
  }

  const newFunds = await fundResolver.flush();
  const newEntities = await entityResolver.flush();
  const newSources = await sourceResolver.flush();

  // Replace previously-seeded assets (cascades their transactions/valuations).
  const assetIds = assets.map((a) => detUuid('asset', `${workspaceId}:${a.code}`));
  await rawDb.delete(fundAssets).where(inArray(fundAssets.id, assetIds));

  // Insert assets.
  const assetRows = assets.map((a) => {
    // Optional enrichment shared across asset types (from Structure/Appendix).
    const shared = {
      investingEntity: a.entity ?? undefined,
      dealType: a.dealType ?? undefined,
      sourceRef: a.sourceRef ?? undefined,
      vintageYear: a.vintageYear ?? undefined,
      sheetCode: a.code,
    };
    const typeDetails: AssetTypeDetails =
      a.assetType === 'fund_of_funds'
        ? { targetFundName: a.name, ...shared }
        : {
            instrumentType: 'equity',
            ...shared,
            shareClass: a.instrument ?? undefined,
            sharesOutstanding: a.sharesOutstanding ?? undefined,
          };
    return {
      id: detUuid('asset', `${workspaceId}:${a.code}`),
      workspace_id: workspaceId,
      asset_type: a.assetType,
      asset_name: a.name,
      legal_name: a.legalName,
      country: a.country,
      funding_source: a.fundingSourceRaw,
      investment_type: a.investmentTypeLabel,
      entry_date: a.entryDate,
      stake_pct: a.stakePct,
      commitment_amount: a.commitmentAmount,
      mgmt_fee_rate_pct: a.mgmtFeeRatePct,
      sector: a.sector,
      sub_sector: a.subSector,
      current_price_per_share: a.currentPricePerShare,
      investment_currency: 'USD',
      report_currency: 'USD',
      type_details: typeDetails,
      status: 'active' as const,
    };
  });
  await rawDb.insert(fundAssets).values(assetRows as never);

  // Insert transactions, each wired to fund + holding entity + funding source.
  const txnRows: Array<Record<string, unknown>> = [];
  for (const a of assets) {
    const fundId = fundIdByName.get(a.fund)!;
    const holdingEntityId = a.entity ? entityResolver.resolve(a.entity) : null;
    const fundingSourceId = a.fundingSource ? sourceResolver.resolve(a.fundingSource) : null;
    const assetId = detUuid('asset', `${workspaceId}:${a.code}`);
    for (const t of a.txns) {
      txnRows.push({
        fund_asset_id: assetId,
        fund_id: fundId,
        holding_entity_id: holdingEntityId,
        funding_source_id: fundingSourceId,
        txn_date: t.date,
        txn_type: t.type,
        sub_type_label: t.subTypeLabel,
        price_per_share: t.pricePerShare,
        share_count: t.shareCount,
        value_amount: t.valueAmount,
        txn_currency: t.currency,
        fx_rate: t.fxRate,
        notes: t.notes,
      });
    }
  }
  await rawDb.insert(fundAssetTransactions).values(txnRows as never);

  // Insert Market Value Tracker marks (quarterly valuations). These feed the
  // unrealized-value fallback in FundMetricsService, so they must land before
  // the recompute pass below.
  const valuationRows: Array<Record<string, unknown>> = [];
  for (const a of assets) {
    const assetId = detUuid('asset', `${workspaceId}:${a.code}`);
    for (const v of a.valuations) {
      valuationRows.push({
        fund_asset_id: assetId,
        as_of_date: v.asOfDate,
        period_label: v.periodLabel,
        valuation_method: v.valuationMethod,
        currency: 'USD',
        market_value_amount: v.marketValue,
        price_per_share: v.pricePerShare,
        shares_outstanding: v.sharesOutstanding,
        shareholding_pct: v.shareholdingPct,
        invested_capital_cum_amount: v.investedCapitalCum,
        gross_moic: v.grossMoic,
        gross_xirr: v.grossXirr,
        notes: v.notes,
      });
    }
  }
  if (valuationRows.length > 0) {
    await rawDb.insert(fundAssetValuations).values(valuationRows as never);
  }

  // Derive rollups from the freshly-inserted ledger (asset first, which
  // cascades into the fund-level aggregate).
  const { fundMetricsService } = createContainer(db, workspaceId);
  for (const id of assetIds) {
    await fundMetricsService.recomputeAsset(id);
  }

  return {
    funds: fundIdByName.size,
    newFunds,
    assets: assetRows.length,
    txns: txnRows.length,
    valuations: valuationRows.length,
    newEntities,
    newSources,
  };
}

async function main() {
  console.log(`reading workbook: ${XLSX_PATH}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);

  const assets = parseWorkbook(wb);
  if (assets.length === 0) {
    throw new Error('No asset sheets parsed — check the workbook path / layout.');
  }

  const direct = assets.filter((a) => a.assetType === 'direct_investment').length;
  const fof = assets.length - direct;
  console.log(
    `parsed ${assets.length} assets (${direct} direct, ${fof} fund-of-funds), ` +
      `${assets.reduce((n, a) => n + a.txns.length, 0)} transactions, ` +
      `${assets.reduce((n, a) => n + a.valuations.length, 0)} valuations`,
  );

  if (DRY_RUN) {
    const entities = new Set<string>();
    const sources = new Set<string>();
    const byFund = new Map<string, number>(FUND_CATALOG.map((f) => [f, 0]));
    console.log('\n  code       fund                    entity / funding source                        txns');
    console.log('  ' + '-'.repeat(100));
    for (const a of assets) {
      if (a.entity) entities.add(a.entity);
      if (a.fundingSource) sources.add(a.fundingSource);
      byFund.set(a.fund, (byFund.get(a.fund) ?? 0) + 1);
      const conn = `${a.entity ?? '(none)'}  <-  ${a.fundingSource ?? '(none)'}`;
      console.log(
        `  ${a.code.padEnd(10)} ${a.fund.padEnd(23)} ${conn.padEnd(46)} ${String(a.txns.length).padStart(3)}`,
      );
    }
    console.log('\n  fund breakdown (full catalog, 0 = created empty):');
    for (const f of FUND_CATALOG) {
      console.log(`    ${f.padEnd(23)} ${String(byFund.get(f) ?? 0).padStart(3)} assets`);
    }

    // Enrichment coverage from the Structure / Appendix master tabs.
    const withStructure = assets.filter((a) => a.commitmentAmount != null || a.dealType != null || a.mgmtFeeRatePct != null);
    const withAppendix = assets.filter((a) => a.sourceRef != null);
    const noAppendix = assets.filter((a) => a.sourceRef == null).map((a) => a.code);
    console.log('\n  master-data enrichment:');
    console.log(`    Structure (commitment / deal / fee): ${withStructure.length}/${assets.length} assets`);
    console.log(`    Appendix  (class / instrument / vintage): ${withAppendix.length}/${assets.length} assets`);
    console.log(`    no Appendix match (${noAppendix.length}): ${noAppendix.join(', ')}`);
    console.log('\n  sample enriched rows:');
    for (const a of withAppendix.slice(0, 6)) {
      console.log(
        `    ${a.code.padEnd(8)} ${(a.sourceRef ?? '').padEnd(5)} ${(a.sector ?? '-').padEnd(4)}/${(a.subSector ?? '-').padEnd(6)} ` +
          `commit=${a.commitmentAmount ?? '-'} fee%=${a.mgmtFeeRatePct ?? '-'} deal=${a.dealType ?? '-'} ` +
          `instr=${a.instrument ?? '-'} vintage=${a.vintageYear ?? '-'}`,
      );
    }

    // Market Value Tracker coverage.
    const totalVals = assets.reduce((n, a) => n + a.valuations.length, 0);
    const withVals = assets.filter((a) => a.valuations.length > 0);
    const withMv = assets.filter((a) => a.valuations.some((v) => v.marketValue != null));
    const withPps = assets.filter((a) => a.valuations.some((v) => v.pricePerShare != null));
    const withShares = assets.filter((a) => a.valuations.some((v) => v.sharesOutstanding != null));
    const withCurPps = assets.filter((a) => a.currentPricePerShare != null);
    const noVals = assets.filter((a) => a.valuations.length === 0).map((a) => a.code);
    console.log('\n  market value tracker coverage:');
    console.log(`    ${totalVals} valuation rows across ${withVals.length}/${assets.length} assets`);
    console.log(`    with market value: ${withMv.length} · with PPS: ${withPps.length} · with shares: ${withShares.length} · current PPS set: ${withCurPps.length}`);
    console.log(`    no valuations (${noVals.length}): ${noVals.join(', ')}`);
    console.log('\n  sample valuations (latest row per asset):');
    for (const a of ['6EST', 'GOTO', 'ALTO', 'HRZN', 'CICL', 'ADVR']
      .map((c) => assets.find((x) => x.code === c))
      .filter((a): a is ParsedAsset => Boolean(a))) {
      const v = a.valuations[a.valuations.length - 1];
      if (!v) {
        console.log(`    ${a.code.padEnd(7)} (no valuations)`);
        continue;
      }
      console.log(
        `    ${a.code.padEnd(7)} ${v.asOfDate} ${v.periodLabel.padEnd(8)} mv=${v.marketValue ?? '-'} pps=${v.pricePerShare ?? '-'} ` +
          `sharesOut=${v.sharesOutstanding ?? '-'} stake%=${v.shareholdingPct ?? '-'} curPPS=${a.currentPricePerShare ?? '-'} (${a.valuations.length} rows)`,
      );
    }

    console.log(`\n  distinct holding entities (${entities.size}): ${[...entities].sort().join(' | ')}`);
    console.log(`  distinct funding sources (${sources.size}): ${[...sources].sort().join(' | ')}`);
    console.log(
      `\n  target workspace: ${WORKSPACE_SLUG ? `slug "${WORKSPACE_SLUG}" (resolved at run time)` : WORKSPACE_ID}`,
    );
    console.log('\n(dry run — no database writes)');
    return;
  }

  const { createPostgresClientFromEnv } = await import('../src/lib/server/db');
  const client = createPostgresClientFromEnv({ prepare: false, onnotice: () => {} });
  const db = drizzle(client);

  try {
    // Resolve the target workspace by slug when given, else fall back to the id.
    let workspaceId = WORKSPACE_ID;
    if (WORKSPACE_SLUG) {
      const [row] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.slug, WORKSPACE_SLUG))
        .limit(1);
      if (!row) {
        throw new Error(`No workspace found with slug "${WORKSPACE_SLUG}".`);
      }
      workspaceId = row.id;
      console.log(`resolved slug "${WORKSPACE_SLUG}" -> workspace ${row.name} (${workspaceId})`);
    }

    console.log(
      `seeding ${process.env.DB_HOST}:${process.env.DB_PORT ?? '5432'} (workspace ${workspaceId})...`,
    );

    const result = await seedPortfolio(db as unknown as DbClient, workspaceId, assets);
    console.log(
      `  ✓ Portfolio: ${result.assets} assets across ${result.funds} funds ` +
        `(${result.newFunds} new), ${result.txns} transactions, ${result.valuations} valuations; ` +
        `+${result.newEntities} holding entities, +${result.newSources} funding sources ` +
        `(rollups derived via FundMetricsService)`,
    );
    console.log('done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('portfolio seed failed:');
  console.error(err);
  process.exit(1);
});
