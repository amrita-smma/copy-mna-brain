import { describe, expect, it } from 'vitest';
import {
  applyPositionChange,
  applyEntryTypeChange,
  buildUpdateEventInput,
  cashIsLockedBySplit,
  deltaHint,
  editBlockedReason,
  entryEditRowHeader,
  eventEditDraftFrom,
  eventEditProblem,
  isDeltaLocked,
  isEventEditSavable,
  isEventEditUnchanged,
  editRowSubTypeControl,
  isTransferEvent,
  orderRowsForDisplay,
  positionIsEditable,
  positionOptionsForRow,
  priceIsDerived,
  valuationIsLocked,
  type EventEditDraft,
} from './editDraft';
import { buildLedgerIndex } from './derive';
import { ENTRIES, EVENTS, buildTestPortfolio } from './testFixtures';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
} from '@/lib/sellProceedsDestination';

const index = buildLedgerIndex(buildTestPortfolio());

const buyDraft = () => eventEditDraftFrom(EVENTS.gotoBuy, [ENTRIES.gotoBuy], index);
const transferDraft = () =>
  eventEditDraftFrom(
    EVENTS.commitTransfer,
    [ENTRIES.transferGive, ENTRIES.transferTake],
    index,
  );
const akulakuDraft = () => eventEditDraftFrom(EVENTS.akulakuBuy, [ENTRIES.akulakuBuy], index);

describe('eventEditDraftFrom', () => {
  it('seeds the event fields and every row it caused', () => {
    const draft = buyDraft();
    expect(draft.eventId).toBe(EVENTS.gotoBuy.id);
    expect(draft.eventDate).toBe('2018-01-22');
    expect(draft.description).toBe('Investment — GOTO Group Series E');
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]).toMatchObject({
      positionId: 'pos-mer-goto',
      entryType: 'buy',
      subType: 'initial',
      quantityDelta: '9500000',
      cashDelta: '-43780000.00',
      pricePerUnit: '4.608',
      dataStatus: 'verified',
    });
  });

  it("keeps each row's stored currency when no currency is pinned", () => {
    const draft = eventEditDraftFrom(
      EVENTS.gotoBuy,
      [{ ...ENTRIES.gotoBuy, currency: 'IDR' }],
      index,
    );
    expect(draft.rows[0].currency).toBe('IDR');
  });

  it('pins every row to the currency it is given', () => {
    const draft = eventEditDraftFrom(
      EVENTS.commitTransfer,
      [
        { ...ENTRIES.transferGive, currency: 'USD' },
        { ...ENTRIES.transferTake, currency: 'IDR' },
      ],
      index,
      'CNY',
    );
    expect(draft.rows.map((row) => row.currency)).toEqual(['CNY', 'CNY']);
  });

  it('seeds money to two places and leaves units at their own precision', () => {
    const draft = eventEditDraftFrom(
      EVENTS.gotoBuy,
      [
        {
          ...ENTRIES.gotoBuy,
          commitment_delta: '0.00000000',
          cash_delta: '-43780000.00000000',
          quantity_delta: '9500000.50000000',
        },
      ],
      index,
    );
    expect(draft.rows[0].commitmentDelta).toBe('0.00');
    expect(draft.rows[0].cashDelta).toBe('-43780000.00');
    expect(draft.rows[0].quantityDelta).toBe('9500000.5');
  });

  it('keeps sub-cent money rather than rounding it away behind the user', () => {
    const draft = eventEditDraftFrom(
      EVENTS.gotoBuy,
      [{ ...ENTRIES.gotoBuy, cash_delta: '-43780000.00012500' }],
      index,
    );
    expect(draft.rows[0].cashDelta).toBe('-43780000.000125');
  });

  it('carries both legs of a transfer, because an edit rewrites the whole event', () => {
    const draft = transferDraft();
    expect(draft.rows).toHaveLength(2);
    expect(isTransferEvent(draft)).toBe(true);
    expect(isTransferEvent(buyDraft())).toBe(false);
  });

  it('turns nulls into empty strings the form can hold', () => {
    const draft = eventEditDraftFrom(
      EVENTS.subscription1982,
      [ENTRIES.subscription1982],
      index,
    );
    expect(draft.rows[0].subType).toBe('');
    expect(draft.rows[0].pricePerUnit).toBe('');
    expect(draft.rows[0].dataStatus).toBe('needs_verification');
    expect(draft.rows[0].notes).toContain('Sheet totals disagree');
  });
});

