import { describe, expect, it } from 'vitest';
import { mapParsedTxnToRow } from './seed-portfolio-xlsx';
import type { ParsedTxn } from '../src/lib/fund_updates/parsers/startech_quarterly';

describe('seed-portfolio-xlsx mapParsedTxnToRow', () => {
  it('maps divestment with explicit sell_proceeds_destination', () => {
    const txn: ParsedTxn = {
      date: '2026-02-01',
      type: 'divestment',
      subTypeLabel: null,
      pricePerShare: 30,
      shareCount: 2000,
      valueAmount: 60000,
      currency: 'USD',
      fxRate: 1,
      sellProceedsDestination: 'cash_in_fund',
      notes: 'Partial sell-down',
    };

    const row = mapParsedTxnToRow('asset-1', 'fund-1', 'he-1', 'fs-1', txn);

    expect(row).toEqual({
      fund_asset_id: 'asset-1',
      fund_id: 'fund-1',
      holding_entity_id: 'he-1',
      funding_source_id: 'fs-1',
      txn_date: '2026-02-01',
      txn_type: 'divestment',
      sell_proceeds_destination: 'cash_in_fund',
      sub_type_label: null,
      price_per_share: 30,
      share_count: 2000,
      value_amount: 60000,
      txn_currency: 'USD',
      fx_rate: 1,
      notes: 'Partial sell-down',
    });
  });

  it('defaults divestment without sellProceedsDestination to distributed_to_investor', () => {
    const txn: ParsedTxn = {
      date: '2025-11-01',
      type: 'divestment',
      subTypeLabel: null,
      pricePerShare: 18.5,
      shareCount: 200000,
      valueAmount: 3700000,
      currency: 'USD',
      fxRate: 1,
      notes: 'Full exit',
    };

    const row = mapParsedTxnToRow('asset-2', 'fund-2', null, null, txn);

    expect(row.sell_proceeds_destination).toBe('distributed_to_investor');
  });

  it('maps non-divestment transactions to null sell_proceeds_destination', () => {
    const txn: ParsedTxn = {
      date: '2021-01-01',
      type: 'contribution',
      subTypeLabel: null,
      pricePerShare: 10,
      shareCount: 1000,
      valueAmount: 10000,
      currency: 'USD',
      fxRate: 1,
      sellProceedsDestination: 'cash_in_fund' as never,
      notes: 'Initial investment',
    };

    const row = mapParsedTxnToRow('asset-3', 'fund-3', 'he-2', 'fs-2', txn);

    expect(row.sell_proceeds_destination).toBeNull();
  });
});
