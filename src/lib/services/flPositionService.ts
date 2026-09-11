import type {
  DbClient,
  FlAssetRepository,
  FlFundingSourceRepository,
  FlFundRepository,
  FlInvestorRepository,
  FlLedgerEntryRepository,
  FlPositionNaturalKey,
  FlPositionRepository,
  Tables,
} from '@/lib/repositories';
import { flAdd, flGt, flIsZero, flSub } from './flDecimal';
import { validateCurrency } from './flCurrency';
import {
  FlMasterDataService,
  isUniqueViolationOrDuplicateError,
} from './flMasterDataService';
import {
  DuplicatePositionError,
  EntityNotFoundError,
  InvalidPositionShapeError,
  PositionNotSettledError,
  WorkspaceMismatchError,
} from './flErrors';
import { assertEligibleCashHolder } from '@/lib/fundLedger/cashOwnership';

export interface OpenPositionInput {
  id?: string;
  holder_investor_id?: string | null;
  holder_fund_id?: string | null;
  fund_id?: string | null;
  asset_id?: string | null;
  holder_source_of_fund_id?: string | null;
  opened_at?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

export interface ListPositionsFilter {
  fundId?: string;
  holderInvestorId?: string;
  holderFundId?: string;
  assetId?: string;
  holderSourceOfFundId?: string | null;
}

export type CashPositionHolder = { kind: 'fund'; id: string };

export class FlPositionService {
  private readonly masterDataService: FlMasterDataService;

