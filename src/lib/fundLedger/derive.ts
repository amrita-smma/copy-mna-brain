/**
 * Turning the fund-ledger read model into the things the Ledger page shows.
 *
 * Every sign in here is read from the **position holder**. An investor's
 * capital call is negative cash for them; the fund's side of the same movement
 * is the identical number with the sign flipped. Nothing is stored as a
 * balance — commitment, paid-in capital, units, blended price and net cash are
 * all counted up from the rows.
 *
 * Money is summed with `flDecimal`'s BigInt arithmetic rather than doubles:
 * these totals are reported, and a position with eight-decimal unit counts
 * would drift under repeated float addition.
 *
 * Pure and UI-free, so the Ledger view and the copilot's `query_ledger_entries`
 * tool derive identical numbers from identical rows.
 */

import type { Tables } from '@/lib/repositories';
import type {
  FlPortfolioLedgerEntry,
  FlPortfolioPosition,
  FlPortfolioReadModel,
} from '@/lib/services/flPortfolioService';
import {
  flAbs,
  flAdd,
  flDiv,
  flIsNegative,
  flIsPositive,
  flIsZero,
  flNeg,
  flSum,
} from '@/lib/services/flDecimal';
import type { FlEntryType } from './entryTypes';
import { distinctEnglishName } from './format';
import { paidInAdjustmentDelta } from './paidInAdjustment';

/** What a party is, for the abbreviation badge next to its name. */
export type PartyKind = 'investor' | 'fund' | 'external_fund' | 'asset' | 'loan' | 'unknown';

/** Whether the position holds a fund participation or an asset holding, or cannot be resolved. */
export type InstrumentKind = 'fund' | 'asset' | 'unknown';

/** Resolution status of a position's relations. */
export type PositionResolutionStatus =
  | 'resolved'
  | 'missing_holder'
  | 'missing_instrument'
  | 'missing_both'
  | 'orphan';

export interface PositionResolution {
  status: PositionResolutionStatus;
  isResolved: boolean;
  hasHolder: boolean;
  hasInstrument: boolean;
  isSynthetic?: boolean;
}

/** One side of a movement — a holder, or the thing being held. */
export interface PartyRef {
  id: string;
  name: string;
  kind: PartyKind;
  /** The English name filed alongside a native-script name, when one is on record. */
  englishName?: string;
}

/** A funding source as the page needs it: name and pool type. */
export interface FundingSourceRef {
  id: string;
  name: string;
  sourceType: string | null;
}

/** A position with its holder, instrument and declared source already resolved. */
export interface ResolvedPosition {
  id: string;
  holder: PartyRef;
  instrument: PartyRef;
  /** Whether the position holds a fund participation or an asset holding, or cannot be resolved. */
  instrumentKind: InstrumentKind;
  /**
   * The single pool this position is funded from, when it declares one. A
   * position with a declared source can never attribute an entry elsewhere;
   * one without it carries the split on each entry instead.
   */
  fundingSource: FundingSourceRef | null;
  status: 'open' | 'closed';
  openedAt: string | null;
  raw: FlPortfolioPosition;
  resolution: PositionResolution;
}

/** An entity the search box can offer. */
export interface SearchEntity {
  id: string;
  name: string;
  /** Section header in the results list. */
  group: 'Investors' | 'Funds' | 'Assets' | 'Sources of fund';
  /** Short badge — INV / FUND / EXT / ASSET / LOAN / SRC. */
  badge: string;
  /** Secondary line: investor type, managed/external, sector, pool type. */
  meta: string;
  /** English rendering of `name`, when one is recorded and differs from it.
   *  Shown under the name and searched alongside it. */
  englishName?: string;
  /** Picking a source filters on the source column; anything else on parties. */
  kind: 'party' | 'source';
}

/** Everything the page reads, indexed for O(1) lookup. */
export interface LedgerIndex {
  positions: Map<string, ResolvedPosition>;
  entries: FlPortfolioLedgerEntry[];
  entriesById: Map<string, FlPortfolioLedgerEntry>;
  events: Map<string, Tables<'fl_business_events'>>;
  /** Every entry sharing one business event — how transfer legs find each other. */
  entriesByEvent: Map<string, FlPortfolioLedgerEntry[]>;
  fundingSources: Map<string, FundingSourceRef>;
  searchEntities: SearchEntity[];
}

