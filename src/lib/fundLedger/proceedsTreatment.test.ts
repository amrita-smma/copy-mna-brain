import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCEEDS_TREATMENT,
  demoteProceedsTreatment,
  isProceedsTreatmentApplicable,
  subTypeControlFor,
  isUnresolvedDivestmentToken,
  PROCEEDS_TREATMENT_ENTRY_TYPES,
  resolveProceedsTreatment,
} from './proceedsTreatment';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
} from '@/lib/sellProceedsDestination';
import type { CashHolderCandidate } from './cashOwnership';

describe('PROCEEDS_TREATMENT_ENTRY_TYPES', () => {
  it('contains exactly sell, distribution, and redemption', () => {
    expect(PROCEEDS_TREATMENT_ENTRY_TYPES).toEqual([
      'sell',
      'distribution',
      'redemption',
    ]);
  });
});

describe('DEFAULT_PROCEEDS_TREATMENT', () => {
  it('equals SUB_TYPE_DIVESTMENT_CASH_IN_FUND', () => {
    expect(DEFAULT_PROCEEDS_TREATMENT).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
  });
});

describe('isProceedsTreatmentApplicable', () => {
  const managedFundHolder: CashHolderCandidate = {
    holder_fund_id: 'fund-managed-1',
    holderFundManaged: true,
  };

  const unmanagedFundHolder: CashHolderCandidate = {
    holder_fund_id: 'fund-unmanaged-2',
    holderFundManaged: false,
  };

  const investorHolder: CashHolderCandidate = {
    holder_investor_id: 'inv-1',
  };

  it('returns true for managed fund holder for all three proceeds entry types', () => {
    for (const entryType of PROCEEDS_TREATMENT_ENTRY_TYPES) {
      expect(
        isProceedsTreatmentApplicable({
          entryType,
          holder: managedFundHolder,
        }),
      ).toBe(true);
    }
  });

  it('returns false for investor holder across all proceeds entry types', () => {
    for (const entryType of PROCEEDS_TREATMENT_ENTRY_TYPES) {
      expect(
        isProceedsTreatmentApplicable({
          entryType,
          holder: investorHolder,
        }),
      ).toBe(false);
    }
  });

  it('returns false for unmanaged fund holder across all proceeds entry types', () => {
    for (const entryType of PROCEEDS_TREATMENT_ENTRY_TYPES) {
      expect(
        isProceedsTreatmentApplicable({
          entryType,
          holder: unmanagedFundHolder,
        }),
      ).toBe(false);
    }
  });

  it('returns false for non-proceeds entry types on a managed fund', () => {
    const nonProceedsTypes = [
      'buy',
      'paid_in',
      'cash_movement',
      'commitment',
      'commitment_transfer',
      'unit_transfer',
      'income',
      'expense',
      'adjustment',
    ];

    for (const entryType of nonProceedsTypes) {
      expect(
        isProceedsTreatmentApplicable({
          entryType,
          holder: managedFundHolder,
        }),
      ).toBe(false);
    }
  });

  it('returns false when entryType is missing, null, or empty', () => {
    expect(
      isProceedsTreatmentApplicable({
        entryType: null,
        holder: managedFundHolder,
      }),
    ).toBe(false);
    expect(
      isProceedsTreatmentApplicable({
        entryType: '',
        holder: managedFundHolder,
      }),
    ).toBe(false);
    expect(
      isProceedsTreatmentApplicable({
        holder: managedFundHolder,
      }),
    ).toBe(false);
    expect(isProceedsTreatmentApplicable()).toBe(false);
  });

  it('returns false when holder is missing or null', () => {
    expect(
      isProceedsTreatmentApplicable({
        entryType: 'sell',
        holder: null,
      }),
    ).toBe(false);
    expect(
      isProceedsTreatmentApplicable({
        entryType: 'sell',
      }),
    ).toBe(false);
  });
});

describe('isUnresolvedDivestmentToken', () => {
  it('returns true for bare "divestment" string', () => {
    expect(isUnresolvedDivestmentToken('divestment')).toBe(true);
    expect(isUnresolvedDivestmentToken('  divestment  ')).toBe(true);
    expect(isUnresolvedDivestmentToken('Divestment')).toBe(true);
    expect(isUnresolvedDivestmentToken('DIVESTMENT')).toBe(true);
  });

  it('returns false for real treatment strings', () => {
    expect(isUnresolvedDivestmentToken('divestment:cash_in_fund')).toBe(false);
    expect(isUnresolvedDivestmentToken('cash_in_fund')).toBe(false);
    expect(
      isUnresolvedDivestmentToken('divestment:distributed_to_investor'),
    ).toBe(false);
    expect(isUnresolvedDivestmentToken('distributed_to_investor')).toBe(false);
  });

  it('returns false for other non-divestment strings and non-string values', () => {
    expect(isUnresolvedDivestmentToken('')).toBe(false);
    expect(isUnresolvedDivestmentToken('sale')).toBe(false);
    expect(isUnresolvedDivestmentToken(null)).toBe(false);
    expect(isUnresolvedDivestmentToken(undefined)).toBe(false);
    expect(isUnresolvedDivestmentToken(123)).toBe(false);
    expect(isUnresolvedDivestmentToken({})).toBe(false);
  });
});

