import { flIsZero, flNeg, toDecimalString } from '@/lib/services/flDecimal';
import { validateCurrency } from '@/lib/services/flCurrency';
import {
  InvalidEntryShapeError,
  InvalidCurrencyError,
  AllocationMismatchError,
} from '@/lib/services/flErrors';
import { SUB_TYPE_DIVESTMENT_CASH_IN_FUND } from '@/lib/sellProceedsDestination';
import {
  PROCEEDS_TREATMENT_ENTRY_TYPES,
  resolveProceedsTreatment,
} from './proceedsTreatment';
import type { FlEntryType } from './entryTypes';

export interface PositionWithFundFlags {
  id: string;
  holder_investor_id?: string | null;
  holder_fund_id?: string | null;
  fund_id?: string | null;
  asset_id?: string | null;
  holderFundManaged?: boolean;
  instrumentFundManaged?: boolean;
}

export interface DerivableEntry {
  position_id: string;
  entry_type: FlEntryType | string;
  sub_type?: string | null;
  cash_delta?: string | null;
  currency: string;
  primary_entry_index?: number | null;
  source_entry_index?: number | null;
  commitment_delta?: string | null;
  quantity_delta?: string | null;
  valuation_delta?: string | null;
  entry_date?: string | null;
  data_status?: string | null;
  source_record_id?: string | null;
  counterparty_position_id?: string | null;
  allocations?: any[];
}

export interface CashLegSpec {
  primary_entry_index: number;
  holder_kind: 'fund';
  holder_id: string;
  currency: string;
  cash_delta: string;
  role: 'holder' | 'instrument';
}

/**
 * Derives all RFC-derived cash legs for primary entries in a business event (RFC §4).
 * Pure and deterministic; encapsulates the complete role-based algorithm.
 */
export function deriveExpectedCashLegSpecs(
  entries: DerivableEntry[],
  positionsWithFundFlags:
    | Map<string, PositionWithFundFlags>
    | Record<string, PositionWithFundFlags>
    | PositionWithFundFlags[],
): CashLegSpec[] {
  const getPos = (id: string): PositionWithFundFlags | undefined => {
    if (positionsWithFundFlags instanceof Map) {
      return positionsWithFundFlags.get(id);
    }
    if (Array.isArray(positionsWithFundFlags)) {
      return positionsWithFundFlags.find((p) => p.id === id);
    }
    return (positionsWithFundFlags as Record<string, PositionWithFundFlags>)[id];
  };

  const specs: CashLegSpec[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];

    // Exclusion: cash_movement cannot recursively generate more legs
    if (entry.entry_type === 'cash_movement') {
      continue;
    }

    // Exclusion: zero-cash entries
    const cashDelta = entry.cash_delta ?? '0';
    if (flIsZero(cashDelta)) {
      continue;
    }

    const pos = getPos(entry.position_id);
    if (!pos) {
      continue;
    }

    const currency = validateCurrency(entry.currency);
    const normalizedCashDelta = toDecimalString(cashDelta);

    // 1. HOLDER-SIDE LEG (managed funds only)
    if (pos.holder_fund_id && pos.holderFundManaged) {
      let excludeHolderLeg = false;

      if (
        (PROCEEDS_TREATMENT_ENTRY_TYPES as readonly string[]).includes(
          entry.entry_type,
        )
      ) {
        const treatment = resolveProceedsTreatment({
          entryType: entry.entry_type,
          holder: {
            holder_investor_id: pos.holder_investor_id,
            holder_fund_id: pos.holder_fund_id,
            holderFundManaged: pos.holderFundManaged,
          },
          statedSubType: entry.sub_type,
        });

        if (treatment.subType !== SUB_TYPE_DIVESTMENT_CASH_IN_FUND) {
          excludeHolderLeg = true;
        }
      }

      if (!excludeHolderLeg) {
        specs.push({
          primary_entry_index: idx,
          holder_kind: 'fund',
          holder_id: pos.holder_fund_id,
          currency,
          cash_delta: normalizedCashDelta,
          role: 'holder',
        });
      }
    }

    // 2. INSTRUMENT-SIDE LEG
    if (pos.fund_id && pos.instrumentFundManaged) {
      const isTransfer =
        entry.entry_type === 'unit_transfer' ||
        entry.entry_type === 'commitment_transfer';

      if (!isTransfer) {
        specs.push({
          primary_entry_index: idx,
          holder_kind: 'fund',
          holder_id: pos.fund_id,
          currency,
          cash_delta: flNeg(normalizedCashDelta),
          role: 'instrument',
        });
      }
    }
  }

  return specs;
}

