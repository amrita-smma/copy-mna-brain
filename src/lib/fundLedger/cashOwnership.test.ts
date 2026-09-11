import { describe, expect, it } from 'vitest';
import {
  assertEligibleCashHolder,
  IneligibleCashHolderError,
  isEligibleCashHolder,
  type CashHolderCandidate,
} from './cashOwnership';

describe('isEligibleCashHolder', () => {
  it('returns true when holder_fund_id is present and holderFundManaged is true', () => {
    const candidate: CashHolderCandidate = {
      holder_fund_id: 'fund-123',
      holderFundManaged: true,
    };
    expect(isEligibleCashHolder(candidate)).toBe(true);
  });

  it('returns false for an investor holder', () => {
    const candidate: CashHolderCandidate = {
      holder_investor_id: 'inv-456',
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false for an investor holder even if holderFundManaged is true', () => {
    const candidate: CashHolderCandidate = {
      holder_investor_id: 'inv-456',
      holderFundManaged: true,
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false for an investor holder even if holder_fund_id is also set', () => {
    const candidate: CashHolderCandidate = {
      holder_investor_id: 'inv-456',
      holder_fund_id: 'fund-123',
      holderFundManaged: true,
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false for an unmanaged fund holder when holderFundManaged is false', () => {
    const candidate: CashHolderCandidate = {
      holder_fund_id: 'fund-123',
      holderFundManaged: false,
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false for an unmanaged fund holder when holderFundManaged is undefined', () => {
    const candidate: CashHolderCandidate = {
      holder_fund_id: 'fund-123',
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false for an unmanaged fund holder when holderFundManaged is null', () => {
    const candidate: CashHolderCandidate = {
      holder_fund_id: 'fund-123',
      holderFundManaged: null,
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false when neither investor nor fund holder is set', () => {
    const candidate: CashHolderCandidate = {};
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false when holder IDs are null', () => {
    const candidate: CashHolderCandidate = {
      holder_investor_id: null,
      holder_fund_id: null,
      holderFundManaged: true,
    };
    expect(isEligibleCashHolder(candidate)).toBe(false);
  });

  it('returns false when candidate is null or undefined', () => {
    expect(isEligibleCashHolder(null)).toBe(false);
    expect(isEligibleCashHolder(undefined)).toBe(false);
    expect(isEligibleCashHolder()).toBe(false);
  });

  it('returns false when holder_fund_id is whitespace or empty', () => {
    expect(
      isEligibleCashHolder({
        holder_fund_id: '   ',
        holderFundManaged: true,
      }),
    ).toBe(false);
    expect(
      isEligibleCashHolder({
        holder_fund_id: '',
        holderFundManaged: true,
      }),
    ).toBe(false);
  });
});

describe('assertEligibleCashHolder', () => {
  it('does not throw when candidate is an eligible managed fund', () => {
    const candidate: CashHolderCandidate = {
      holder_fund_id: 'fund-managed-1',
      holderFundManaged: true,
    };
    expect(() => assertEligibleCashHolder(candidate, 'testContext')).not.toThrow();
    expect(() => assertEligibleCashHolder(candidate)).not.toThrow();
  });

  it('throws IneligibleCashHolderError naming investor-held when holder is an investor', () => {
    const candidate: CashHolderCandidate = {
      holder_investor_id: 'inv-999',
    };
    expect(() => assertEligibleCashHolder(candidate, 'ledgerPosting')).toThrowError(
      IneligibleCashHolderError,
    );
    expect(() => assertEligibleCashHolder(candidate, 'ledgerPosting')).toThrowError(
      'ledgerPosting: Ineligible cash holder: investor-held (inv-999)',
    );
  });

  it('throws IneligibleCashHolderError naming unmanaged fund when fund is not managed', () => {
    const candidateFalse: CashHolderCandidate = {
      holder_fund_id: 'fund-unmanaged-2',
      holderFundManaged: false,
    };
    expect(() => assertEligibleCashHolder(candidateFalse, 'cashLegs')).toThrowError(
      IneligibleCashHolderError,
    );
    expect(() => assertEligibleCashHolder(candidateFalse, 'cashLegs')).toThrowError(
      'cashLegs: Ineligible cash holder: unmanaged fund (fund-unmanaged-2)',
    );

    const candidateUndefined: CashHolderCandidate = {
      holder_fund_id: 'fund-unmanaged-3',
    };
    expect(() => assertEligibleCashHolder(candidateUndefined, 'cashLegs')).toThrowError(
      'cashLegs: Ineligible cash holder: unmanaged fund (fund-unmanaged-3)',
    );

    const candidateNull: CashHolderCandidate = {
      holder_fund_id: 'fund-unmanaged-4',
      holderFundManaged: null,
    };
    expect(() => assertEligibleCashHolder(candidateNull, 'cashLegs')).toThrowError(
      'cashLegs: Ineligible cash holder: unmanaged fund (fund-unmanaged-4)',
    );
  });

  it('throws IneligibleCashHolderError naming no holder when candidate has no holder info', () => {
    expect(() => assertEligibleCashHolder({}, 'validation')).toThrowError(
      IneligibleCashHolderError,
    );
    expect(() => assertEligibleCashHolder({}, 'validation')).toThrowError(
      'validation: Ineligible cash holder: no holder',
    );

    expect(() =>
      assertEligibleCashHolder(
        { holder_fund_id: null, holder_investor_id: null },
        'validation',
      ),
    ).toThrowError('validation: Ineligible cash holder: no holder');

    expect(() => assertEligibleCashHolder(null, 'validation')).toThrowError(
      'validation: Ineligible cash holder: no holder',
    );

    expect(() => assertEligibleCashHolder(undefined, 'validation')).toThrowError(
      'validation: Ineligible cash holder: no holder',
    );
  });

  it('formats error message without prefix when context is omitted', () => {
    expect(() =>
      assertEligibleCashHolder({ holder_investor_id: 'inv-123' }),
    ).toThrowError('Ineligible cash holder: investor-held (inv-123)');

    expect(() =>
      assertEligibleCashHolder({
        holder_fund_id: 'fund-123',
        holderFundManaged: false,
      }),
    ).toThrowError('Ineligible cash holder: unmanaged fund (fund-123)');

    expect(() => assertEligibleCashHolder(null)).toThrowError(
      'Ineligible cash holder: no holder',
    );
  });

  it('creates an error instance with IneligibleCashHolderError name and Error prototype', () => {
    try {
      assertEligibleCashHolder(null);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IneligibleCashHolderError);
      expect(err).toBeInstanceOf(Error);
      expect((err as IneligibleCashHolderError).name).toBe('IneligibleCashHolderError');
    }
  });
});