const PARTY_BADGES: Record<PartyKind, string> = {
  investor: 'INV',
  fund: 'FUND',
  external_fund: 'EXT',
  asset: 'ASSET',
  loan: 'LOAN',
  unknown: '?',
};

/** The short badge shown before a party's name. */
export function partyBadge(kind: PartyKind): string {
  return PARTY_BADGES[kind] ?? (kind === 'unknown' ? '?' : kind);
}

const PARTY_KIND_LABELS: Record<PartyKind, string> = {
  investor: 'Investor',
  fund: 'Fund',
  external_fund: 'Ext. fund',
  asset: 'Asset',
  loan: 'Loan',
  unknown: 'Unknown',
};

/** The human label for a party kind, e.g. under a name in the detail panel. */
export function partyKindLabel(kind: PartyKind): string {
  return PARTY_KIND_LABELS[kind] ?? kind;
}

/** A stand-in for a party that no longer resolves — a deleted or filtered row. */
const UNKNOWN_PARTY: PartyRef = { id: '', name: '—', kind: 'unknown' };

function fundParty(fund: Tables<'fl_funds'>): PartyRef {
  return {
    id: fund.id,
    name: fund.name,
    kind: fund.managed ? 'fund' : 'external_fund',
    englishName: fund.english_name ?? undefined,
  };
}

function assetParty(asset: Tables<'fl_assets'>): PartyRef {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.asset_kind === 'loan' ? 'loan' : 'asset',
    englishName: asset.english_name ?? undefined,
  };
}

/**
 * Index a portfolio read model.
 *
 * The read model already arrives with holder/instrument/funding-source rows
 * joined onto each position, so this walks it once rather than re-querying
 * anything — which is what keeps the whole page to a single request.
 */
export function buildLedgerIndex(portfolio: FlPortfolioReadModel): LedgerIndex {
  const fundingSources = new Map<string, FundingSourceRef>();
  for (const source of portfolio.funding_sources ?? []) {
    fundingSources.set(source.id, {
      id: source.id,
      name: source.name,
      sourceType: source.source_type ?? null,
    });
  }

  const positions = new Map<string, ResolvedPosition>();
  for (const position of portfolio.positions ?? []) {
    const resolved = resolvePosition(position, fundingSources);
    positions.set(position.id, resolved);
  }

  const events = new Map<string, Tables<'fl_business_events'>>();
  for (const event of portfolio.business_events ?? []) {
    events.set(event.id, event);
  }

  const entries = portfolio.entries ?? [];
  const entriesById = new Map<string, FlPortfolioLedgerEntry>();
  const entriesByEvent = new Map<string, FlPortfolioLedgerEntry[]>();
  for (const entry of entries) {
    entriesById.set(entry.id, entry);
    const eventId = entry.business_event_id;
    if (!eventId) continue;
    const siblings = entriesByEvent.get(eventId);
    if (siblings) siblings.push(entry);
    else entriesByEvent.set(eventId, [entry]);
  }

  return {
    positions,
    entries,
    entriesById,
    events,
    entriesByEvent,
    fundingSources,
    searchEntities: buildSearchEntities(portfolio),
  };
}

export const SYNTHETIC_ORPHAN_POSITION_ID = 'synthetic:unresolved-group';

/**
 * Creates a synthetic unresolved position for orphan entries referencing an
 * absent position ID.
 */
export function createSyntheticPosition(
  positionId = SYNTHETIC_ORPHAN_POSITION_ID,
): ResolvedPosition {
  return {
    id: positionId,
    holder: {
      id: `synthetic-holder:${positionId}`,
      name: 'Missing holder',
      kind: 'unknown',
    },
    instrument: {
      id: `synthetic-instrument:${positionId}`,
      name: 'Missing instrument',
      kind: 'unknown',
    },
    instrumentKind: 'unknown',
    fundingSource: null,
    status: 'open',
    openedAt: null,
    raw: {
      id: positionId,
      workspace_id: '',
      holder_investor_id: null,
      holder_fund_id: null,
      fund_id: null,
      asset_id: null,
      holder_source_of_fund_id: null,
      status: 'open',
      opened_at: '',
      closed_at: null,
      notes: null,
      created_by: null,
      created_at: '',
      updated_at: '',
      current_value: '0',
      valuation_method: null,
      holder_investor: null,
      holder_fund: null,
      fund: null,
      asset: null,
      funding_source: null,
    },
    resolution: {
      status: 'orphan',
      isResolved: false,
      hasHolder: false,
      hasInstrument: false,
      isSynthetic: true,
    },
  };
}

