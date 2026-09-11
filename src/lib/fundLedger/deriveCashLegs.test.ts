import { describe, expect, it } from 'vitest';
import {
  deriveCashLegs,
  deriveExpectedCashLegSpecs,
  reconcileCashLegs,
  type DerivableEntry,
  type PositionWithFundFlags,
} from './deriveCashLegs';
import {
  InvalidEntryShapeError,
  InvalidCurrencyError,
  AllocationMismatchError,
} from '@/lib/services/flErrors';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
} from '@/lib/sellProceedsDestination';

describe('deriveCashLegs pure sign matrix (RFC §4)', () => {
  const managedFundA = 'fund-managed-a';
  const managedFundB = 'fund-managed-b';
  const externalFundX = 'fund-ext-x';

  // Positions
  // 1. LP position in managed fund A: holder is LP investor, instrument is managed fund A
  const lpPositionInFundA: PositionWithFundFlags = {
    id: 'pos-lp-a',
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    fund_id: managedFundA,
    asset_id: null,
    holderFundManaged: false,
    instrumentFundManaged: true,
  };

  // 2. Asset position held by managed fund A: holder is managed fund A, instrument is asset
  const assetPositionFundA: PositionWithFundFlags = {
    id: 'pos-asset-a',
    holder_investor_id: null,
    holder_fund_id: managedFundA,
    fund_id: null,
    asset_id: 'asset-equity-1',
    holderFundManaged: true,
    instrumentFundManaged: false,
  };

  // 3. FoF position: managed fund A holds target external fund X
  const fofPositionFundAToX: PositionWithFundFlags = {
    id: 'pos-fof-a-x',
    holder_investor_id: null,
    holder_fund_id: managedFundA,
    fund_id: externalFundX,
    asset_id: null,
    holderFundManaged: true,
    instrumentFundManaged: false, // target fund is unmanaged
  };

  // 4. Managed-to-managed FoF position: managed fund A holds managed fund B
  const managedToManagedPosition: PositionWithFundFlags = {
    id: 'pos-m2m-a-b',
    holder_investor_id: null,
    holder_fund_id: managedFundA,
    fund_id: managedFundB,
    asset_id: null,
    holderFundManaged: true,
    instrumentFundManaged: true,
  };

  // 5. LP position in external unmanaged fund X
  const lpPositionInExtX: PositionWithFundFlags = {
    id: 'pos-lp-ext-x',
    holder_investor_id: 'inv-1',
    holder_fund_id: null,
    fund_id: externalFundX,
    asset_id: null,
    holderFundManaged: false,
    instrumentFundManaged: false,
  };

  // 6. Asset position held by external unmanaged fund X
  const assetPositionExtX: PositionWithFundFlags = {
    id: 'pos-asset-ext-x',
    holder_investor_id: null,
    holder_fund_id: externalFundX,
    fund_id: null,
    asset_id: 'asset-equity-ext',
    holderFundManaged: false,
    instrumentFundManaged: false,
  };

  // 7. Another LP position in managed fund A (for transfers)
  const lpPosition2InFundA: PositionWithFundFlags = {
    id: 'pos-lp-a-2',
    holder_investor_id: 'inv-2',
    holder_fund_id: null,
    fund_id: managedFundA,
    asset_id: null,
    holderFundManaged: false,
    instrumentFundManaged: true,
  };

  // 8. Managed fund A's structural cash position
  const cashPositionFundAUsd: PositionWithFundFlags = {
    id: 'pos-cash-a-usd',
    holder_investor_id: null,
    holder_fund_id: managedFundA,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holderFundManaged: true,
    instrumentFundManaged: false,
  };

  // 9. Managed fund B's structural cash position
  const cashPositionFundBUsd: PositionWithFundFlags = {
    id: 'pos-cash-b-usd',
    holder_investor_id: null,
    holder_fund_id: managedFundB,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holderFundManaged: true,
    instrumentFundManaged: false,
  };

  const positionsMap = new Map<string, PositionWithFundFlags>([
    [lpPositionInFundA.id, lpPositionInFundA],
    [assetPositionFundA.id, assetPositionFundA],
    [fofPositionFundAToX.id, fofPositionFundAToX],
    [managedToManagedPosition.id, managedToManagedPosition],
    [lpPositionInExtX.id, lpPositionInExtX],
    [assetPositionExtX.id, assetPositionExtX],
    [lpPosition2InFundA.id, lpPosition2InFundA],
    [cashPositionFundAUsd.id, cashPositionFundAUsd],
    [cashPositionFundBUsd.id, cashPositionFundBUsd],
  ]);

  // 1. LP paid_in (+X)
  it('case 1: LP paid_in derives +X on managed fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInFundA.id,
        entry_type: 'paid_in',
        cash_delta: '-500000', // outflow from LP holder
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '500000.00000000', // -(-500000) = +500000
      role: 'instrument',
    });
  });

  // 2. fund buy (−X)
  it('case 2: fund buy derives -X on fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-1000000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-1000000.00000000',
      role: 'holder',
    });
  });

  // 3. FoF paid_in (−X)
  it('case 3: FoF paid_in derives -X on FoF fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: fofPositionFundAToX.id,
        entry_type: 'paid_in',
        cash_delta: '-250000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-250000.00000000',
      role: 'holder',
    });
  });

  // 4. FoF distribution received (+X)
  it('case 4a: FoF distribution received with cash_in_fund derives +X on FoF fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: fofPositionFundAToX.id,
        entry_type: 'distribution',
        sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        cash_delta: '75000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '75000.00000000',
      role: 'holder',
    });
  });

  it('case 4b: FoF distribution received with NULL destination defaults to retained and produces holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: fofPositionFundAToX.id,
        entry_type: 'distribution',
        sub_type: null,
        cash_delta: '75000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '75000.00000000',
      role: 'holder',
    });
  });

  it('case 4c: FoF distribution received with distributed_to_investor produces NO leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: fofPositionFundAToX.id,
        entry_type: 'distribution',
        sub_type: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
        cash_delta: '75000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  it('case 4d (FIX 2 allowlist): proceeds entry with sub_type="divestment" defaults to retained and produces holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: 'divestment',
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '50000.00000000',
      role: 'holder',
    });
  });

  it('case 4e (FIX 2 allowlist): proceeds entry with arbitrary label defaults to retained and produces holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: 'custom_exit_label',
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '50000.00000000',
      role: 'holder',
    });
  });

  it('case 4f (FIX 2 allowlist): proceeds entry with bare "cash_in_fund" posts holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: 'cash_in_fund',
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '50000.00000000',
      role: 'holder',
    });
  });

  it('case 4g (FIX 2 allowlist): proceeds entry with "divestment:cash_in_fund" posts holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '50000.00000000',
      role: 'holder',
    });
  });

  // 5. fund distribution to LPs (−X)
  it('case 5: fund distribution to LPs derives -X on fund cash position and is NOT destination-gated', () => {
    // LP distribution with NULL sub_type must still post instrument-side leg!
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInFundA.id,
        entry_type: 'distribution',
        sub_type: null,
        cash_delta: '300000', // positive inflow to LP
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-300000.00000000',
      role: 'instrument',
    });
  });

  // 6. managed-to-managed (two legs, opposite signs)
  it('case 6: managed-to-managed investment derives two legs with opposite signs', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedToManagedPosition.id,
        entry_type: 'paid_in',
        cash_delta: '-100000',
        currency: 'EUR',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(2);

    const holderLeg = legs.find((l) => l.role === 'holder');
    expect(holderLeg).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'EUR',
      cash_delta: '-100000.00000000',
      role: 'holder',
    });

    const instrumentLeg = legs.find((l) => l.role === 'instrument');
    expect(instrumentLeg).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundB,
      currency: 'EUR',
      cash_delta: '100000.00000000', // -(-100000) = +100000
      role: 'instrument',
    });
  });

  it('case 6b: managed-to-managed distribution with cash_in_fund derives two legs', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedToManagedPosition.id,
        entry_type: 'distribution',
        sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        cash_delta: '200000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(2);

    const holderLeg = legs.find((l) => l.role === 'holder');
    expect(holderLeg).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '200000.00000000',
      role: 'holder',
    });

    const instrumentLeg = legs.find((l) => l.role === 'instrument');
    expect(instrumentLeg).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundB,
      currency: 'USD',
      cash_delta: '-200000.00000000',
      role: 'instrument',
    });
  });

  it('case 6c: managed-to-managed distribution with NULL sub_type defaults to retained and posts both holder and instrument legs', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedToManagedPosition.id,
        entry_type: 'distribution',
        sub_type: null,
        cash_delta: '200000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(2);
    const holderLeg = legs.find((l) => l.role === 'holder');
    expect(holderLeg).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '200000.00000000',
      role: 'holder',
    });

    const instrumentLeg = legs.find((l) => l.role === 'instrument');
    expect(instrumentLeg).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundB,
      currency: 'USD',
      cash_delta: '-200000.00000000',
      role: 'instrument',
    });
  });

  // 7. retained sell (+X)
  it('case 7: retained sell derives +X on fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        cash_delta: '1500000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '1500000.00000000',
      role: 'holder',
    });
  });

  // 8. distributed sell (none)
  it('case 8: distributed sell derives NO leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
        cash_delta: '1500000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  // 9. NULL-destination sell defaults to retained (+X)
  it('case 9: NULL-destination sell defaults to retained and derives holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: null,
        cash_delta: '1500000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '1500000.00000000',
      role: 'holder',
    });
  });

  // 10. unit_transfer between LPs of a managed fund (no instrument leg)
  it('case 10: unit_transfer between LPs never posts instrument leg to the fund', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInFundA.id,
        entry_type: 'unit_transfer',
        cash_delta: '-50000',
        currency: 'USD',
      },
      {
        position_id: lpPosition2InFundA.id,
        entry_type: 'unit_transfer',
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  it('case 10b: unit_transfer with a managed fund as holder DOES post holder-side leg', () => {
    // E.g. managed fund A buys units from another holder in target fund X
    const entries: DerivableEntry[] = [
      {
        position_id: fofPositionFundAToX.id,
        entry_type: 'unit_transfer',
        cash_delta: '-80000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-80000.00000000',
      role: 'holder',
    });
  });

  // 10c. commitment_transfer between LPs of a managed fund (no instrument leg)
  it('case 10c: commitment_transfer between LPs never posts instrument leg to the fund', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInFundA.id,
        entry_type: 'commitment_transfer',
        cash_delta: '-50000',
        currency: 'USD',
      },
      {
        position_id: lpPosition2InFundA.id,
        entry_type: 'commitment_transfer',
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  it('case 10d: commitment_transfer with a managed fund as holder DOES post holder-side leg', () => {
    // Managed fund A acquires commitment from another holder in target fund X with cash consideration
    const entries: DerivableEntry[] = [
      {
        position_id: fofPositionFundAToX.id,
        entry_type: 'commitment_transfer',
        cash_delta: '-60000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-60000.00000000',
      role: 'holder',
    });
  });

  // 11. expense (−X)
  it('case 11: expense derives -X on fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'expense',
        cash_delta: '-12000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-12000.00000000',
      role: 'holder',
    });
  });

  // 12. income (+X)
  it('case 12: income derives +X on fund cash position', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'income',
        cash_delta: '45000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '45000.00000000',
      role: 'holder',
    });
  });

  // 13. external (unmanaged) funds → no legs anywhere
  it('case 13: entries on unmanaged funds produce NO legs', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInExtX.id,
        entry_type: 'paid_in',
        cash_delta: '-50000',
        currency: 'USD',
      },
      {
        position_id: assetPositionExtX.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      {
        position_id: assetPositionExtX.id,
        entry_type: 'sell',
        sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        cash_delta: '200000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  // 14. zero-cash entries
  it('case 14: zero-cash entries produce NO legs', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInFundA.id,
        entry_type: 'commitment',
        cash_delta: '0',
        currency: 'USD',
      },
      {
        position_id: assetPositionFundA.id,
        entry_type: 'adjustment',
        cash_delta: '0.00000000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  // 15. cash_movement entries do not recursively derive legs
  it('case 15: cash_movement entries (opening_balance, FX transfer) never derive legs', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        sub_type: 'opening_balance',
        cash_delta: '100000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  // 16. explicit mirrored leg idempotency (suppression)
  it('case 16: explicitly supplied valid mirrored leg suppresses generation for same primary/fund/currency', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      // Explicitly supplied mirrored leg targeting entry 0
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-100000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0);
  });

  // 17. managed-to-managed one-explicit/one-generated regression
  it('case 17a: managed-to-managed entry with explicit holder leg suppresses holder leg and generates instrument leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedToManagedPosition.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      // Explicit leg for holder fund A
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-100000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    // Exactly 1 leg generated for instrument fund B
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundB,
      currency: 'USD',
      cash_delta: '100000.00000000',
      role: 'instrument',
    });
  });

  it('case 17b: managed-to-managed entry with explicit instrument leg suppresses instrument leg and generates holder leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedToManagedPosition.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      // Explicit leg for instrument fund B
      {
        position_id: cashPositionFundBUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '100000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    // Exactly 1 leg generated for holder fund A
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundA,
      currency: 'USD',
      cash_delta: '-100000.00000000',
      role: 'holder',
    });
  });

  // 18. wrong-sign explicit leg rejection
  it('case 18: explicit leg with wrong sign is rejected with InvalidEntryShapeError', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      // Wrong sign: +100000 instead of -100000
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '100000',
        currency: 'USD',
      },
    ];
    expect(() => deriveCashLegs(entries, positionsMap)).toThrow(InvalidEntryShapeError);
    expect(() => deriveCashLegs(entries, positionsMap)).toThrow(/cash_delta/);
  });

  // 19. wrong-magnitude explicit leg rejection
  it('case 19: explicit leg with wrong magnitude is rejected with InvalidEntryShapeError', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      // Wrong magnitude: -80000 instead of -100000
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-80000',
        currency: 'USD',
      },
    ];
    expect(() => deriveCashLegs(entries, positionsMap)).toThrow(InvalidEntryShapeError);
    expect(() => deriveCashLegs(entries, positionsMap)).toThrow(/cash_delta/);
  });

  // 20. explicit leg on primary entry with no RFC-derived leg
  it('case 20: explicit leg on primary entry with no RFC-derived leg is rejected with InvalidEntryShapeError', () => {
    // Unmanaged fund entry
    const entriesExt: DerivableEntry[] = [
      {
        position_id: lpPositionInExtX.id,
        entry_type: 'paid_in',
        cash_delta: '-50000',
        currency: 'USD',
      },
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    expect(() => deriveCashLegs(entriesExt, positionsMap)).toThrow(InvalidEntryShapeError);
    expect(() => deriveCashLegs(entriesExt, positionsMap)).toThrow(/does not derive a cash leg/);

    // Zero-cash entry
    const entriesZero: DerivableEntry[] = [
      {
        position_id: lpPositionInFundA.id,
        entry_type: 'commitment',
        cash_delta: '0',
        currency: 'USD',
      },
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '50000',
        currency: 'USD',
      },
    ];
    expect(() => deriveCashLegs(entriesZero, positionsMap)).toThrow(InvalidEntryShapeError);

    // Divestment distributed to investor
    const entriesDivest: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'sell',
        sub_type: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
        cash_delta: '100000',
        currency: 'USD',
      },
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '100000',
        currency: 'USD',
      },
    ];
    expect(() => deriveCashLegs(entriesDivest, positionsMap)).toThrow(InvalidEntryShapeError);
  });

  // 21. explicit leg with non-zero commitment, quantity, or valuation
  it('case 21: explicit leg with non-zero commitment, quantity, or valuation is rejected', () => {
    const baseBuy: DerivableEntry = {
      position_id: assetPositionFundA.id,
      entry_type: 'buy',
      cash_delta: '-100000',
      currency: 'USD',
    };

    expect(() =>
      deriveCashLegs(
        [
          baseBuy,
          {
            position_id: cashPositionFundAUsd.id,
            entry_type: 'cash_movement',
            primary_entry_index: 0,
            cash_delta: '-100000',
            commitment_delta: '5000',
            currency: 'USD',
          },
        ],
        positionsMap,
      ),
    ).toThrow(InvalidEntryShapeError);

    expect(() =>
      deriveCashLegs(
        [
          baseBuy,
          {
            position_id: cashPositionFundAUsd.id,
            entry_type: 'cash_movement',
            primary_entry_index: 0,
            cash_delta: '-100000',
            quantity_delta: '100',
            currency: 'USD',
          },
        ],
        positionsMap,
      ),
    ).toThrow(InvalidEntryShapeError);

    expect(() =>
      deriveCashLegs(
        [
          baseBuy,
          {
            position_id: cashPositionFundAUsd.id,
            entry_type: 'cash_movement',
            primary_entry_index: 0,
            cash_delta: '-100000',
            valuation_delta: '5000',
            currency: 'USD',
          },
        ],
        positionsMap,
      ),
    ).toThrow(InvalidEntryShapeError);
  });

  // 22. explicit leg with allocations
  it('case 22: explicit leg with allocations is rejected with AllocationMismatchError', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-100000',
        currency: 'USD',
        allocations: [{ funding_source_id: 'fs-1', amount: '100000' }],
      },
    ];
    expect(() => deriveCashLegs(entries, positionsMap)).toThrow(AllocationMismatchError);
  });

  // FIX 3: Mirrored cash leg with currency mismatch
  it('case 23 (FIX 3): explicit mirrored leg whose currency differs from its primary is rejected with InvalidCurrencyError', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-100000',
        currency: 'EUR', // differs from primary USD!
      },
    ];
    expect(() => deriveCashLegs(entries, positionsMap)).toThrow(InvalidCurrencyError);
  });

  it('case 24 (FIX 3): explicit mirrored leg with matching currency is accepted', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: assetPositionFundA.id,
        entry_type: 'buy',
        cash_delta: '-100000',
        currency: 'USD',
      },
      {
        position_id: cashPositionFundAUsd.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-100000',
        currency: 'USD', // matches primary USD
      },
    ];
    const legs = deriveCashLegs(entries, positionsMap);
    expect(legs).toHaveLength(0); // suppressed by valid explicit leg
  });
});