describe('eventEditProblem', () => {
  it('accepts an untouched draft', () => {
    expect(eventEditProblem(buyDraft())).toBeNull();
    expect(eventEditProblem(transferDraft())).toBeNull();
    expect(isEventEditSavable(buyDraft())).toBe(true);
  });

  it('requires a date and at least one row', () => {
    expect(eventEditProblem({ ...buyDraft(), eventDate: '' })).toMatch(/needs a date/);
    expect(eventEditProblem({ ...buyDraft(), rows: [] })).toMatch(/at least one row/);
  });

  it('rejects a delta that is not a number', () => {
    const draft = buyDraft();
    draft.rows[0].cashDelta = 'about forty million';
    expect(eventEditProblem(draft)).toMatch(/not a number/);
  });

  it('treats a blank delta as zero rather than an error', () => {
    const draft = buyDraft();
    draft.rows[0].quantityDelta = '';
    // buy allows quantity >= 0, so a blank is fine.
    expect(eventEditProblem(draft)).toBeNull();
  });

  it('enforces the entry-type matrix, so the service cannot reject the save', () => {
    const positiveCashOnABuy = buyDraft();
    positiveCashOnABuy.rows[0].cashDelta = '1000';
    expect(eventEditProblem(positiveCashOnABuy)).toMatch(/cannot carry that cash/);

    const commitmentOnABuy = buyDraft();
    commitmentOnABuy.rows[0].commitmentDelta = '500';
    expect(eventEditProblem(commitmentOnABuy)).toMatch(/cannot carry that commitment/);

    const negativeUnitsOnABuy = buyDraft();
    negativeUnitsOnABuy.rows[0].quantityDelta = '-1';
    expect(eventEditProblem(negativeUnitsOnABuy)).toMatch(/cannot carry that quantity/);
  });

  it('rejects a transfer whose legs no longer cancel', () => {
    const draft = transferDraft();
    draft.rows[0].commitmentDelta = '-4000000';
    expect(eventEditProblem(draft)).toMatch(/no longer cancel/);
  });

  it('accepts a transfer edited on both legs so they still cancel', () => {
    const draft = transferDraft();
    draft.rows[0].commitmentDelta = '-4000000';
    draft.rows[1].commitmentDelta = '4000000';
    expect(eventEditProblem(draft)).toBeNull();
  });

  it('rejects an unparseable fx rate or price', () => {
    const badFx = buyDraft();
    badFx.rows[0].fxRate = 'par';
    expect(eventEditProblem(badFx)).toMatch(/FX rate is not a number/);

    const badPrice = buyDraft();
    badPrice.rows[0].pricePerUnit = 'market';
    expect(eventEditProblem(badPrice)).toMatch(/price per unit is not a number/);
  });

  it('requires a currency on every row', () => {
    const draft = buyDraft();
    draft.rows[0].currency = '  ';
    expect(eventEditProblem(draft)).toMatch(/needs a currency/);
  });

  it('allows an investor-held sale without a proceeds destination', () => {
    const sell = buyDraft();
    sell.rows[0].entryType = 'sell';
    sell.rows[0].cashDelta = '1000000.00';
    sell.rows[0].quantityDelta = '-50000.00';

    sell.rows[0].subType = '';
    expect(sell.rows[0].positionHolderKind).toBe('investor');
    expect(eventEditProblem(sell)).toBeNull();
    expect(isEventEditSavable(sell)).toBe(true);
  });

  it('requires a canonical proceeds destination for a managed-fund-held sale', () => {
    const sell = buyDraft();
    sell.rows[0].entryType = 'sell';
    sell.rows[0].cashDelta = '1000000.00';
    sell.rows[0].quantityDelta = '-50000.00';
    sell.rows[0].positionHolderKind = 'managed_fund';
    sell.rows[0].positionHolderId = 'managed-fund-1';

    sell.rows[0].subType = '';
    expect(eventEditProblem(sell)).toBe('Choose a proceeds destination before saving.');
    expect(isEventEditSavable(sell)).toBe(false);

    sell.rows[0].subType = 'secondary';
    expect(eventEditProblem(sell)).toBe('Choose a proceeds destination before saving.');
    expect(isEventEditSavable(sell)).toBe(false);

    // Canonical cash_in_fund
    sell.rows[0].subType = SUB_TYPE_DIVESTMENT_CASH_IN_FUND;
    expect(eventEditProblem(sell)).toBeNull();
    expect(isEventEditSavable(sell)).toBe(true);

    // Canonical distributed_to_investor
    sell.rows[0].subType = SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR;
    expect(eventEditProblem(sell)).toBeNull();
    expect(isEventEditSavable(sell)).toBe(true);
  });

  it("saves an investor sale's edited notes with no proceeds destination", () => {
    // The scenario the shared ownership rule exists for: an investor cannot
    // retain cash in a fund, so its sale carries no destination and a notes
    // edit must go through on its own.
    // Both shapes an investor sale is stored as: nothing at all, and the
    // 'divestment' the fund-update apply path writes for an ineligible holder.
    for (const stored of [null, 'divestment']) {
      const original = eventEditDraftFrom(
        EVENTS.gotoBuy,
        [
          {
            ...ENTRIES.gotoBuy,
            entry_type: 'sell',
            sub_type: stored,
            quantity_delta: '-9500000',
            cash_delta: '43780000.00',
          },
        ],
        index,
      );
      expect(original.rows[0].positionHolderKind).toBe('investor');
      expect(editRowSubTypeControl(original.rows[0])).toBe('none');

      const draft: EventEditDraft = {
        ...original,
        rows: [{ ...original.rows[0], notes: 'Exit confirmed with the buyer.' }],
      };

      expect(isEventEditUnchanged(draft, original)).toBe(false);
      expect(eventEditProblem(draft)).toBeNull();
      expect(isEventEditSavable(draft)).toBe(true);
      expect(buildUpdateEventInput(draft).entries[0]).toMatchObject({
        entry_type: 'sell',
        sub_type: null,
        notes: 'Exit confirmed with the buyer.',
      });
    }
  });

  it('clears a sub-type the row can no longer show when it becomes an investor sale', () => {
    const buy = buyDraft();
    expect(buy.rows[0].subType).toBe('initial');

    const patched = { ...buy.rows[0], ...applyEntryTypeChange(buy.rows[0], 'sell') };
    expect(editRowSubTypeControl(patched)).toBe('none');
    // Nothing the user can no longer see may reach the wire.
    expect(patched.subType).toBe('');
    expect(
      buildUpdateEventInput({ ...buy, rows: [patched] }).entries[0].sub_type,
    ).toBeNull();
  });

  it('offers the free-text sub-type on a non-proceeds entry and the destination on a managed-fund sale', () => {
    const investorRow = buyDraft().rows[0];
    expect(editRowSubTypeControl(investorRow)).toBe('free_text');

    const managedSell = {
      ...investorRow,
      entryType: 'sell' as const,
      positionHolderKind: 'managed_fund' as const,
      positionHolderId: 'managed-fund-1',
    };
    expect(editRowSubTypeControl(managedSell)).toBe('destination');
  });

  it("preserves a managed-fund sale's recorded destination when the editor loads it", () => {
    for (const stored of [
      SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      'distributed_to_investor',
    ]) {
      const loaded = eventEditDraftFrom(
        EVENTS.distribution,
        [
          {
            ...ENTRIES.distribution,
            position_id: 'pos-star-1982',
            entry_type: 'redemption',
            sub_type: stored,
          },
        ],
        index,
      );
      expect(loaded.rows[0].positionHolderKind).toBe('managed_fund');
      expect(loaded.rows[0].subType).toBe(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR);
    }
  });

  it('normalises a recognized destination alias instead of replacing it with the default', () => {
    const sell = buyDraft();
    sell.rows[0].positionHolderKind = 'managed_fund';
    sell.rows[0].positionHolderId = 'managed-fund-1';
    sell.rows[0].subType = 'distributed_to_investor';

    expect(applyEntryTypeChange(sell.rows[0], 'sell').subType).toBe(
      SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    );
  });

  it('allows a normal distribution to retain a free-text subtype or remain empty', () => {
    const dist = buyDraft();
    dist.rows[0].entryType = 'distribution';
    dist.rows[0].cashDelta = '50000.00';
    dist.rows[0].quantityDelta = '0.00';
    // Distribution is fund-only, so the row has to sit on a fund position for
    // this to be about the subtype and nothing else.
    dist.rows[0].positionInstrumentKind = 'fund';

    // Free-text subtype
    dist.rows[0].subType = 'dividend';
    expect(eventEditProblem(dist)).toBeNull();
    expect(isEventEditSavable(dist)).toBe(true);

    // Empty subtype
    dist.rows[0].subType = '';
    expect(eventEditProblem(dist)).toBeNull();
    expect(isEventEditSavable(dist)).toBe(true);
  });
});