  constructor(
    private readonly db: DbClient,
    private readonly positionRepo: FlPositionRepository,
    private readonly investorRepo: FlInvestorRepository,
    private readonly fundRepo: FlFundRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly ledgerRepo: FlLedgerEntryRepository,
    private readonly fundingSourceRepo?: FlFundingSourceRepository,
    masterDataService?: FlMasterDataService,
  ) {
    this.masterDataService =
      masterDataService ??
      new FlMasterDataService(
        db,
        investorRepo,
        fundRepo,
        assetRepo,
        fundingSourceRepo,
      );
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

  private validatePositionShape(input: OpenPositionInput): void {
    const holderCount =
      (input.holder_investor_id ? 1 : 0) + (input.holder_fund_id ? 1 : 0);
    if (holderCount !== 1) {
      throw new InvalidPositionShapeError(
        'Position must have exactly one holder (either holder_investor_id or holder_fund_id).',
      );
    }

    const instrumentCount =
      (input.fund_id ? 1 : 0) + (input.asset_id ? 1 : 0);
    if (instrumentCount !== 1) {
      throw new InvalidPositionShapeError(
        'Position must have exactly one instrument (either fund_id or asset_id).',
      );
    }

    if (
      input.holder_fund_id &&
      input.fund_id &&
      input.holder_fund_id === input.fund_id
    ) {
      throw new InvalidPositionShapeError(
        'A fund cannot hold a position in itself.',
      );
    }
  }

  private async validateReferencedEntities(
    workspaceId: string,
    input: OpenPositionInput,
    exec: DbClient,
  ): Promise<void> {
    let holderFund: Tables<'fl_funds'> | null = null;
    if (input.holder_investor_id) {
      const inv = await this.investorRepo.findById(
        workspaceId,
        input.holder_investor_id,
        exec,
      );
      if (!inv) {
        throw new WorkspaceMismatchError(
          `Holder investor ${input.holder_investor_id} does not exist in workspace ${workspaceId}`,
        );
      }
    }

    if (input.holder_fund_id) {
      const fund = await this.fundRepo.findById(
        workspaceId,
        input.holder_fund_id,
        exec,
      );
      if (!fund) {
        throw new WorkspaceMismatchError(
          `Holder fund ${input.holder_fund_id} does not exist in workspace ${workspaceId}`,
        );
      }
      holderFund = fund;
    }

    if (input.fund_id) {
      const fund = await this.fundRepo.findById(
        workspaceId,
        input.fund_id,
        exec,
      );
      if (!fund) {
        throw new WorkspaceMismatchError(
          `Fund instrument ${input.fund_id} does not exist in workspace ${workspaceId}`,
        );
      }
    }

    if (input.asset_id) {
      const asset = await this.assetRepo.findById(
        workspaceId,
        input.asset_id,
        exec,
      );
      if (!asset) {
        throw new WorkspaceMismatchError(
          `Asset instrument ${input.asset_id} does not exist in workspace ${workspaceId}`,
        );
      }
      if (asset.asset_kind === 'cash') {
        assertEligibleCashHolder(
          {
            holder_investor_id: input.holder_investor_id,
            holder_fund_id: input.holder_fund_id,
            holderFundManaged: holderFund?.managed,
          },
          'openPosition',
        );
      }
    }

    if (input.holder_source_of_fund_id) {
      const fs = await this.fundingSourceRepo.findById(
        workspaceId,
        input.holder_source_of_fund_id,
        exec,
      );
      if (!fs) {
        throw new WorkspaceMismatchError(
          `Source of fund ${input.holder_source_of_fund_id} does not exist in workspace ${workspaceId}`,
        );
      }
    }
  }

  async openPosition(
    workspaceId: string,
    input: OpenPositionInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    this.validatePositionShape(input);

    return this.withExecutor(executor, async (exec) => {
      await this.validateReferencedEntities(workspaceId, input, exec);

      const naturalKey: FlPositionNaturalKey = {
        holderInvestorId: input.holder_investor_id ?? null,
        holderFundId: input.holder_fund_id ?? null,
        fundId: input.fund_id ?? null,
        assetId: input.asset_id ?? null,
        holderSourceOfFundId: input.holder_source_of_fund_id ?? null,
      };

      const existing = await this.positionRepo.findByNaturalKey(
        workspaceId,
        naturalKey,
        exec,
      );
      if (existing) {
        throw new DuplicatePositionError(
          `Position already exists for key: ${JSON.stringify(naturalKey)}`,
        );
      }

      const openedAt =
        input.opened_at ?? new Date().toISOString().slice(0, 10);

      return this.positionRepo.create(
        {
          id: input.id,
          workspace_id: workspaceId,
          holder_investor_id: input.holder_investor_id ?? null,
          holder_fund_id: input.holder_fund_id ?? null,
          fund_id: input.fund_id ?? null,
          asset_id: input.asset_id ?? null,
          holder_source_of_fund_id: input.holder_source_of_fund_id ?? null,
          status: 'open',
          opened_at: openedAt,
          notes: input.notes ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getOrOpenPosition(
    workspaceId: string,
    input: OpenPositionInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    this.validatePositionShape(input);

    return this.withExecutor(executor, async (exec) => {
      await this.validateReferencedEntities(workspaceId, input, exec);

      const naturalKey: FlPositionNaturalKey = {
        holderInvestorId: input.holder_investor_id ?? null,
        holderFundId: input.holder_fund_id ?? null,
        fundId: input.fund_id ?? null,
        assetId: input.asset_id ?? null,
        holderSourceOfFundId: input.holder_source_of_fund_id ?? null,
      };

      const existing = await this.positionRepo.findByNaturalKey(
        workspaceId,
        naturalKey,
        exec,
      );
      if (existing) {
        const requested = input.opened_at?.trim() || null;
        if (requested && (!existing.opened_at || requested < existing.opened_at)) {
          const updated = await this.positionRepo.update(
            workspaceId,
            existing.id,
            { opened_at: requested },
            exec,
          );
          return updated ?? existing;
        }
        return existing;
      }

      const openedAt =
        input.opened_at ?? new Date().toISOString().slice(0, 10);

      return this.positionRepo.create(
        {
          id: input.id,
          workspace_id: workspaceId,
          holder_investor_id: input.holder_investor_id ?? null,
          holder_fund_id: input.holder_fund_id ?? null,
          fund_id: input.fund_id ?? null,
          asset_id: input.asset_id ?? null,
          holder_source_of_fund_id: input.holder_source_of_fund_id ?? null,
          status: 'open',
          opened_at: openedAt,
          notes: input.notes ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getOrCreateCashPosition(
    workspaceId: string,
    holder: { kind: 'fund'; id: string },
    currency: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    const { id: holderId } = holder;
    const validCurrency = validateCurrency(currency);
    return this.withExecutor(executor, async (exec) => {
      const fund = await this.fundRepo.findById(workspaceId, holderId, exec);
      if (!fund) {
        throw new WorkspaceMismatchError(
          `Fund ${holderId} not found in workspace ${workspaceId}`,
        );
      }
      assertEligibleCashHolder(
        {
          holder_fund_id: holderId,
          holderFundManaged: fund.managed,
        },
        'getOrCreateCashPosition',
      );

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

  private validatePositionSettlement(
    position: Tables<'fl_positions'>,
    deltaSums?: {
      quantity_sum?: string;
      commitment_sum?: string;
      contributed_sum?: string;
      paid_in_adjustment_sum?: string;
    },
  ): void {
    const quantitySum = deltaSums?.quantity_sum ?? '0';
    const commitmentSum = deltaSums?.commitment_sum ?? '0';
    const contributedSum = flAdd(deltaSums?.contributed_sum ?? '0', deltaSums?.paid_in_adjustment_sum ?? '0');

    if (!flIsZero(quantitySum)) {
      throw new PositionNotSettledError(
        `Position ${position.id} has nonzero remaining quantity (${quantitySum}) and cannot be closed`,
      );
    }

    if (position.fund_id) {
      const unfunded = flSub(commitmentSum, contributedSum);
      if (flGt(unfunded, '0')) {
        throw new PositionNotSettledError(
          `Fund position ${position.id} has remaining unfunded commitment (${unfunded}) and cannot be closed`,
        );
      }
    }
  }

  async closePosition(
    workspaceId: string,
    positionId: string,
    closedAt?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    return this.withExecutor(executor, async (exec) => {
      const position = await this.positionRepo.findById(
        workspaceId,
        positionId,
        exec,
      );
      if (!position) {
        throw new EntityNotFoundError(
          `Position ${positionId} not found in workspace ${workspaceId}`,
        );
      }

      const [deltaSums] = await this.ledgerRepo.sumDeltasByPositionIds(
        workspaceId,
        [positionId],
        undefined,
        exec,
      );

      this.validatePositionSettlement(position, deltaSums);

      const effectiveClosedAt =
        closedAt ?? new Date().toISOString().slice(0, 10);

      const updated = await this.positionRepo.updateStatus(
        workspaceId,
        positionId,
        'closed',
        effectiveClosedAt,
        exec,
      );

      if (!updated) {
        throw new EntityNotFoundError(
          `Position ${positionId} could not be updated`,
        );
      }

      return updated;
    });
  }

  async closePositions(
    workspaceId: string,
    positionIds: string[],
    closedAt?: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (positionIds.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    for (const id of positionIds) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new InvalidPositionShapeError('positionIds must contain only non-empty string IDs');
      }
      if (seen.has(id)) {
        throw new InvalidPositionShapeError(`Duplicate position ID: ${id}`);
      }
      seen.add(id);
    }

    return this.withExecutor(executor, async (exec) => {
      const positions = await this.positionRepo.findByIds(
        workspaceId,
        positionIds,
        exec,
      );

      const posMap = new Map(positions.map((p) => [p.id, p]));
      for (const id of positionIds) {
        if (!posMap.has(id)) {
          throw new EntityNotFoundError(
            `Position ${id} not found in workspace ${workspaceId}`,
          );
        }
      }

      const deltaSumsList = await this.ledgerRepo.sumDeltasByPositionIds(
        workspaceId,
        positionIds,
        undefined,
        exec,
      );
      const deltaMap = new Map(
        deltaSumsList.map((d) => [d.position_id, d]),
      );

      for (const id of positionIds) {
        const pos = posMap.get(id)!;
        this.validatePositionSettlement(pos, deltaMap.get(id));
      }

      const effectiveClosedAt =
        closedAt ?? new Date().toISOString().slice(0, 10);

      return this.positionRepo.updateStatuses(
        workspaceId,
        positionIds,
        'closed',
        effectiveClosedAt,
        exec,
      );
    });
  }

  async reopenPosition(
    workspaceId: string,
    positionId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>> {
    return this.withExecutor(executor, async (exec) => {
      const position = await this.positionRepo.findById(
        workspaceId,
        positionId,
        exec,
      );
      if (!position) {
        throw new EntityNotFoundError(
          `Position ${positionId} not found in workspace ${workspaceId}`,
        );
      }

      if (position.asset_id) {
        const asset = await this.assetRepo.findById(workspaceId, position.asset_id, exec);
        if (asset?.asset_kind === 'cash') {
          let holderFundManaged: boolean | undefined;
          if (position.holder_fund_id) {
            const fund = await this.fundRepo.findById(workspaceId, position.holder_fund_id, exec);
            holderFundManaged = fund?.managed;
          }
          assertEligibleCashHolder(
            {
              holder_investor_id: position.holder_investor_id,
              holder_fund_id: position.holder_fund_id,
              holderFundManaged,
            },
            'reopenPosition',
          );
        }
      }

      const updated = await this.positionRepo.updateStatus(
        workspaceId,
        positionId,
        'open',
        null,
        exec,
      );

      if (!updated) {
        throw new EntityNotFoundError(
          `Position ${positionId} could not be updated`,
        );
      }

      return updated;
    });
  }

  async getPositionById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'> | undefined> {
    return this.positionRepo.findById(workspaceId, id, executor);
  }

  async listPositions(
    workspaceId: string,
    filters?: ListPositionsFilter,
    executor?: DbClient,
  ): Promise<Tables<'fl_positions'>[]> {
    if (
      filters?.holderSourceOfFundId !== undefined ||
      (filters && Object.keys(filters).length > 1)
    ) {
      return this.positionRepo.findWithFilters(workspaceId, filters, executor);
    }
    if (filters?.fundId) {
      return this.positionRepo.findByFundIds(
        workspaceId,
        [filters.fundId],
        executor,
      );
    }
    if (filters?.holderInvestorId) {
      return this.positionRepo.findByHolderInvestorIds(
        workspaceId,
        [filters.holderInvestorId],
        executor,
      );
    }
    if (filters?.holderFundId) {
      return this.positionRepo.findByHolderFundIds(
        workspaceId,
        [filters.holderFundId],
        executor,
      );
    }
    if (filters?.assetId) {
      return this.positionRepo.findByAssetIds(
        workspaceId,
        [filters.assetId],
        executor,
      );
    }
    return this.positionRepo.findByWorkspaceId(workspaceId, executor);
  }
}
