/**
 * STARTECH Quarterly Reporting workbook parser.
 *
 * Pure Excel → structured asset extraction. Shared by the CLI portfolio seed
 * and Smart Files fund-update ingestion (propose-only; no DB writes here).
 */
import ExcelJS from 'exceljs';
import type { DeterministicParser, FundUpdateStructuredResult } from '../types';
import { normalizeParsedAsset, quarterPeriodLabel } from '../normalizeParsedAsset';

export const STARTECH_TEMPLATE_ID = 'startech_master_sheet_v1' as const;

export const EXCLUDED_SHEETS = new Set([
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

// The full catalog of groups this workspace tracks. All eight are always created
// (even when empty) so the group list is stable regardless of what the workbook
// happens to contain this quarter.
export const GROUP_CATALOG = [
  'Startech Growth Fund 1',
  'Startech Growth Fund 2',
  'Startech Growth Fund 3',
  'Startech Growth Fund 4',
  'Startech Growth Fund 5',
  'Meranti 1',
  'Meranti 2',
  'Others',
] as const;

/** @deprecated Use GROUP_CATALOG */
export const FUND_CATALOG = GROUP_CATALOG;

export const OTHERS_GROUP = 'Others';

/** @deprecated Use OTHERS_GROUP */
export const OTHERS_FUND = OTHERS_GROUP;

export const UNATTRIBUTED_ENTITY = 'Unattributed (STARTECH)';

const COMPOSITE_ENTITY_REGEX = /[,&]|\s+and\s+/i;

/**
 * Returns true when the entity string names more than one entity.
 * Treats `,`, `&`, and whitespace-delimited `and` as separators.
 * Does not fire on legal suffixes or null.
 */
export function isCompositeEntity(entity: string | null): boolean {
  if (!entity) return false;
  return COMPOSITE_ENTITY_REGEX.test(entity);
}

/**
 * Assigns an asset to one of the catalog groups from its holding entity (the
 * investor), per the agreed mapping:
 *   - "Meranti Global Investment Ltd" (the flagship vehicle) -> Meranti 1
 *   - any other Meranti vehicle (Pte / SG / co-invest)       -> Meranti 2
 *   - "Startech Growth Fund VCC"                             -> Startech Growth Fund 1
 *     (the workbook exposes a single Startech entity, so all Startech holdings
 *      land in one Startech group rather than being split across 1-5)
 *   - everything else (incl. no entity)                      -> Others
 */
export function groupForEntity(entity: string | null): string {
  if (!entity) return OTHERS_GROUP;
  const e = entity.toLowerCase();
  if (e.includes('meranti')) {
    return /^meranti global investment ltd\.?$/.test(e) ? 'Meranti 1' : 'Meranti 2';
  }
  if (e.includes('startech')) return 'Startech Growth Fund 1';
  return OTHERS_GROUP;
}

/** @deprecated Use groupForEntity */
export function fundForEntity(entity: string | null): string {
  return groupForEntity(entity);
}

// ---- Master-data enrichment (Structure + Appendix tabs) ----
//
// Two excluded reference tabs carry richer per-asset metadata that the
// per-company sheets don't. We read them here (without treating them as asset
// sheets) to enrich the injected assets:
//   - "Structure": keyed by sheet code (col B) — company (col D), investment
//     commitment (col G), invested capital (col H), deal structure (col K),
//     fee rate (col L).
//   - "Appendix":  keyed by a stable "Invt ID" (col A) — investment name
//     (col B), class (col C), sub-type (col D), instrument (col J), share
//     count (col K), vintage year (col M).
//
// Appendix has no Sheet Name column and Structure has no Invt ID, and names
// diverge across tabs ("GOTO Group" vs Appendix labels, "Alpha JWC Fund II"
// vs "Alpha JWC 2"). We hybrid-resolve sheet → Invt ID:
//   1) manual overrides for known awkward cases
//   2) fuzzy match on sheet code / Structure company / sheet D7 name
//   3) leave unmatched (skip Appendix enrichment)
//
// TODO: Ask STARTECH owners to add a Sheet Name column on Appendix (or Invt ID
// on Structure) so this override map + fuzzy join can be deleted.
// TODO: Revisit fuzzy threshold / roman-numeral handling (AJWC II/III) once a
// native join key exists; prefer exact keys over name matching for fund data.

/** Manual sheet-code → Invt ID for cases fuzzy name match still misses. */
const APPENDIX_ID_OVERRIDES_BY_CODE: Record<string, string> = {
  GOTO: 'S009',
  AJWCII: 'S006',
  AJWCIII: 'S023',
};

/** Minimum fuzzy score to accept an Appendix name match (0 wrongs @ 0.7 on 2Q26). */
const APPENDIX_FUZZY_MIN_SCORE = 0.7;

const APPENDIX_NAME_STOP_WORDS = new Set([
  'fund',
  'inc',
  'ltd',
  'pte',
  'pt',
  'the',
  'and',
  'of',
  'group',
  'limited',
  'investment',
  'ventures',
  'capital',
  'formerly',
]);

export interface StructureRow {
  company: string | null; // col D
  commitmentAmount: number | null; // col G, falls back to col H (invested)
  dealType: string | null; // col K ("EPA" / "Mgmt Fee" / "Loan" / ...)
  mgmtFeeRatePct: number | null; // col L (stored as a fraction → *100)
}

export interface AppendixRow {
  sourceRef: string; // col A ("S017")
  name: string; // col B ("Akulaku")
  sector: string | null; // col C ("VC" / "PE" / "PC" / "PW")
  subSector: string | null; // col D ("DI" / "Fund" / ...)
  instrument: string | null; // col J ("Common equity" / "Preference Shares" / ...)
  sharesOutstanding: number | null; // col K
  vintageYear: number | null; // col M
}

// Values that mean "not applicable" — treated as no entity / no source.
const NA_VALUES = new Set(['', 'na', 'n/a', 'n.a', 'n.a.', '-', 'none', 'null', 'tbd']);

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

function normalizeAppendixName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function appendixNameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !APPENDIX_NAME_STOP_WORDS.has(t));
}

function appendixTokenJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Score how well a query (sheet code / company / D7 name) matches an Appendix Investment Name. */
export function scoreAppendixNameMatch(query: string, candidate: string): number {
  const q = query.trim();
  const c = candidate.trim();
  if (!q || !c) return 0;
  const nq = normalizeAppendixName(q);
  const nc = normalizeAppendixName(c);
  if (nq === nc) return 1;
  if (nq.includes(nc) || nc.includes(nq)) return 0.85;
  const tok = appendixTokenJaccard(appendixNameTokens(q), appendixNameTokens(c));
  if (tok >= 0.5) return tok;
  if (nc.startsWith(nq) || nq.startsWith(nc)) return 0.7;
  return tok;
}

/**
 * Resolve sheet code → Appendix Invt ID: overrides first, then fuzzy name match.
 * Returns undefined when nothing is confident enough (caller skips enrichment).
 */
export function resolveAppendixId(
  sheetCode: string,
  queries: Array<string | null | undefined>,
  appendixEntries: Array<{ id: string; name: string }>,
): string | undefined {
  const override = APPENDIX_ID_OVERRIDES_BY_CODE[sheetCode];
  if (override) return override;

  let best: { id: string; score: number } | null = null;
  for (const query of queries) {
    if (!query) continue;
    for (const entry of appendixEntries) {
      const score = scoreAppendixNameMatch(query, entry.name);
      if (!best || score > best.score) best = { id: entry.id, score };
    }
  }
  if (best && best.score >= APPENDIX_FUZZY_MIN_SCORE) return best.id;
  return undefined;
}

// ---- Parsing ----

export type TxnTypeEnum =
  | 'contribution'
  | 'divestment'
  | 'interest_income'
  | 'dividend'
  | 'return_of_capital'
  | 'expense'
  | 'other';

import type { SellProceedsDestination } from '@/lib/sellProceedsDestination';
export type { SellProceedsDestination };

export interface ParsedTxn {
  date: string;
  type: TxnTypeEnum;
  subTypeLabel: string | null;
  pricePerShare: number | null;
  shareCount: number | null;
  valueAmount: number | null;
  currency?: string;
  fxRate: number | null;
  sellProceedsDestination?: SellProceedsDestination | null;
  notes: string | null;
  /** Exact workbook provenance. Required for deterministic replay. */
  sourceSheet?: string;
  sourceRow?: number;
  dataStatus?: 'verified' | 'needs_verification';
  /** Original submitted review ID when threading approval decisions through apply. */
  submittedId?: string;
  /**
   * Set when a reviewer explicitly reclassified an unresolved (Other / Unknown) row into a
   * concrete economic type. Carries the actual-event policy through to posting so estimate
   * wording in the source no longer blocks the row.
   */
  reviewerResolvedType?: boolean;
  allocations?: Array<{ funding_source_id?: string; fundingSourceId?: string; amount?: string | number }>;
  fundingSource?: string | null;
  fundingSourceId?: string | null;
  allowPost?: boolean;
}

