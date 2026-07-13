import type {
  FundSourceRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';

export class FundSourceNotFoundError extends Error {
  constructor(id: string) {
    super(`Fund source ${id} not found`);
    this.name = 'FundSourceNotFoundError';
  }
}

/** Source-of-Fund capital pools — the by-source view + Add Asset combobox. */
export class FundSourceService {
  constructor(private readonly fundSourceRepo: FundSourceRepository) {}

  listFundSources(): Promise<Tables<'funding_sources'>[]> {
    return this.fundSourceRepo.findAll();
  }

  createFundSource(
    data: Omit<TablesInsert<'funding_sources'>, 'workspace_id'>,
  ): Promise<Tables<'funding_sources'>> {
    return this.fundSourceRepo.insert(data);
  }

  async updateFundSource(
    id: string,
    updates: TablesUpdate<'funding_sources'>,
  ): Promise<Tables<'funding_sources'>> {
    const row = await this.fundSourceRepo.update(id, updates);
    if (!row) throw new FundSourceNotFoundError(id);
    return row;
  }

  async deleteFundSource(id: string): Promise<void> {
    const existing = await this.fundSourceRepo.findById(id);
    if (!existing) throw new FundSourceNotFoundError(id);
    await this.fundSourceRepo.delete(id);
  }
}
