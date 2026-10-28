import type {
  DbClient,
  FlAssetRepository,
  FlFundRepository,
  FlPositionRepository,
  FlSourceRecordRepository,
  FlValuationRepository,
  FlValuationTarget,
  Tables,
} from '@/lib/repositories';
import { validateCurrency } from './flCurrency';
import { toDecimalString } from './flDecimal';
import {
  EntityNotFoundError,
  InvalidEntryShapeError,
  InvalidValuationTargetError,
  WorkspaceMismatchError,
} from './flErrors';
import { queryAll } from '@/lib/server/queryAll';

export type FlValuationMethod =
  | 'at_cost'
  | 'fundraise_round'
  | 'secondary_sale'
  | 'listed_price'
  | 'comparables'
  | 'capital_account_statement'
  | 'appraisal'
  | 'other';

export interface RecordValuationInput {
  id?: string;
  asset_id?: string | null;
  fund_id?: string | null;
  position_id?: string | null;
  as_of_date: string;
  valuation_method?: FlValuationMethod | null;
  currency?: string;
  market_value?: string | null;
  price_per_unit?: string | null;
  units_outstanding?: string | null;
  gross_value?: string | null;
  net_value?: string | null;
  data_status?: 'verified' | 'needs_verification';
  source_record_id?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

export interface UpdateValuationInput {
  asset_id?: string | null;
  fund_id?: string | null;
  position_id?: string | null;
  as_of_date?: string;
  valuation_method?: FlValuationMethod | null;
  currency?: string;
  market_value?: string | null;
  price_per_unit?: string | null;
  units_outstanding?: string | null;
  gross_value?: string | null;
  net_value?: string | null;
  data_status?: 'verified' | 'needs_verification';
  source_record_id?: string | null;
  notes?: string | null;
}

export interface ValuationTargetsInput {
  assetIds?: string[];
  fundIds?: string[];
  positionIds?: string[];
}

export class FlValuationService {
  constructor(
    private readonly db: DbClient,
    private readonly valuationRepo: FlValuationRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly fundRepo: FlFundRepository,
    private readonly positionRepo: FlPositionRepository,
    private readonly sourceRecordRepo: FlSourceRecordRepository,
  ) {}

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