/**
 * Reconciles explicitly supplied Form-1 cash_movement legs against expected specs.
 * An explicitly supplied leg suppresses automatic generation only when it exactly
 * matches the RFC-derived leg:
 * - same transient primary reference
 * - exact managed fund role/destination and currency
 * - exact cash-delta magnitude and sign
 * - zero commitment/quantity/valuation, no allocations
 * - copied primary metadata per Phase 3
 *
 * A wrong-sign or wrong-magnitude explicit leg is rejected with InvalidEntryShapeError.
 * For managed-to-managed entries, one valid explicit leg suppresses only that role's
 * leg and the other required leg is retained for automatic generation.
 */
export function reconcileCashLegs(
  expectedSpecs: CashLegSpec[],
  entries: DerivableEntry[],
  positionsWithFundFlags:
    | Map<string, PositionWithFundFlags>
    | Record<string, PositionWithFundFlags>
    | PositionWithFundFlags[],
): CashLegSpec[] {
  const getPos = (id: string): PositionWithFundFlags | undefined => {
    if (positionsWithFundFlags instanceof Map) {
      return positionsWithFundFlags.get(id);
    }
    if (Array.isArray(positionsWithFundFlags)) {
      return positionsWithFundFlags.find((p) => p.id === id);
    }
    return (positionsWithFundFlags as Record<string, PositionWithFundFlags>)[id];
  };

  const suppressedSpecIndices = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.entry_type !== 'cash_movement') {
      continue;
    }

    const primaryIdx = e.primary_entry_index ?? e.source_entry_index;
    const hasTransientRef = primaryIdx !== undefined && primaryIdx !== null;

    if (!hasTransientRef) {
      // Form 2 (FX transfer) or Form 3 (Opening balance)
      continue;
    }

    if (
      typeof primaryIdx !== 'number' ||
      !Number.isInteger(primaryIdx) ||
      primaryIdx < 0 ||
      primaryIdx >= entries.length
    ) {
      throw new InvalidEntryShapeError(
        `Mirrored cash_movement primary_entry_index ${primaryIdx} is out of range [0, ${entries.length})`,
      );
    }

    if (primaryIdx === i) {
      throw new InvalidEntryShapeError(
        'Mirrored cash_movement leg cannot reference itself',
      );
    }

    const primary = entries[primaryIdx];
    if (primary.entry_type === 'cash_movement') {
      throw new InvalidEntryShapeError(
        'Mirrored cash_movement leg cannot reference another cash_movement entry',
      );
    }

    // Zero commitment, quantity, valuation
    if (
      e.commitment_delta !== undefined &&
      e.commitment_delta !== null &&
      !flIsZero(e.commitment_delta)
    ) {
      throw new InvalidEntryShapeError(
        `Explicit cash_movement leg requires commitment_delta = 0. Received: ${e.commitment_delta}`,
      );
    }
    if (
      e.quantity_delta !== undefined &&
      e.quantity_delta !== null &&
      !flIsZero(e.quantity_delta)
    ) {
      throw new InvalidEntryShapeError(
        `Explicit cash_movement leg requires quantity_delta = 0. Received: ${e.quantity_delta}`,
      );
    }
    if (
      e.valuation_delta !== undefined &&
      e.valuation_delta !== null &&
      !flIsZero(e.valuation_delta)
    ) {
      throw new InvalidEntryShapeError(
        `Explicit cash_movement leg requires valuation_delta = 0. Received: ${e.valuation_delta}`,
      );
    }

    // Nonzero cash delta
    if (!e.cash_delta || flIsZero(e.cash_delta)) {
      throw new InvalidEntryShapeError(
        'Explicit cash_movement leg requires cash_delta <> 0',
      );
    }

    // Allocations
    if (e.allocations && e.allocations.length > 0) {
      throw new AllocationMismatchError(
        'cash_movement entries must carry no funding allocations',
      );
    }

    const pos = getPos(e.position_id);
    if (!pos || !pos.holder_fund_id || pos.fund_id) {
      throw new InvalidEntryShapeError(
        `Explicit cash_movement leg position "${e.position_id}" must belong to a holder fund`,
      );
    }

    const explicitHolderId = pos.holder_fund_id;
    // Mirrored leg's declared currency must match the primary entry's currency
    const explicitCurrency = validateCurrency(e.currency);

    // Find the matching expected spec for this primary entry and holder
    const matchingSpecIndex = expectedSpecs.findIndex(
      (spec, sIdx) =>
        !suppressedSpecIndices.has(sIdx) &&
        spec.primary_entry_index === primaryIdx &&
        spec.holder_kind === 'fund' &&
        spec.holder_id === explicitHolderId,
    );

    if (matchingSpecIndex === -1) {
      throw new InvalidEntryShapeError(
        `Explicit cash_movement leg references primary entry ${primaryIdx} which does not derive a cash leg for fund "${explicitHolderId}"`,
      );
    }

    const matchedSpec = expectedSpecs[matchingSpecIndex];

    if (explicitCurrency !== matchedSpec.currency) {
      throw new InvalidCurrencyError(
        `Explicit cash_movement leg currency "${explicitCurrency}" does not match expected currency "${matchedSpec.currency}"`,
      );
    }

    const explicitCashDelta = toDecimalString(e.cash_delta);
    if (explicitCashDelta !== matchedSpec.cash_delta) {
      throw new InvalidEntryShapeError(
        `Explicit cash_movement leg cash_delta (${explicitCashDelta}) does not match expected RFC-derived cash_delta (${matchedSpec.cash_delta}) for primary entry ${primaryIdx}`,
      );
    }

    // Valid explicit leg suppresses this specific spec
    suppressedSpecIndices.add(matchingSpecIndex);
  }

  return expectedSpecs.filter((_, idx) => !suppressedSpecIndices.has(idx));
}