describe('resolveProceedsTreatment', () => {
  const managedFundHolder: CashHolderCandidate = {
    holder_fund_id: 'fund-managed-1',
    holderFundManaged: true,
  };

  const unmanagedFundHolder: CashHolderCandidate = {
    holder_fund_id: 'fund-unmanaged-2',
    holderFundManaged: false,
  };

  const investorHolder: CashHolderCandidate = {
    holder_investor_id: 'inv-1',
  };

  describe('when not applicable', () => {
    it('drops stated treatment for an investor holder and returns subType null, defaulted false', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: investorHolder,
        statedSubType: 'cash_in_fund',
      });
      expect(result).toEqual({ subType: null, defaulted: false });

      const distributedResult = resolveProceedsTreatment({
        entryType: 'sell',
        holder: investorHolder,
        statedSubType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      });
      expect(distributedResult).toEqual({ subType: null, defaulted: false });
    });

    it('drops stated treatment for an unmanaged fund holder and returns subType null, defaulted false', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: unmanagedFundHolder,
        statedSubType: 'cash_in_fund',
      });
      expect(result).toEqual({ subType: null, defaulted: false });

      const distributedResult = resolveProceedsTreatment({
        entryType: 'redemption',
        holder: unmanagedFundHolder,
        statedSubType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      });
      expect(distributedResult).toEqual({ subType: null, defaulted: false });
    });

    it('returns subType null, defaulted false for non-proceeds entry types even on managed fund', () => {
      const result = resolveProceedsTreatment({
        entryType: 'buy',
        holder: managedFundHolder,
        statedSubType: 'cash_in_fund',
      });
      expect(result).toEqual({ subType: null, defaulted: false });

      const paidInResult = resolveProceedsTreatment({
        entryType: 'paid_in',
        holder: managedFundHolder,
        statedSubType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
      });
      expect(paidInResult).toEqual({ subType: null, defaulted: false });

      const movementResult = resolveProceedsTreatment({
        entryType: 'cash_movement',
        holder: managedFundHolder,
        statedSubType: 'cash_in_fund',
      });
      expect(movementResult).toEqual({ subType: null, defaulted: false });
    });
  });

  describe('when applicable and statedSubType is a real treatment', () => {
    it('honours divestment:cash_in_fund with defaulted false', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: managedFundHolder,
        statedSubType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
      });
      expect(result).toEqual({
        subType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        defaulted: false,
      });
    });

    it('honours bare cash_in_fund by canonicalizing to divestment:cash_in_fund with defaulted false', () => {
      const result = resolveProceedsTreatment({
        entryType: 'distribution',
        holder: managedFundHolder,
        statedSubType: 'cash_in_fund',
      });
      expect(result).toEqual({
        subType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
        defaulted: false,
      });
    });

    it('honours divestment:distributed_to_investor with defaulted false', () => {
      const result = resolveProceedsTreatment({
        entryType: 'redemption',
        holder: managedFundHolder,
        statedSubType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      });
      expect(result).toEqual({
        subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
        defaulted: false,
      });
    });

    it('honours bare distributed_to_investor by canonicalizing with defaulted false', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: managedFundHolder,
        statedSubType: 'distributed_to_investor',
      });
      expect(result).toEqual({
        subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
        defaulted: false,
      });
    });
  });

  describe('when applicable and statedSubType is null, undefined, or empty', () => {
    it('defaults to DEFAULT_PROCEEDS_TREATMENT with defaulted true when statedSubType is null', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: managedFundHolder,
        statedSubType: null,
      });
      expect(result).toEqual({
        subType: DEFAULT_PROCEEDS_TREATMENT,
        defaulted: true,
      });
    });

    it('defaults to DEFAULT_PROCEEDS_TREATMENT with defaulted true when statedSubType is undefined', () => {
      const result = resolveProceedsTreatment({
        entryType: 'distribution',
        holder: managedFundHolder,
        statedSubType: undefined,
      });
      expect(result).toEqual({
        subType: DEFAULT_PROCEEDS_TREATMENT,
        defaulted: true,
      });
    });

    it('defaults to DEFAULT_PROCEEDS_TREATMENT with defaulted true when statedSubType is omitted', () => {
      const result = resolveProceedsTreatment({
        entryType: 'redemption',
        holder: managedFundHolder,
      });
      expect(result).toEqual({
        subType: DEFAULT_PROCEEDS_TREATMENT,
        defaulted: true,
      });
    });

    it('defaults to DEFAULT_PROCEEDS_TREATMENT with defaulted true when statedSubType is empty string', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: managedFundHolder,
        statedSubType: '',
      });
      expect(result).toEqual({
        subType: DEFAULT_PROCEEDS_TREATMENT,
        defaulted: true,
      });
    });
  });

  describe('when applicable and statedSubType is bare "divestment" or non-treatment string', () => {
    it('treats bare "divestment" as unstated and defaults to DEFAULT_PROCEEDS_TREATMENT with defaulted true', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: managedFundHolder,
        statedSubType: 'divestment',
      });
      expect(result).toEqual({
        subType: DEFAULT_PROCEEDS_TREATMENT,
        defaulted: true,
      });
    });

    it('treats arbitrary non-treatment strings as unstated and defaults with defaulted true', () => {
      const result = resolveProceedsTreatment({
        entryType: 'sell',
        holder: managedFundHolder,
        statedSubType: 'some_arbitrary_label',
      });
      expect(result).toEqual({
        subType: DEFAULT_PROCEEDS_TREATMENT,
        defaulted: true,
      });
    });
  });
});