  async record(
    workspaceId: string,
    input: RecordValuationInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>> {
    const targetCount =
      (input.asset_id ? 1 : 0) +
      (input.fund_id ? 1 : 0) +
      (input.position_id ? 1 : 0);

    if (targetCount !== 1) {
      throw new InvalidValuationTargetError(
        'Valuation must target exactly one of asset_id, fund_id, or position_id.',
      );
    }

    const currency = validateCurrency(input.currency ?? 'USD');

    if (
      input.market_value !== undefined &&
      input.market_value !== null &&
      typeof input.market_value !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'market_value must be a string, received ' + typeof input.market_value,
      );
    }
    if (
      input.price_per_unit !== undefined &&
      input.price_per_unit !== null &&
      typeof input.price_per_unit !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'price_per_unit must be a string, received ' +
          typeof input.price_per_unit,
      );
    }
    if (
      input.units_outstanding !== undefined &&
      input.units_outstanding !== null &&
      typeof input.units_outstanding !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'units_outstanding must be a string, received ' +
          typeof input.units_outstanding,
      );
    }
    if (
      input.gross_value !== undefined &&
      input.gross_value !== null &&
      typeof input.gross_value !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'gross_value must be a string, received ' + typeof input.gross_value,
      );
    }
    if (
      input.net_value !== undefined &&
      input.net_value !== null &&
      typeof input.net_value !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'net_value must be a string, received ' + typeof input.net_value,
      );
    }

    return this.withExecutor(executor, async (exec) => {
      if (input.asset_id) {
        const asset = await this.assetRepo.findById(
          workspaceId,
          input.asset_id,
          exec,
        );
        if (!asset) {
          throw new WorkspaceMismatchError(
            `Asset ${input.asset_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      if (input.fund_id) {
        const fund = await this.fundRepo.findById(
          workspaceId,
          input.fund_id,
          exec,
        );
        if (!fund) {
          throw new WorkspaceMismatchError(
            `Fund ${input.fund_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      if (input.position_id) {
        const position = await this.positionRepo.findById(
          workspaceId,
          input.position_id,
          exec,
        );
        if (!position) {
          throw new WorkspaceMismatchError(
            `Position ${input.position_id} does not exist in workspace ${workspaceId}`,
          );
        }
        if (position.opened_at && input.as_of_date < position.opened_at) {
          throw new InvalidEntryShapeError(
            `Valuation as_of_date (${input.as_of_date}) cannot be before position opened_at (${position.opened_at})`,
          );
        }
      }

      if (input.source_record_id) {
        const src = await this.sourceRecordRepo.findById(
          workspaceId,
          input.source_record_id,
          exec,
        );
        if (!src) {
          throw new WorkspaceMismatchError(
            `Source record ${input.source_record_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      return this.valuationRepo.create(
        {
          id: input.id,
          asset_id: input.asset_id ?? null,
          fund_id: input.fund_id ?? null,
          position_id: input.position_id ?? null,
          as_of_date: input.as_of_date,
          valuation_method: input.valuation_method ?? null,
          currency,
          market_value:
            input.market_value !== undefined && input.market_value !== null
              ? toDecimalString(input.market_value)
              : null,
          price_per_unit:
            input.price_per_unit !== undefined && input.price_per_unit !== null
              ? toDecimalString(input.price_per_unit)
              : null,
          units_outstanding:
            input.units_outstanding !== undefined &&
            input.units_outstanding !== null
              ? toDecimalString(input.units_outstanding)
              : null,
          gross_value:
            input.gross_value !== undefined && input.gross_value !== null
              ? toDecimalString(input.gross_value)
              : null,
          net_value:
            input.net_value !== undefined && input.net_value !== null
              ? toDecimalString(input.net_value)
              : null,
          data_status: input.data_status ?? 'verified',
          source_record_id: input.source_record_id ?? null,
          notes: input.notes ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getSeries(
    workspaceId: string,
    target: FlValuationTarget,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>[]> {
    return this.valuationRepo.findSeriesByTarget(workspaceId, target, executor);
  }

  async getLatestForTargets(
    workspaceId: string,
    targets: ValuationTargetsInput,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<{
    assets: Tables<'fl_valuations'>[];
    funds: Tables<'fl_valuations'>[];
    positions: Tables<'fl_valuations'>[];
  }> {
    const [assets, funds, positions] = await queryAll(executor, [
      () => targets.assetIds && targets.assetIds.length > 0
        ? this.valuationRepo.findLatestByAssetIds(
            workspaceId,
            targets.assetIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
      () => targets.fundIds && targets.fundIds.length > 0
        ? this.valuationRepo.findLatestByFundIds(
            workspaceId,
            targets.fundIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
      () => targets.positionIds && targets.positionIds.length > 0
        ? this.valuationRepo.findLatestByPositionIds(
            workspaceId,
            targets.positionIds,
            asOfDate,
            executor,
          )
        : Promise.resolve([]),
    ]);

    return { assets, funds, positions };
  }

  async getLatestForAsset(
    workspaceId: string,
    assetId: string,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'> | undefined> {
    const rows = await this.valuationRepo.findLatestByAssetIds(
      workspaceId,
      [assetId],
      asOfDate,
      executor,
    );
    return rows[0];
  }

  async getLatestForFund(
    workspaceId: string,
    fundId: string,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'> | undefined> {
    const rows = await this.valuationRepo.findLatestByFundIds(
      workspaceId,
      [fundId],
      asOfDate,
      executor,
    );
    return rows[0];
  }

  async getLatestForPosition(
    workspaceId: string,
    positionId: string,
    asOfDate?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'> | undefined> {
    const rows = await this.valuationRepo.findLatestByPositionIds(
      workspaceId,
      [positionId],
      asOfDate,
      executor,
    );
    return rows[0];
  }

  async getValuationById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'> | undefined> {
    return this.valuationRepo.findById(workspaceId, id, executor);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateValuationInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_valuations'>> {
    if (
      input.market_value !== undefined &&
      input.market_value !== null &&
      typeof input.market_value !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'market_value must be a string, received ' + typeof input.market_value,
      );
    }
    if (
      input.price_per_unit !== undefined &&
      input.price_per_unit !== null &&
      typeof input.price_per_unit !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'price_per_unit must be a string, received ' +
          typeof input.price_per_unit,
      );
    }
    if (
      input.units_outstanding !== undefined &&
      input.units_outstanding !== null &&
      typeof input.units_outstanding !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'units_outstanding must be a string, received ' +
          typeof input.units_outstanding,
      );
    }
    if (
      input.gross_value !== undefined &&
      input.gross_value !== null &&
      typeof input.gross_value !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'gross_value must be a string, received ' + typeof input.gross_value,
      );
    }
    if (
      input.net_value !== undefined &&
      input.net_value !== null &&
      typeof input.net_value !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'net_value must be a string, received ' + typeof input.net_value,
      );
    }

    return this.withExecutor(executor, async (exec) => {
      const existing = await this.valuationRepo.findById(
        workspaceId,
        id,
        exec,
      );
      if (!existing) {
        throw new EntityNotFoundError(
          `Valuation ${id} not found in workspace ${workspaceId}`,
        );
      }

      const effectiveAssetId =
        input.asset_id !== undefined ? input.asset_id : existing.asset_id;
      const effectiveFundId =
        input.fund_id !== undefined ? input.fund_id : existing.fund_id;
      const effectivePositionId =
        input.position_id !== undefined
          ? input.position_id
          : existing.position_id;

      const targetCount =
        (effectiveAssetId ? 1 : 0) +
        (effectiveFundId ? 1 : 0) +
        (effectivePositionId ? 1 : 0);

      if (targetCount !== 1) {
        throw new InvalidValuationTargetError(
          'Valuation must target exactly one of asset_id, fund_id, or position_id.',
        );
      }

      if (input.asset_id) {
        const asset = await this.assetRepo.findById(
          workspaceId,
          input.asset_id,
          exec,
        );
        if (!asset) {
          throw new WorkspaceMismatchError(
            `Asset ${input.asset_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      if (input.fund_id) {
        const fund = await this.fundRepo.findById(
          workspaceId,
          input.fund_id,
          exec,
        );
        if (!fund) {
          throw new WorkspaceMismatchError(
            `Fund ${input.fund_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      if (effectivePositionId && (input.position_id !== undefined || input.as_of_date !== undefined)) {
        const position = await this.positionRepo.findById(
          workspaceId,
          effectivePositionId,
          exec,
        );
        if (!position) {
          throw new WorkspaceMismatchError(
            `Position ${effectivePositionId} does not exist in workspace ${workspaceId}`,
          );
        }
        const effectiveDate = input.as_of_date ?? existing.as_of_date;
        if (position.opened_at && effectiveDate < position.opened_at) {
          throw new InvalidEntryShapeError(
            `Valuation as_of_date (${effectiveDate}) cannot be before position opened_at (${position.opened_at})`,
          );
        }
      } else if (input.position_id) {
        const position = await this.positionRepo.findById(
          workspaceId,
          input.position_id,
          exec,
        );
        if (!position) {
          throw new WorkspaceMismatchError(
            `Position ${input.position_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      if (input.source_record_id) {
        const src = await this.sourceRecordRepo.findById(
          workspaceId,
          input.source_record_id,
          exec,
        );
        if (!src) {
          throw new WorkspaceMismatchError(
            `Source record ${input.source_record_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      const updates: Partial<Tables<'fl_valuations'>> = {};
      if (input.asset_id !== undefined) updates.asset_id = input.asset_id;
      if (input.fund_id !== undefined) updates.fund_id = input.fund_id;
      if (input.position_id !== undefined)
        updates.position_id = input.position_id;
      if (input.as_of_date !== undefined)
        updates.as_of_date = input.as_of_date;
      if (input.valuation_method !== undefined)
        updates.valuation_method = input.valuation_method;
      if (input.currency !== undefined)
        updates.currency = validateCurrency(input.currency);
      if (input.market_value !== undefined)
        updates.market_value =
          input.market_value !== null
            ? toDecimalString(input.market_value)
            : null;
      if (input.price_per_unit !== undefined)
        updates.price_per_unit =
          input.price_per_unit !== null
            ? toDecimalString(input.price_per_unit)
            : null;
      if (input.units_outstanding !== undefined)
        updates.units_outstanding =
          input.units_outstanding !== null
            ? toDecimalString(input.units_outstanding)
            : null;
      if (input.gross_value !== undefined)
        updates.gross_value =
          input.gross_value !== null
            ? toDecimalString(input.gross_value)
            : null;
      if (input.net_value !== undefined)
        updates.net_value =
          input.net_value !== null ? toDecimalString(input.net_value) : null;
      if (input.data_status !== undefined)
        updates.data_status = input.data_status;
      if (input.source_record_id !== undefined)
        updates.source_record_id = input.source_record_id;
      if (input.notes !== undefined) updates.notes = input.notes;

      const updated = await this.valuationRepo.update(id, updates, exec);
      if (!updated) {
        throw new EntityNotFoundError(
          `Valuation ${id} could not be updated`,
        );
      }
      return updated;
    });
  }

  async delete(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.valuationRepo.findById(
        workspaceId,
        id,
        exec,
      );
      if (!existing) {
        throw new EntityNotFoundError(
          `Valuation ${id} not found in workspace ${workspaceId}`,
        );
      }
      await this.valuationRepo.delete(id, exec);
    });
  }
}