describe('isEventEditUnchanged', () => {
  it('is true until something is actually edited', () => {
    const original = buyDraft();
    expect(isEventEditUnchanged(buyDraft(), original)).toBe(true);
  });

  it('is false once a field differs', () => {
    const original = buyDraft();
    const edited = buyDraft();
    edited.description = 'Investment — GOTO Group Series E (corrected)';
    expect(isEventEditUnchanged(edited, original)).toBe(false);
  });
});

describe('buildUpdateEventInput', () => {
  it('sends the event fields and every row', () => {
    const payload = buildUpdateEventInput(buyDraft());
    expect(payload.event_date).toBe('2018-01-22');
    expect(payload.description).toBe('Investment — GOTO Group Series E');
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      position_id: 'pos-mer-goto',
      entry_type: 'buy',
      sub_type: 'initial',
      cash_delta: '-43780000.00000000',
      quantity_delta: '9500000.00000000',
      currency: 'USD',
      counterparty_position_id: null,
      data_status: 'verified',
    });
  });

  it('stamps every row with the event date, which is what the route re-posts', () => {
    const draft = buyDraft();
    draft.eventDate = '2018-02-01';
    const payload = buildUpdateEventInput(draft);
    expect(payload.entries[0].entry_date).toBe('2018-02-01');
  });

  it('keeps both transfer legs pointing at each other', () => {
    const payload = buildUpdateEventInput(transferDraft());
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0].counterparty_position_id).toBe('pos-smma-star');
    expect(payload.entries[1].counterparty_position_id).toBe('pos-coin-star');
  });

  it('sends null rather than an empty string for the optional text fields', () => {
    const draft = buyDraft();
    draft.description = '   ';
    draft.rows[0].subType = '';
    draft.rows[0].notes = '  ';
    draft.rows[0].fxRate = '';
    draft.rows[0].pricePerUnit = '';
    const payload = buildUpdateEventInput(draft);
    expect(payload.description).toBeNull();
    expect(payload.entries[0].sub_type).toBeNull();
    expect(payload.entries[0].notes).toBeNull();
    expect(payload.entries[0].fx_rate).toBeNull();
    expect(payload.entries[0].price_per_unit).toBeNull();
  });

  it('normalises a lowercase currency', () => {
    const draft = buyDraft();
    draft.rows[0].currency = 'usd';
    expect(buildUpdateEventInput(draft).entries[0].currency).toBe('USD');
  });

  it('sends no funding allocations — the service derives them from the position', () => {
    const payload = buildUpdateEventInput(buyDraft());
    expect(payload.entries[0].allocations).toBeUndefined();
  });

  it('keeps eight decimals exactly rather than rounding through a double', () => {
    const draft = buyDraft();
    draft.rows[0].quantityDelta = '0.00000003';
    expect(buildUpdateEventInput(draft).entries[0].quantity_delta).toBe('0.00000003');
  });

  it('never sends source_ledger_entry_id in the payload', () => {
    const derivedLeg = {
      ...ENTRIES.paidIn,
      id: 'le-call4-cash',
      entry_type: 'cash_movement' as const,
      sub_type: null,
      quantity_delta: '0',
      cash_delta: '100000',
      price_per_unit: null,
      source_ledger_entry_id: ENTRIES.paidIn.id,
    };
    const callDraft = eventEditDraftFrom(EVENTS.call4, [ENTRIES.paidIn, derivedLeg], index);
    const payload = buildUpdateEventInput(callDraft);
    expect(payload.entries).toHaveLength(1);
    for (const entry of payload.entries) {
      expect(entry).not.toHaveProperty('source_ledger_entry_id');
    }
  });
});

