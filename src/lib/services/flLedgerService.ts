import { randomUUID } from 'node:crypto';
import type {
  DbClient,
  FlAllocationRepository,
  FlBusinessEventRepository,
  FlBusinessEventRevisionRepository,
  FlFundingSourceRepository,
  FlLedgerEntryPagination,
  FlLedgerEntryRepository,
  FlPositionRepository,
  FlSourceRecordRepository,
  Tables,
  TablesInsert,
} from '@/lib/repositories';
import { FlAssetRepository } from '@/lib/repositories/flAssetRepository';
import { FlBusinessEventRevisionRepository as FlBusinessEventRevisionRepoClass } from '@/lib/repositories/flBusinessEventRevisionRepository';
import { FlFundRepository } from '@/lib/repositories/flFundRepository';
import { FlInvestorRepository } from '@/lib/repositories/flInvestorRepository';
import { validateCurrency } from './flCurrency';
import {
  FlMasterDataService,
  getCashAssetCurrency,
  isUniqueViolationOrDuplicateError,
} from './flMasterDataService';
import {
  FlPositionService,
  type CashPositionHolder,
} from './flPositionService';
import {
  deriveCashLegs,
  type CashLegSpec,
  type PositionWithFundFlags,
} from '@/lib/fundLedger/deriveCashLegs';
import {
  assertEligibleCashHolder,
  type CashHolderCandidate,
} from '@/lib/fundLedger/cashOwnership';
import {
  PROCEEDS_TREATMENT_ENTRY_TYPES,
  demoteProceedsTreatment,
  isProceedsTreatmentApplicable,
  resolveProceedsTreatment,
} from '@/lib/fundLedger/proceedsTreatment';

import {
  flAbs,
  flEq,
  flGt,
  flGte,
  flIsZero,
  flLt,
  flLte,
  flNeg,
  flSum,
  toDecimalString,
} from './flDecimal';
import {
  AllocationMismatchError,
  AllocationSourceMismatchError,
  CannotDeletePostedEventError,
  CannotReverseReversalError,
  EntityNotFoundError,
  EntryPositionKindMismatchError,
  EventAlreadyReversedError,
  IneligibleCashHolderError,
  InvalidCurrencyError,
  InvalidEntryShapeError,
  PositionClosedError,
  UnbalancedTransferError,
  WorkspaceMismatchError,
} from './flErrors';
import { toIsoDate } from '@/lib/fundLedger/format';

export type FlEntryType =
  | 'commitment'
  | 'commitment_transfer'
  | 'paid_in'
  | 'distribution'
  | 'redemption'
  | 'unit_transfer'
  | 'buy'
  | 'sell'
  | 'income'
  | 'expense'
  | 'adjustment'
  | 'cash_movement';

export type FlDataStatus = 'verified' | 'needs_verification';

export interface FlAllocationInput {
  id?: string;
  ledger_entry_id?: string;
  entry_index?: number;
  funding_source_id: string;
  amount: string;
  created_by?: string | null;
}

export interface FlLedgerEntryInput {
  id?: string;
  position_id: string;
  entry_date?: string;
  entry_type: FlEntryType;
  sub_type?: string | null;
  is_reversal?: boolean;
  commitment_delta?: string;
  quantity_delta?: string;
  valuation_delta?: string;
  cash_delta?: string;
  currency: string;
  fx_rate?: string | null;
  price_per_unit?: string | null;
  counterparty_position_id?: string | null;
  data_status?: FlDataStatus;
  source_record_id?: string | null;
  source_ledger_entry_id?: string | null;
  primary_entry_index?: number | null;
  source_entry_index?: number | null;
  notes?: string | null;
  created_by?: string | null;
  allocations?: FlAllocationInput[];
}

export interface PostEventInput {
  business_event_id?: string;
  event_date: string;
  description?: string | null;
  source_record_id?: string | null;
  created_by?: string | null;
  entries: FlLedgerEntryInput[];
  allocations?: FlAllocationInput[];
}

export interface ReverseEventOptions {
  business_event_id?: string;
  event_date?: string;
  description?: string | null;
  created_by?: string | null;
}

