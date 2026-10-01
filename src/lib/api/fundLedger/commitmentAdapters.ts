import {
  toRawAmountString,
  addDecimalStrings,
} from './decimal';
import { getPortfolio } from './portfolio';
import { listPositions, openPosition } from './positions';
import {
  getEvent,
  postEvent,
  updateEvent,
  reverseEvent,
} from './events';
import type {
  CommitmentEventType,
  CommitmentEventWithBalance,
  LedgerEntryInput,
  EntryType,
} from './types';

// ---- Commitment Adapters ----

export async function listCommitmentEvents(params?: {
  fundId?: string;
  holdingEntityId?: string;
}): Promise<CommitmentEventWithBalance[]> {
  const portfolio = await getPortfolio();
  let positions = portfolio.positions.filter(
    (p) => p.holder_investor_id != null && p.fund_id != null,
  );
  if (params?.holdingEntityId) {
    positions = positions.filter((p) => p.holder_investor_id === params.holdingEntityId);
  }
  if (params?.fundId) {
    positions = positions.filter((p) => p.fund_id === params.fundId);
  }

  const posIds = new Set(positions.map((p) => p.id));
  const posMap = new Map(positions.map((p) => [p.id, p]));

  const commitmentEntries = portfolio.entries.filter(
    (e) =>
      posIds.has(e.position_id) &&
      (e.entry_type === 'commitment' || e.entry_type === 'commitment_transfer'),
  );

  const entriesByPosition = new Map<string, typeof commitmentEntries>();
  for (const entry of commitmentEntries) {
    let list = entriesByPosition.get(entry.position_id);
    if (!list) {
      list = [];
      entriesByPosition.set(entry.position_id, list);
    }
    list.push(entry);
  }

  const result: CommitmentEventWithBalance[] = [];

  for (const [posId, posEntries] of entriesByPosition.entries()) {
    const pos = posMap.get(posId);
    if (!pos) continue;

    posEntries.sort((a, b) => {
      if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? -1 : 1;
      return a.created_at < b.created_at ? -1 : 1;
    });

    let running = '0';
    for (const e of posEntries) {
      const delta = e.commitment_delta || '0';
      const cpPos = e.counterparty_position_id
        ? portfolio.positions.find((p) => p.id === e.counterparty_position_id)
        : null;

      let event_type: CommitmentEventType = 'additional_commitment';
      if (e.entry_type === 'commitment_transfer') {
        event_type = delta.startsWith('-') ? 'transfer_out' : 'transfer_in';
      } else if (e.entry_type === 'commitment' && e.sub_type === 'transfer_in') {
        // A transferee-only transfer (Nanjing import): no counterparty leg.
        event_type = 'transfer_in';
      } else if (delta.startsWith('-')) {
        event_type = 'reduction';
      } else {
        event_type = 'additional_commitment';
      }

      running = addDecimalStrings(running, delta);

      result.push({
        id: e.id,
        fund_id: pos.fund_id!,
        holding_entity_id: pos.holder_investor_id!,
        effective_date: e.entry_date,
        event_type,
        amount: Math.abs(Number(delta)),
        currency: e.currency,
        counterparty_holding_entity_id: cpPos?.holder_investor_id ?? null,
        transfer_group_id: e.business_event_id,
        notes: e.notes,
        source: null,
        runningBalance: Number(running),
        created_at: e.created_at,
      });
    }
  }

  result.sort((a, b) => {
    if (a.effective_date !== b.effective_date) return a.effective_date < b.effective_date ? -1 : 1;
    return a.created_at < b.created_at ? -1 : 1;
  });

  return result;
}

export async function createCommitmentEvent(input: {
  fundId: string;
  holdingEntityId: string;
  effectiveDate: string;
  eventType: CommitmentEventType;
  amount: number | string;
  currency?: string;
  counterpartyHoldingEntityId?: string | null;
  notes?: string | null;
  fundingSourceId?: string | null;
}) {
  const explicitFundingSourceId = input.fundingSourceId ?? null;

  const positions = await listPositions({
    holderInvestorId: input.holdingEntityId,
    fundId: input.fundId,
    holderSourceOfFundId: explicitFundingSourceId,
  });

  if (positions.length > 1) {
    throw new Error(
      `Ambiguous position match: found ${positions.length} matching positions for holderInvestorId=${input.holdingEntityId}, fundId=${input.fundId}, fundingSourceId=${explicitFundingSourceId}`,
    );
  }

  let pos = positions[0];
  if (!pos) {
    pos = await openPosition({
      holder_investor_id: input.holdingEntityId,
      holder_fund_id: null,
      fund_id: input.fundId,
      asset_id: null,
      holder_source_of_fund_id: explicitFundingSourceId,
      opened_at: input.effectiveDate,
    });
  }

  const rawAmt = toRawAmountString(input.amount, false) || '0';
  const delta = input.eventType === 'reduction' ? `-${rawAmt}` : rawAmt;

  return postEvent({
    event_date: input.effectiveDate,
    description: input.notes || 'Commitment event',
    entries: [
      {
        position_id: pos.id,
        entry_date: input.effectiveDate,
        entry_type: 'commitment',
        commitment_delta: delta,
        quantity_delta: '0',
        cash_delta: '0',
        currency: input.currency || 'USD',
        notes: input.notes ?? null,
      },
    ],
  });
}