export type ValuationMethodEnum =
  | 'at_cost'
  | 'fundraise_round'
  | 'secondary_sale'
  | 'stock_market_price'
  | 'comparables'
  | 'capital_account_statement'
  | 'other';

// One row of a company sheet's "Market Value Tracker" (a quarterly mark).
export interface ParsedValuation {
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
  /** Exact workbook provenance. */
  sourceSheet?: string;
  sourceRow?: number;
  dataStatus?: 'verified' | 'needs_verification';
  /** Original submitted review ID when threading approval decisions through apply. */
  submittedId?: string;
}

export interface ParsedAsset {
  code: string; // sheet name
  name: string;
  legalName: string | null;
  englishName?: string | null;
  country: string | null;
  investmentTypeLabel: string; // "Direct Investments" / "Fund of Funds" (D10)
  assetType: 'direct_investment' | 'fund_of_funds';
  fund: string; // catalog fund, derived from the holding entity
  fundEnglishName?: string | null;
  /** Group the holding entity rolls up to (was the synthetic fund name). */
  group?: string;
  /** Who holds the position: the real holding entity, or a fund (legacy/Nanjing). */
  holderKind?: 'fund' | 'investor';
  /** Display name of the holder — the entity, or UNATTRIBUTED_ENTITY when absent. */
  holderName?: string | null;
  /** G8 named more than one entity; needs human attribution before apply. */
  entityIsComposite?: boolean;
  /** G8 had no usable entity; holder falls back to UNATTRIBUTED_ENTITY. */
  entityIsUnattributed?: boolean;
  entity: string | null; // holding entity (Investment Entity)
  fundingSource: string | null; // source of funds (Funding Source)
  fundingSourceRaw: string | null;
  entryDate: string | null;
  stakePct: number | null;
  /** ISO-4217 code the asset's amounts are denominated in ('USD' for STARTECH). */
  currency?: string;
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

interface MappedTxnType {
  type: TxnTypeEnum;
  sellProceedsDestination: SellProceedsDestination | null;
}

// RFC §5 rule: 'distributed_to_investor' means the cash bypassed the fund's
// accounts entirely and no corresponding LP distribution entry exists.
// Proceeds that landed in the fund and were later paid to LPs via a distribution
// event are 'cash_in_fund' (to prevent double-deduction).
//
// Startech mapping review decision:
// The Startech quarterly reporting parser only parses portfolio asset tabs
// (direct investments and fund of funds holdings). The workbook does not
// contain or emit any LP-level distribution entries. Because these asset
// divestments/distributions do not produce matching LP distribution entries
// for the same money in this ingestion pipeline, they represent genuine
// pass-throughs and safely map to 'distributed_to_investor'.
const TXN_TYPE_MAP: Record<string, MappedTxnType> = {
  'cost of investment': { type: 'contribution', sellProceedsDestination: null },
  contribution: { type: 'contribution', sellProceedsDestination: null },
  distribution: { type: 'divestment', sellProceedsDestination: 'distributed_to_investor' },
  divestment: { type: 'divestment', sellProceedsDestination: 'distributed_to_investor' },
  'return of capital': { type: 'return_of_capital', sellProceedsDestination: null },
  'interest income': { type: 'interest_income', sellProceedsDestination: null },
  interest: { type: 'interest_income', sellProceedsDestination: null },
  others: { type: 'other', sellProceedsDestination: null },
  other: { type: 'other', sellProceedsDestination: null },
};

function mapTxnType(raw: string): MappedTxnType {
  return (
    TXN_TYPE_MAP[raw.toLowerCase().trim()] ?? {
      type: 'other',
      sellProceedsDestination: null,
    }
  );
}

/** Finds the "Txn Date" header row (col C) in the 18..32 band. */
function findTxnHeaderRow(ws: ExcelJS.Worksheet): number | null {
  for (let r = 18; r <= 32; r++) {
    if (asString(cellValue(ws.getCell(r, 3))) === 'Txn Date') return r;
  }
  return null;
}

function normalizeCurrency(raw: string | null): string {
  if (!raw) return 'USD';
  const c = raw.toUpperCase().trim();
  if (c === 'US$') return 'USD';
  if (c === 'S$') return 'SGD';
  if (c === 'RP') return 'IDR';
  return c;
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

    const mapped = mapTxnType(typeRaw);
    const type = mapped.type;
    // Sheet convention: outflows (contributions) are negative, inflows positive.
    // Store invested capital as a positive magnitude; keep the natural sign for
    // realized flows so a negative "Others" (a fee/cost) reduces net distribution.
    const valueAmount =
      rawValue == null ? null : type === 'contribution' ? Math.abs(rawValue) : rawValue;
    const sellProceedsDestination = mapped.sellProceedsDestination;

    // Some STARTECH sheets retain dated placeholder rows whose transaction
    // value is exactly zero and which have no share movement. They are not
    // ledger events. Keep share-only rows so they can still be reviewed.
    if (valueAmount === 0 && (shares == null || shares === 0)) continue;

    txns.push({
      date: isoDate(date)!,
      type,
      subTypeLabel: type === 'other' ? typeRaw : null,
      pricePerShare: pps == null ? null : Math.abs(pps),
      shareCount: shares == null ? null : Math.abs(shares),
      valueAmount,
      currency: normalizeCurrency(asString(cellValue(ws.getCell(r, 9)))), // I: Currency
      fxRate: asNumber(cellValue(ws.getCell(r, 10))), // J: Forex Reference
      sellProceedsDestination,
      notes: asString(cellValue(ws.getCell(r, 11))), // K: Notes
      sourceSheet: ws.name,
      sourceRow: r,
      dataStatus: 'verified',
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
      periodLabel: quarterPeriodLabel(iso),
      marketValue: mv,
      pricePerShare: pps == null ? null : Math.abs(pps),
      sharesOutstanding: sharesOut,
      shareholdingPct: shPct,
      investedCapitalCum: costCum,
      grossMoic: moic,
      grossXirr: xirr,
      valuationMethod: method,
      notes,
      sourceSheet: ws.name,
      sourceRow: r,
      dataStatus: 'verified',
    });

    if (pps != null && (latestPpsDate == null || iso > latestPpsDate)) {
      latestPpsDate = iso;
      currentPricePerShare = Math.abs(pps);
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
          periodLabel: quarterPeriodLabel(iso),
          marketValue: sumMv,
          pricePerShare: null,
          sharesOutstanding: null,
          shareholdingPct: null,
          investedCapitalCum: null,
          grossMoic: null,
          grossXirr: null,
          valuationMethod: null,
          notes: null,
          sourceSheet: ws.name,
          sourceRow: r,
          dataStatus: 'verified',
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
      company: meaningful(asString(cellValue(ws.getCell(r, 4)))), // D: Company
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
    const name = asString(cellValue(ws.getCell(r, 2))) ?? id; // B: Investment Name
    out.set(id, {
      sourceRef: id,
      name,
      sector: meaningful(asString(cellValue(ws.getCell(r, 3)))), // C: Investment Type
      subSector: meaningful(asString(cellValue(ws.getCell(r, 4)))), // D: Sub-type
      instrument: meaningful(asString(cellValue(ws.getCell(r, 10)))), // J: Instrument
      sharesOutstanding: asNumber(cellValue(ws.getCell(r, 11))), // K: No. of Shares
      vintageYear: asNumber(cellValue(ws.getCell(r, 13))), // M: Vintage Year
    });
  }
  return out;
}

export function parseWorkbook(wb: ExcelJS.Workbook): ParsedAsset[] {
  const structureByCode = parseStructure(wb);
  const appendixById = parseAppendix(wb);
  const appendixEntries = [...appendixById.values()].map((row) => ({
    id: row.sourceRef,
    name: row.name,
  }));

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
    // TODO: replace hybrid resolve once Appendix exposes Sheet Name (or Structure Invt ID).
    const appendixId = resolveAppendixId(
      ws.name,
      [ws.name, structure?.company, name],
      appendixEntries,
    );
    const appendix = appendixId ? appendixById.get(appendixId) : undefined;
    const { valuations, currentPricePerShare } = parseValuations(ws);

    assets.push({
      code: ws.name,
      name,
      legalName: asString(cellValue(ws.getCell(8, 4))), // D8
      country: meaningful(asString(cellValue(ws.getCell(9, 4)))), // D9
      investmentTypeLabel: INVESTMENT_TYPE_LABEL[invType],
      assetType: invType === 'fund of funds' ? 'fund_of_funds' : 'direct_investment',
      fund: groupForEntity(entity),
      group: groupForEntity(entity),
      holderKind: 'investor',
      holderName: entity ?? UNATTRIBUTED_ENTITY,
      entityIsComposite: isCompositeEntity(entity),
      entityIsUnattributed: entity == null,
      entity,
      fundingSource: meaningful(fundingRaw),
      fundingSourceRaw: fundingRaw,
      entryDate,
      stakePct: stakeFrac == null ? null : stakeFrac * 100,
      currency: 'USD',
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

  return assets.map(normalizeParsedAsset);
}


async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

/**
 * Fast check that this buffer is the STARTECH quarterly master workbook.
 * Uses Structure + (Appendix or Master Data) plus at least one asset sheet
 * with a recognized Investment Type and a Txn Date ledger header.
 */
export async function fingerprintStartechQuarterly(buffer: Buffer): Promise<boolean> {
  try {
    const wb = await loadWorkbook(buffer);
    if (!wb.getWorksheet('Structure')) return false;
    if (!wb.getWorksheet('Appendix') && !wb.getWorksheet('Master Data >>')) return false;

    for (const ws of wb.worksheets) {
      if (EXCLUDED_SHEETS.has(ws.name)) continue;
      const invType = asString(cellValue(ws.getCell(10, 4)))?.toLowerCase();
      if (!invType || !VALID_INVESTMENT_TYPES.has(invType)) continue;
      if (findTxnHeaderRow(ws) != null) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function parseStartechQuarterlyBuffer(buffer: Buffer): Promise<ParsedAsset[]> {
  const wb = await loadWorkbook(buffer);
  return parseWorkbook(wb);
}

export interface StartechParseResult {
  template_id: typeof STARTECH_TEMPLATE_ID;
  assets: ParsedAsset[];
  stats: {
    asset_count: number;
    direct_count: number;
    fund_of_funds_count: number;
    transaction_count: number;
    valuation_count: number;
  };
}

/** Parse + summarize for Smart Files structured_notes (no DB writes). */
export async function parseStartechQuarterlyForIngestion(buffer: Buffer): Promise<StartechParseResult | null> {
  if (!(await fingerprintStartechQuarterly(buffer))) return null;
  const assets = await parseStartechQuarterlyBuffer(buffer);
  if (assets.length === 0) return null;
  const direct = assets.filter((a) => a.assetType === 'direct_investment').length;
  return {
    template_id: STARTECH_TEMPLATE_ID,
    assets,
    stats: {
      asset_count: assets.length,
      direct_count: direct,
      fund_of_funds_count: assets.length - direct,
      transaction_count: assets.reduce((n, a) => n + a.txns.length, 0),
      valuation_count: assets.reduce((n, a) => n + a.valuations.length, 0),
    },
  };
}

export const startechQuarterlyParser: DeterministicParser = {
  templateId: STARTECH_TEMPLATE_ID,
  async parse(buffer: Buffer): Promise<FundUpdateStructuredResult | null> {
    const parsed = await parseStartechQuarterlyForIngestion(buffer);
    if (!parsed) return null;

    const { stats, assets, template_id } = parsed;
    const assetNames = assets.map((a) => a.name);
    const funds = [...new Set(assets.map((a) => a.fund))].sort();

    // Prefer the latest Market Value Tracker as-of date across assets, else entry dates.
    let fileDate: string | null = null;
    for (const a of assets) {
      for (const v of a.valuations) {
        if (!fileDate || v.asOfDate > fileDate) fileDate = v.asOfDate;
      }
    }
    if (!fileDate) {
      for (const a of assets) {
        if (a.entryDate && (!fileDate || a.entryDate > fileDate)) fileDate = a.entryDate;
      }
    }

    return {
      file_type: 'fund_updates',
      parser: template_id,
      summary:
        `STARTECH quarterly master sheet: ${stats.asset_count} assets ` +
        `(${stats.direct_count} direct, ${stats.fund_of_funds_count} fund-of-funds), ` +
        `${stats.transaction_count} transactions, ${stats.valuation_count} valuations. ` +
        `Proposed only — pending per-asset review before funds DB updates.`,
      key_points: [
        `Format: ${STARTECH_TEMPLATE_ID}`,
        `Funds touched: ${funds.join(', ') || '(none)'}`,
        `${stats.asset_count} proposed asset updates`,
        `${stats.transaction_count} proposed ledger rows`,
        `${stats.valuation_count} proposed valuation marks`,
      ],
      action_items: [
        'Review proposed asset changes in the Fund Updates review flow (mockup pending).',
      ],
      tags: ['Fund Update', 'STARTECH', ...funds.slice(0, 8)],
      companies_detected: assetNames,
      company_notes: [],
      file_date: fileDate,
      suggested_track_ids: [],
      matched_companies: [],
      fund_update_proposal: {
        template_id,
        stats,
        assets,
        fund_catalog: [...FUND_CATALOG],
      },
    };
  },
};