export interface RecordCommitmentInput {
  positionId: string;
  amount: string;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordPaidInInput {
  positionId: string;
  cashAmount: string;
  unitsIssued?: string | null;
  date: string;
  currency: string;
  allocations?: { fundingSourceId: string; amount: string }[];
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordDistributionInput {
  positionId: string;
  amount: string;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordRedemptionInput {
  positionId: string;
  cashAmount: string;
  unitsRedeemed: string;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordBuyInput {
  positionId: string;
  cashAmount: string;
  quantity?: string | null;
  pricePerUnit?: string | null;
  date: string;
  currency: string;
  allocations?: { fundingSourceId: string; amount: string }[];
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordSellInput {
  positionId: string;
  cashAmount: string;
  quantity?: string | null;
  pricePerUnit?: string | null;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordCommitmentTransferInput {
  fromPositionId: string;
  toPositionId: string;
  amount: string;
  cashConsideration?: string | null;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  businessEventId?: string;
}

export interface RecordUnitTransferInput {
  fromPositionId: string;
  toPositionId: string;
  units: string;
  cashConsideration?: string | null;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  businessEventId?: string;
}

export interface RecordIncomeInput {
  positionId: string;
  amount: string;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordExpenseInput {
  positionId: string;
  amount: string;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

export interface RecordAdjustmentInput {
  positionId: string;
  commitmentDelta?: string;
  quantityDelta?: string;
  valuationDelta?: string;
  date: string;
  currency: string;
  subType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  id?: string;
  businessEventId?: string;
}

const FUND_ONLY_TYPES = new Set<FlEntryType>([
  'commitment',
  'commitment_transfer',
  'paid_in',
  'distribution',
  'redemption',
  'unit_transfer',
]);

const ASSET_ONLY_TYPES = new Set<FlEntryType>(['buy', 'sell']);

export class FlLedgerService {
  private readonly assetRepo: FlAssetRepository;
  private readonly fundRepo: FlFundRepository;
  private readonly investorRepo: FlInvestorRepository;
  private readonly revisionRepo: FlBusinessEventRevisionRepository;
  private readonly masterDataService: FlMasterDataService;
  private readonly positionService?: FlPositionService;

  constructor(
    private readonly db: DbClient,
    private readonly ledgerRepo: FlLedgerEntryRepository,
    private readonly eventRepo: FlBusinessEventRepository,
    private readonly allocationRepo: FlAllocationRepository,
    private readonly positionRepo: FlPositionRepository,
    private readonly fundingSourceRepo: FlFundingSourceRepository,
    private readonly sourceRecordRepo: FlSourceRecordRepository,
    assetRepo?: FlAssetRepository,
    fundRepo?: FlFundRepository,
    masterDataService?: FlMasterDataService,
    positionService?: FlPositionService,
    investorRepo?: FlInvestorRepository,
    revisionRepo?: FlBusinessEventRevisionRepository,
  ) {
    this.assetRepo = assetRepo ?? new FlAssetRepository(db);
    this.fundRepo = fundRepo ?? new FlFundRepository(db);
    this.investorRepo = investorRepo ?? new FlInvestorRepository(db);
    this.revisionRepo =
      revisionRepo ?? new FlBusinessEventRevisionRepoClass(db);
    this.masterDataService =
      masterDataService ??
      new FlMasterDataService(
        db,
        this.investorRepo,
        this.fundRepo,
        this.assetRepo,
        this.fundingSourceRepo,
      );
    this.positionService = positionService;
  }

  async getOrCreateCashPosition(
    workspaceId: string,
    holder: CashPositionHolder,
    currency: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    if (this.positionService) {
      return this.positionService.getOrCreateCashPosition(
        workspaceId,
        holder,
        currency,
        executor,
      );
    }

    const { id: holderId } = holder;
    const validCurrency = validateCurrency(currency);
    return this.withExecutor(executor, async (exec) => {
      const fund = await this.fundRepo.findById(workspaceId, holderId, exec);
      if (!fund) {
        throw new WorkspaceMismatchError(
          `Fund ${holderId} not found in workspace ${workspaceId}`,
        );
      }
      if (!fund.managed) {
        throw new IneligibleCashHolderError(
          `Cash positions can only be held by managed funds; fund ${holderId} is not managed`,
        );
      }

      const cashAsset = await this.masterDataService.getOrCreateCashAsset(
        workspaceId,
        validCurrency,
        exec,
      );

      const findExisting = () =>
        this.positionRepo.findCashPosition(
          workspaceId,
          holderId,
          cashAsset.id,
          exec,
        );

      const existing = await findExisting();
      if (existing) {
        if (existing.status === 'closed') {
          const updated = await this.positionRepo.update(
            workspaceId,
            existing.id,
            { status: 'open' },
            exec,
          );
          return updated ?? existing;
        }
        return existing;
      }

      const openedAt = new Date().toISOString().slice(0, 10);
      try {
        return await this.positionRepo.create(
          {
            workspace_id: workspaceId,
            holder_fund_id: holderId,
            holder_investor_id: null,
            fund_id: null,
            asset_id: cashAsset.id,
            status: 'open',
            opened_at: openedAt,
          },
          exec,
        );
      } catch (err) {
        if (isUniqueViolationOrDuplicateError(err)) {
          const winner = await findExisting();
          if (winner) {
            return winner;
          }
        }
        throw err;
      }
    });
  }

  private async withExecutor<T>(
    executor: DbClient | undefined,
    fn: (exec: DbClient) => Promise<T>,
  ): Promise<T> {
    if (executor) {
      return fn(executor);
    }
    return (this.db as any).transaction(async (tx: unknown) => {
      return fn(tx as DbClient);
    });
  }

  private validateEntryDeltas(entry: FlLedgerEntryInput): {
    commitmentDelta: string;
    quantityDelta: string;
    valuationDelta: string;
    cashDelta: string;
  } {
    if (
      entry.commitment_delta !== undefined &&
      typeof entry.commitment_delta !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'commitment_delta must be a string, received ' +
          typeof entry.commitment_delta,
      );
    }
    if (
      entry.quantity_delta !== undefined &&
      typeof entry.quantity_delta !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'quantity_delta must be a string, received ' +
          typeof entry.quantity_delta,
      );
    }
    if (
      entry.valuation_delta !== undefined &&
      typeof entry.valuation_delta !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'valuation_delta must be a string, received ' +
          typeof entry.valuation_delta,
      );
    }
    if (
      entry.cash_delta !== undefined &&
      typeof entry.cash_delta !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'cash_delta must be a string, received ' + typeof entry.cash_delta,
      );
    }
    if (
      entry.fx_rate !== undefined &&
      entry.fx_rate !== null &&
      typeof entry.fx_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'fx_rate must be a string, received ' + typeof entry.fx_rate,
      );
    }
    if (
      entry.price_per_unit !== undefined &&
      entry.price_per_unit !== null &&
      typeof entry.price_per_unit !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'price_per_unit must be a string, received ' +
          typeof entry.price_per_unit,
      );
    }

    const c = toDecimalString(entry.commitment_delta ?? '0');
    const q = toDecimalString(entry.quantity_delta ?? '0');
    const v = toDecimalString(entry.valuation_delta ?? '0');
    const k = toDecimalString(entry.cash_delta ?? '0');

    const isRev = entry.is_reversal === true;

    switch (entry.entry_type) {
      case 'commitment':
        if (flIsZero(c) || !flIsZero(q) || !flIsZero(k) || !flIsZero(v)) {
          throw new InvalidEntryShapeError(
            `commitment requires commitment_delta <> 0, quantity_delta = 0, valuation_delta = 0, cash_delta = 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
          );
        }
        break;
      case 'commitment_transfer':
        if (flIsZero(c) || !flIsZero(q) || !flIsZero(v)) {
          throw new InvalidEntryShapeError(
            `commitment_transfer requires commitment_delta <> 0, quantity_delta = 0, valuation_delta = 0. Got: c=${c}, q=${q}, v=${v}`,
          );
        }
        break;
      case 'paid_in':
        if (isRev) {
          if (!flIsZero(c) || flGt(q, '0') || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `paid_in (reversal) requires commitment_delta = 0, quantity_delta <= 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || flLt(q, '0') || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `paid_in requires commitment_delta = 0, quantity_delta >= 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'distribution':
        if (isRev) {
          if (!flIsZero(c) || !flIsZero(q) || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `distribution (reversal) requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || !flIsZero(q) || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `distribution requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'redemption':
        if (isRev) {
          if (!flIsZero(c) || flLte(q, '0') || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `redemption (reversal) requires commitment_delta = 0, quantity_delta > 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || flGte(q, '0') || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `redemption requires commitment_delta = 0, quantity_delta < 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'unit_transfer':
        if (!flIsZero(c) || flIsZero(q) || !flIsZero(v)) {
          throw new InvalidEntryShapeError(
            `unit_transfer requires commitment_delta = 0, quantity_delta <> 0, valuation_delta = 0. Got: c=${c}, q=${q}, v=${v}`,
          );
        }
        break;
      case 'buy':
        if (isRev) {
          if (!flIsZero(c) || flGt(q, '0') || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `buy (reversal) requires commitment_delta = 0, quantity_delta <= 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || flLt(q, '0') || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `buy requires commitment_delta = 0, quantity_delta >= 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'sell':
        if (isRev) {
          if (!flIsZero(c) || flLt(q, '0') || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `sell (reversal) requires commitment_delta = 0, quantity_delta >= 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || flGt(q, '0') || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `sell requires commitment_delta = 0, quantity_delta <= 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'income':
        if (isRev) {
          if (!flIsZero(c) || !flIsZero(q) || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `income (reversal) requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || !flIsZero(q) || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `income requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'expense':
        if (isRev) {
          if (!flIsZero(c) || !flIsZero(q) || flLte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `expense (reversal) requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta > 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        } else {
          if (!flIsZero(c) || !flIsZero(q) || flGte(k, '0') || !flIsZero(v)) {
            throw new InvalidEntryShapeError(
              `expense requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta < 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
            );
          }
        }
        break;
      case 'adjustment':
        if (!flIsZero(k)) {
          throw new InvalidEntryShapeError(
            `adjustment requires cash_delta = 0. Got: k=${k}`,
          );
        }
        break;
      case 'cash_movement':
        if (!flIsZero(c) || !flIsZero(q) || !flIsZero(v) || flIsZero(k)) {
          throw new InvalidEntryShapeError(
            `cash_movement requires commitment_delta = 0, quantity_delta = 0, valuation_delta = 0, cash_delta <> 0. Got: c=${c}, q=${q}, v=${v}, k=${k}`,
          );
        }
        break;
      default:
        throw new InvalidEntryShapeError(
          `Unknown entry_type: ${(entry as any).entry_type}`,
        );
    }

    return { commitmentDelta: c, quantityDelta: q, valuationDelta: v, cashDelta: k };
  }

  private validateEntryInputs(input: PostEventInput): void {
    if (!input.entries || input.entries.length === 0) {
      throw new InvalidEntryShapeError('At least one ledger entry is required');
    }

    const seenPrimaryPositionPairs = new Set<string>();

    for (let i = 0; i < input.entries.length; i++) {
      const entry = input.entries[i];

      if (entry.is_reversal === true) {
        throw new InvalidEntryShapeError(
          'is_reversal cannot be set to true in postEvent input. Reversals must be created via reverseEvent.',
        );
      }

      if (entry.source_ledger_entry_id !== undefined && entry.source_ledger_entry_id !== null) {
        throw new InvalidEntryShapeError(
          'caller-supplied persisted source_ledger_entry_id is not permitted; use transient same-request pairing reference (primary_entry_index)',
        );
      }

      const hasPrimaryIdx =
        entry.primary_entry_index !== undefined && entry.primary_entry_index !== null;
      const hasSourceIdx =
        entry.source_entry_index !== undefined && entry.source_entry_index !== null;

      if (hasPrimaryIdx && hasSourceIdx && entry.primary_entry_index !== entry.source_entry_index) {
        throw new InvalidEntryShapeError(
          'Ambiguous primary entry reference: primary_entry_index and source_entry_index must match',
        );
      }

      const transientPrimaryIndex = entry.primary_entry_index ?? entry.source_entry_index;
      const hasTransientRef = transientPrimaryIndex !== undefined && transientPrimaryIndex !== null;

      if (hasTransientRef && entry.entry_type !== 'cash_movement') {
        throw new InvalidEntryShapeError(
          'primary_entry_index is only permitted on cash_movement entries',
        );
      }

      if (entry.entry_type === 'cash_movement') {
        const hasCp = Boolean(entry.counterparty_position_id);
        const isOpeningBalance = entry.sub_type === 'opening_balance';

        if (hasTransientRef && hasCp) {
          throw new InvalidEntryShapeError(
            'cash_movement leg cannot have both primary_entry_index and counterparty_position_id',
          );
        }

        if (hasTransientRef && isOpeningBalance) {
          throw new InvalidEntryShapeError(
            'Opening balance cash_movement cannot have primary_entry_index',
          );
        }

        if (hasCp && isOpeningBalance) {
          throw new InvalidEntryShapeError(
            'Opening balance cash_movement cannot have counterparty_position_id',
          );
        }

        if (!hasTransientRef && !hasCp && !isOpeningBalance) {
          throw new InvalidEntryShapeError(
            'cash_movement without primary_entry_index or counterparty_position_id must have sub_type = "opening_balance"',
          );
        }

        if (hasTransientRef) {
          // Form 1: Mirrored leg
          if (
            typeof transientPrimaryIndex !== 'number' ||
            !Number.isInteger(transientPrimaryIndex) ||
            transientPrimaryIndex < 0 ||
            transientPrimaryIndex >= input.entries.length
          ) {
            throw new InvalidEntryShapeError(
              `Mirrored cash_movement primary_entry_index ${transientPrimaryIndex} is out of range [0, ${input.entries.length})`,
            );
          }

          if (transientPrimaryIndex === i) {
            throw new InvalidEntryShapeError(
              'Mirrored cash_movement leg cannot reference itself',
            );
          }

          const primary = input.entries[transientPrimaryIndex];
          if (primary.entry_type === 'cash_movement') {
            throw new InvalidEntryShapeError(
              'Mirrored cash_movement leg cannot reference another cash_movement entry',
            );
          }

          const pairKey = `${transientPrimaryIndex}:${entry.position_id}`;
          if (seenPrimaryPositionPairs.has(pairKey)) {
            throw new InvalidEntryShapeError(
              `Duplicate cash_movement leg for primary_entry_index "${transientPrimaryIndex}" and position "${entry.position_id}"`,
            );
          }
          seenPrimaryPositionPairs.add(pairKey);

          if (entry.sub_type !== undefined && entry.sub_type !== null) {
            throw new InvalidEntryShapeError(
              'Mirrored cash_movement leg cannot have sub_type',
            );
          }

          // Mirrored leg currency validation: reject mismatches rather than coerce
          if (
            entry.currency !== undefined &&
            entry.currency !== null &&
            String(entry.currency).trim() !== ''
          ) {
            const legCurrency = validateCurrency(entry.currency);
            const primaryCurrency = validateCurrency(primary.currency);
            if (legCurrency !== primaryCurrency) {
              throw new InvalidCurrencyError(
                `Explicit mirrored cash_movement leg currency "${legCurrency}" does not match primary entry currency "${primaryCurrency}"`,
              );
            }
            entry.currency = primaryCurrency;
          } else {
            entry.currency = primary.currency;
          }

          // Hard-copy mirrored metadata deterministically from primary per Phase 3
          entry.entry_date = primary.entry_date ?? input.event_date;
          entry.data_status = primary.data_status ?? 'verified';
          entry.source_record_id = primary.source_record_id ?? null;
        }
      }

      validateCurrency(entry.currency);
      this.validateEntryDeltas(entry);

      if (
        entry.counterparty_position_id &&
        entry.entry_type !== 'commitment_transfer' &&
        entry.entry_type !== 'unit_transfer' &&
        entry.entry_type !== 'cash_movement'
      ) {
        throw new InvalidEntryShapeError(
          `counterparty_position_id is only permitted on transfer entries. Found on: ${entry.entry_type}`,
        );
      }
      if (entry.counterparty_position_id === entry.position_id) {
        throw new InvalidEntryShapeError(
          'A transfer counterparty must be a different position',
        );
      }
    }
  }

  private async validateCashOwnership(
    workspaceId: string,
    entries: Array<{ position_id: string; entry_type: string }>,
    derivedLegs: CashLegSpec[] | undefined,
    exec: DbClient,
    cache?: {
      positionsMap?: Map<string, Tables<'fl_positions'>>;
      fundsMap?: Map<string, Tables<'fl_funds'>>;
    },
  ): Promise<void> {
    const cashEntries = entries.filter((e) => e.entry_type === 'cash_movement');
    if (cashEntries.length === 0 && (!derivedLegs || derivedLegs.length === 0)) {
      return;
    }

    // 1. Resolve positions for cash entries
    let positionsMap = cache?.positionsMap;
    const missingPosIds = cashEntries
      .map((e) => e.position_id)
      .filter((id) => !positionsMap?.has(id));

    if (missingPosIds.length > 0) {
      const fetched = await this.positionRepo.findByIds(
        workspaceId,
        Array.from(new Set(missingPosIds)),
        exec,
      );
      const mergedMap = new Map<string, Tables<'fl_positions'>>(positionsMap);
      for (const pos of fetched) {
        mergedMap.set(pos.id, pos);
      }
      positionsMap = mergedMap;
    }

    // 2. Collect all fund IDs that need to be checked
    let fundsMap = cache?.fundsMap;
    const fundIdsToCheck = new Set<string>();
    for (const entry of cashEntries) {
      const pos = positionsMap?.get(entry.position_id);
      if (pos?.holder_fund_id) {
        fundIdsToCheck.add(pos.holder_fund_id);
      }
    }
    if (derivedLegs) {
      for (const leg of derivedLegs) {
        if (leg.holder_kind === 'fund' && leg.holder_id) {
          fundIdsToCheck.add(leg.holder_id);
        }
      }
    }

    const missingFundIds = Array.from(fundIdsToCheck).filter(
      (id) => !fundsMap?.has(id),
    );
    if (missingFundIds.length > 0) {
      const fetchedFunds = await this.fundRepo.findByIds(
        workspaceId,
        missingFundIds,
        exec,
      );
      const mergedFundsMap = new Map<string, Tables<'fl_funds'>>(fundsMap);
      for (const fund of fetchedFunds) {
        mergedFundsMap.set(fund.id, fund);
      }
      fundsMap = mergedFundsMap;
    }

    // 3. Validate cash movement entries
    for (const entry of cashEntries) {
      const pos = positionsMap?.get(entry.position_id);
      if (!pos) {
        throw new WorkspaceMismatchError(
          `Position ${entry.position_id} not found in workspace ${workspaceId}`,
        );
      }

      const holderFund = pos.holder_fund_id
        ? fundsMap?.get(pos.holder_fund_id)
        : undefined;

      assertEligibleCashHolder(
        {
          holder_investor_id: pos.holder_investor_id,
          holder_fund_id: pos.holder_fund_id,
          holderFundManaged: holderFund?.managed,
        },
        `Cash movement on position ${pos.id}`,
      );
    }

    // 4. Validate derived legs
    if (derivedLegs) {
      for (const leg of derivedLegs) {
        const holderKind = (leg as any).holder_kind;
        if (holderKind !== 'fund') {
          throw new IneligibleCashHolderError(
            `Derived cash leg has ineligible holder kind: ${holderKind}`,
          );
        }
        const fund = fundsMap?.get(leg.holder_id);
        assertEligibleCashHolder(
          {
            holder_fund_id: leg.holder_id,
            holderFundManaged: fund?.managed,
          },
          `Derived cash leg for fund ${leg.holder_id}`,
        );
      }
    }
  }

  private async buildAndInsertEntries(
    workspaceId: string,
    businessEventId: string,
    input: PostEventInput,
    exec: DbClient,
  ): Promise<{
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }> {
    // Re-validates because updateEvent enters through the helper.
    this.validateEntryInputs(input);

    // 1. Validate referenced positions (and counterparty positions)
    const positionIdsSet = new Set<string>();
    for (const e of input.entries) {
      positionIdsSet.add(e.position_id);
      if (e.counterparty_position_id) {
        positionIdsSet.add(e.counterparty_position_id);
      }
    }
    const referencedPositionIds = Array.from(positionIdsSet);
    const positions = await this.positionRepo.findByIds(
      workspaceId,
      referencedPositionIds,
      exec,
    );

    if (positions.length !== referencedPositionIds.length) {
      throw new WorkspaceMismatchError(
        `One or more referenced positions do not exist in workspace ${workspaceId}`,
      );
    }

    const positionsMap = new Map<string, Tables<'fl_positions'>>();
    for (const pos of positions) {
      positionsMap.set(pos.id, pos);
    }

    // Batch load funds for referenced positions (managed flags for cash-leg derivation)
    const fundIdsToLoad = new Set<string>();
    for (const pos of positions) {
      if (pos.holder_fund_id) fundIdsToLoad.add(pos.holder_fund_id);
      if (pos.fund_id) fundIdsToLoad.add(pos.fund_id);
    }
    const funds =
      fundIdsToLoad.size > 0
        ? await this.fundRepo.findByIds(
            workspaceId,
            Array.from(fundIdsToLoad),
            exec,
          )
        : [];
    if (funds.length !== fundIdsToLoad.size) {
      throw new WorkspaceMismatchError(
        `One or more referenced funds do not exist in workspace ${workspaceId}`,
      );
    }
    const fundsMap = new Map<string, Tables<'fl_funds'>>(
      funds.map((f) => [f.id, f]),
    );

    // Batch load assets for cash_movement entries and position asset kind checks
    const referencedAssetIds = Array.from(
      new Set(
        positions
          .map((p) => p.asset_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const assets =
      referencedAssetIds.length > 0
        ? await this.assetRepo.findByIds(workspaceId, referencedAssetIds, exec)
        : [];
    const assetsMap = new Map<string, Tables<'fl_assets'>>(
      assets.map((a) => [a.id, a]),
    );

    // 2. Validate position open status & position kind agreement
    for (const entry of input.entries) {
      const pos = positionsMap.get(entry.position_id);
      if (!pos) {
        throw new WorkspaceMismatchError(
          `Position ${entry.position_id} not found in workspace`,
        );
      }
      if (pos.status === 'closed') {
        throw new PositionClosedError(
          `Position ${pos.id} is closed and cannot receive new ledger entries`,
        );
      }

      if (entry.counterparty_position_id) {
        const cpPos = positionsMap.get(entry.counterparty_position_id);
        if (!cpPos) {
          throw new WorkspaceMismatchError(
            `Counterparty position ${entry.counterparty_position_id} not found in workspace`,
          );
        }
        if (cpPos.status === 'closed') {
          throw new PositionClosedError(
            `Counterparty position ${cpPos.id} is closed`,
          );
        }
      }

      if (FUND_ONLY_TYPES.has(entry.entry_type)) {
        const targetAsset = pos.asset_id ? assetsMap.get(pos.asset_id) : undefined;
        const terms = targetAsset?.instrument_terms as Record<string, unknown> | null | undefined;
        const isFundInvestmentAsset = targetAsset?.asset_kind === 'equity' &&
          typeof terms?.investmentTypeLabel === 'string' &&
          terms.investmentTypeLabel.toLowerCase() === 'fund of funds';
        // External fund investments may be stored as assets. Commitments and
        // ownership transfers still require an actual fund vehicle.
        const isFundInvestmentEntry = entry.entry_type === 'paid_in' ||
          entry.entry_type === 'distribution' || entry.entry_type === 'redemption';
        if (!pos.fund_id && !(isFundInvestmentAsset && isFundInvestmentEntry)) {
          throw new EntryPositionKindMismatchError(
            `Entry type "${entry.entry_type}" is a fund-only entry type, but position ${pos.id} is an asset position`,
          );
        }
      } else if (ASSET_ONLY_TYPES.has(entry.entry_type)) {
        if (!pos.asset_id) {
          throw new EntryPositionKindMismatchError(
            `Entry type "${entry.entry_type}" is an asset-only entry type, but position ${pos.id} is a fund position`,
          );
        }
      } else if (entry.entry_type === 'cash_movement') {
        if (!pos.asset_id) {
          throw new EntryPositionKindMismatchError(
            `Entry type "cash_movement" can only be posted to cash asset positions, but position ${pos.id} is a fund position`,
          );
        }
        const asset = assetsMap.get(pos.asset_id);
        if (!asset || asset.asset_kind !== 'cash') {
          throw new EntryPositionKindMismatchError(
            `Entry type "cash_movement" can only be posted to positions with asset_kind = 'cash', but position ${pos.id} has asset_kind "${asset?.asset_kind ?? 'unknown'}"`,
          );
        }
        const cashAssetCurrency = getCashAssetCurrency(asset);
        const normalizedEntryCurrency = validateCurrency(entry.currency);
        if (!cashAssetCurrency || normalizedEntryCurrency !== cashAssetCurrency) {
          throw new InvalidCurrencyError(
            `Entry currency "${normalizedEntryCurrency}" does not match cash asset currency "${cashAssetCurrency}" for position ${pos.id}`,
          );
        }
      }
    }

    // 3. Validate transfer legs netting & counterparties
    const commitmentTransfers = input.entries.filter(
      (e) => e.entry_type === 'commitment_transfer',
    );
    if (commitmentTransfers.length > 0) {
      const byCurrency = new Map<string, FlLedgerEntryInput[]>();
      for (const ct of commitmentTransfers) {
        const curr = ct.currency.trim().toUpperCase();
        const list = byCurrency.get(curr) ?? [];
        list.push(ct);
        byCurrency.set(curr, list);
      }

      for (const [curr, legs] of byCurrency.entries()) {
        const commitmentNet = flSum(
          legs.map((l) => toDecimalString(l.commitment_delta ?? '0')),
        );
        if (!flIsZero(commitmentNet)) {
          throw new UnbalancedTransferError(
            `commitment_transfer legs do not net to zero for currency ${curr}. Net: ${commitmentNet}`,
          );
        }

        const hasCash = legs.some((l) => !flIsZero(l.cash_delta ?? '0'));
        if (hasCash) {
          const cashNet = flSum(
            legs.map((l) => toDecimalString(l.cash_delta ?? '0')),
          );
          if (!flIsZero(cashNet)) {
            throw new UnbalancedTransferError(
              `commitment_transfer cash deltas do not net to zero for currency ${curr}. Net: ${cashNet}`,
            );
          }
        }

        for (const leg of legs) {
          if (!leg.counterparty_position_id) {
            throw new UnbalancedTransferError(
              'Transfer leg must have counterparty_position_id set',
            );
          }
          const sibling = legs.find(
            (other) =>
              other.position_id === leg.counterparty_position_id &&
              other.counterparty_position_id === leg.position_id,
          );
          if (!sibling) {
            throw new UnbalancedTransferError(
              `Transfer leg for position ${leg.position_id} lacks matching sibling counterparty leg`,
            );
          }
        }
      }
    }

    const unitTransfers = input.entries.filter(
      (e) => e.entry_type === 'unit_transfer',
    );
    if (unitTransfers.length > 0) {
      const byCurrency = new Map<string, FlLedgerEntryInput[]>();
      for (const ut of unitTransfers) {
        const curr = ut.currency.trim().toUpperCase();
        const list = byCurrency.get(curr) ?? [];
        list.push(ut);
        byCurrency.set(curr, list);
      }

      for (const [curr, legs] of byCurrency.entries()) {
        const quantityNet = flSum(
          legs.map((l) => toDecimalString(l.quantity_delta ?? '0')),
        );
        if (!flIsZero(quantityNet)) {
          throw new UnbalancedTransferError(
            `unit_transfer legs do not net to zero for currency ${curr}. Net: ${quantityNet}`,
          );
        }

        const hasCash = legs.some((l) => !flIsZero(l.cash_delta ?? '0'));
        if (hasCash) {
          const cashNet = flSum(
            legs.map((l) => toDecimalString(l.cash_delta ?? '0')),
          );
          if (!flIsZero(cashNet)) {
            throw new UnbalancedTransferError(
              `unit_transfer cash deltas do not net to zero for currency ${curr}. Net: ${cashNet}`,
            );
          }
        }

        for (const leg of legs) {
          if (!leg.counterparty_position_id) {
            throw new UnbalancedTransferError(
              'Transfer leg must have counterparty_position_id set',
            );
          }
          const sibling = legs.find(
            (other) =>
              other.position_id === leg.counterparty_position_id &&
              other.counterparty_position_id === leg.position_id,
          );
          if (!sibling) {
            throw new UnbalancedTransferError(
              `Transfer leg for position ${leg.position_id} lacks matching sibling counterparty leg`,
            );
          }
        }
      }
    }

    // 3.5. Validate cash_movement forms
    const cashMovements = input.entries.filter(
      (e) => e.entry_type === 'cash_movement',
    );

    for (const entry of cashMovements) {
      if (entry.allocations && entry.allocations.length > 0) {
        throw new AllocationMismatchError(
          'cash_movement entries must carry no funding allocations',
        );
      }

      const hasCp = Boolean(entry.counterparty_position_id);

      if (hasCp) {
        // Form 2: FX transfer
        const sibling = input.entries.find(
          (other) =>
            other !== entry &&
            other.entry_type === 'cash_movement' &&
            other.position_id === entry.counterparty_position_id &&
            other.counterparty_position_id === entry.position_id,
        );
        if (!sibling) {
          throw new UnbalancedTransferError(
            `FX transfer cash_movement leg for position ${entry.position_id} lacks matching sibling counterparty leg`,
          );
        }
        const siblingHasPrimary =
          (sibling.primary_entry_index !== undefined && sibling.primary_entry_index !== null) ||
          (sibling.source_entry_index !== undefined && sibling.source_entry_index !== null);
        if (siblingHasPrimary || sibling.source_ledger_entry_id) {
          throw new InvalidEntryShapeError(
            'FX transfer cash_movement legs cannot have primary_entry_index',
          );
        }

        const pos = positionsMap.get(entry.position_id)!;
        const cpPos = positionsMap.get(entry.counterparty_position_id!)!;

        const sameFundHolder = Boolean(
          pos.holder_fund_id &&
          cpPos.holder_fund_id &&
          pos.holder_fund_id === cpPos.holder_fund_id,
        );
        const sameInvestorHolder = Boolean(
          pos.holder_investor_id &&
          cpPos.holder_investor_id &&
          pos.holder_investor_id === cpPos.holder_investor_id,
        );

        if (!sameFundHolder && !sameInvestorHolder) {
          throw new InvalidEntryShapeError(
            'FX transfer cash_movement legs must belong to the same holder',
          );
        }

        if (
          validateCurrency(entry.currency) ===
          validateCurrency(sibling.currency)
        ) {
          throw new InvalidEntryShapeError(
            'FX transfer cash_movement legs must have different currencies',
          );
        }
      }
    }

    // 4. Validate source records workspace
    const sourceRecordIds = new Set<string>();
    if (input.source_record_id) {
      sourceRecordIds.add(input.source_record_id);
    }
    for (const e of input.entries) {
      if (e.source_record_id) {
        sourceRecordIds.add(e.source_record_id);
      }
    }
    if (sourceRecordIds.size > 0) {
      const srcList = await this.sourceRecordRepo.findByIds(
        workspaceId,
        Array.from(sourceRecordIds),
        exec,
      );
      if (srcList.length !== sourceRecordIds.size) {
        throw new WorkspaceMismatchError(
          `One or more source records do not exist in workspace ${workspaceId}`,
        );
      }
    }

    // 5. Gather, default, and validate allocations per Phase 3 validation 5
    const allAllocationsByEntryIndex = new Map<number, FlAllocationInput[]>();

    // Allocations attached directly to entries
    input.entries.forEach((e, idx) => {
      if (e.allocations && e.allocations.length > 0) {
        const list = allAllocationsByEntryIndex.get(idx) ?? [];
        list.push(...e.allocations);
        allAllocationsByEntryIndex.set(idx, list);
      }
    });

    // Allocations specified at top level
    if (input.allocations) {
      for (const alloc of input.allocations) {
        const hasEntryIndex =
          alloc.entry_index !== undefined && alloc.entry_index !== null;
        const hasLedgerEntryId =
          alloc.ledger_entry_id !== undefined && alloc.ledger_entry_id !== null;

        let targetIndexFromIndex: number | undefined;
        let targetIndexFromId: number | undefined;

        if (hasEntryIndex) {
          if (
            !Number.isInteger(alloc.entry_index) ||
            alloc.entry_index! < 0 ||
            alloc.entry_index! >= input.entries.length
          ) {
            throw new InvalidEntryShapeError(
              `Top-level allocation entry_index ${alloc.entry_index} is out of bounds [0, ${input.entries.length})`,
            );
          }
          targetIndexFromIndex = alloc.entry_index;
        }

        if (hasLedgerEntryId) {
          const idx = input.entries.findIndex(
            (e) => e.id === alloc.ledger_entry_id,
          );
          if (idx === -1) {
            throw new InvalidEntryShapeError(
              `Top-level allocation ledger_entry_id "${alloc.ledger_entry_id}" does not match any entry id in input`,
            );
          }
          targetIndexFromId = idx;
        }

        if (hasEntryIndex && hasLedgerEntryId) {
          if (targetIndexFromIndex !== targetIndexFromId) {
            throw new InvalidEntryShapeError(
              `Top-level allocation selectors conflict: entry_index (${alloc.entry_index}) does not match ledger_entry_id (${alloc.ledger_entry_id} -> index ${targetIndexFromId})`,
            );
          }
        }

        let targetIndex: number;
        if (hasEntryIndex) {
          targetIndex = targetIndexFromIndex!;
        } else if (hasLedgerEntryId) {
          targetIndex = targetIndexFromId!;
        } else {
          targetIndex = 0;
        }

        const list = allAllocationsByEntryIndex.get(targetIndex) ?? [];
        list.push(alloc);
        allAllocationsByEntryIndex.set(targetIndex, list);
      }
    }

    for (const [, allocs] of allAllocationsByEntryIndex) {
      for (const a of allocs) {
        if (typeof a.amount !== 'string') {
          throw new InvalidEntryShapeError(
            'Allocation amount must be a string, received ' + typeof a.amount,
          );
        }
      }
    }

    // Apply strict Phase 3 validation-5 consistency rules per entry
    const finalizedAllocationsByEntryIndex = new Map<number, FlAllocationInput[]>();
    const allFundingSourceIds = new Set<string>();

    for (let i = 0; i < input.entries.length; i++) {
      const entry = input.entries[i];
      const pos = positionsMap.get(entry.position_id)!;
      const positionSourceId = pos.holder_source_of_fund_id ?? null;
      const absCash = flAbs(entry.cash_delta ?? '0');
      const isZeroCash = flIsZero(absCash);
      const explicitAllocs = allAllocationsByEntryIndex.get(i) ?? [];
      if (entry.entry_type === 'cash_movement') {
        if (explicitAllocs.length > 0) {
          throw new AllocationMismatchError(
            'cash_movement entries must carry no funding allocations',
          );
        }
        finalizedAllocationsByEntryIndex.set(i, []);
        continue;
      }

      if (isZeroCash) {
        if (explicitAllocs.length > 0) {
          throw new AllocationMismatchError(
            `Explicit allocation is not allowed on zero-cash entry index ${i}`,
          );
        }
        finalizedAllocationsByEntryIndex.set(i, []);
      } else {
        if (positionSourceId !== null) {
          if (explicitAllocs.length === 0) {
            const defaultAlloc: FlAllocationInput = {
              funding_source_id: positionSourceId,
              amount: absCash,
            };
            finalizedAllocationsByEntryIndex.set(i, [defaultAlloc]);
            allFundingSourceIds.add(positionSourceId);
          } else {
            if (explicitAllocs.length > 1) {
              throw new AllocationSourceMismatchError(
                `Sourced position ${pos.id} (holder_source_of_fund_id: ${positionSourceId}) cannot receive multi-source allocation split at entry index ${i}`,
              );
            }
            const singleAlloc = explicitAllocs[0];
            if (singleAlloc.funding_source_id !== positionSourceId) {
              throw new AllocationSourceMismatchError(
                `Allocation funding source (${singleAlloc.funding_source_id}) does not match position funding source (${positionSourceId}) at entry index ${i}`,
              );
            }
            if (!flGt(singleAlloc.amount, '0')) {
              throw new AllocationMismatchError(
                `Allocation amount must be > 0. Received: ${singleAlloc.amount}`,
              );
            }
            if (!flEq(singleAlloc.amount, absCash)) {
              throw new AllocationSourceMismatchError(
                `Explicit allocation amount (${singleAlloc.amount}) does not match full entry |cash_delta| (${absCash}) on sourced position ${pos.id}`,
              );
            }
            finalizedAllocationsByEntryIndex.set(i, [singleAlloc]);
            allFundingSourceIds.add(singleAlloc.funding_source_id);
          }
        } else {
          if (explicitAllocs.length === 0) {
            finalizedAllocationsByEntryIndex.set(i, []);
          } else {
            for (const a of explicitAllocs) {
              if (!flGt(a.amount, '0')) {
                throw new AllocationMismatchError(
                  `Allocation amount must be > 0. Received: ${a.amount}`,
                );
              }
              allFundingSourceIds.add(a.funding_source_id);
            }
            const allocSum = flSum(explicitAllocs.map((a) => a.amount));
            if (!flEq(allocSum, absCash)) {
              throw new AllocationMismatchError(
                `Allocation sum (${allocSum}) does not match |cash_delta| (${absCash}) for entry index ${i}`,
              );
            }
            finalizedAllocationsByEntryIndex.set(i, explicitAllocs);
          }
        }
      }
    }

    if (allFundingSourceIds.size > 0) {
      const fsList = await this.fundingSourceRepo.findByIds(
        workspaceId,
        Array.from(allFundingSourceIds),
        exec,
      );
      if (fsList.length !== allFundingSourceIds.size) {
        throw new WorkspaceMismatchError(
          `One or more funding sources do not exist in workspace ${workspaceId}`,
        );
      }
    }

    // 5.5. Derive role-based cash legs (RFC §4) and provision cash positions
    const positionsWithFundFlagsMap = new Map<string, PositionWithFundFlags>();
    for (const pos of positions) {
      const holderFund = pos.holder_fund_id
        ? fundsMap.get(pos.holder_fund_id)
        : undefined;
      const instrumentFund = pos.fund_id
        ? fundsMap.get(pos.fund_id)
        : undefined;
      const referencedAsset = pos.asset_id
        ? assetsMap.get(pos.asset_id)
        : undefined;
      positionsWithFundFlagsMap.set(pos.id, {
        id: pos.id,
        holder_investor_id: pos.holder_investor_id,
        holder_fund_id: pos.holder_fund_id,
        fund_id: pos.fund_id,
        asset_id: pos.asset_id,
        holderFundManaged: holderFund?.managed === true,
        instrumentFundManaged: instrumentFund?.managed === true,
      });
    }

    // Resolve proceeds treatment once, before deriving legs and before insert
    const resolvedEntries = input.entries.map((e) => {
      if (
        (PROCEEDS_TREATMENT_ENTRY_TYPES as readonly string[]).includes(
          e.entry_type,
        )
      ) {
        const pos = positionsWithFundFlagsMap.get(e.position_id);
        const holderCandidate: CashHolderCandidate = pos
          ? {
              holder_investor_id: pos.holder_investor_id,
              holder_fund_id: pos.holder_fund_id,
              holderFundManaged: pos.holderFundManaged,
            }
          : null;

        if (isProceedsTreatmentApplicable({ entryType: e.entry_type, holder: holderCandidate })) {
          const res = resolveProceedsTreatment({
            entryType: e.entry_type,
            holder: holderCandidate,
            statedSubType: e.sub_type,
          });
          return {
            ...e,
            sub_type: res.subType,
          };
        } else {
          return {
            ...e,
            sub_type: demoteProceedsTreatment(e.sub_type, e.entry_type),
          };
        }
      }
      return { ...e };
    });

    await this.validateCashOwnership(
      workspaceId,
      resolvedEntries,
      undefined,
      exec,
      { positionsMap, fundsMap },
    );

    const derivedLegs = deriveCashLegs(
      resolvedEntries,
      positionsWithFundFlagsMap,
    );

    await this.validateCashOwnership(
      workspaceId,
      [],
      derivedLegs,
      exec,
      { positionsMap, fundsMap },
    );

    const neededHolderCurrencies = new Map<
      string,
      { holderKind: 'fund'; holderId: string; currency: string }
    >();
    for (const leg of derivedLegs) {
      const key = `fund:${leg.holder_id}:${leg.currency}`;
      if (!neededHolderCurrencies.has(key)) {
        neededHolderCurrencies.set(key, {
          holderKind: 'fund',
          holderId: leg.holder_id,
          currency: leg.currency,
        });
      }
    }
    for (const entry of resolvedEntries) {
      if (entry.entry_type === 'cash_movement') {
        const primaryIdx = entry.primary_entry_index ?? entry.source_entry_index;
        if (primaryIdx !== undefined && primaryIdx !== null) {
          const pos = positionsMap.get(entry.position_id);
          if (pos?.holder_fund_id) {
            const ccy = validateCurrency(entry.currency);
            const key = `fund:${pos.holder_fund_id}:${ccy}`;
            if (!neededHolderCurrencies.has(key)) {
              neededHolderCurrencies.set(key, {
                holderKind: 'fund',
                holderId: pos.holder_fund_id,
                currency: ccy,
              });
            }
          }
        }
      }
    }

    const cashPositionsByHolderAndCurrency = new Map<string, Tables<'fl_positions'>>();
    for (const [key, item] of neededHolderCurrencies.entries()) {
      const cashPos = await this.getOrCreateCashPosition(
        workspaceId,
        { kind: item.holderKind, id: item.holderId },
        item.currency,
        exec,
      );
      cashPositionsByHolderAndCurrency.set(key, cashPos);
    }

    // Verify explicit Form-1 legs point to the canonical cash position
    for (const entry of resolvedEntries) {
      if (entry.entry_type === 'cash_movement') {
        const primaryIdx = entry.primary_entry_index ?? entry.source_entry_index;
        if (primaryIdx !== undefined && primaryIdx !== null) {
          const pos = positionsMap.get(entry.position_id)!;
          if (pos.holder_fund_id) {
            const ccy = validateCurrency(entry.currency);
            const canonicalCashPos = cashPositionsByHolderAndCurrency.get(
              `fund:${pos.holder_fund_id}:${ccy}`,
            );
            if (canonicalCashPos && entry.position_id !== canonicalCashPos.id) {
              throw new InvalidEntryShapeError(
                `Explicit cash_movement leg position "${entry.position_id}" does not match canonical cash position "${canonicalCashPos.id}" for fund "${pos.holder_fund_id}" and currency "${ccy}"`,
              );
            }
          }
        }
      }
    }

    // Prepare and insert ledger entries
    const entryIdMap = new Map<number, string>();
    for (let idx = 0; idx < resolvedEntries.length; idx++) {
      entryIdMap.set(idx, resolvedEntries[idx].id ?? randomUUID());
    }

    const entryInserts: TablesInsert<'fl_ledger_entries'>[] = resolvedEntries.map(
      (e, idx) => {
        const entryId = entryIdMap.get(idx)!;
        const deltas = this.validateEntryDeltas(e);

        let entryDate = e.entry_date ?? input.event_date;
        let currency = validateCurrency(e.currency);
        let dataStatus = e.data_status ?? 'verified';
        let sourceRecordId = e.source_record_id ?? null;
        let sourceLedgerEntryId: string | null = null;

        if (e.entry_type === 'cash_movement') {
          const transientPrimaryIndex = e.primary_entry_index ?? e.source_entry_index;
          if (transientPrimaryIndex !== undefined && transientPrimaryIndex !== null) {
            const primary = resolvedEntries[transientPrimaryIndex];
            if (primary) {
              entryDate = primary.entry_date ?? input.event_date;
              currency = validateCurrency(primary.currency);
              dataStatus = primary.data_status ?? 'verified';
              sourceRecordId = primary.source_record_id ?? null;
              sourceLedgerEntryId = entryIdMap.get(transientPrimaryIndex) ?? null;
            }
          }
        }

        return {
          id: entryId,
          position_id: e.position_id,
          business_event_id: businessEventId,
          entry_date: entryDate,
          entry_type: e.entry_type,
          sub_type: e.sub_type ?? null,
          is_reversal: false,
          commitment_delta: deltas.commitmentDelta,
          quantity_delta: deltas.quantityDelta,
          valuation_delta: deltas.valuationDelta,
          cash_delta: deltas.cashDelta,
          currency,
          fx_rate: e.fx_rate ?? null,
          price_per_unit: e.price_per_unit ? toDecimalString(e.price_per_unit) : null,
          counterparty_position_id: e.counterparty_position_id ?? null,
          data_status: dataStatus,
          source_record_id: sourceRecordId,
          source_ledger_entry_id: sourceLedgerEntryId,
          notes: e.notes ?? null,
          created_by: e.created_by ?? input.created_by ?? null,
        };
      },
    );

    for (const leg of derivedLegs) {
      const primary = resolvedEntries[leg.primary_entry_index];
      const primaryEntryId = entryIdMap.get(leg.primary_entry_index)!;
      const cashPos = cashPositionsByHolderAndCurrency.get(
        `${leg.holder_kind}:${leg.holder_id}:${leg.currency}`,
      )!;

      entryInserts.push({
        id: randomUUID(),
        position_id: cashPos.id,
        business_event_id: businessEventId,
        entry_date: primary.entry_date ?? input.event_date,
        entry_type: 'cash_movement',
        sub_type: null,
        is_reversal: false,
        commitment_delta: '0.00000000',
        quantity_delta: '0.00000000',
        valuation_delta: '0.00000000',
        cash_delta: toDecimalString(leg.cash_delta),
        currency: validateCurrency(primary.currency),
        fx_rate: null,
        price_per_unit: null,
        counterparty_position_id: null,
        data_status: primary.data_status ?? 'verified',
        source_record_id: primary.source_record_id ?? input.source_record_id ?? null,
        source_ledger_entry_id: primaryEntryId,
        notes: null,
        created_by: primary.created_by ?? input.created_by ?? null,
      });
    }

    let insertedEntries: Tables<'fl_ledger_entries'>[];
    try {
      insertedEntries = await this.ledgerRepo.createMany(
        entryInserts,
        exec,
      );
    } catch (err) {
      if (
        err &&
        ((err as { code?: string }).code === '23505' ||
          (typeof (err as { message?: string }).message === 'string' &&
            ((err as { message: string }).message.includes('fl_ledger_entries_source_position_uniq') ||
              (err as { message: string }).message.includes('unique constraint') ||
              (err as { message: string }).message.includes('duplicate key'))))
      ) {
        throw new InvalidEntryShapeError(
          'Duplicate cash_movement leg for source_ledger_entry_id and position',
        );
      }
      throw err;
    }

    // Prepare and insert allocations
    const allocationInserts: TablesInsert<'fl_ledger_entry_funding_allocations'>[] =
      [];
    for (let i = 0; i < input.entries.length; i++) {
      const allocs = finalizedAllocationsByEntryIndex.get(i);
      const ledgerEntryId = entryIdMap.get(i)!;
      if (allocs && allocs.length > 0) {
        for (const a of allocs) {
          allocationInserts.push({
            id: a.id,
            ledger_entry_id: ledgerEntryId,
            funding_source_id: a.funding_source_id,
            amount: toDecimalString(a.amount),
            created_by: a.created_by ?? input.created_by ?? null,
          });
        }
      }
    }

    const insertedAllocations =
      allocationInserts.length > 0
        ? await this.allocationRepo.createMany(allocationInserts, exec)
        : [];

    return {
      entries: insertedEntries,
      allocations: insertedAllocations,
    };
  }

  async postEvent(
    workspaceId: string,
    input: PostEventInput,
    executor?: DbClient,
  ): Promise<{
    event: Tables<'fl_business_events'>;
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }> {
    this.validateEntryInputs(input);

    return this.withExecutor(executor, async (exec) => {
      // Create business event
      const event = await this.eventRepo.create(
        {
          id: input.business_event_id,
          workspace_id: workspaceId,
          event_date: input.event_date,
          description: input.description ?? null,
          status: 'posted',
          source_record_id: input.source_record_id ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );

      const { entries, allocations } = await this.buildAndInsertEntries(
        workspaceId,
        event.id,
        input,
        exec,
      );

      return {
        event,
        entries,
        allocations,
      };
    });
  }

  async reverseEvent(
    workspaceId: string,
    eventId: string,
    options?: ReverseEventOptions,
    executor?: DbClient,
  ): Promise<{
    event: Tables<'fl_business_events'>;
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }> {
    return this.withExecutor(executor, async (exec) => {
      const originalEvent = await this.eventRepo.findById(
        workspaceId,
        eventId,
        exec,
      );
      if (!originalEvent) {
        throw new EntityNotFoundError(
          `Business event ${eventId} not found in workspace ${workspaceId}`,
        );
      }

      if (originalEvent.status === 'reversed') {
        throw new EventAlreadyReversedError(
          `Event ${eventId} has already been reversed`,
        );
      }

      if (
        originalEvent.reversal_of_event_id !== null &&
        originalEvent.reversal_of_event_id !== undefined
      ) {
        throw new CannotReverseReversalError(
          `Cannot reverse event ${eventId} because it is a reversal of event ${originalEvent.reversal_of_event_id}`,
        );
      }

      const originalEntries = await this.ledgerRepo.findByBusinessEventId(
        workspaceId,
        eventId,
        exec,
      );
      if (originalEntries.length === 0) {
        throw new InvalidEntryShapeError(
          `Cannot reverse event ${eventId} because it has no ledger entries`,
        );
      }

      if (originalEntries.some((e) => e.is_reversal)) {
        throw new CannotReverseReversalError(
          `Cannot reverse event ${eventId} because it contains reversal entries`,
        );
      }

      await this.validateCashOwnership(
        workspaceId,
        originalEntries,
        undefined,
        exec,
      );

      const originalEntryIds = originalEntries.map((entry) => entry.id);
      const originalAllocations =
        await this.allocationRepo.findByLedgerEntryIds(
          workspaceId,
          originalEntryIds,
          exec,
        );

      const reversalDate = options?.event_date ?? originalEvent.event_date;
      const reversalDescription =
        options?.description !== undefined && options?.description !== null
          ? options.description
          : originalEvent.description
            ? `Reversal of: ${originalEvent.description}`
            : `Reversal of event ${originalEvent.id}`;

      // Create reversal business event
      const reversalEvent = await this.eventRepo.create(
        {
          id: options?.business_event_id,
          workspace_id: workspaceId,
          event_date: reversalDate,
          description: reversalDescription,
          status: 'posted',
          reversal_of_event_id: originalEvent.id,
          source_record_id: originalEvent.source_record_id,
          created_by: options?.created_by ?? originalEvent.created_by ?? null,
          updated_by: options?.created_by ?? originalEvent.created_by ?? null,
        },
        exec,
      );

      // Mirror entries with negated deltas and is_reversal: true
      const reversalEntryInserts: TablesInsert<'fl_ledger_entries'>[] = [];
      const oldToNewEntryIdMap = new Map<string, string>();
      for (const origEntry of originalEntries) {
        oldToNewEntryIdMap.set(origEntry.id, randomUUID());
      }

      for (const origEntry of originalEntries) {
        const newEntryId = oldToNewEntryIdMap.get(origEntry.id)!;

        const mirroredCommitment = flNeg(origEntry.commitment_delta ?? '0');
        const mirroredQuantity = flNeg(origEntry.quantity_delta ?? '0');
        const mirroredValuation = flNeg(origEntry.valuation_delta ?? '0');
        const mirroredCash = flNeg(origEntry.cash_delta ?? '0');

        this.validateEntryDeltas({
          position_id: origEntry.position_id,
          entry_type: origEntry.entry_type,
          commitment_delta: mirroredCommitment,
          quantity_delta: mirroredQuantity,
          valuation_delta: mirroredValuation,
          cash_delta: mirroredCash,
          currency: origEntry.currency,
          fx_rate: origEntry.fx_rate,
          price_per_unit: origEntry.price_per_unit,
          is_reversal: true,
        });

        reversalEntryInserts.push({
          id: newEntryId,
          position_id: origEntry.position_id,
          business_event_id: reversalEvent.id,
          entry_date: reversalDate,
          entry_type: origEntry.entry_type,
          sub_type: origEntry.sub_type,
          is_reversal: true,
          commitment_delta: mirroredCommitment,
          quantity_delta: mirroredQuantity,
          valuation_delta: mirroredValuation,
          cash_delta: mirroredCash,
          currency: origEntry.currency,
          fx_rate: origEntry.fx_rate,
          price_per_unit: origEntry.price_per_unit,
          counterparty_position_id: origEntry.counterparty_position_id,
          data_status: origEntry.data_status,
          source_record_id: origEntry.source_record_id,
          source_ledger_entry_id: origEntry.source_ledger_entry_id
            ? oldToNewEntryIdMap.get(origEntry.source_ledger_entry_id) ?? null
            : null,
          notes: origEntry.notes,
          created_by: options?.created_by ?? originalEvent.created_by ?? null,
        });
      }

      // Check transfer netting on reversal entries
      const commitmentTransfers = reversalEntryInserts.filter(
        (e) => e.entry_type === 'commitment_transfer',
      );
      if (commitmentTransfers.length > 0) {
        const byCurrency = new Map<string, typeof commitmentTransfers>();
        for (const ct of commitmentTransfers) {
          const curr = ct.currency.trim().toUpperCase();
          const list = byCurrency.get(curr) ?? [];
          list.push(ct);
          byCurrency.set(curr, list);
        }
        for (const [curr, legs] of byCurrency.entries()) {
          const commitmentNet = flSum(legs.map((l) => l.commitment_delta));
          if (!flIsZero(commitmentNet)) {
            throw new UnbalancedTransferError(
              `commitment_transfer legs do not net to zero for currency ${curr}. Net: ${commitmentNet}`,
            );
          }
          const hasCash = legs.some((l) => !flIsZero(l.cash_delta ?? '0'));
          if (hasCash) {
            const cashNet = flSum(legs.map((l) => l.cash_delta));
            if (!flIsZero(cashNet)) {
              throw new UnbalancedTransferError(
                `commitment_transfer cash deltas do not net to zero for currency ${curr}. Net: ${cashNet}`,
              );
            }
          }
        }
      }

      const unitTransfers = reversalEntryInserts.filter(
        (e) => e.entry_type === 'unit_transfer',
      );
      if (unitTransfers.length > 0) {
        const byCurrency = new Map<string, typeof unitTransfers>();
        for (const ut of unitTransfers) {
          const curr = ut.currency.trim().toUpperCase();
          const list = byCurrency.get(curr) ?? [];
          list.push(ut);
          byCurrency.set(curr, list);
        }
        for (const [curr, legs] of byCurrency.entries()) {
          const quantityNet = flSum(legs.map((l) => l.quantity_delta));
          if (!flIsZero(quantityNet)) {
            throw new UnbalancedTransferError(
              `unit_transfer legs do not net to zero for currency ${curr}. Net: ${quantityNet}`,
            );
          }
          const hasCash = legs.some((l) => !flIsZero(l.cash_delta ?? '0'));
          if (hasCash) {
            const cashNet = flSum(legs.map((l) => l.cash_delta));
            if (!flIsZero(cashNet)) {
              throw new UnbalancedTransferError(
                `unit_transfer cash deltas do not net to zero for currency ${curr}. Net: ${cashNet}`,
              );
            }
          }
        }
      }

      const insertedEntries = await this.ledgerRepo.createMany(
        reversalEntryInserts,
        exec,
      );

      // Mirror funding allocations
      const reversalAllocationInserts: TablesInsert<'fl_ledger_entry_funding_allocations'>[] =
        [];
      for (const origAlloc of originalAllocations) {
        const newLedgerEntryId = oldToNewEntryIdMap.get(
          origAlloc.ledger_entry_id,
        );
        if (newLedgerEntryId) {
          reversalAllocationInserts.push({
            id: randomUUID(),
            ledger_entry_id: newLedgerEntryId,
            funding_source_id: origAlloc.funding_source_id,
            amount: origAlloc.amount,
            created_by: options?.created_by ?? originalEvent.created_by ?? null,
          });
        }
      }

      const insertedAllocations =
        reversalAllocationInserts.length > 0
          ? await this.allocationRepo.createMany(
              reversalAllocationInserts,
              exec,
            )
          : [];

      // Mark original event as reversed
      await this.eventRepo.markReversed(workspaceId, eventId, exec);

      return {
        event: reversalEvent,
        entries: insertedEntries,
        allocations: insertedAllocations,
      };
    });
  }

  async deleteEvent(
    workspaceId: string,
    eventId: string,
    executor?: DbClient,
  ): Promise<{
    event: Tables<'fl_business_events'>;
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }> {
    return this.withExecutor(executor, async (exec) => {
      const originalEvent = await this.eventRepo.findById(
        workspaceId,
        eventId,
        exec,
      );
      if (!originalEvent) {
        throw new EntityNotFoundError(
          `Business event ${eventId} not found in workspace ${workspaceId}`,
        );
      }

      if (
        originalEvent.status === 'posted' ||
        originalEvent.status === 'reversed'
      ) {
        throw new CannotDeletePostedEventError(
          `Hard deletion is retired for posted ledger events (event: ${eventId}, status: ${originalEvent.status}). Use reverseEvent instead.`,
        );
      }

      const originalEntries = await this.ledgerRepo.findByBusinessEventId(
        workspaceId,
        eventId,
        exec,
      );
      const originalEntryIds = originalEntries.map((entry) => entry.id);
      const originalAllocations =
        await this.allocationRepo.findByLedgerEntryIds(
          workspaceId,
          originalEntryIds,
          exec,
        );

      await this.allocationRepo.deleteByLedgerEntryIds(originalEntryIds, exec);
      await this.ledgerRepo.deleteByBusinessEventId(workspaceId, eventId, exec);
      await this.eventRepo.delete(workspaceId, eventId, exec);

      return {
        event: originalEvent,
        entries: originalEntries,
        allocations: originalAllocations,
      };
    });
  }

  async updateEvent(
    workspaceId: string,
    eventId: string,
    input: PostEventInput,
    options?: { updated_by?: string | null },
    executor?: DbClient,
  ): Promise<{
    event: Tables<'fl_business_events'>;
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }> {
    this.validateEntryInputs(input);

    return this.withExecutor(executor, async (exec) => {
      // 1. Load the event; throw EntityNotFoundError if absent
      const originalEvent = await this.eventRepo.findById(
        workspaceId,
        eventId,
        exec,
      );
      if (!originalEvent) {
        throw new EntityNotFoundError(
          `Business event ${eventId} not found in workspace ${workspaceId}`,
        );
      }

      // 2. Refuse when the event is on either side of an existing reversal pair
      if (originalEvent.status === 'reversed') {
        throw new EventAlreadyReversedError(
          `Event ${eventId} has been reversed. The later corrected event is the live one to edit.`,
        );
      }

      if (
        originalEvent.reversal_of_event_id !== null &&
        originalEvent.reversal_of_event_id !== undefined
      ) {
        throw new CannotReverseReversalError(
          `A reversal event cannot be edited: event ${eventId} is a reversal of event ${originalEvent.reversal_of_event_id}`,
        );
      }

      const originalEntries = await this.ledgerRepo.findByBusinessEventId(
        workspaceId,
        eventId,
        exec,
      );

      if (originalEntries.some((e) => e.is_reversal)) {
        throw new CannotReverseReversalError(
          `A reversal event cannot be edited: event ${eventId} contains reversal entries`,
        );
      }

      await this.validateCashOwnership(
        workspaceId,
        originalEntries,
        undefined,
        exec,
      );

      const originalEntryIds = originalEntries.map((e) => e.id);
      const originalAllocations =
        originalEntryIds.length > 0
          ? await this.allocationRepo.findByLedgerEntryIds(
              workspaceId,
              originalEntryIds,
              exec,
            )
          : [];

      // 3. Snapshot the CURRENT state before changing anything
      const nextRevNo = await this.revisionRepo.nextRevisionNo(
        workspaceId,
        eventId,
        exec,
      );

      await this.revisionRepo.create(
        {
          workspace_id: workspaceId,
          business_event_id: eventId,
          revision_no: nextRevNo,
          snapshot: {
            event: originalEvent,
            entries: originalEntries,
            allocations: originalAllocations,
          },
          changed_by: options?.updated_by ?? null,
        },
        exec,
      );

      // 4. Delete the event's allocations then its entries (do NOT delete fl_business_events)
      if (originalEntryIds.length > 0) {
        await this.allocationRepo.deleteByLedgerEntryIds(originalEntryIds, exec);
      }
      await this.ledgerRepo.deleteByBusinessEventId(workspaceId, eventId, exec);

      // 5. Re-post the replacement entries under the same business_event_id
      const { entries, allocations } = await this.buildAndInsertEntries(
        workspaceId,
        eventId,
        input,
        exec,
      );

      // 6. Update the fl_business_events row in place
      const updatedEvent = await this.eventRepo.update(
        workspaceId,
        eventId,
        {
          event_date: input.event_date,
          description: input.description ?? null,
          source_record_id: input.source_record_id ?? null,
          updated_by: options?.updated_by ?? null,
        },
        exec,
      );

      if (!updatedEvent) {
        throw new EntityNotFoundError(
          `Business event ${eventId} not found in workspace ${workspaceId}`,
        );
      }

      // 7. Return the updated event, entries, and allocations
      return {
        event: updatedEvent,
        entries,
        allocations,
      };
    });
  }

  async replaceEvent(
    workspaceId: string,
    eventId: string,
    replacement: PostEventInput,
    options?: {
      reversal_business_event_id?: string;
      reversal_event_date?: string;
      reversal_description?: string | null;
      corrected_business_event_id?: string;
    },
    executor?: DbClient,
  ): Promise<{
    event: Tables<'fl_business_events'>;
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }> {
    return this.withExecutor(executor, async (exec) => {
      // 1. Reverse the original event atomically
      await this.reverseEvent(
        workspaceId,
        eventId,
        {
          business_event_id: options?.reversal_business_event_id,
          event_date: options?.reversal_event_date,
          description:
            options?.reversal_description ??
            `Reversal of event ${eventId} prior to replacement`,
        },
        exec,
      );

      // 2. Post the corrected event under a NEW event ID (never reuse original eventId)
      let correctedEventId = options?.corrected_business_event_id;
      if (
        !correctedEventId &&
        replacement.business_event_id &&
        replacement.business_event_id !== eventId
      ) {
        correctedEventId = replacement.business_event_id;
      }

      return this.postEvent(
        workspaceId,
        {
          ...replacement,
          business_event_id: correctedEventId,
        },
        exec,
      );
    });
  }

  // ===== Convenience Wrappers =====

  async recordCommitment(
    workspaceId: string,
    input: RecordCommitmentInput,
    executor?: DbClient,
  ) {
    if (typeof input.amount !== 'string') {
      throw new InvalidEntryShapeError('amount must be a string');
    }
    const amountStr = toDecimalString(input.amount);
    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Commitment of ${amountStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'commitment',
            sub_type: input.subType,
            commitment_delta: amountStr,
            quantity_delta: '0',
            cash_delta: '0',
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordPaidIn(
    workspaceId: string,
    input: RecordPaidInInput,
    executor?: DbClient,
  ) {
    if (typeof input.cashAmount !== 'string') {
      throw new InvalidEntryShapeError('cashAmount must be a string');
    }
    if (
      input.unitsIssued !== undefined &&
      input.unitsIssued !== null &&
      typeof input.unitsIssued !== 'string'
    ) {
      throw new InvalidEntryShapeError('unitsIssued must be a string');
    }
    const cashStr = toDecimalString(input.cashAmount);
    const negativeCash = flNeg(flAbs(cashStr));
    const quantityStr = input.unitsIssued ? toDecimalString(input.unitsIssued) : '0';

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Capital call contribution of ${cashStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'paid_in',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: quantityStr,
            cash_delta: negativeCash,
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
            allocations: input.allocations?.map((a) => ({
              funding_source_id: a.fundingSourceId,
              amount: a.amount,
            })),
          },
        ],
      },
      executor,
    );
  }

  async recordDistribution(
    workspaceId: string,
    input: RecordDistributionInput,
    executor?: DbClient,
  ) {
    if (typeof input.amount !== 'string') {
      throw new InvalidEntryShapeError('amount must be a string');
    }
    const amountStr = toDecimalString(flAbs(input.amount));
    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Distribution of ${amountStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'distribution',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: '0',
            cash_delta: amountStr,
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordRedemption(
    workspaceId: string,
    input: RecordRedemptionInput,
    executor?: DbClient,
  ) {
    if (typeof input.cashAmount !== 'string') {
      throw new InvalidEntryShapeError('cashAmount must be a string');
    }
    if (typeof input.unitsRedeemed !== 'string') {
      throw new InvalidEntryShapeError('unitsRedeemed must be a string');
    }
    const cashStr = toDecimalString(flAbs(input.cashAmount));
    const unitsStr = flNeg(flAbs(input.unitsRedeemed));

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Redemption of ${unitsStr} units for ${cashStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'redemption',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: unitsStr,
            cash_delta: cashStr,
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordBuy(
    workspaceId: string,
    input: RecordBuyInput,
    executor?: DbClient,
  ) {
    if (typeof input.cashAmount !== 'string') {
      throw new InvalidEntryShapeError('cashAmount must be a string');
    }
    if (
      input.quantity !== undefined &&
      input.quantity !== null &&
      typeof input.quantity !== 'string'
    ) {
      throw new InvalidEntryShapeError('quantity must be a string');
    }
    if (
      input.pricePerUnit !== undefined &&
      input.pricePerUnit !== null &&
      typeof input.pricePerUnit !== 'string'
    ) {
      throw new InvalidEntryShapeError('pricePerUnit must be a string');
    }
    const cashStr = toDecimalString(flAbs(input.cashAmount));
    const negativeCash = flNeg(cashStr);
    const quantityStr = input.quantity ? toDecimalString(flAbs(input.quantity)) : '0';

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Asset investment of ${cashStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'buy',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: quantityStr,
            cash_delta: negativeCash,
            currency: input.currency,
            price_per_unit: input.pricePerUnit,
            notes: input.notes,
            created_by: input.createdBy,
            allocations: input.allocations?.map((a) => ({
              funding_source_id: a.fundingSourceId,
              amount: a.amount,
            })),
          },
        ],
      },
      executor,
    );
  }

  async recordSell(
    workspaceId: string,
    input: RecordSellInput,
    executor?: DbClient,
  ) {
    if (typeof input.cashAmount !== 'string') {
      throw new InvalidEntryShapeError('cashAmount must be a string');
    }
    if (
      input.quantity !== undefined &&
      input.quantity !== null &&
      typeof input.quantity !== 'string'
    ) {
      throw new InvalidEntryShapeError('quantity must be a string');
    }
    if (
      input.pricePerUnit !== undefined &&
      input.pricePerUnit !== null &&
      typeof input.pricePerUnit !== 'string'
    ) {
      throw new InvalidEntryShapeError('pricePerUnit must be a string');
    }
    const cashStr = toDecimalString(flAbs(input.cashAmount));
    const quantityStr = input.quantity ? flNeg(flAbs(input.quantity)) : '0';

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Asset divestment of ${quantityStr} units for ${cashStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'sell',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: quantityStr,
            cash_delta: cashStr,
            currency: input.currency,
            price_per_unit: input.pricePerUnit,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordCommitmentTransfer(
    workspaceId: string,
    input: RecordCommitmentTransferInput,
    executor?: DbClient,
  ) {
    if (typeof input.amount !== 'string') {
      throw new InvalidEntryShapeError('amount must be a string');
    }
    if (
      input.cashConsideration !== undefined &&
      input.cashConsideration !== null &&
      typeof input.cashConsideration !== 'string'
    ) {
      throw new InvalidEntryShapeError('cashConsideration must be a string');
    }
    const amountStr = toDecimalString(flAbs(input.amount));
    const cashStr = input.cashConsideration
      ? toDecimalString(flAbs(input.cashConsideration))
      : '0';

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Commitment transfer of ${amountStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            position_id: input.fromPositionId,
            counterparty_position_id: input.toPositionId,
            entry_type: 'commitment_transfer',
            sub_type: input.subType,
            commitment_delta: flNeg(amountStr),
            quantity_delta: '0',
            cash_delta: cashStr,
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
          {
            position_id: input.toPositionId,
            counterparty_position_id: input.fromPositionId,
            entry_type: 'commitment_transfer',
            sub_type: input.subType,
            commitment_delta: amountStr,
            quantity_delta: '0',
            cash_delta: flNeg(cashStr),
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordUnitTransfer(
    workspaceId: string,
    input: RecordUnitTransferInput,
    executor?: DbClient,
  ) {
    if (typeof input.units !== 'string') {
      throw new InvalidEntryShapeError('units must be a string');
    }
    if (
      input.cashConsideration !== undefined &&
      input.cashConsideration !== null &&
      typeof input.cashConsideration !== 'string'
    ) {
      throw new InvalidEntryShapeError('cashConsideration must be a string');
    }
    const unitsStr = toDecimalString(flAbs(input.units));
    const cashStr = input.cashConsideration
      ? toDecimalString(flAbs(input.cashConsideration))
      : '0';

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Unit transfer of ${unitsStr} units in ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            position_id: input.fromPositionId,
            counterparty_position_id: input.toPositionId,
            entry_type: 'unit_transfer',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: flNeg(unitsStr),
            cash_delta: cashStr,
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
          {
            position_id: input.toPositionId,
            counterparty_position_id: input.fromPositionId,
            entry_type: 'unit_transfer',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: unitsStr,
            cash_delta: flNeg(cashStr),
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordIncome(
    workspaceId: string,
    input: RecordIncomeInput,
    executor?: DbClient,
  ) {
    if (typeof input.amount !== 'string') {
      throw new InvalidEntryShapeError('amount must be a string');
    }
    const amountStr = toDecimalString(flAbs(input.amount));
    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Income of ${amountStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'income',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: '0',
            cash_delta: amountStr,
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordExpense(
    workspaceId: string,
    input: RecordExpenseInput,
    executor?: DbClient,
  ) {
    if (typeof input.amount !== 'string') {
      throw new InvalidEntryShapeError('amount must be a string');
    }
    const amountStr = toDecimalString(flAbs(input.amount));
    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: `Expense of ${amountStr} ${input.currency}`,
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'expense',
            sub_type: input.subType,
            commitment_delta: '0',
            quantity_delta: '0',
            cash_delta: flNeg(amountStr),
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  async recordAdjustment(
    workspaceId: string,
    input: RecordAdjustmentInput,
    executor?: DbClient,
  ) {
    if (
      input.commitmentDelta !== undefined &&
      input.commitmentDelta !== null &&
      typeof input.commitmentDelta !== 'string'
    ) {
      throw new InvalidEntryShapeError('commitmentDelta must be a string');
    }
    if (
      input.quantityDelta !== undefined &&
      input.quantityDelta !== null &&
      typeof input.quantityDelta !== 'string'
    ) {
      throw new InvalidEntryShapeError('quantityDelta must be a string');
    }
    if (
      input.valuationDelta !== undefined &&
      input.valuationDelta !== null &&
      typeof input.valuationDelta !== 'string'
    ) {
      throw new InvalidEntryShapeError('valuationDelta must be a string');
    }
    const c = input.commitmentDelta ? toDecimalString(input.commitmentDelta) : '0';
    const q = input.quantityDelta ? toDecimalString(input.quantityDelta) : '0';
    const v = input.valuationDelta ? toDecimalString(input.valuationDelta) : '0';

    return this.postEvent(
      workspaceId,
      {
        business_event_id: input.businessEventId,
        event_date: input.date,
        description: 'Adjustment',
        created_by: input.createdBy,
        entries: [
          {
            id: input.id,
            position_id: input.positionId,
            entry_type: 'adjustment',
            sub_type: input.subType,
            commitment_delta: c,
            quantity_delta: q,
            valuation_delta: v,
            cash_delta: '0',
            currency: input.currency,
            notes: input.notes,
            created_by: input.createdBy,
          },
        ],
      },
      executor,
    );
  }

  // ===== Read methods =====

  async listEntriesByPositionIds(
    workspaceId: string,
    positionIds: string[],
    pagination?: FlLedgerEntryPagination,
    executor?: DbClient,
  ): Promise<{ entries: Tables<'fl_ledger_entries'>[]; total: number }> {
    const entries = await this.ledgerRepo.findByPositionIds(
      workspaceId,
      positionIds,
      pagination,
      executor,
    );
    const total = await this.ledgerRepo.countByPositionIds(
      workspaceId,
      positionIds,
      executor,
    );
    return { entries, total };
  }

  async getEventById(
    workspaceId: string,
    eventId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_events'> | undefined> {
    return this.eventRepo.findById(workspaceId, eventId, executor);
  }

  async getEntriesByEventId(
    workspaceId: string,
    eventId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entries'>[]> {
    return this.ledgerRepo.findByBusinessEventId(
      workspaceId,
      eventId,
      executor,
    );
  }

  async getAllocationsByEntryIds(
    workspaceId: string,
    entryIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>[]> {
    return this.allocationRepo.findByLedgerEntryIds(
      workspaceId,
      entryIds,
      executor,
    );
  }
}