describe('preserving an entry-level funding split', () => {
  it('locks cash on a row whose split lives on the entry', () => {
    // Akulaku is jointly funded: the position declares no source, so the split
    // is on the row and has to add up to the cash.
    expect(cashIsLockedBySplit(akulakuDraft().rows[0])).toBe(true);
  });

  it('leaves cash editable when the position declares a source', () => {
    // The service recreates the single allocation for whatever the new cash is.
    expect(cashIsLockedBySplit(buyDraft().rows[0])).toBe(false);
  });

  it('sends the split back verbatim, since a re-post would otherwise drop it', () => {
    const payload = buildUpdateEventInput(akulakuDraft());
    expect(payload.entries[0].allocations).toEqual([
      { funding_source_id: 'src-ald', amount: '4000000' },
      { funding_source_id: 'src-haw', amount: '2630000' },
    ]);
  });

  it('omits allocations on a sourced position so the service derives them', () => {
    expect(buildUpdateEventInput(buyDraft()).entries[0].allocations).toBeUndefined();
  });
});

describe('editBlockedReason', () => {
  it('allows an ordinary event', () => {
    expect(editBlockedReason(buyDraft())).toBeNull();
    expect(editBlockedReason(transferDraft())).toBeNull();
  });

  it('blocks a reversal event, which cannot be re-posted without losing the flag', () => {
    const draft = eventEditDraftFrom(EVENTS.feeReversal, [ENTRIES.feeReversal], index);
    expect(draft.rows[0].isReversal).toBe(true);
    expect(editBlockedReason(draft)).toMatch(/revers/i);
    expect(editBlockedReason(draft)).toMatch(/post a new event/i);
  });

  it('blocks an event that has already been reversed', () => {
    const draft = buyDraft();
    draft.status = 'reversed';
    expect(editBlockedReason(draft)).not.toBeNull();
    expect(editBlockedReason(draft)).toMatch(/reversed/i);
  });

  it('reversed-event message points the user at posting a new event', () => {
    const draft = buyDraft();
    draft.status = 'reversed';
    const reason = editBlockedReason(draft);
    expect(reason).toMatch(/reversed/i);
    expect(reason).toMatch(/post a new event/i);
  });
});

