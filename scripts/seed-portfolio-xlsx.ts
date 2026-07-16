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
 * Not for production.
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

// Non-asset tabs to skip outright.
const EXCLUDED_SHEETS = new Set([
  'Output',
  'PPT Tables',
  'Structure',
  'Master Data >>',
  'Consolidated Data >>',
  'Appendix',
  'Portfolio Accts',
  // Template / summary tabs that look like asset sheets but aren't real holdings.
  'Company A',
  '40Strand',
]);

// Canonical "Investment Type" labels (D10), used to classify each sheet as a
// direct holding vs a fund-of-funds and to filter out non-asset tabs.
const INVESTMENT_TYPE_LABEL: Record<string, string> = {
  'direct investments': 'Direct Investments',
  'fund of funds': 'Fund of Funds',
};

const VALID_INVESTMENT_TYPES = new Set(Object.keys(INVESTMENT_TYPE_LABEL));

// The full catalog of funds this workspace tracks. All eight are always created
// (even when empty) so the fund list is stable regardless of what the workbook
// happens to contain this quarter.
const FUND_CATALOG = [
  'Startech Growth Fund 1',
  'Startech Growth Fund 2',
  'Startech Growth Fund 3',
  'Startech Growth Fund 4',
  'Startech Growth Fund 5',
  'Meranti 1',
  'Meranti 2',
  'Others',
] as const;
const OTHERS_FUND = 'Others';

/**
 * Assigns an asset to one of the catalog funds from its holding entity (the
 * investor), per the agreed mapping:
 *   - "Meranti Global Investment Ltd" (the flagship vehicle) -> Meranti 1
 *   - any other Meranti vehicle (Pte / SG / co-invest)       -> Meranti 2
 *   - "Startech Growth Fund VCC"                             -> Startech Growth Fund 1
 *     (the workbook exposes a single Startech entity, so all Startech holdings
 *      land in one Startech fund rather than being split across 1-5)
 *   - everything else (incl. no entity)                      -> Others
 */
function fundForEntity(entity: string | null): string {
  if (!entity) return OTHERS_FUND;
  const e = entity.toLowerCase();
  if (e.includes('meranti')) {
    return /^meranti global investment ltd\.?$/.test(e) ? 'Meranti 1' : 'Meranti 2';
  }
  if (e.includes('startech growth')) return 'Startech Growth Fund 1';
  return OTHERS_FUND;
}

// ---- Master-data enrichment (Structure + Appendix tabs) ----
//
// Two excluded reference tabs carry richer per-asset metadata that the
// per-company sheets don't. We read them here (without treating them as asset
// sheets) to enrich the injected assets:
//   - "Structure": keyed by sheet code (col B) — investment commitment (col G),
//     invested capital (col H), deal structure (col K), fee rate (col L).
//   - "Appendix":  keyed by a stable "Invt ID" (col A) — investment class
//     (col C), sub-type (col D), instrument (col J), share count (col K),
//     vintage year (col M). It has no sheet code, and its names diverge from
//     the company sheets ("Gojek" vs "GOTO Group", "Mahogany (Coco)" vs
//     "Coco"), so we join it via an explicit sheet-code -> Invt ID map built
//     from the two tabs. Codes with no confident Appendix row (e.g. Next
//     Energy, Welab Sky, and the newer names — Databricks, Anthropic, OpenAI,
//     SpaceX, ByteDance, SpeedX, Xtalpi) are intentionally omitted.
const APPENDIX_ID_BY_CODE: Record<string, string> = {
  '1982': 'S029',
  '6EST': 'S012',
  ACVV: 'S036',
  ADVR: 'S032',
  AGAT: 'S020',
  AGRI: 'S043',
  ABNB: 'S002',
  AKUL: 'S017',
  AJWCI: 'S003',
  AJWCII: 'S006',
  AJWCIII: 'S023',
  ALTO: 'S015',
  BUMA: 'S039',
  QNTM: 'S022',
  CICL: 'S034',
  ENTM: 'S005',
  FORE: 'S042',
  BEAM: 'S021',
  GANS: 'S037',
  GOTO: 'S009',
  GUSH: 'S013',
  HRZN: 'S027',
  IDEO: 'S010',
  ISOII: 'S007',
  ISTFI: 'S011',
  ISTFII: 'S024',
  JARVI: 'S045',
  JARVII: 'S046',
  COCO: 'S048',
  META: 'S026',
  MYTH: 'S041',
  RPHA: 'S044',
  SBOX: 'S018',
  SIRC: 'S016',
  SPOT: 'S001',
  SYLV: 'S008',
  TANG: 'S030',
  VIVA: 'S033',
};