describe('deriveCashLegs — fund-only cash ownership and proceeds treatment defaulting', () => {
  const managedFundId = 'fund-managed-1';
  const unmanagedFundId = 'fund-unmanaged-2';
  const investorId = 'inv-entity-1';
  const externalFundId = 'fund-ext-3';

  // 1. Managed fund held asset position
  const managedFundAssetPos: PositionWithFundFlags = {
    id: 'pos-managed-asset-1',
    holder_investor_id: null,
    holder_fund_id: managedFundId,
    fund_id: null,
    asset_id: 'asset-equity-1',
    holderFundManaged: true,
  };

  // 2. Unmanaged fund held asset position
  const unmanagedFundAssetPos: PositionWithFundFlags = {
    id: 'pos-unmanaged-asset-1',
    holder_investor_id: null,
    holder_fund_id: unmanagedFundId,
    fund_id: null,
    asset_id: 'asset-equity-1',
    holderFundManaged: false,
  };

  // 3. Investor held asset position
  const investorAssetPos: PositionWithFundFlags = {
    id: 'pos-inv-asset-1',
    holder_investor_id: investorId,
    holder_fund_id: null,
    fund_id: null,
    asset_id: 'asset-equity-1',
  };

  // 4. Investor held fund position (LP in managed fund)
  const lpPositionInManagedFund: PositionWithFundFlags = {
    id: 'pos-lp-managed-1',
    holder_investor_id: investorId,
    holder_fund_id: null,
    fund_id: managedFundId,
    asset_id: null,
    instrumentFundManaged: true,
  };

  // 5. Cash position for managed fund
  const managedFundCashPos: PositionWithFundFlags = {
    id: 'pos-managed-cash-usd',
    holder_investor_id: null,
    holder_fund_id: managedFundId,
    fund_id: null,
    asset_id: 'asset-cash-usd',
    holderFundManaged: true,
  };

  const testMap = new Map<string, PositionWithFundFlags>([
    [managedFundAssetPos.id, managedFundAssetPos],
    [unmanagedFundAssetPos.id, unmanagedFundAssetPos],
    [investorAssetPos.id, investorAssetPos],
    [lpPositionInManagedFund.id, lpPositionInManagedFund],
    [managedFundCashPos.id, managedFundCashPos],
  ]);

  it('posts NO holder leg for investor-held positions across buy, sell, distribution, redemption, paid_in', () => {
    for (const entryType of ['buy', 'sell', 'distribution', 'redemption', 'paid_in'] as const) {
      const entries: DerivableEntry[] = [
        {
          position_id: investorAssetPos.id,
          entry_type: entryType,
          cash_delta: entryType === 'buy' || entryType === 'paid_in' ? '-50000' : '50000',
          currency: 'USD',
          sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        },
      ];
      const legs = deriveCashLegs(entries, testMap);
      expect(legs).toHaveLength(0);
    }
  });

  it('posts NO holder leg for unmanaged fund holders', () => {
    for (const entryType of ['buy', 'sell', 'distribution', 'redemption'] as const) {
      const entries: DerivableEntry[] = [
        {
          position_id: unmanagedFundAssetPos.id,
          entry_type: entryType,
          cash_delta: entryType === 'buy' ? '-50000' : '50000',
          currency: 'USD',
          sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        },
      ];
      const legs = deriveCashLegs(entries, testMap);
      expect(legs).toHaveLength(0);
    }
  });

  it('managed-fund sale with NO stated treatment DOES emit a holder cash leg (new default: retained)', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedFundAssetPos.id,
        entry_type: 'sell',
        sub_type: null,
        cash_delta: '250000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, testMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundId,
      currency: 'USD',
      cash_delta: '250000.00000000',
      role: 'holder',
    });
  });

  it('managed-fund sale with bare "divestment" token DOES emit a holder cash leg (defaults to retained)', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedFundAssetPos.id,
        entry_type: 'sell',
        sub_type: 'divestment',
        cash_delta: '250000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, testMap);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundId,
      currency: 'USD',
      cash_delta: '250000.00000000',
      role: 'holder',
    });
  });

  it('managed-fund sale with explicit "divestment:cash_in_fund" emits holder cash leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedFundAssetPos.id,
        entry_type: 'sell',
        sub_type: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        cash_delta: '250000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, testMap);
    expect(legs).toHaveLength(1);
    expect(legs[0].cash_delta).toBe('250000.00000000');
  });

  it('managed-fund sale with bare "cash_in_fund" emits holder cash leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedFundAssetPos.id,
        entry_type: 'sell',
        sub_type: 'cash_in_fund',
        cash_delta: '250000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, testMap);
    expect(legs).toHaveLength(1);
    expect(legs[0].cash_delta).toBe('250000.00000000');
  });

  it('managed-fund sale with "distributed_to_investor" excludes holder cash leg', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: managedFundAssetPos.id,
        entry_type: 'sell',
        sub_type: 'distributed_to_investor',
        cash_delta: '250000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, testMap);
    expect(legs).toHaveLength(0);
  });

  it('instrument-side leg for a managed invested fund still fires', () => {
    const entries: DerivableEntry[] = [
      {
        position_id: lpPositionInManagedFund.id,
        entry_type: 'paid_in',
        cash_delta: '-100000',
        currency: 'USD',
      },
    ];
    const legs = deriveCashLegs(entries, testMap);
    // LP is investor -> no holder leg. Instrument is managed fund -> instrument leg fires!
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual({
      primary_entry_index: 0,
      holder_kind: 'fund',
      holder_id: managedFundId,
      currency: 'USD',
      cash_delta: '100000.00000000', // negated
      role: 'instrument',
    });
  });

  it('transfers (unit_transfer, commitment_transfer) exclude instrument-side legs', () => {
    for (const entryType of ['unit_transfer', 'commitment_transfer'] as const) {
      const entries: DerivableEntry[] = [
        {
          position_id: lpPositionInManagedFund.id,
          entry_type: entryType,
          cash_delta: '100000',
          currency: 'USD',
        },
      ];
      const legs = deriveCashLegs(entries, testMap);
      expect(legs).toHaveLength(0);
    }
  });

  it('rejects explicit cash_movement targeting an investor-held position', () => {
    const badInvestorCashPos: PositionWithFundFlags = {
      id: 'pos-inv-cash',
      holder_investor_id: investorId,
      holder_fund_id: null,
      fund_id: null,
      asset_id: 'asset-cash-usd',
    };
    const map = new Map(testMap);
    map.set(badInvestorCashPos.id, badInvestorCashPos);

    const entries: DerivableEntry[] = [
      {
        position_id: managedFundAssetPos.id,
        entry_type: 'buy',
        cash_delta: '-50000',
        currency: 'USD',
      },
      {
        position_id: badInvestorCashPos.id,
        entry_type: 'cash_movement',
        primary_entry_index: 0,
        cash_delta: '-50000',
        currency: 'USD',
      },
    ];
    expect(() => deriveCashLegs(entries, map)).toThrowError(
      /must belong to a holder fund/,
    );
  });
});



describe('external fund target versus asset target cash parity', () => {
  it.each(['paid_in', 'distribution', 'redemption', 'expense'])('%s preserves cash legs for both holder kinds and proceeds treatments', (entryType) => {
    for (const holderKind of ['fund', 'investor'] as const) {
      for (const subType of [null, SUB_TYPE_DIVESTMENT_CASH_IN_FUND, SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR]) {
        const fundPosition: PositionWithFundFlags = {
          id: 'position',
          holder_fund_id: holderKind === 'fund' ? 'holder' : null,
          holder_investor_id: holderKind === 'investor' ? 'holder' : null,
          holderFundManaged: true,
          instrumentFundManaged: false,
          fund_id: 'external', asset_id: null,
        };
        const assetPosition = { ...fundPosition, fund_id: null, asset_id: 'asset' };
        const entries: DerivableEntry[] = [{ position_id: 'position', entry_type: entryType, sub_type: subType, cash_delta: entryType === 'paid_in' || entryType === 'expense' ? '-100' : '100', currency: 'USD' }];
        expect(deriveCashLegs(entries, [assetPosition])).toEqual(deriveCashLegs(entries, [fundPosition]));
      }
    }
  });
});