describe('field metadata', () => {
  it('locks the columns a type may never touch', () => {
    expect(isDeltaLocked('buy', 'commitment')).toBe(true);
    expect(isDeltaLocked('buy', 'cash')).toBe(false);
    expect(isDeltaLocked('adjustment', 'cash')).toBe(true);
    expect(isDeltaLocked('adjustment', 'quantity')).toBe(false);
  });

  it('spells out what each column allows', () => {
    expect(deltaHint('buy', 'cash')).toBe('must be below 0');
    expect(deltaHint('buy', 'quantity')).toBe('0 or above');
    expect(deltaHint('buy', 'commitment')).toBe('must be 0');
    expect(deltaHint('distribution', 'cash')).toBe('must be above 0');
    expect(deltaHint('commitment', 'commitment')).toBe('any non-zero');
    expect(deltaHint('adjustment', 'quantity')).toBe('any value');
  });

  it('flags a price that was derived rather than recorded', () => {
    const derived = eventEditDraftFrom(
      EVENTS.akulakuBuy,
      [{ ...ENTRIES.akulakuBuy, price_per_unit: null }],
      index,
    );
    expect(priceIsDerived(derived.rows[0])).toBe(true);
    expect(priceIsDerived(buyDraft().rows[0])).toBe(false);
  });

  it('does not call a price derived when there are no units or no cash', () => {
    const draft = buyDraft();
    draft.rows[0].pricePerUnit = '';
    draft.rows[0].quantityDelta = '0';
    expect(priceIsDerived(draft.rows[0])).toBe(false);
  });
});

/** A draft assembled by hand, to prove the model does not depend on the fixture. */
describe('a hand-built draft', () => {
  const draft: EventEditDraft = {
    eventId: 'ev-1',
    eventDate: '2026-01-01',
    description: 'Capital call',
    rows: [
      {
        id: 'le-1',
        positionId: 'pos-1',
        entryType: 'paid_in',
        subType: 'capital_call',
        commitmentDelta: '0',
        quantityDelta: '1000000',
        cashDelta: '-1000000',
        valuationDelta: '0',
        currency: 'USD',
        fxRate: '1',
        pricePerUnit: '1',
        counterpartyPositionId: null,
        dataStatus: 'verified',
        notes: '',
        isReversal: false,
        isDerivedCashLeg: false,
        sourceLedgerEntryId: null,
        positionHasDeclaredSource: true,
        positionInstrumentKind: 'fund',
        positionHolderKind: 'managed_fund',
        positionHolderId: 'fund-1',
        positionIsClosed: false,
        allocations: [],
      },
    ],
  };

  it('validates and serialises', () => {
    expect(eventEditProblem(draft)).toBeNull();
    expect(buildUpdateEventInput(draft).entries[0].cash_delta).toBe('-1000000.00000000');
  });
});

/**
 * A capital call as the ledger actually stores it: the paid_in row the user
 * posted, plus the fund-cash leg `postEvent` derived from it. Re-sending that
 * leg is what produced "cash_movement without primary_entry_index or
 * counterparty_position_id must have sub_type = opening_balance" — the leg is
 * paired to its primary by an index that only exists inside the request that
 * created it, so the replacement has to leave it out and let the service
 * derive it again.
 */