export async function createCommitmentTransfer(input: {
  fundId: string;
  fromHoldingEntityId: string;
  toHoldingEntityId: string;
  effectiveDate: string;
  amount: number | string;
  currency?: string;
  notes?: string | null;
  fromFundingSourceId?: string | null;
  toFundingSourceId?: string | null;
}) {
  const fromSourceId = input.fromFundingSourceId ?? null;
  const toSourceId = input.toFundingSourceId ?? null;

  const fromPositions = await listPositions({
    holderInvestorId: input.fromHoldingEntityId,
    fundId: input.fundId,
    holderSourceOfFundId: fromSourceId,
  });

  if (fromPositions.length > 1) {
    throw new Error(
      `Ambiguous position match: found ${fromPositions.length} matching positions for fromHoldingEntityId=${input.fromHoldingEntityId}`,
    );
  }

  let fromPos = fromPositions[0];
  if (!fromPos) {
    fromPos = await openPosition({
      holder_investor_id: input.fromHoldingEntityId,
      holder_fund_id: null,
      fund_id: input.fundId,
      asset_id: null,
      holder_source_of_fund_id: fromSourceId,
      opened_at: input.effectiveDate,
    });
  }

  const toPositions = await listPositions({
    holderInvestorId: input.toHoldingEntityId,
    fundId: input.fundId,
    holderSourceOfFundId: toSourceId,
  });

  if (toPositions.length > 1) {
    throw new Error(
      `Ambiguous position match: found ${toPositions.length} matching positions for toHoldingEntityId=${input.toHoldingEntityId}`,
    );
  }

  let toPos = toPositions[0];
  if (!toPos) {
    toPos = await openPosition({
      holder_investor_id: input.toHoldingEntityId,
      holder_fund_id: null,
      fund_id: input.fundId,
      asset_id: null,
      holder_source_of_fund_id: toSourceId,
      opened_at: input.effectiveDate,
    });
  }

  const rawAmt = toRawAmountString(input.amount, false) || '0';

  return postEvent({
    event_date: input.effectiveDate,
    description: input.notes || 'Commitment transfer',
    entries: [
      {
        position_id: fromPos.id,
        counterparty_position_id: toPos.id,
        entry_date: input.effectiveDate,
        entry_type: 'commitment_transfer',
        commitment_delta: `-${rawAmt}`,
        quantity_delta: '0',
        cash_delta: '0',
        currency: input.currency || 'USD',
        notes: input.notes ?? null,
      },
      {
        position_id: toPos.id,
        counterparty_position_id: fromPos.id,
        entry_date: input.effectiveDate,
        entry_type: 'commitment_transfer',
        commitment_delta: rawAmt,
        quantity_delta: '0',
        cash_delta: '0',
        currency: input.currency || 'USD',
        notes: input.notes ?? null,
      },
    ],
  });
}

export async function updateCommitmentEvent(
  id: string,
  input: {
    effectiveDate?: string;
    eventType?: CommitmentEventType;
    amount?: number | string;
    currency?: string;
    notes?: string | null;
  },
) {
  let eventId = id;
  const portfolio = await getPortfolio().catch(() => null);
  const entryFromPortfolio = portfolio?.entries.find((e) => e.id === id);
  if (entryFromPortfolio?.business_event_id) {
    eventId = entryFromPortfolio.business_event_id;
  }

  const eventData = await getEvent(eventId);
  if (!eventData || !eventData.event) {
    throw new Error(`Business event "${eventId}" not found`);
  }

  const { event, entries } = eventData;
  const targetEntry = entries.find((e) => e.id === id) || entries[0];
  if (!targetEntry) {
    throw new Error(`No entries found for event "${eventId}"`);
  }

  const newDate = input.effectiveDate || event.event_date;
  const rawAmt =
    input.amount != null
      ? toRawAmountString(input.amount, false) || '0'
      : (targetEntry.commitment_delta || '0').replace(/^-/, '');
  const currency = input.currency || targetEntry.currency || 'USD';
  const notes = input.notes !== undefined ? input.notes : event.description;

  const isTransfer = entries.some((e) => e.entry_type === 'commitment_transfer');

  if (isTransfer) {
    const updatedEntries: LedgerEntryInput[] = entries.map((e) => {
      const isNeg = e.commitment_delta?.startsWith('-');
      return {
        position_id: e.position_id,
        counterparty_position_id: e.counterparty_position_id,
        entry_date: newDate,
        entry_type: 'commitment_transfer',
        sub_type: e.sub_type,
        commitment_delta: isNeg ? `-${rawAmt}` : rawAmt,
        quantity_delta: '0',
        cash_delta: '0',
        currency,
        notes,
      };
    });

    return updateEvent(event.id, {
      event_date: newDate,
      description: notes || 'Commitment transfer update',
      entries: updatedEntries,
    });
  } else {
    const isNeg =
      input.eventType === 'reduction' ||
      input.eventType === 'transfer_out' ||
      (input.eventType === undefined && targetEntry.commitment_delta?.startsWith('-'));

    const updatedEntries: LedgerEntryInput[] = [
      {
        position_id: targetEntry.position_id,
        counterparty_position_id: targetEntry.counterparty_position_id,
        entry_date: newDate,
        entry_type: targetEntry.entry_type as EntryType,
        sub_type: targetEntry.sub_type,
        commitment_delta: isNeg ? `-${rawAmt}` : rawAmt,
        quantity_delta: '0',
        cash_delta: '0',
        currency,
        notes,
      },
    ];

    return updateEvent(event.id, {
      event_date: newDate,
      description: notes || 'Commitment update',
      entries: updatedEntries,
    });
  }
}

export async function deleteCommitmentEvent(id: string) {
  const portfolio = await getPortfolio().catch(() => null);
  const entry = portfolio?.entries.find((e) => e.id === id);
  const eventId = entry?.business_event_id ?? id;
  return reverseEvent(eventId, { description: 'Commitment event reversed' });
}