/**
 * Resolve one position's holder and instrument.
 *
 * A position is ideally one holder (investor XOR fund) holding one thing (fund
 * participation XOR asset). When either or both sides fail to resolve, the
 * position is retained with clear explicit labels ('Missing holder' / 'Missing instrument')
 * and an explicit resolution state, so its entries and rollups remain visible
 * for audit/history without masquerading as a valid posting target.
 */
export function resolvePosition(
  position: FlPortfolioPosition,
  fundingSources: Map<string, FundingSourceRef>,
): ResolvedPosition {
  const holderParty = position.holder_fund
    ? fundParty(position.holder_fund)
    : position.holder_investor
      ? {
          id: position.holder_investor.id,
          name: position.holder_investor.name,
          kind: 'investor' as const,
          englishName: position.holder_investor.english_name ?? undefined,
        }
      : null;

  const instrumentParty = position.asset
    ? assetParty(position.asset)
    : position.fund
      ? fundParty(position.fund)
      : null;

  const hasHolder = holderParty !== null;
  const hasInstrument = instrumentParty !== null;

  let status: PositionResolutionStatus = 'resolved';
  if (!hasHolder && !hasInstrument) {
    status = 'missing_both';
  } else if (!hasHolder) {
    status = 'missing_holder';
  } else if (!hasInstrument) {
    status = 'missing_instrument';
  }

  const holder: PartyRef = holderParty ?? {
    id: position.holder_investor_id ?? position.holder_fund_id ?? `missing-holder:${position.id}`,
    name: 'Missing holder',
    kind: 'unknown',
  };

  const instrument: PartyRef = instrumentParty ?? {
    id: position.asset_id ?? position.fund_id ?? `missing-instrument:${position.id}`,
    name: 'Missing instrument',
    kind: 'unknown',
  };

  const instrumentKind: InstrumentKind = position.asset
    ? 'asset'
    : position.fund
      ? 'fund'
      : 'unknown';

  return {
    id: position.id,
    holder,
    instrument,
    instrumentKind,
    fundingSource: position.holder_source_of_fund_id
      ? (fundingSources.get(position.holder_source_of_fund_id) ?? null)
      : null,
    status: position.status,
    openedAt: position.opened_at ?? null,
    raw: position,
    resolution: {
      status,
      isResolved: hasHolder && hasInstrument,
      hasHolder,
      hasInstrument,
      isSynthetic: false,
    },
  };
}

/** Everything the entity search offers, grouped and in display order. */
function buildSearchEntities(portfolio: FlPortfolioReadModel): SearchEntity[] {
  const entities: SearchEntity[] = [];

  for (const investor of portfolio.investors ?? []) {
    entities.push({
      id: investor.id,
      name: investor.name,
      group: 'Investors',
      badge: 'INV',
      meta: investor.investor_type.replace(/_/g, ' '),
      englishName: distinctEnglishName(investor.name, investor.english_name),
      kind: 'party',
    });
  }
  for (const fund of portfolio.funds ?? []) {
    entities.push({
      id: fund.id,
      name: fund.name,
      group: 'Funds',
      badge: fund.managed ? 'FUND' : 'EXT',
      meta: fund.managed ? 'managed' : 'external',
      englishName: distinctEnglishName(fund.name, fund.english_name),
      kind: 'party',
    });
  }
  for (const asset of portfolio.assets ?? []) {
    entities.push({
      id: asset.id,
      name: asset.name,
      group: 'Assets',
      badge: asset.asset_kind === 'loan' ? 'LOAN' : 'ASSET',
      meta: asset.sector ?? asset.asset_kind.replace(/_/g, ' '),
      englishName: distinctEnglishName(asset.name, asset.english_name),
      kind: 'party',
    });
  }
  for (const source of portfolio.funding_sources ?? []) {
    entities.push({
      id: source.id,
      name: source.name,
      group: 'Sources of fund',
      badge: 'SRC',
      meta: source.source_type ?? 'capital pool',
      kind: 'source',
    });
  }

  return entities;
}

