import {
  toRawAmountString,
  multiplyDecimalStrings,
} from './decimal';
import { getPosition, listPositions, openPosition } from './positions';
import {
  listEntries,
  getEvent,
  postEvent,
  updateEvent,
  reverseEvent,
} from './events';
import { recordValuation, updateValuation } from './valuations';
import type { EntryType, LedgerEntryInput } from './types';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  toDivestmentSubType,
} from '@/lib/sellProceedsDestination';

// ---- High-Level Workflow Helpers for Fund Management UI ----

export async function saveHoldingTransaction(
  fundId: string,
  holdingId: string,
  isFoF: boolean,
  txn: {
    date: string;
    type: 'Buy' | 'Sell' | 'Other';
    value?: number | string | null;
    pps?: number | string | null;
    ppsCurrency?: string | null;
    shares?: number | string | null;
    fx?: string | null;
    notes?: string | null;
    label?: string;
    fundingSourceId?: string | null;
    positionId?: string | null;
    allocations?: Array<{ fundingSourceId: string; amount: string }>;
    entryType?: string | null;
    isReversal?: boolean;
    preserveEconomicFields?: boolean;
    /** Fund-style cash accounting may use an asset target. */
    fundStyle?: boolean;
    sellProceedsDestination?: string | null;
    holderInvestorId?: string | null;
  },
  existingTxnId?: string,
  holderInvestorId?: string | null,
) {
  const explicitFundingSourceId = txn.fundingSourceId ?? null;
  const effectiveHolderInvestorId = holderInvestorId ?? txn.holderInvestorId ?? null;

  const positions = txn.positionId
    ? [await getPosition(txn.positionId)]
    : await listPositions({
        ...(effectiveHolderInvestorId
          ? { holderInvestorId: effectiveHolderInvestorId }
          : { holderFundId: fundId }),
        assetId: isFoF ? undefined : holdingId,
        fundId: isFoF ? holdingId : undefined,
        holderSourceOfFundId: explicitFundingSourceId,
      });

  if (positions.length > 1) {
    const holderParam = effectiveHolderInvestorId
      ? `holderInvestorId=${effectiveHolderInvestorId}`
      : `holderFundId=${fundId}`;
    throw new Error(
      `Ambiguous position match: found ${positions.length} matching positions for ${holderParam}, ${isFoF ? 'fundId' : 'assetId'}=${holdingId}, fundingSourceId=${explicitFundingSourceId}`,
    );
  }

  let pos = positions[0];
  if (!pos) {
    pos = await openPosition({
      holder_fund_id: effectiveHolderInvestorId ? null : fundId,
      holder_investor_id: effectiveHolderInvestorId ?? null,
      asset_id: isFoF ? null : holdingId,
      fund_id: isFoF ? holdingId : null,
      holder_source_of_fund_id: explicitFundingSourceId,
      opened_at: txn.date,
    });
  }

  let rawValueStr = toRawAmountString(txn.value, true);
  let rawSharesStr = toRawAmountString(txn.shares, true);
  const ppsStr = toRawAmountString(txn.pps, false);

  if ((!rawValueStr || rawValueStr === '0') && ppsStr && rawSharesStr && rawSharesStr !== '0') {
    rawValueStr = multiplyDecimalStrings(ppsStr, rawSharesStr);
  }

  const isFoFEffective = Boolean(txn.fundStyle || isFoF || pos.fund_id != null);
  const isBuy = txn.type === 'Buy';
  const isSell = txn.type === 'Sell';

  const absValue = rawValueStr ? rawValueStr.replace(/^-/, '') : '0';
  const absShares = rawSharesStr ? rawSharesStr.replace(/^-/, '') : '0';

  let entryType: EntryType;
  if (txn.entryType) {
    entryType = txn.entryType as EntryType;
  } else if (isFoFEffective) {
    if (isBuy) {
      entryType = 'paid_in';
    } else if (isSell) {
      entryType = absShares && absShares !== '0' ? 'redemption' : 'distribution';
    } else if (
      txn.label === 'Interest income' ||
      txn.label === 'Return of capital' ||
      txn.label === 'Distribution' ||
      txn.label === 'Dividend'
    ) {
      entryType = 'distribution';
    } else {
      entryType = 'expense';
    }
  } else {
    entryType = isBuy
      ? 'buy'
      : isSell
        ? 'sell'
        : txn.label === 'Interest income' || txn.label === 'Return of capital'
          ? 'income'
          : 'expense';
  }

  if (entryType === 'redemption' && (!absShares || absShares === '0')) {
    entryType = 'distribution';
  }

  if (
    (entryType === 'buy' ||
      entryType === 'sell' ||
      entryType === 'paid_in' ||
      entryType === 'distribution' ||
      entryType === 'redemption') &&
    (!absValue || absValue === '0')
  ) {
    throw new Error(`${txn.type} transaction requires a non-zero cash value (or price per unit and quantity)`);
  }
  if ((entryType === 'income' || entryType === 'expense') && (!absValue || absValue === '0')) {
    throw new Error(`${txn.label || entryType} transaction requires a non-zero cash value`);
  }

  let cashDelta = '0';
  let quantityDelta = '0';

  if (entryType === 'paid_in' || entryType === 'buy') {
    cashDelta = `-${absValue}`;
    quantityDelta = absShares && absShares !== '0' ? absShares : '0';
  } else if (entryType === 'redemption') {
    cashDelta = absValue;
    quantityDelta = absShares && absShares !== '0' ? `-${absShares}` : '0';
  } else if (entryType === 'sell') {
    cashDelta = absValue;
    quantityDelta = absShares && absShares !== '0' ? `-${absShares}` : '0';
  } else if (entryType === 'distribution' || entryType === 'income') {
    cashDelta = absValue;
    quantityDelta = '0';
  } else {
    cashDelta = `-${absValue}`;
    quantityDelta = '0';
  }

  const isDivestmentEntry =
    isSell || entryType === 'sell' || entryType === 'redemption' || entryType === 'distribution';
  const explicitSubType = isDivestmentEntry
    ? (toDivestmentSubType(txn.sellProceedsDestination) ?? toDivestmentSubType(txn.label))
    : null;

  const subType =
    explicitSubType ?? (txn.label ?? (entryType === 'distribution' && isSell ? 'divestment' : null));

  const entryInput: LedgerEntryInput = {
    position_id: pos.id,
    entry_date: txn.date,
    entry_type: entryType,
    sub_type: subType,
    commitment_delta: '0',
    quantity_delta: quantityDelta,
    cash_delta: cashDelta,
    currency: txn.ppsCurrency || 'USD',
    price_per_unit: ppsStr,
    fx_rate: toRawAmountString(txn.fx, false),
    notes: txn.notes ?? null,
    allocations:
      txn.allocations?.length && absValue !== '0'
        ? txn.allocations.map((allocation) => ({
            funding_source_id: allocation.fundingSourceId,
            amount: allocation.amount,
          }))
        : explicitFundingSourceId && absValue !== '0'
          ? [
            {
              funding_source_id: explicitFundingSourceId,
              amount: absValue,
            },
            ]
          : undefined,
  };

  if (existingTxnId) {
    const entries = await listEntries({ positionIds: [pos.id] });
    const entry = entries.find((e) => e.id === existingTxnId);
    let eventId = entry?.business_event_id;
    if (!eventId) {
      const ev = await getEvent(existingTxnId).catch(() => null);
      eventId = ev?.event?.id ?? existingTxnId;
    }
    const original = await getEvent(eventId);
    const allocationsByEntryId = new Map<string, typeof original.allocations>();
    for (const allocation of original.allocations ?? []) {
      const existing = allocationsByEntryId.get(allocation.ledger_entry_id) ?? [];
      existing.push(allocation);
      allocationsByEntryId.set(allocation.ledger_entry_id, existing);
    }
    // Cash legs the service derived for itself are left out: postEvent builds
    // them again from the primary rows, and re-sending one is rejected, because
    // the transient primary_entry_index that paired it to its primary existed
    // only inside the original request. An opening balance and an FX transfer
    // leg are standalone rows and are preserved.
    const preservedEntries = original.entries.filter(
      (originalEntry) =>
        originalEntry.entry_type !== 'cash_movement' ||
        originalEntry.counterparty_position_id ||
        originalEntry.sub_type === 'opening_balance',
    );
    const replacementEntries: LedgerEntryInput[] = preservedEntries.map((originalEntry) => {
      const preserved: LedgerEntryInput = {
        position_id: originalEntry.position_id,
        entry_date: txn.date,
        entry_type: originalEntry.entry_type,
        sub_type: originalEntry.sub_type,
        commitment_delta: String(originalEntry.commitment_delta),
        quantity_delta: String(originalEntry.quantity_delta),
        valuation_delta: String(originalEntry.valuation_delta ?? '0'),
        cash_delta: String(originalEntry.cash_delta),
        currency: originalEntry.currency,
        fx_rate: originalEntry.fx_rate,
        price_per_unit: originalEntry.price_per_unit,
        counterparty_position_id: originalEntry.counterparty_position_id,
        data_status: originalEntry.data_status,
        source_record_id: originalEntry.source_record_id,
        notes: originalEntry.notes,
        allocations: (allocationsByEntryId.get(originalEntry.id) ?? []).map((allocation) => ({
          funding_source_id: allocation.funding_source_id,
          amount: String(allocation.amount),
        })),
      };
      if (originalEntry.id !== existingTxnId) return preserved;
      if (txn.preserveEconomicFields) {
        return {
          ...preserved,
          sub_type: explicitSubType ?? (txn.label ?? originalEntry.sub_type),
          notes: txn.notes ?? null,
        };
      }
      return entryInput;
    });
    return updateEvent(eventId, {
      event_date: txn.date,
      description: txn.notes || txn.label || txn.type,
      source_record_id: original.event.source_record_id,
      entries: replacementEntries,
    });
  } else {
    return postEvent({
      event_date: txn.date,
      description: txn.notes || txn.label || txn.type,
      entries: [entryInput],
    });
  }
}

