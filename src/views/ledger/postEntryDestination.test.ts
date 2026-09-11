import { describe, expect, it } from 'vitest';
import {
  PROCEEDS_DESTINATION_OPTIONS,
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  isProceedsTreatmentApplicable,
  resolveNextProceedsDestination,
} from './postEntryDestination';
import {
  isDivestmentSubType,
  toDivestmentSubType,
} from '@/lib/sellProceedsDestination';

describe('postEntryDestination mapping helper', () => {
  describe('isProceedsTreatmentApplicable', () => {
    it('returns true for sell, redemption, distribution when holder is a managed fund', () => {
      const managedFundCandidate = {
        holder_fund_id: 'fund-1',
        holderFundManaged: true,
      };

      expect(isProceedsTreatmentApplicable({ entryType: 'sell', holder: managedFundCandidate })).toBe(true);
      expect(isProceedsTreatmentApplicable({ entryType: 'redemption', holder: managedFundCandidate })).toBe(true);
      expect(isProceedsTreatmentApplicable({ entryType: 'distribution', holder: managedFundCandidate })).toBe(true);
    });

    it('returns false for all entry types when holder is an investor', () => {
      const investorCandidate = {
        holder_investor_id: 'inv-1',
        holderFundManaged: null,
      };

      expect(isProceedsTreatmentApplicable({ entryType: 'sell', holder: investorCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'redemption', holder: investorCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'distribution', holder: investorCandidate })).toBe(false);
    });

    it('returns false when holder is an unmanaged fund', () => {
      const unmanagedFundCandidate = {
        holder_fund_id: 'fund-1',
        holderFundManaged: false,
      };

      expect(isProceedsTreatmentApplicable({ entryType: 'sell', holder: unmanagedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'redemption', holder: unmanagedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'distribution', holder: unmanagedFundCandidate })).toBe(false);
    });

    it('returns false when holder is missing or null', () => {
      expect(isProceedsTreatmentApplicable({ entryType: 'sell', holder: null })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'sell', holder: undefined })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'sell' })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'redemption', holder: null })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'distribution', holder: null })).toBe(false);
    });

    it('returns false for non-proceeds entry types even when holder is a managed fund', () => {
      const managedFundCandidate = {
        holder_fund_id: 'fund-1',
        holderFundManaged: true,
      };
      expect(isProceedsTreatmentApplicable({ entryType: 'buy', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'paid_in', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'commitment', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'income', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'expense', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'adjustment', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'unit_transfer', holder: managedFundCandidate })).toBe(false);
      expect(isProceedsTreatmentApplicable({ entryType: 'commitment_transfer', holder: managedFundCandidate })).toBe(false);
    });
  });

  describe('resolveNextProceedsDestination', () => {
    it('preselects cash_in_fund when applicable and no prior selection', () => {
      expect(resolveNextProceedsDestination(true, '')).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
      expect(resolveNextProceedsDestination(true, null)).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
      expect(resolveNextProceedsDestination(true, undefined)).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
    });

    it('preserves valid prior selection when applicable', () => {
      expect(
        resolveNextProceedsDestination(true, SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR),
      ).toBe(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR);
      expect(
        resolveNextProceedsDestination(true, SUB_TYPE_DIVESTMENT_CASH_IN_FUND),
      ).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
    });

    it('clears destination to empty string when not applicable', () => {
      expect(
        resolveNextProceedsDestination(false, SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR),
      ).toBe('');
      expect(
        resolveNextProceedsDestination(false, SUB_TYPE_DIVESTMENT_CASH_IN_FUND),
      ).toBe('');
    });
  });

  describe('PROCEEDS_DESTINATION_OPTIONS', () => {
    it('offers the two canonical options with exact labels and values', () => {
      expect(PROCEEDS_DESTINATION_OPTIONS).toEqual([
        {
          value: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
          label: 'Retained in fund',
        },
        {
          value: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
          label: 'Distributed to investors',
        },
      ]);
    });
  });

  describe('sellProceedsDestination constants and subtype mapping', () => {
    it('maps destinations to distinct canonical subtypes', () => {
      expect(toDivestmentSubType('cash_in_fund')).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
      expect(toDivestmentSubType('distributed_to_investor')).toBe(
        SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      );
      expect(toDivestmentSubType(null)).toBeNull();
      expect(toDivestmentSubType(undefined)).toBeNull();
    });

    it('validates canonical subtypes with isDivestmentSubType', () => {
      expect(isDivestmentSubType(SUB_TYPE_DIVESTMENT_CASH_IN_FUND)).toBe(true);
      expect(isDivestmentSubType(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR)).toBe(true);
      expect(isDivestmentSubType('cash_in_fund')).toBe(false);
      expect(isDivestmentSubType('distributed_to_investor')).toBe(false);
      expect(isDivestmentSubType('other')).toBe(false);
      expect(isDivestmentSubType(null)).toBe(false);
    });
  });
});