/** The position an entry sits on, or `undefined` when it no longer resolves. */
export function positionOf(
  entry: FlPortfolioLedgerEntry,
  index: LedgerIndex,
): ResolvedPosition | undefined {
  return index.positions.get(entry.position_id);
}

/** "PT Sinar Mas · Startech Growth Fund VCC" — how a position is named inline. */
export function positionLabel(positionId: string, index: LedgerIndex): string {
  const position = index.positions.get(positionId);
  if (!position) return positionId;
  return `${position.holder.name} · ${position.instrument.name}`;
}

/** "PT Sinar Mas → Startech Growth Fund VCC" — holder and instrument as direction of travel. */
export function positionDirectionLabel(positionId: string, index: LedgerIndex): string {
  const position = index.positions.get(positionId);
  if (!position) return positionId;
  return `${position.holder.name} → ${position.instrument.name}`;
}

/** Which side of a movement paid and which received. */
export interface FromTo {
  from: PartyRef;
  to: PartyRef;
  /** True when the `from` side is the thing held rather than a holder. */
  fromIsInstrument: boolean;
  toIsInstrument: boolean;
  /** True when no cash moved — the arrow is drawn dashed. */
  noCash: boolean;
}

/**
 * Read an entry's direction of travel.
 *
 * A transfer has two holders and a counterparty leg, so the side giving up the
 * pledge or the units is the payer. Everything else runs between the holder and
 * the thing they hold: money leaving the holder reads holder → instrument, and
 * money coming back reads instrument → holder.
 */
export function describeFromTo(entry: FlPortfolioLedgerEntry, index: LedgerIndex): FromTo {
  const position = index.positions.get(entry.position_id);
  const holder = position?.holder ?? UNKNOWN_PARTY;
  const instrument = position?.instrument ?? UNKNOWN_PARTY;
  const noCash = flIsZero(entry.cash_delta ?? '0');

  if (entry.counterparty_position_id) {
    const other = index.positions.get(entry.counterparty_position_id)?.holder ?? UNKNOWN_PARTY;
    // The leg that gives something up is the one with a negative commitment or
    // unit delta; the other leg receives it.
    const moved = flIsZero(entry.commitment_delta ?? '0')
      ? (entry.quantity_delta ?? '0')
      : (entry.commitment_delta ?? '0');
    const giving = flIsNegative(moved);
    return {
      from: giving ? holder : other,
      to: giving ? other : holder,
      fromIsInstrument: false,
      toIsInstrument: false,
      noCash,
    };
  }

  const inflow = flIsPositive(entry.cash_delta ?? '0');
  return {
    from: inflow ? instrument : holder,
    to: inflow ? holder : instrument,
    fromIsInstrument: inflow,
    toIsInstrument: !inflow,
    noCash,
  };
}

/** How an entry's cash is attributed across capital pools. */
export interface AllocationSplit {
  source: FundingSourceRef;
  amount: string;
  /**
   * True when the split wasn't recorded on the entry but follows from the
   * position's declared source — the whole amount, by definition.
   */
  implied: boolean;
}

/**
 * The funding split for an entry.
 *
 * Attribution sits at two levels. A position that declares a single source of
 * fund attributes every entry there automatically and cannot name another pool.
 * A position that declares none carries the split on the entry, where it must
 * add up to the cash that moved.
 */
export function allocationsOf(
  entry: FlPortfolioLedgerEntry,
  index: LedgerIndex,
): AllocationSplit[] {
  const recorded = entry.allocations ?? [];
  if (recorded.length > 0) {
    return recorded.flatMap((allocation) => {
      const source = index.fundingSources.get(allocation.funding_source_id);
      if (!source) return [];
      return [{ source, amount: allocation.amount, implied: false }];
    });
  }

  const position = index.positions.get(entry.position_id);
  const declared = position?.fundingSource;
  if (!declared || flIsZero(entry.cash_delta ?? '0')) return [];
  return [{ source: declared, amount: flAbs(entry.cash_delta ?? '0'), implied: true }];
}