export async function deleteHoldingTransaction(
  fundId: string,
  holdingId: string,
  isFoF: boolean,
  txnId: string,
  options?: {
    fundingSourceId?: string | null;
    holderInvestorId?: string | null;
  } | null,
  holderInvestorId?: string | null,
) {
  const explicitFundingSourceId = options?.fundingSourceId ?? null;
  const effectiveHolderInvestorId = holderInvestorId ?? options?.holderInvestorId ?? null;

  const positions = await listPositions({
    ...(effectiveHolderInvestorId
      ? { holderInvestorId: effectiveHolderInvestorId }
      : { holderFundId: fundId }),
    assetId: isFoF ? undefined : holdingId,
    fundId: isFoF ? holdingId : undefined,
    holderSourceOfFundId: explicitFundingSourceId,
  });

  if (positions.length === 1) {
    const entries = await listEntries({ positionIds: [positions[0].id] });
    const entry = entries.find((e) => e.id === txnId);
    const eventId = entry?.business_event_id ?? txnId;
    return reverseEvent(eventId, { description: 'Transaction reversed' });
  } else if (positions.length > 1) {
    const entries = await listEntries({ positionIds: positions.map((p) => p.id) });
    const entry = entries.find((e) => e.id === txnId);
    if (entry?.business_event_id) {
      return reverseEvent(entry.business_event_id, { description: 'Transaction reversed' });
    }
  }

  return reverseEvent(txnId, { description: 'Transaction reversed' });
}