/**
 * Derives role-based cash legs for business event entries per RFC §4.
 *
 * For each primary entry with cash_delta != 0 in a business event:
 * - Position's holder_fund_id refers to a fund with managed = true ->
 *   leg of +cash_delta on that fund's cash position (entry's currency).
 * - Position's fund_id (instrument) refers to a fund with managed = true ->
 *   leg of -cash_delta on that fund's cash position.
 * - Both managed -> two legs, opposite signs.
 *
 * Exclusions:
 * - proceeds-type entries (sell, redemption, distribution):
 *   holder-side (+cash) leg posts when resolved treatment is 'divestment:cash_in_fund'.
 *   Default treatment applies: missing or unstated treatment resolves to 'divestment:cash_in_fund'.
 * - unit_transfer/commitment_transfer: instrument-side legs never post (cash moves holder-to-holder,
 *   never touches fund). Holder-side legs DO post when holder is a managed fund and leg carries cash.
 * - cash_movement itself; zero-cash entries.
 * - explicitly supplied valid mirrored leg suppresses generation for the same
 *   primary/fund/currency only when economically exact.
 */
export function deriveCashLegs(
  entries: DerivableEntry[],
  positionsWithFundFlags:
    | Map<string, PositionWithFundFlags>
    | Record<string, PositionWithFundFlags>
    | PositionWithFundFlags[],
): CashLegSpec[] {
  const expectedSpecs = deriveExpectedCashLegSpecs(
    entries,
    positionsWithFundFlags,
  );
  return reconcileCashLegs(expectedSpecs, entries, positionsWithFundFlags);
}
