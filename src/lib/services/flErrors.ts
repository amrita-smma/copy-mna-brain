/**
 * Fund Ledger Domain Errors
 * All errors extend Error and set their name property to match the class name.
 */

export class InvalidEntryShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntryShapeError';
  }
}

export class EntryPositionKindMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryPositionKindMismatchError';
  }
}

export class PositionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionClosedError';
  }
}

export class UnbalancedTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedTransferError';
  }
}

export class AllocationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationMismatchError';
  }
}

export class AllocationSourceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationSourceMismatchError';
  }
}

export class WorkspaceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceMismatchError';
  }
}

export class InvalidCurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCurrencyError';
  }
}

export class EventAlreadyReversedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventAlreadyReversedError';
  }
}

export class CannotReverseReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotReverseReversalError';
  }
}

export class CannotDeletePostedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotDeletePostedEventError';
  }
}

export class PositionNotSettledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionNotSettledError';
  }
}

export class InvalidPositionShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPositionShapeError';
  }
}

export class DuplicatePositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicatePositionError';
  }
}

export class InvalidValuationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidValuationTargetError';
  }
}

export class EntityNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityNotFoundError';
  }
}

export class InvalidMasterDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMasterDataError';
  }
}

export class FundUpdateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundUpdateValidationError';
  }
}

export class IneligibleCashHolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IneligibleCashHolderError';
  }
}

/**
 * A name is both a managed fund and an investor. A managed fund's LP stakes are
 * positions held by the fund itself; a same-named investor row double-counts them.
 */
export class ManagedFundInvestorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedFundInvestorConflictError';
  }
}

/** A funding round's inputs can't produce a valid ownership change (bad terms, non-company asset, closed position). */
export class CorporateActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorporateActionValidationError';
  }
}

export const FL_DOMAIN_ERRORS = [
  InvalidEntryShapeError,
  EntryPositionKindMismatchError,
  PositionClosedError,
  UnbalancedTransferError,
  AllocationMismatchError,
  AllocationSourceMismatchError,
  WorkspaceMismatchError,
  InvalidCurrencyError,
  EventAlreadyReversedError,
  CannotReverseReversalError,
  CannotDeletePostedEventError,
  PositionNotSettledError,
  InvalidPositionShapeError,
  DuplicatePositionError,
  InvalidValuationTargetError,
  EntityNotFoundError,
  InvalidMasterDataError,
  FundUpdateValidationError,
  IneligibleCashHolderError,
  ManagedFundInvestorConflictError,
  CorporateActionValidationError,
] as const;