export async function saveHoldingValuation(
  holdingId: string,
  isFoF: boolean,
  rec: {
    id?: string;
    asOfDate?: string;
    q?: string;
    mv?: number | string | null;
    cost?: number | string | null;
    pps?: number | string | null;
    ppsCurrency?: string | null;
    sharesOut?: number | string | null;
    shPct?: number | null;
    moic?: number | null;
    xirr?: number | null;
    notes?: string | null;
  },
) {
  const rawMv = toRawAmountString(rec.mv, true);
  const rawCost = toRawAmountString(rec.cost, true);
  const rawShares = toRawAmountString(rec.sharesOut, true);
  const pps = toRawAmountString(rec.pps, false);
  const meta: Record<string, unknown> = {};
  if (rec.q) meta.period_label = rec.q;
  if (rec.shPct != null) meta.shareholding_pct = rec.shPct;
  if (rec.moic != null) meta.gross_moic = rec.moic;
  if (rec.xirr != null) meta.gross_xirr = rec.xirr;

  const userNotes = rec.notes?.trim();
  const serializedMeta = Object.keys(meta).length > 0
    ? `source_meta: ${JSON.stringify(meta)}`
    : null;
  const notes = userNotes && serializedMeta
    ? `${userNotes} | ${serializedMeta}`
    : userNotes || serializedMeta;

  if (rec.id) {
    return updateValuation(rec.id, {
      as_of_date: rec.asOfDate,
      market_value: rawMv,
      price_per_unit: pps,
      units_outstanding: rawShares,
      gross_value: rawCost,
      currency: rec.ppsCurrency || 'USD',
      notes: notes ?? null,
    });
  } else {
    return recordValuation({
      asset_id: isFoF ? null : holdingId,
      fund_id: isFoF ? holdingId : null,
      as_of_date: rec.asOfDate || new Date().toISOString().slice(0, 10),
      market_value: rawMv,
      price_per_unit: pps,
      units_outstanding: rawShares,
      gross_value: rawCost,
      currency: rec.ppsCurrency || 'USD',
      notes: notes ?? null,
    });
  }
}
