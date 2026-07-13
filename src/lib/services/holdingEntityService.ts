import type {
  HoldingEntityRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';

export class HoldingEntityNotFoundError extends Error {
  constructor(id: string) {
    super(`HoldingEntity ${id} not found`);
    this.name = 'HoldingEntityNotFoundError';
  }
}

/** Investment Entities — the by-investment-entity view + Add Asset combobox. */
export class HoldingEntityService {
  constructor(private readonly holdingEntityRepo: HoldingEntityRepository) {}

  listHoldingEntities(): Promise<Tables<'holding_entities'>[]> {
    return this.holdingEntityRepo.findAll();
  }

  createHoldingEntity(
    data: Omit<TablesInsert<'holding_entities'>, 'workspace_id'>,
  ): Promise<Tables<'holding_entities'>> {
    return this.holdingEntityRepo.insert(data);
  }

  async updateHoldingEntity(
    id: string,
    updates: TablesUpdate<'holding_entities'>,
  ): Promise<Tables<'holding_entities'>> {
    const row = await this.holdingEntityRepo.update(id, updates);
    if (!row) throw new HoldingEntityNotFoundError(id);
    return row;
  }

  async deleteHoldingEntity(id: string): Promise<void> {
    const existing = await this.holdingEntityRepo.findById(id);
    if (!existing) throw new HoldingEntityNotFoundError(id);
    await this.holdingEntityRepo.delete(id);
  }
}