interface StructureRow {
  commitmentAmount: number | null; // col G, falls back to col H (invested)
  dealType: string | null; // col K ("EPA" / "Mgmt Fee" / "Loan" / ...)
  mgmtFeeRatePct: number | null; // col L (stored as a fraction → *100)
}

interface AppendixRow {
  sourceRef: string; // col A ("S017")
  sector: string | null; // col C ("VC" / "PE" / "PC" / "PW")
  subSector: string | null; // col D ("DI" / "Fund" / ...)
  instrument: string | null; // col J ("Common equity" / "Preference Shares" / ...)
  sharesOutstanding: number | null; // col K
  vintageYear: number | null; // col M
}

// Values that mean "not applicable" — treated as no entity / no source.
const NA_VALUES = new Set(['', 'na', 'n/a', 'n.a', 'n.a.', '-', 'none', 'null', 'tbd']);

// Deterministic UUIDs so a re-run replaces the same rows. Not a real v5 UUID,
// just a stable, syntactically valid UUID derived from a namespaced key.
function detUuid(kind: string, key: string): string {
  const h = createHash('md5').update(`startech-portfolio:${kind}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---- Cell helpers ----

type CellVal = string | number | boolean | Date | null;

/** Unwraps ExcelJS's formula / error / rich-text cell shapes into a scalar. */
function cellValue(cell: ExcelJS.Cell): CellVal {
  const v = cell.value as unknown;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('error' in o) return null; // #REF!, #VALUE!, ...
    if ('result' in o) {
      const r = o.result;
      if (r == null) return null;
      if (r instanceof Date) return r;
      if (typeof r === 'object') return null;
      return r as CellVal;
    }
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
    }
    if ('text' in o) return String(o.text);
    return null;
  }
  return v as CellVal;
}

function asString(v: CellVal): string | null {
  if (v == null) return null;
  if (v instanceof Date) return null;
  // Collapse embedded newlines / runs of whitespace — several cells wrap long
  // entity names across lines ("Asia Star Fund Ltd,\nMeranti ...").
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

function asNumber(v: CellVal): number | null {
  if (v == null || v instanceof Date) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function asDate(v: CellVal): Date | null {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v : null;
}

/** Local-safe ISO date (YYYY-MM-DD) — the workbook stores dates at UTC midnight. */
function isoDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** A real value once NA-style placeholders are stripped. */
function meaningful(v: string | null): string | null {
  if (v == null) return null;
  return NA_VALUES.has(v.toLowerCase()) ? null : v;
}

// ---- Parsing ----

type TxnTypeEnum =
  | 'contribution'
  | 'divestment'
  | 'distribution'
  | 'interest_income'
  | 'return_of_capital'
  | 'other';

interface ParsedTxn {
  date: string;
  type: TxnTypeEnum;
  subTypeLabel: string | null;
  pricePerShare: number | null;
  shareCount: number | null;
  valueAmount: number | null;
  currency: string;
  fxRate: number | null;
  notes: string | null;
}

type ValuationMethodEnum =
  | 'at_cost'
  | 'fundraise_round'
  | 'secondary_sale'
  | 'stock_market_price'
  | 'comparables'
  | 'capital_account_statement'
  | 'other';

// One row of a company sheet's "Market Value Tracker" (a quarterly mark).
interface ParsedValuation {
  asOfDate: string;
  periodLabel: string;
  marketValue: number | null;
  pricePerShare: number | null;
  sharesOutstanding: number | null;
  shareholdingPct: number | null;
  investedCapitalCum: number | null;
  grossMoic: number | null;
  grossXirr: number | null;
  valuationMethod: ValuationMethodEnum | null;
  notes: string | null;
}

interface ParsedAsset {
  code: string; // sheet name
  name: string;
  legalName: string | null;
  country: string | null;
  investmentTypeLabel: string; // "Direct Investments" / "Fund of Funds" (D10)
  assetType: 'direct_investment' | 'fund_of_funds';
  fund: string; // catalog fund, derived from the holding entity
  entity: string | null; // holding entity (Investment Entity)
  fundingSource: string | null; // source of funds (Funding Source)
  fundingSourceRaw: string | null;
  entryDate: string | null;
  stakePct: number | null;
  // Enrichment from the Structure / Appendix master tabs (may be absent).
  commitmentAmount: number | null;
  dealType: string | null;
  mgmtFeeRatePct: number | null;
  sector: string | null;
  subSector: string | null;
  instrument: string | null;
  sharesOutstanding: number | null;
  sourceRef: string | null;
  vintageYear: number | null;
  // Market Value Tracker (quarterly marks) + the latest per-share mark.
  valuations: ParsedValuation[];
  currentPricePerShare: number | null;
  txns: ParsedTxn[];
}

const TXN_TYPE_MAP: Record<string, TxnTypeEnum> = {
  'cost of investment': 'contribution',
  contribution: 'contribution',
  distribution: 'distribution',
  divestment: 'divestment',
  'return of capital': 'return_of_capital',
  'interest income': 'interest_income',
  interest: 'interest_income',
  others: 'other',
  other: 'other',
};

function mapTxnType(raw: string): TxnTypeEnum {
  return TXN_TYPE_MAP[raw.toLowerCase().trim()] ?? 'other';
}

/** Finds the "Txn Date" header row (col C) in the 18..32 band. */
function findTxnHeaderRow(ws: ExcelJS.Worksheet): number | null {
  for (let r = 18; r <= 32; r++) {
    if (asString(cellValue(ws.getCell(r, 3))) === 'Txn Date') return r;
  }
  return null;
}

function parseTransactions(ws: ExcelJS.Worksheet, headerRow: number): ParsedTxn[] {
  const txns: ParsedTxn[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const date = asDate(cellValue(ws.getCell(r, 3))); // C: Txn Date
    const typeRaw = asString(cellValue(ws.getCell(r, 5))); // E: Transaction Type
    const rawValue = asNumber(cellValue(ws.getCell(r, 8))); // H: Transaction Value
    const shares = asNumber(cellValue(ws.getCell(r, 7))); // G: No of Shares
    const pps = asNumber(cellValue(ws.getCell(r, 6))); // F: Price per Share

    // End of the ledger: a fully-blank row.
    if (!date && !typeRaw && rawValue == null && shares == null && pps == null) break;
    // Skip stray rows with no type/date (subtotals, notes, spacers).
    if (!typeRaw || !date) continue;

    const type = mapTxnType(typeRaw);
    // Sheet convention: outflows (contributions) are negative, inflows positive.
    // Store invested capital as a positive magnitude; keep the natural sign for
    // realized flows so a negative "Others" (a fee/cost) reduces net distribution.
    const valueAmount =
      rawValue == null ? null : type === 'contribution' ? Math.abs(rawValue) : rawValue;

    txns.push({
      date: isoDate(date)!,
      type,
      subTypeLabel: type === 'other' ? typeRaw : null,
      pricePerShare: pps,
      shareCount: shares == null ? null : Math.abs(shares),
      valueAmount,
      currency: asString(cellValue(ws.getCell(r, 9))) ?? 'USD', // I: Currency
      fxRate: asNumber(cellValue(ws.getCell(r, 10))), // J: Forex Reference
      notes: asString(cellValue(ws.getCell(r, 11))), // K: Notes
    });
  }
  return txns;
}

// ---- Market Value Tracker (quarterly valuations) ----

// Which valuation field each Market Value Tracker column maps to, matched by
// its header label (row 23, cols N..) so column drift between sheets is handled
// — the workbook's canonical layout is N=Date, O=No of Shares, P=PPS,
// Q=Market Value, R=Total Shares Outstanding, S=Shareholding %, T=Forex,
// U=Cost of Investment, V=MOIC, W=XIRR (some sheets add Valuation Method/Notes).
type TrackerField =
  | 'date'
  | 'posShares'
  | 'pps'
  | 'mv'
  | 'netMv'
  | 'sharesOut'
  | 'shPct'
  | 'fx'
  | 'costCum'
  | 'method'
  | 'moic'
  | 'xirr'
  | 'notes';

function classifyTrackerHeader(label: string): TrackerField | null {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!l) return null;
  if (l === 'date' || (l.includes('date') && !l.includes('report'))) return 'date';
  if (l.includes('net market value')) return 'netMv';
  if (l.includes('market value') || l.includes('gross market')) return 'mv';
  if (l.includes('pps') || l.includes('price per share')) return 'pps';
  // "Total Shares Outstanding" ("Tota Shares Oustanding" typo in the workbook).
  if (l.includes('outstanding') || l.includes('oustanding') || l.includes('total shares')) return 'sharesOut';
  if (l.includes('no of shares') || l.includes('number of shares')) return 'posShares';
  if (l.includes('shareholding') || l.includes('stake') || l === '%') return 'shPct';
  if (l.includes('forex') || l.includes('fx')) return 'fx';
  if (l.includes('valuation method') || l.includes('method')) return 'method';
  if (l.includes('cost of investment') || l.includes('cost')) return 'costCum';
  if (l.includes('moic')) return 'moic';
  if (l.includes('xirr') || l.includes('irr')) return 'xirr';
  if (l.includes('note')) return 'notes';
  return null;
}

/** Maps a free-text valuation-method label to the DB enum. */
function mapValuationMethod(raw: string | null): ValuationMethodEnum | null {
  if (!raw) return null;
  const l = raw.toLowerCase();
  if (l.includes('fundrais') || l.includes('series') || l.includes('round')) return 'fundraise_round';
  if (l.includes('secondary')) return 'secondary_sale';
  if (l.includes('stock') || l.includes('market price') || l.includes('listed') || l.includes('public')) {
    return 'stock_market_price';
  }
  if (l.includes('comparable') || l.includes('comps')) return 'comparables';
  if (l.includes('capital account')) return 'capital_account_statement';
  if (l.includes('cost')) return 'at_cost';
  return 'other';
}

/** "Q3 2025"-style label from an as-of date (calendar quarter of its month). */
function periodLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

/** Percentages are stored as fractions in the sheet (0.1451 = 14.51%). */
function normalizePct(v: number | null): number | null {
  if (v == null) return null;
  return Math.abs(v) <= 1 ? v * 100 : v;
}

/**
 * Reads a company sheet's "Market Value Tracker" plus its post-ledger
 * "Report Date / Market Value" summary into quarterly valuation rows, and
 * derives the asset's latest per-share mark for current_price_per_share.
 */
function parseValuations(
  ws: ExcelJS.Worksheet,
): { valuations: ParsedValuation[]; currentPricePerShare: number | null } {
  // The tracker sits to the right of the ledger; its "Date" header is in col N
  // (14) around row 23. Locate it so we never read the ledger's own columns.
  let headerRow: number | null = null;
  for (let r = 20; r <= 28; r++) {
    if (asString(cellValue(ws.getCell(r, 14)))?.toLowerCase() === 'date') {
      headerRow = r;
      break;
    }
  }
  if (headerRow == null) return { valuations: [], currentPricePerShare: null };

  // Map each tracker column to a field by its header label (cols N..~AD).
  const colOf = new Map<TrackerField, number>();
  for (let c = 14; c <= 30; c++) {
    const field = classifyTrackerHeader(asString(cellValue(ws.getCell(headerRow, c))) ?? '');
    if (field && !colOf.has(field)) colOf.set(field, c);
  }
  const dateCol = colOf.get('date');
  if (!dateCol) return { valuations: [], currentPricePerShare: null };
  const numAt = (r: number, f: TrackerField) => {
    const c = colOf.get(f);
    return c ? asNumber(cellValue(ws.getCell(r, c))) : null;
  };
  const strAt = (r: number, f: TrackerField) => {
    const c = colOf.get(f);
    return c ? asString(cellValue(ws.getCell(r, c))) : null;
  };

  const byDate = new Map<string, ParsedValuation>();
  let currentPricePerShare: number | null = null;
  let latestPpsDate: string | null = null;
  let blanks = 0;

  for (let r = headerRow + 1; r <= headerRow + 60; r++) {
    const date = asDate(cellValue(ws.getCell(r, dateCol)));
    if (!date) {
      if (++blanks >= 6) break;
      continue;
    }
    blanks = 0;
    const iso = isoDate(date)!;

    const posShares = numAt(r, 'posShares');
    const pps = numAt(r, 'pps');
    // Prefer the sheet's Market Value; otherwise derive shares × PPS.
    const mv = numAt(r, 'mv') ?? (posShares != null && pps != null ? posShares * pps : null);
    // shares_outstanding: prefer "Total Shares Outstanding", else "No of Shares".
    const sharesOut = numAt(r, 'sharesOut') ?? posShares;
    const shPct = normalizePct(numAt(r, 'shPct'));
    const costCum = numAt(r, 'costCum');
    const moic = numAt(r, 'moic');
    const xirr = numAt(r, 'xirr');
    const method = mapValuationMethod(strAt(r, 'method'));
    const notes = strAt(r, 'notes');

    // Skip date-only rows (no substance to record).
    if (
      mv == null &&
      pps == null &&
      sharesOut == null &&
      shPct == null &&
      costCum == null &&
      moic == null
    ) {
      continue;
    }

    byDate.set(iso, {
      asOfDate: iso,
      periodLabel: periodLabel(iso),
      marketValue: mv,
      pricePerShare: pps,
      sharesOutstanding: sharesOut,
      shareholdingPct: shPct,
      investedCapitalCum: costCum,
      grossMoic: moic,
      grossXirr: xirr,
      valuationMethod: method,
      notes,
    });

    if (pps != null && (latestPpsDate == null || iso > latestPpsDate)) {
      latestPpsDate = iso;
      currentPricePerShare = pps;
    }
  }

  // Post-ledger summary row ("Report Date" in col C, "Market Value" in col H)
  // — the current mark. Used to fill a quarter the tracker didn't value.
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    if (asString(cellValue(ws.getCell(r, 3)))?.toLowerCase() !== 'report date') continue;
    const sumDate = asDate(cellValue(ws.getCell(r, 4)));
    const sumMv = asNumber(cellValue(ws.getCell(r, 8)));
    if (sumDate && sumMv != null) {
      const iso = isoDate(sumDate)!;
      const existing = byDate.get(iso);
      if (!existing) {
        byDate.set(iso, {
          asOfDate: iso,
          periodLabel: periodLabel(iso),
          marketValue: sumMv,
          pricePerShare: null,
          sharesOutstanding: null,
          shareholdingPct: null,
          investedCapitalCum: null,
          grossMoic: null,
          grossXirr: null,
          valuationMethod: null,
          notes: null,
        });
      } else if (existing.marketValue == null) {
        existing.marketValue = sumMv;
      }
    }
    break;
  }

  const valuations = [...byDate.values()].sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : 1));
  return { valuations, currentPricePerShare };
}

/** Finds a header row in `col` matching `label` within the first `scan` rows. */
function findHeaderRow(
  ws: ExcelJS.Worksheet,
  col: number,
  label: string,
  scan = 6,
): number | null {
  for (let r = 1; r <= scan; r++) {
    if (asString(cellValue(ws.getCell(r, col)))?.toLowerCase() === label.toLowerCase()) return r;
  }
  return null;
}

/** Reads the "Structure" tab into a per-sheet-code metadata map. */
function parseStructure(wb: ExcelJS.Workbook): Map<string, StructureRow> {
  const out = new Map<string, StructureRow>();
  const ws = wb.getWorksheet('Structure');
  if (!ws) return out;
  const header = findHeaderRow(ws, 2, 'Sheet Name') ?? 3; // col B
  for (let r = header + 1; r <= ws.rowCount; r++) {
    const code = asString(cellValue(ws.getCell(r, 2))); // B: Sheet Name
    if (!code) continue;
    const commitment = asNumber(cellValue(ws.getCell(r, 7))); // G: Investment Commitment
    const invested = asNumber(cellValue(ws.getCell(r, 8))); // H: Invested Capital
    const rate = asNumber(cellValue(ws.getCell(r, 12))); // L: Rate (fraction)
    out.set(code, {
      // Direct deals leave G blank and carry the figure in H; funds fill G.
      commitmentAmount: commitment ?? invested,
      dealType: meaningful(asString(cellValue(ws.getCell(r, 11)))), // K: Structure
      mgmtFeeRatePct: rate == null ? null : rate * 100,
    });
  }
  return out;
}

/** Reads the "Appendix" tab into a map keyed by its stable "Invt ID". */
function parseAppendix(wb: ExcelJS.Workbook): Map<string, AppendixRow> {
  const out = new Map<string, AppendixRow>();
  const ws = wb.getWorksheet('Appendix');
  if (!ws) return out;
  const header = findHeaderRow(ws, 1, 'Invt ID') ?? 1; // col A
  for (let r = header + 1; r <= ws.rowCount; r++) {
    const id = asString(cellValue(ws.getCell(r, 1))); // A: Invt ID
    if (!id) continue;
    out.set(id, {
      sourceRef: id,
      sector: meaningful(asString(cellValue(ws.getCell(r, 3)))), // C: Investment Type
      subSector: meaningful(asString(cellValue(ws.getCell(r, 4)))), // D: Sub-type
      instrument: meaningful(asString(cellValue(ws.getCell(r, 10)))), // J: Instrument
      sharesOutstanding: asNumber(cellValue(ws.getCell(r, 11))), // K: No. of Shares
      vintageYear: asNumber(cellValue(ws.getCell(r, 13))), // M: Vintage Year
    });
  }
  return out;
}

function parseWorkbook(wb: ExcelJS.Workbook): ParsedAsset[] {
  const structureByCode = parseStructure(wb);
  const appendixById = parseAppendix(wb);

  // First pass: which company names have a canonical sheet (valid Reporting
  // Date in G4). The "*X" backups and stale copies have a broken (#REF!) date.
  const canonicalNames = new Set<string>();
  for (const ws of wb.worksheets) {
    if (EXCLUDED_SHEETS.has(ws.name)) continue;
    const invType = asString(cellValue(ws.getCell(10, 4)))?.toLowerCase();
    if (!invType || !VALID_INVESTMENT_TYPES.has(invType)) continue;
    const name = asString(cellValue(ws.getCell(7, 4)));
    if (name && asDate(cellValue(ws.getCell(4, 7)))) canonicalNames.add(name.toLowerCase());
  }

  const assets: ParsedAsset[] = [];
  const seenNonCanonical = new Set<string>();
  const usedAssetNames = new Set<string>();

  for (const ws of wb.worksheets) {
    if (EXCLUDED_SHEETS.has(ws.name)) continue;

    const headerRow = findTxnHeaderRow(ws);
    if (headerRow == null) continue; // not an asset sheet

    const invTypeRaw = asString(cellValue(ws.getCell(10, 4))); // D10
    const invType = invTypeRaw?.toLowerCase();
    if (!invType || !VALID_INVESTMENT_TYPES.has(invType)) continue;

    let name = asString(cellValue(ws.getCell(7, 4))); // D7
    if (!name) continue;
    const key = name.toLowerCase();

    const hasValidReportDate = asDate(cellValue(ws.getCell(4, 7))) != null; // G4
    // Canonical sheets (valid Reporting Date) are always kept — each distinct
    // tab is a distinct asset, keyed by sheet code, even if two tabs happen to
    // share a (mislabeled) company name. Only sheets with a broken report date
    // are treated as duplicates: skip the "*X" backups and any stale copy of a
    // company that already has a canonical sheet or another kept copy.
    if (!hasValidReportDate) {
      if (ws.name.endsWith('X')) continue;
      if (canonicalNames.has(key) || seenNonCanonical.has(key)) continue;
      seenNonCanonical.add(key);
    }

    const txns = parseTransactions(ws, headerRow);
    if (txns.length === 0) continue; // nothing to inject

    // Disambiguate duplicate display names (e.g. the workbook labels AJWCIII as
    // "Alpha JWC Fund II" too) so both assets stay distinguishable in the UI.
    if (usedAssetNames.has(name.toLowerCase())) name = `${name} (${ws.name})`;
    usedAssetNames.add(name.toLowerCase());

    const stakeFrac = asNumber(cellValue(ws.getCell(10, 7))); // G10 (fraction)
    const entryDate =
      isoDate(asDate(cellValue(ws.getCell(7, 7)))) ?? // G7
      txns.reduce<string | null>((min, t) => (min == null || t.date < min ? t.date : min), null);

    const fundingRaw = asString(cellValue(ws.getCell(9, 7))); // G9
    const entity = meaningful(asString(cellValue(ws.getCell(8, 7)))); // G8

    const structure = structureByCode.get(ws.name);
    const appendix = appendixById.get(APPENDIX_ID_BY_CODE[ws.name]);
    const { valuations, currentPricePerShare } = parseValuations(ws);

    assets.push({
      code: ws.name,
      name,
      legalName: asString(cellValue(ws.getCell(8, 4))), // D8
      country: meaningful(asString(cellValue(ws.getCell(9, 4)))), // D9
      investmentTypeLabel: INVESTMENT_TYPE_LABEL[invType],
      assetType: invType === 'fund of funds' ? 'fund_of_funds' : 'direct_investment',
      fund: fundForEntity(entity),
      entity,
      fundingSource: meaningful(fundingRaw),
      fundingSourceRaw: fundingRaw,
      entryDate,
      stakePct: stakeFrac == null ? null : stakeFrac * 100,
      commitmentAmount: structure?.commitmentAmount ?? null,
      dealType: structure?.dealType ?? null,
      mgmtFeeRatePct: structure?.mgmtFeeRatePct ?? null,
      sector: appendix?.sector ?? null,
      subSector: appendix?.subSector ?? null,
      instrument: appendix?.instrument ?? null,
      sharesOutstanding: appendix?.sharesOutstanding ?? null,
      sourceRef: appendix?.sourceRef ?? null,
      vintageYear: appendix?.vintageYear ?? null,
      valuations,
      currentPricePerShare,
      txns,
    });
  }

  return assets;
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