describe('demoteProceedsTreatment', () => {
  it('strips a :cash_in_fund / :distributed_to_investor suffix and keeps the base', () => {
    expect(demoteProceedsTreatment('divestment:cash_in_fund')).toBe('divestment');
    expect(demoteProceedsTreatment('divestment:distributed_to_investor')).toBe('divestment');
    expect(demoteProceedsTreatment('partial_exit:cash_in_fund')).toBe('partial_exit');
    expect(demoteProceedsTreatment('partial_exit:distributed_to_investor')).toBe('partial_exit');
    expect(demoteProceedsTreatment('  divestment:cash_in_fund  ')).toBe('divestment');
  });

  it('returns "divestment" if the base is empty after stripping suffix', () => {
    expect(demoteProceedsTreatment(':cash_in_fund')).toBe('divestment');
    expect(demoteProceedsTreatment(':distributed_to_investor')).toBe('divestment');
    expect(demoteProceedsTreatment('   :cash_in_fund')).toBe('divestment');
    expect(demoteProceedsTreatment('   :distributed_to_investor   ')).toBe('divestment');
  });

  it('demotes bare cash_in_fund or distributed_to_investor to "divestment"', () => {
    expect(demoteProceedsTreatment('cash_in_fund')).toBe('divestment');
    expect(demoteProceedsTreatment('distributed_to_investor')).toBe('divestment');
    expect(demoteProceedsTreatment('  cash_in_fund  ')).toBe('divestment');
    expect(demoteProceedsTreatment('  distributed_to_investor  ')).toBe('divestment');
  });

  it('passes through any other non-empty value trimmed', () => {
    expect(demoteProceedsTreatment('divestment')).toBe('divestment');
    expect(demoteProceedsTreatment('  divestment  ')).toBe('divestment');
    expect(demoteProceedsTreatment('sale')).toBe('sale');
    expect(demoteProceedsTreatment('  secondary  ')).toBe('secondary');
  });

  it('returns null for null, undefined, or empty/whitespace-only input', () => {
    expect(demoteProceedsTreatment(null)).toBeNull();
    expect(demoteProceedsTreatment(undefined)).toBeNull();
    expect(demoteProceedsTreatment('')).toBeNull();
  });

  it('never turns a value that carried a divestment marker into null', () => {
    const divestmentValues = [
      'divestment',
      'divestment:cash_in_fund',
      'divestment:distributed_to_investor',
      'cash_in_fund',
      'distributed_to_investor',
      ':cash_in_fund',
      ':distributed_to_investor',
      '  divestment  ',
      '  divestment:cash_in_fund  ',
      '  divestment:distributed_to_investor  ',
    ];

    for (const val of divestmentValues) {
      const result = demoteProceedsTreatment(val);
      expect(result).not.toBeNull();
      expect(result).toBe('divestment');
    }
  });
});

describe('subTypeControlFor', () => {
  const managedFund = { holder_fund_id: 'fund-1', holderFundManaged: true };
  const unmanagedFund = { holder_fund_id: 'fund-2', holderFundManaged: false };
  const investor = { holder_investor_id: 'inv-1' };

  it('offers the destination choice on a proceeds entry held by a managed fund', () => {
    for (const entryType of ['sell', 'distribution', 'redemption']) {
      expect(subTypeControlFor({ entryType, holder: managedFund })).toBe('destination');
    }
  });

  it('offers nothing on a sale whose holder cannot retain cash', () => {
    expect(subTypeControlFor({ entryType: 'sell', holder: investor })).toBe('none');
    expect(subTypeControlFor({ entryType: 'sell', holder: unmanagedFund })).toBe('none');
    expect(subTypeControlFor({ entryType: 'sell', holder: null })).toBe('none');
  });

  it('falls back to the free-text sub-type everywhere else', () => {
    expect(subTypeControlFor({ entryType: 'buy', holder: managedFund })).toBe('free_text');
    expect(subTypeControlFor({ entryType: 'distribution', holder: investor })).toBe('free_text');
    expect(subTypeControlFor({ entryType: 'expense', holder: investor })).toBe('free_text');
  });
});
