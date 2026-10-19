import type { DbClient, Tables } from '@/lib/repositories';
import { FlAssetRepository, FlInvestmentTypeRepository } from '@/lib/repositories';
import { EntityNotFoundError, InvalidMasterDataError } from './flErrors';

/** The default investment types, in display order. The migration backfills them
 * into every workspace that existed at the time, and `scripts/seed.ts` seeds them;
 * a workspace created later starts with none. */
export const DEFAULT_INVESTMENT_TYPES = [
  'Realized Funds',
  'Venture Capital',
  'Private Equity',
  'Private Credit',
  'Others',
  'Realized and Partially Realized',
  'Unrealized',
] as const;

/**
 * Investment types: a workspace-configurable grouping for fund-ledger assets,
 * shown as "by investment type" in Fund Management. Each asset belongs to at
 * most one type.
 */
export class FlInvestmentTypeService {
  constructor(
    private readonly db: DbClient,
    private readonly investmentTypeRepo: FlInvestmentTypeRepository,
    private readonly assetRepo: FlAssetRepository,
  ) {}

  private async withExecutor<T>(
    executor: DbClient | undefined,
    fn: (exec: DbClient) => Promise<T>,
  ): Promise<T> {
    if (executor) return fn(executor);
    return (this.db as any).transaction(async (tx: unknown) => fn(tx as DbClient));
  }

  private cleanName(name: unknown): string {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean === '') throw new InvalidMasterDataError('Investment type name is required');
    return clean;
  }

  private assertUnique(
    existing: Tables<'fl_investment_types'>[],
    name: string,
    exceptId?: string,
  ): void {
    const lower = name.toLowerCase();
    if (existing.some((t) => t.id !== exceptId && t.name.toLowerCase() === lower)) {
      throw new InvalidMasterDataError(`Investment type "${name}" already exists`);
    }
  }

  async list(workspaceId: string, executor?: DbClient): Promise<Tables<'fl_investment_types'>[]> {
    return this.investmentTypeRepo.findByWorkspaceId(workspaceId, executor);
  }

  /** Adds a type at the end of the list. */
  async create(
    workspaceId: string,
    name: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investment_types'>> {
    const clean = this.cleanName(name);
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.investmentTypeRepo.findByWorkspaceId(workspaceId, exec);
      this.assertUnique(existing, clean);
      const nextOrder = existing.reduce((max, t) => Math.max(max, t.sort_order + 1), 0);
      return this.investmentTypeRepo.create(
        { workspace_id: workspaceId, name: clean, sort_order: nextOrder },
        exec,
      );
    });
  }

  async rename(
    workspaceId: string,
    id: string,
    name: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investment_types'>> {
    const clean = this.cleanName(name);
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.investmentTypeRepo.findByWorkspaceId(workspaceId, exec);
      if (!existing.some((t) => t.id === id)) {
        throw new EntityNotFoundError(`Investment type ${id} not found`);
      }
      this.assertUnique(existing, clean, id);
      const updated = await this.investmentTypeRepo.update(workspaceId, id, { name: clean }, exec);
      if (!updated) throw new EntityNotFoundError(`Investment type ${id} not found`);
      return updated;
    });
  }

  /** Deletes the type. Assets assigned to it become unassigned. */
  async delete(workspaceId: string, id: string, executor?: DbClient): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.investmentTypeRepo.findById(workspaceId, id, exec);
      if (!existing) throw new EntityNotFoundError(`Investment type ${id} not found`);
      await this.investmentTypeRepo.delete(workspaceId, id, exec);
    });
  }

  /** Assigns an asset to a type, or unassigns it with `null`. */
  async assignAsset(
    workspaceId: string,
    assetId: string,
    investmentTypeId: string | null,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    return this.withExecutor(executor, async (exec) => {
      if (investmentTypeId !== null) {
        const type = await this.investmentTypeRepo.findById(workspaceId, investmentTypeId, exec);
        if (!type) throw new EntityNotFoundError(`Investment type ${investmentTypeId} not found`);
      }
      const updated = await this.assetRepo.update(
        workspaceId,
        assetId,
        { investment_type_id: investmentTypeId },
        exec,
      );
      if (!updated) throw new EntityNotFoundError(`Asset ${assetId} not found`);
      return updated;
    });
  }
}