describe('derived cash legs', () => {
  const derivedLeg = {
    ...ENTRIES.paidIn,
    id: 'le-call4-cash',
    entry_type: 'cash_movement' as const,
    sub_type: null,
    quantity_delta: '0',
    cash_delta: '100000',
    price_per_unit: null,
    source_ledger_entry_id: ENTRIES.paidIn.id,
  };

  const callDraft = () =>
    eventEditDraftFrom(EVENTS.call4, [ENTRIES.paidIn, derivedLeg], index);

  it('flags the derived leg and leaves the row it mirrors editable', () => {
    const draft = callDraft();
    expect(draft.rows.map((row) => row.isDerivedCashLeg)).toEqual([false, true]);
  });

  it('drops the derived leg from the replacement so the service re-derives it', () => {
    const entries = buildUpdateEventInput(callDraft()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_type).toBe('paid_in');
  });

  it('never sends a cash_movement the service would reject', () => {
    for (const entry of buildUpdateEventInput(callDraft()).entries) {
      if (entry.entry_type !== 'cash_movement') continue;
      expect(
        Boolean(entry.counterparty_position_id) || entry.sub_type === 'opening_balance',
      ).toBe(true);
    }
  });

  it('does not block the save on figures the service is about to recompute', () => {
    expect(eventEditProblem(callDraft())).toBeNull();
    expect(editBlockedReason(callDraft())).toBeNull();
  });

  it('keeps an opening balance, which is a row in its own right', () => {
    const opening = {
      ...derivedLeg,
      id: 'le-opening',
      sub_type: 'opening_balance',
      source_ledger_entry_id: null,
    };
    const draft = eventEditDraftFrom(EVENTS.call4, [opening], index);
    expect(draft.rows[0].isDerivedCashLeg).toBe(false);
    expect(buildUpdateEventInput(draft).entries).toHaveLength(1);
  });

  it('keeps an FX transfer leg, which carries its own counterparty', () => {
    const fxLeg = {
      ...derivedLeg,
      id: 'le-fx',
      counterparty_position_id: 'pos-mer-goto',
      source_ledger_entry_id: null,
    };
    const draft = eventEditDraftFrom(EVENTS.call4, [fxLeg], index);
    expect(draft.rows[0].isDerivedCashLeg).toBe(false);
    expect(buildUpdateEventInput(draft).entries).toHaveLength(1);
  });
});

describe('valuation deltas', () => {
  it('preserves a paid-in adjustment when editing the event', () => {
    const draft = eventEditDraftFrom(EVENTS.writeOff,
      [{ ...ENTRIES.writeOff, sub_type: 'paid_in_writeoff', valuation_delta: '-914781.37000000' }], index);
    expect(buildUpdateEventInput(draft).entries[0]).toMatchObject({
      valuation_delta: '-914781.37000000', cash_delta: '0.00000000',
    });
  });
  it('carries a write-down back through the replacement instead of zeroing it', () => {
    const draft = eventEditDraftFrom(
      EVENTS.writeOff,
      [{ ...ENTRIES.writeOff, valuation_delta: '-1250000.00000000' }],
      index,
    );
    expect(buildUpdateEventInput(draft).entries[0].valuation_delta).toBe(
      '-1250000.00000000',
    );
  });
});

