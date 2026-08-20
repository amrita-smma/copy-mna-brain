import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { fundAssetTransactions, sellProceedsDestination, transactionType } from './schema';

describe('fundAssetTransactions schema & sell proceeds destination invariant (MB-493)', () => {
  it('defines sell_proceeds_destination enum with expected values', () => {
    expect(sellProceedsDestination.enumValues).toEqual([
      'cash_in_fund',
      'distributed_to_investor',
    ]);
  });

  it('defines transaction_type enum with internal_transfer', () => {
    expect(transactionType.enumValues).toContain('internal_transfer');
  });

  it('includes sell_proceeds_destination on fundAssetTransactions table', () => {
    const config = getTableConfig(fundAssetTransactions);
    const col = config.columns.find((c) => c.name === 'sell_proceeds_destination');
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it('includes source_divestment_txn_id on fundAssetTransactions table', () => {
    const config = getTableConfig(fundAssetTransactions);
    const col = config.columns.find((c) => c.name === 'source_divestment_txn_id');
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it('includes the database CHECK constraint on fundAssetTransactions', () => {
    const config = getTableConfig(fundAssetTransactions);
    const chk = config.checks.find(
      (c) => c.name === 'fund_asset_transactions_sell_proceeds_destination_chk',
    );
    expect(chk).toBeDefined();
  });

  it('includes foreign key and unique constraint for source_divestment_txn_id', () => {
    const config = getTableConfig(fundAssetTransactions);
    const fk = config.foreignKeys.find(
      (f) => f.getName() === 'fund_asset_transactions_source_divestment_fkey',
    );
    expect(fk).toBeDefined();

    const uniq = config.uniqueConstraints.find(
      (u) => u.name === 'fund_asset_transactions_source_divestment_uniq',
    );
    expect(uniq).toBeDefined();
  });

  describe('sell proceeds destination invariant logic', () => {
    const satisfiesInvariant = (
      txnType: string,
      destination: string | null | undefined,
    ): boolean => {
      const isDivestment = txnType === 'divestment';
      const hasDestination = destination !== null && destination !== undefined;
      return (isDivestment && hasDestination) || (!isDivestment && !hasDestination);
    };

    it('accepts divestment with cash_in_fund or distributed_to_investor', () => {
      expect(satisfiesInvariant('divestment', 'cash_in_fund')).toBe(true);
      expect(satisfiesInvariant('divestment', 'distributed_to_investor')).toBe(true);
    });

    it('rejects divestment with null or undefined destination', () => {
      expect(satisfiesInvariant('divestment', null)).toBe(false);
      expect(satisfiesInvariant('divestment', undefined)).toBe(false);
    });

    it('accepts non-divestment types with null or undefined destination', () => {
      const nonDivestmentTypes = transactionType.enumValues.filter((t) => t !== 'divestment');
      for (const t of nonDivestmentTypes) {
        expect(satisfiesInvariant(t, null)).toBe(true);
        expect(satisfiesInvariant(t, undefined)).toBe(true);
      }
    });

    it('rejects non-divestment types with non-null destination', () => {
      const nonDivestmentTypes = transactionType.enumValues.filter((t) => t !== 'divestment');
      for (const t of nonDivestmentTypes) {
        expect(satisfiesInvariant(t, 'cash_in_fund')).toBe(false);
        expect(satisfiesInvariant(t, 'distributed_to_investor')).toBe(false);
      }
    });
  });
});