/**
 * Every capital pool a row touches — the position's declared source plus any
 * pool named in the entry's own split.
 *
 * A row can reach a pool by either route, and the two are not interchangeable:
 * a position that declares a source attributes every entry there, while one
 * that declares none carries the split on the entry. Anything that asks "which
 * rows involve this pool?" — the search count, the Source column, the filter,
 * the copilot tool — has to consider both, or the same question gets different
 * answers depending on where it was asked.
 */
export function sourceNamesOf(entry: FlPortfolioLedgerEntry, index: LedgerIndex): string[] {
  const names: string[] = [];
  const declared = index.positions.get(entry.position_id)?.fundingSource?.name;
  if (declared) names.push(declared);
  for (const allocation of entry.allocations ?? []) {
    const name = index.fundingSources.get(allocation.funding_source_id)?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** True when the splits add up to exactly the cash that moved. */
export function allocationsBalance(
  entry: FlPortfolioLedgerEntry,
  splits: AllocationSplit[],
): boolean {
  const cash = entry.cash_delta ?? '0';
  if (flIsZero(cash)) return true;
  if (splits.length === 0) return false;
  const total = flSum(splits.map((split) => split.amount));
  return flIsZero(flAdd(total, flNeg(flAbs(cash))));
}

/**
 * Why a transfer leg can't stand on its own, or `null` when it's sound.
 *
 * A transfer moves value between two holders: the fund's own totals do not
 * change, so the legs must cancel exactly. A leg whose partner is missing, or
 * whose event doesn't net to zero, is a data problem worth surfacing on the row
 * rather than leaving for a downstream report to trip over.
 */
export function transferLegProblem(
  entry: FlPortfolioLedgerEntry,
  index: LedgerIndex,
): string | null {
  if (!entry.counterparty_position_id) return null;
  const siblings = entry.business_event_id
    ? (index.entriesByEvent.get(entry.business_event_id) ?? [])
    : [];
  const partner = siblings.find(
    (sibling) =>
      sibling.id !== entry.id && sibling.position_id === entry.counterparty_position_id,
  );
  if (!partner) {
    return 'Transfer leg has no counterparty row — it cannot post alone';
  }
  const commitment = flSum(siblings.map((s) => s.commitment_delta ?? '0'));
  const quantity = flSum(siblings.map((s) => s.quantity_delta ?? '0'));
  const cash = flSum(siblings.map((s) => s.cash_delta ?? '0'));
  if (!flIsZero(commitment) || !flIsZero(quantity) || !flIsZero(cash)) {
    return "Transfer legs do not cancel — the fund's totals would move";
  }
  return null;
}

/** What a position is worth, counted up from its rows. */
export interface PositionRollup {
  positionId: string;
  rowCount: number;
  /** Total pledged, net of any commitment transferred away. */
  commitment: string;
  /** Cash actually put in against a commitment, as a positive number. */
  paidIn: string;
  /** Commitment not yet called — commitment minus paid-in. */
  undrawn: string;
  /** Everything paid in or bought with, as a positive number. */
  invested: string;
  /** Units or shares still held: everything acquired minus everything given up. */
  units: string;
  /** Net cash across every row, holder's perspective. */
  netCash: string;
  /** Average cost of the units acquired, or `null` when none were. */
  blendedPrice: string | null;
  /** Rows imported from a source that disagreed with itself. */
  needsChecking: number;
}

/**
 * Roll a position's rows up into its balances.
 *
 * The caller passes the rows already narrowed to the as-of date and nothing
 * else: a position's history is never truncated by the "from" date or by the
 * quick filters, so what it is worth doesn't change as you narrow the view.
 *
 * Blended price covers **acquisitions only** — a disposal at a different price
 * does not move what the units still held cost.
 */
export function rollupPosition(
  positionId: string,
  entries: FlPortfolioLedgerEntry[],
): PositionRollup {
  const rows = entries.filter((entry) => entry.position_id === positionId);

  const commitment = flSum(rows.map((row) => row.commitment_delta ?? '0'));
  const units = flSum(rows.map((row) => row.quantity_delta ?? '0'));
  const netCash = flSum(rows.map((row) => row.cash_delta ?? '0'));

  const paidIn = flAdd(
    flNeg(flSum(rows.filter((row) => row.entry_type === 'paid_in').map((row) => row.cash_delta ?? '0'))),
    flSum(rows.map((row) => paidInAdjustmentDelta(row))),
  );
  const invested = flNeg(
    flSum(
      rows
        .filter((row) => row.entry_type === 'paid_in' || row.entry_type === 'buy')
        .map((row) => row.cash_delta ?? '0'),
    ),
  );

  const acquisitions = rows.filter((row) => flIsPositive(row.quantity_delta ?? '0'));
  const acquiredUnits = flSum(acquisitions.map((row) => row.quantity_delta ?? '0'));
  const acquiredCost = flSum(acquisitions.map((row) => flAbs(row.cash_delta ?? '0')));
  const blendedPrice =
    flIsZero(acquiredUnits) || flIsZero(acquiredCost) ? null : flDiv(acquiredCost, acquiredUnits);

  return {
    positionId,
    rowCount: rows.length,
    commitment,
    paidIn,
    undrawn: flAdd(commitment, flNeg(paidIn)),
    invested,
    units,
    netCash,
    blendedPrice,
    needsChecking: rows.filter((row) => row.data_status === 'needs_verification').length,
  };
}

/** The headline figures above the sheet. */
export interface LedgerSummary {
  /** Cash paid out in the window, as a positive number. */
  cashOut: string;
  cashOutRows: number;
  /** Cash received in the window, as a positive number. */
  cashIn: string;
  cashInRows: number;
  /** Pledged from inception to the as-of date. */
  commitment: string;
  /** Paid in from inception to the as-of date. */
  paidIn: string;
  /** Commitment minus paid-in, from inception to the as-of date. */
  undrawn: string;
  needsChecking: number;
  windowRows: number;
}

/**
 * Summarise the sheet.
 *
 * Two different scopes, deliberately: cash flows and the flagged-row count come
 * from `windowEntries` (what you are currently looking at), while commitment,
 * paid-in and undrawn come from `asOfEntries` (inception to the as-of date).
 * Narrowing the range or adding a filter changes what you are looking at; it
 * never changes what has been pledged.
 */
export function summarizeLedger(
  asOfEntries: FlPortfolioLedgerEntry[],
  windowEntries: FlPortfolioLedgerEntry[],
): LedgerSummary {
  const outflows = windowEntries.filter((entry) => flIsNegative(entry.cash_delta ?? '0'));
  const inflows = windowEntries.filter((entry) => flIsPositive(entry.cash_delta ?? '0'));

  const commitment = flSum(asOfEntries.map((entry) => entry.commitment_delta ?? '0'));
  const cashPaidIn = flNeg(
    flSum(
      asOfEntries
        .filter((entry) => entry.entry_type === 'paid_in')
        .map((entry) => entry.cash_delta ?? '0'),
    ),
  );

  const paidIn = flAdd(cashPaidIn, flSum(asOfEntries.map((row) => paidInAdjustmentDelta(row))));

  return {
    cashOut: flAbs(flSum(outflows.map((entry) => entry.cash_delta ?? '0'))),
    cashOutRows: outflows.length,
    cashIn: flSum(inflows.map((entry) => entry.cash_delta ?? '0')),
    cashInRows: inflows.length,
    commitment,
    paidIn,
    undrawn: flAdd(commitment, flNeg(paidIn)),
    needsChecking: windowEntries.filter((entry) => entry.data_status === 'needs_verification')
      .length,
    windowRows: windowEntries.length,
  };
}

/** Count the entries of each type, for the type-filter chip counts. */
export function countByEntryType(
  entries: FlPortfolioLedgerEntry[],
): Partial<Record<FlEntryType, number>> {
  const counts: Partial<Record<FlEntryType, number>> = {};
  for (const entry of entries) {
    const type = entry.entry_type as FlEntryType;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/** How many rows mention an entity — the "12 rows" hint in the search list. */
export function countEntityRows(entity: SearchEntity, index: LedgerIndex): number {
  return index.entries.filter((entry) => {
    const position = index.positions.get(entry.position_id);
    if (!position) return false;
    if (entity.kind === 'source') {
      if (position.fundingSource?.id === entity.id) return true;
      return (entry.allocations ?? []).some(
        (allocation) => allocation.funding_source_id === entity.id,
      );
    }
    if (position.holder.id === entity.id || position.instrument.id === entity.id) return true;
    if (!entry.counterparty_position_id) return false;
    return index.positions.get(entry.counterparty_position_id)?.holder.id === entity.id;
  }).length;
}