describe('entryEditRowHeader', () => {
  const derivedLeg = {
    ...ENTRIES.paidIn,
    id: 'le-call4-cash',
    entry_type: 'cash_movement' as const,
    sub_type: null,
    quantity_delta: '0',
    cash_delta: '100000',
    price_per_unit: null,
    source_ledger_entry_id: ENTRIES.paidIn.id,
  };

  const callDraft = () =>
    eventEditDraftFrom(EVENTS.call4, [ENTRIES.paidIn, derivedLeg], index);

  it('renders a primary row as Type · Holder → Instrument', () => {
    const draft = callDraft();
    expect(entryEditRowHeader(draft.rows[0], index)).toBe(
      'Paid-in capital · PT Sinar Mas Multiartha Tbk → Startech Growth Fund VCC',
    );
  });

  it('renders a derived cash leg as Cash effect · Holder · Instrument', () => {
    const draft = callDraft();
    expect(entryEditRowHeader(draft.rows[1], index)).toBe(
      'Cash effect · PT Sinar Mas Multiartha Tbk · Startech Growth Fund VCC',
    );
  });

  it('renders transfer legs with · gives up and · receives based on delta sign', () => {
    const draft = transferDraft();
    expect(entryEditRowHeader(draft.rows[0], index)).toBe(
      'Commitment transfer · Co-invest Partners → Startech Growth Fund VCC · gives up',
    );
    expect(entryEditRowHeader(draft.rows[1], index)).toBe(
      'Commitment transfer · PT Sinar Mas Multiartha Tbk → Startech Growth Fund VCC · receives',
    );
  });

  it('falls back to position id when position is unknown', () => {
    const primary = {
      ...callDraft().rows[0],
      positionId: 'missing-pos',
    };
    expect(entryEditRowHeader(primary, index)).toBe(
      'Paid-in capital · missing-pos',
    );

    const derived = {
      ...callDraft().rows[1],
      positionId: 'missing-cash-pos',
    };
    expect(entryEditRowHeader(derived, index)).toBe(
      'Cash effect · missing-cash-pos',
    );
  });

  it('handles unit transfers with gives up on negative quantity and receives on positive', () => {
    const giveUnit = {
      ...transferDraft().rows[0],
      entryType: 'unit_transfer' as const,
      commitmentDelta: '0',
      quantityDelta: '-5000',
    };
    const receiveUnit = {
      ...transferDraft().rows[1],
      entryType: 'unit_transfer' as const,
      commitmentDelta: '0',
      quantityDelta: '5000',
    };
    expect(entryEditRowHeader(giveUnit, index)).toBe(
      'Unit transfer · Co-invest Partners → Startech Growth Fund VCC · gives up',
    );
    expect(entryEditRowHeader(receiveUnit, index)).toBe(
      'Unit transfer · PT Sinar Mas Multiartha Tbk → Startech Growth Fund VCC · receives',
    );
  });
});

describe('orderRowsForDisplay', () => {
  const derivedLeg = {
    ...ENTRIES.paidIn,
    id: 'le-call4-cash',
    entry_type: 'cash_movement' as const,
    sub_type: null,
    quantity_delta: '0',
    cash_delta: '100000',
    price_per_unit: null,
    source_ledger_entry_id: ENTRIES.paidIn.id,
  };

  it('places derived cash legs immediately under their primary', () => {
    const draft = eventEditDraftFrom(EVENTS.call4, [ENTRIES.paidIn, derivedLeg], index);
    const ordered = orderRowsForDisplay(draft.rows);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toEqual({ row: draft.rows[0], isNested: false });
    expect(ordered[1]).toEqual({ row: draft.rows[1], isNested: true });
  });

  it('orders primaries first even if derived leg appeared first in input', () => {
    const draft = eventEditDraftFrom(EVENTS.call4, [derivedLeg, ENTRIES.paidIn], index);
    // In draft.rows, derived leg is index 0 and primary is index 1
    expect(draft.rows[0].id).toBe('le-call4-cash');
    expect(draft.rows[1].id).toBe(ENTRIES.paidIn.id);

    const ordered = orderRowsForDisplay(draft.rows);
    // In display, primary is first, derived leg is second and marked nested
    expect(ordered[0].row.id).toBe(ENTRIES.paidIn.id);
    expect(ordered[0].isNested).toBe(false);
    expect(ordered[1].row.id).toBe('le-call4-cash');
    expect(ordered[1].isNested).toBe(true);

    // draft.rows is untouched
    expect(draft.rows[0].id).toBe('le-call4-cash');
    expect(draft.rows[1].id).toBe(ENTRIES.paidIn.id);
  });

  it('renders orphaned derived legs last with isNested false', () => {
    const orphanedLeg = {
      ...derivedLeg,
      id: 'le-orphan',
      source_ledger_entry_id: 'unknown-primary-id',
    };
    const draft = eventEditDraftFrom(EVENTS.call4, [orphanedLeg, ENTRIES.paidIn], index);
    const ordered = orderRowsForDisplay(draft.rows);
    expect(ordered[0].row.id).toBe(ENTRIES.paidIn.id);
    expect(ordered[0].isNested).toBe(false);
    expect(ordered[1].row.id).toBe('le-orphan');
    expect(ordered[1].isNested).toBe(false);
  });
});

