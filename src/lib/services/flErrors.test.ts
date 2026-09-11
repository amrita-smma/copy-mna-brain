import { describe, expect, it } from 'vitest';
import {
  AllocationMismatchError,
  AllocationSourceMismatchError,
  CannotDeletePostedEventError,
  CannotReverseReversalError,
  DuplicatePositionError,
  EntityNotFoundError,
  EntryPositionKindMismatchError,
  EventAlreadyReversedError,
  FL_DOMAIN_ERRORS,
  FundUpdateValidationError,
  InvalidCurrencyError,
  InvalidEntryShapeError,
  InvalidMasterDataError,
  InvalidPositionShapeError,
  InvalidValuationTargetError,
  PositionClosedError,
  PositionNotSettledError,
  UnbalancedTransferError,
  WorkspaceMismatchError,
} from './flErrors';

describe('flErrors', () => {
  it('instantiates each error with proper name and message', () => {
    const errors = [
      new InvalidEntryShapeError('bad shape'),
      new EntryPositionKindMismatchError('kind mismatch'),
      new PositionClosedError('position closed'),
      new UnbalancedTransferError('unbalanced'),
      new AllocationMismatchError('bad allocation'),
      new AllocationSourceMismatchError('bad allocation source'),
      new WorkspaceMismatchError('tenant mismatch'),
      new InvalidCurrencyError('invalid currency'),
      new EventAlreadyReversedError('already reversed'),
      new CannotReverseReversalError('cannot reverse reversal'),
      new CannotDeletePostedEventError('cannot delete posted event'),
      new PositionNotSettledError('not settled'),
      new InvalidPositionShapeError('bad position shape'),
      new DuplicatePositionError('duplicate position'),
      new InvalidValuationTargetError('invalid target'),
      new EntityNotFoundError('not found'),
      new InvalidMasterDataError('invalid master data'),
      new FundUpdateValidationError('invalid fund update'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(err.constructor.name);
      expect(err.message).toBeDefined();
    }
  });

  it('includes all domain error classes in FL_DOMAIN_ERRORS', () => {
    expect(FL_DOMAIN_ERRORS).toHaveLength(19);
    for (const ErrorClass of FL_DOMAIN_ERRORS) {
      const instance = new ErrorClass('test error');
      expect(instance).toBeInstanceOf(Error);
      expect(instance.name).toBe(ErrorClass.name);
    }
  });
});