describe('editing which position a row hits', () => {
  it('seeds the position kind and open status alongside its declared source', () => {
    expect(buyDraft().rows[0]).toMatchObject({
      positionId: 'pos-mer-goto',
      positionInstrumentKind: 'asset',
      positionIsClosed: false,
      positionHasDeclaredSource: true,
    });
  });

  it('offers only positions the row\u2019s type may sit on', () => {
    const options = positionOptionsForRow(buyDraft().rows[0], index);
    const ids = options.map((option) => option.id);
    // buy is asset-only, so no fund participation may be offered.
    expect(ids).toContain('pos-mer-goto');
    expect(ids).toContain('pos-mer-aku');
    expect(ids).not.toContain('pos-smma-star');
  });

  it('keeps the current position in the list even when the type has moved on', () => {
    const draft = buyDraft();
    draft.rows[0].entryType = 'commitment';
    const ids = positionOptionsForRow(draft.rows[0], index).map((option) => option.id);
    expect(ids).toContain('pos-mer-goto');
  });

  it('recomputes the declared-source flag and drops the split on a move', () => {
    // Akulaku is unsourced and carries its split on the entry; GOTO declares DCA.
    const row = akulakuDraft().rows[0];
    expect(cashIsLockedBySplit(row)).toBe(true);

    const patch = applyPositionChange(row, 'pos-mer-goto', index);
    expect(patch).toMatchObject({
      positionId: 'pos-mer-goto',
      positionHasDeclaredSource: true,
      positionInstrumentKind: 'asset',
      positionIsClosed: false,
      allocations: [],
    });
    // With no entry-level split left, the cash figure becomes editable again.
    expect(cashIsLockedBySplit({ ...row, ...patch })).toBe(false);
  });

  it('keeps the split when the position is re-selected unchanged', () => {
    const row = akulakuDraft().rows[0];
    const patch = applyPositionChange(row, row.positionId, index);
    expect(patch.allocations).toEqual(row.allocations);
  });

  it('blocks a save when the type and the position disagree', () => {
    const draft = buyDraft();
    Object.assign(draft.rows[0], applyPositionChange(draft.rows[0], 'pos-smma-star', index));
    expect(draft.rows[0].positionInstrumentKind).toBe('fund');
    expect(eventEditProblem(draft)).toBe('Buy can only sit on an asset position.');
  });

  it('blocks a save onto a closed position, or none at all', () => {
    const closed = buyDraft();
    closed.rows[0].positionIsClosed = true;
    expect(eventEditProblem(closed)).toBe(
      'That position is closed, so it cannot take an entry. Pick an open one.',
    );

    const missing = buyDraft();
    missing.rows[0].positionId = '';
    expect(eventEditProblem(missing)).toBe('Every row needs a position.');
  });

  it('sends the chosen position back in the payload', () => {
    const draft = buyDraft();
    Object.assign(draft.rows[0], applyPositionChange(draft.rows[0], 'pos-mer-aku', index));
    expect(buildUpdateEventInput(draft).entries[0].position_id).toBe('pos-mer-aku');
    expect(buildUpdateEventInput(draft).entries[0].allocations).toBeUndefined();
  });

  it('leaves a derived cash leg and a cash movement where they are', () => {
    const draft = buyDraft();
    expect(positionIsEditable(draft.rows[0])).toBe(true);
    expect(positionIsEditable({ ...draft.rows[0], isDerivedCashLeg: true })).toBe(false);
    expect(positionIsEditable({ ...draft.rows[0], entryType: 'cash_movement' })).toBe(false);
  });
});

describe('the valuation delta', () => {
  it('is locked to zero on every type but an adjustment', () => {
    expect(valuationIsLocked('buy')).toBe(true);
    expect(valuationIsLocked('adjustment')).toBe(false);
  });

  it('rejects a valuation on a type that may not restate a value', () => {
    const draft = buyDraft();
    draft.rows[0].valuationDelta = '1000.00';
    expect(eventEditProblem(draft)).toBe(
      'Buy cannot carry a valuation \u0394 — only an adjustment may.',
    );
  });

  it('accepts and serialises one on an adjustment', () => {
    const draft = buyDraft();
    draft.rows[0].entryType = 'adjustment';
    draft.rows[0].cashDelta = '0';
    draft.rows[0].valuationDelta = '-2500.50';
    expect(eventEditProblem(draft)).toBeNull();
    expect(buildUpdateEventInput(draft).entries[0].valuation_delta).toBe('-2500.50000000');
  });

  it('reports a valuation that is not a number', () => {
    const draft = buyDraft();
    draft.rows[0].entryType = 'adjustment';
    draft.rows[0].cashDelta = '0';
    draft.rows[0].valuationDelta = 'oops';
    expect(eventEditProblem(draft)).toBe('The valuation \u0394 is not a number.');
  });
});
