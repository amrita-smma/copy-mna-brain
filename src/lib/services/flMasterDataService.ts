import type {
  DbClient,
  FlAssetRepository,
  FlFundingSourceRepository,
  FlFundRepository,
  FlInvestorRepository,
  Tables,
} from '@/lib/repositories';
import { validateCurrency } from './flCurrency';
import { isSameBusinessIdentity, normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import {
  EntityNotFoundError,
  InvalidCurrencyError,
  InvalidEntryShapeError,
  InvalidMasterDataError,
  WorkspaceMismatchError,
} from './flErrors';

export interface CreateInvestorInput {
  id?: string;
  name: string;
  legal_name?: string | null;
  english_name?: string | null;
  investor_type: 'individual' | 'institution' | 'internal_entity';
  country?: string | null;
  parent_investor_id?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

export interface UpdateInvestorInput {
  name?: string;
  legal_name?: string | null;
  english_name?: string | null;
  investor_type?: 'individual' | 'institution' | 'internal_entity';
  country?: string | null;
  parent_investor_id?: string | null;
  notes?: string | null;
}

export interface CreateFundInput {
  id?: string;
  name: string;
  legal_name?: string | null;
  english_name?: string | null;
  registration_no?: string | null;
  managed?: boolean;
  ownership_basis: 'units' | 'commitment' | 'capital_account';
  base_currency?: string;
  vintage_year?: number | null;
  fund_life_years?: number | null;
  status?: 'raising' | 'investing' | 'harvesting' | 'liquidated';
  mgmt_fee_rate?: string | null;
  carry_rate?: string | null;
  preferred_return_rate?: string | null;
  description?: string | null;
  created_by?: string | null;
}

export interface UpdateFundInput {
  name?: string;
  legal_name?: string | null;
  english_name?: string | null;
  registration_no?: string | null;
  managed?: boolean;
  ownership_basis?: 'units' | 'commitment' | 'capital_account';
  base_currency?: string;
  vintage_year?: number | null;
  fund_life_years?: number | null;
  status?: 'raising' | 'investing' | 'harvesting' | 'liquidated';
  mgmt_fee_rate?: string | null;
  carry_rate?: string | null;
  preferred_return_rate?: string | null;
  description?: string | null;
}

export interface CreateAssetInput {
  id?: string;
  name: string;
  legal_name?: string | null;
  english_name?: string | null;
  asset_kind:
    | 'equity'
    | 'loan'
    | 'note'
    | 'safe'
    | 'real_estate'
    | 'listed_security'
    | 'cash'
    | 'other';
  country?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
  instrument_terms?: Record<string, unknown> | null;
  description?: string | null;
  created_by?: string | null;
}

export interface UpdateAssetInput {
  name?: string;
  legal_name?: string | null;
  english_name?: string | null;
  asset_kind?:
    | 'equity'
    | 'loan'
    | 'note'
    | 'safe'
    | 'real_estate'
    | 'listed_security'
    | 'cash'
    | 'other';
  country?: string | null;
  sector?: string | null;
  sub_sector?: string | null;
  instrument_terms?: Record<string, unknown> | null;
  description?: string | null;
}

export interface CreateFundingSourceInput {
  id?: string;
  name: string;
  source_type?: string | null;
  owner_investor_id?: string | null;
  currency?: string | null;
  created_by?: string | null;
}

export interface UpdateFundingSourceInput {
  name?: string;
  source_type?: string | null;
  owner_investor_id?: string | null;
  currency?: string | null;
}

export function isUniqueViolationOrDuplicateError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof InvalidMasterDataError && err.message.includes('already exists')) {
    return true;
  }
  const e = err as { code?: string; routine?: string; message?: string; constraint?: string };
  if (e.code === '23505') return true;
  if (
    typeof e.message === 'string' &&
    (e.message.includes('unique constraint') ||
      e.message.includes('duplicate key') ||
      e.message.includes('already exists'))
  ) {
    return true;
  }
  return false;
}

export function getCashAssetCurrency(
  asset: { instrument_terms?: unknown } | null | undefined,
): string | undefined {
  if (!asset || typeof asset !== 'object') return undefined;
  const terms = (asset as { instrument_terms?: unknown }).instrument_terms;
  if (terms && typeof terms === 'object' && 'currency' in terms) {
    const raw = (terms as { currency?: unknown }).currency;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim().toUpperCase();
    }
  }
  return undefined;
}

export class FlMasterDataService {
  constructor(
    private readonly db: DbClient,
    private readonly investorRepo: FlInvestorRepository,
    private readonly fundRepo: FlFundRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly fundingSourceRepo: FlFundingSourceRepository,
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

  // ===== Investors =====

  async listInvestors(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>[]> {
    return this.investorRepo.findByWorkspaceId(workspaceId, executor);
  }

  async getInvestorById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'> | undefined> {
    return this.investorRepo.findById(workspaceId, id, executor);
  }

  async createInvestor(
    workspaceId: string,
    input: CreateInvestorInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Investor name is required');
    }
    const validTypes = ['individual', 'institution', 'internal_entity'];
    if (!validTypes.includes(input.investor_type)) {
      throw new InvalidMasterDataError(
        `Invalid investor_type: ${input.investor_type}`,
      );
    }

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.investorRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (inv) =>
          isSameBusinessIdentity(inv.name, input.name) ||
          (inv.legal_name && isSameBusinessIdentity(inv.legal_name, input.name)),
      );
      if (existing) {
        throw new InvalidMasterDataError(
          `Investor "${input.name}" already exists in workspace ${workspaceId}`,
        );
      }

      if (input.parent_investor_id) {
        const parent = await this.investorRepo.findById(
          workspaceId,
          input.parent_investor_id,
          exec,
        );
        if (!parent) {
          throw new WorkspaceMismatchError(
            `Parent investor ${input.parent_investor_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      return this.investorRepo.create(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: normalizeCanonicalName(input.name),
          legal_name: input.legal_name ?? null,
          english_name: input.english_name ?? null,
          investor_type: input.investor_type,
          country: input.country ?? null,
          parent_investor_id: input.parent_investor_id ?? null,
          notes: input.notes ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getOrCreateInvestor(
    workspaceId: string,
    input: CreateInvestorInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Investor name is required');
    }
    const validTypes = ['individual', 'institution', 'internal_entity'];
    if (!validTypes.includes(input.investor_type)) {
      throw new InvalidMasterDataError(
        `Invalid investor_type: ${input.investor_type}`,
      );
    }

    const canonicalName = normalizeCanonicalName(input.name);

    return this.withExecutor(executor, async (exec) => {
      // 1. Check existing in-memory / pre-query
      const existingList = await this.investorRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (inv) =>
          inv.canonical_name === canonicalName ||
          isSameBusinessIdentity(inv.name, input.name) ||
          (inv.legal_name && isSameBusinessIdentity(inv.legal_name, input.name)),
      );
      if (existing) {
        if (!existing.english_name && input.english_name?.trim()) {
          const updated = await this.investorRepo.update(
            workspaceId,
            existing.id,
            { english_name: input.english_name.trim() },
            exec,
          );
          return updated ?? existing;
        }
        return existing;
      }

      if (input.parent_investor_id) {
        const parent = await this.investorRepo.findById(
          workspaceId,
          input.parent_investor_id,
          exec,
        );
        if (!parent) {
          throw new WorkspaceMismatchError(
            `Parent investor ${input.parent_investor_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      // 2. Transaction-safe atomic insert with onConflictDoNothing
      const inserted = await this.investorRepo.insertOnConflictDoNothing(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: canonicalName,
          legal_name: input.legal_name ?? null,
          english_name: input.english_name ?? null,
          investor_type: input.investor_type,
          country: input.country ?? null,
          parent_investor_id: input.parent_investor_id ?? null,
          notes: input.notes ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );

      if (inserted) {
        return inserted;
      }

      // 3. Concurrent winner inserted: lookup existing and backfill if necessary
      const winner = await this.investorRepo.findByCanonicalName(
        workspaceId,
        canonicalName,
        exec,
      );
      if (winner) {
        if (!winner.english_name && input.english_name?.trim()) {
          const updated = await this.investorRepo.update(
            workspaceId,
            winner.id,
            { english_name: input.english_name.trim() },
            exec,
          );
          return updated ?? winner;
        }
        return winner;
      }

      // Fallback reload all in workspace
      const reloaded = await this.investorRepo.findByWorkspaceId(workspaceId, exec);
      const matched = reloaded.find(
        (inv) =>
          inv.canonical_name === canonicalName ||
          isSameBusinessIdentity(inv.name, input.name) ||
          (inv.legal_name && isSameBusinessIdentity(inv.legal_name, input.name)),
      );
      if (matched) {
        if (!matched.english_name && input.english_name?.trim()) {
          const updated = await this.investorRepo.update(
            workspaceId,
            matched.id,
            { english_name: input.english_name.trim() },
            exec,
          );
          return updated ?? matched;
        }
        return matched;
      }

      throw new InvalidMasterDataError(
        `Failed to get or create investor "${input.name}" in workspace ${workspaceId}`,
      );
    });
  }

  // ===== Funds =====

  async listFunds(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>[]> {
    return this.fundRepo.findByWorkspaceId(workspaceId, executor);
  }

  async getFundById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'> | undefined> {
    return this.fundRepo.findById(workspaceId, id, executor);
  }

  async createFund(
    workspaceId: string,
    input: CreateFundInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Fund name is required');
    }
    const validBasis = ['units', 'commitment', 'capital_account'];
    if (!validBasis.includes(input.ownership_basis)) {
      throw new InvalidMasterDataError(`Invalid ownership_basis: ${input.ownership_basis}`);
    }

    const baseCurrency = validateCurrency(input.base_currency ?? 'USD');

    const validStatuses = ['raising', 'investing', 'harvesting', 'liquidated'];
    const status = input.status ?? 'investing';
    if (!validStatuses.includes(status)) {
      throw new InvalidMasterDataError(`Invalid fund status: ${status}`);
    }

    if (
      input.mgmt_fee_rate !== undefined &&
      input.mgmt_fee_rate !== null &&
      typeof input.mgmt_fee_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'mgmt_fee_rate must be a string, received ' + typeof input.mgmt_fee_rate,
      );
    }
    if (
      input.carry_rate !== undefined &&
      input.carry_rate !== null &&
      typeof input.carry_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'carry_rate must be a string, received ' + typeof input.carry_rate,
      );
    }
    if (
      input.preferred_return_rate !== undefined &&
      input.preferred_return_rate !== null &&
      typeof input.preferred_return_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'preferred_return_rate must be a string, received ' +
          typeof input.preferred_return_rate,
      );
    }

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.fundRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (f) =>
          isSameBusinessIdentity(f.name, input.name) ||
          (f.legal_name && isSameBusinessIdentity(f.legal_name, input.name)),
      );
      if (existing) {
        throw new InvalidMasterDataError(
          `Fund "${input.name}" already exists in workspace ${workspaceId}`,
        );
      }

      return this.fundRepo.create(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: normalizeCanonicalName(input.name),
          legal_name: input.legal_name ?? null,
          english_name: input.english_name ?? null,
          registration_no: input.registration_no ?? null,
          managed: input.managed ?? false,
          ownership_basis: input.ownership_basis,
          base_currency: baseCurrency,
          vintage_year: input.vintage_year ?? null,
          fund_life_years: input.fund_life_years ?? null,
          status,
          mgmt_fee_rate: input.mgmt_fee_rate ?? null,
          carry_rate: input.carry_rate ?? null,
          preferred_return_rate: input.preferred_return_rate ?? null,
          description: input.description ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getOrCreateFund(
    workspaceId: string,
    input: CreateFundInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Fund name is required');
    }
    const validBases = ['units', 'commitment', 'capital_account'];
    if (!validBases.includes(input.ownership_basis)) {
      throw new InvalidMasterDataError(
        `Invalid ownership_basis: ${input.ownership_basis}`,
      );
    }
    const baseCurrency = validateCurrency(input.base_currency ?? 'USD');
    const status = input.status ?? 'investing';
    const validStatuses = ['raising', 'investing', 'harvesting', 'liquidated'];
    if (!validStatuses.includes(status)) {
      throw new InvalidMasterDataError(`Invalid status: ${status}`);
    }
    if (
      input.mgmt_fee_rate !== undefined &&
      input.mgmt_fee_rate !== null &&
      typeof input.mgmt_fee_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'mgmt_fee_rate must be a string, received ' +
          typeof input.mgmt_fee_rate,
      );
    }
    if (
      input.carry_rate !== undefined &&
      input.carry_rate !== null &&
      typeof input.carry_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'carry_rate must be a string, received ' + typeof input.carry_rate,
      );
    }
    if (
      input.preferred_return_rate !== undefined &&
      input.preferred_return_rate !== null &&
      typeof input.preferred_return_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'preferred_return_rate must be a string, received ' +
          typeof input.preferred_return_rate,
      );
    }

    const canonicalName = normalizeCanonicalName(input.name);

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.fundRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (f) =>
          f.canonical_name === canonicalName ||
          isSameBusinessIdentity(f.name, input.name) ||
          (f.legal_name && isSameBusinessIdentity(f.legal_name, input.name)),
      );
      if (existing) {
        const updates: { registration_no?: string; english_name?: string } = {};
        if (!existing.registration_no && input.registration_no?.trim()) {
          updates.registration_no = input.registration_no.trim();
        }
        if (!existing.english_name && input.english_name?.trim()) {
          updates.english_name = input.english_name.trim();
        }
        if (Object.keys(updates).length > 0) {
          const updated = await this.fundRepo.update(workspaceId, existing.id, updates, exec);
          return updated ?? existing;
        }
        return existing;
      }

      const inserted = await this.fundRepo.insertOnConflictDoNothing(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: canonicalName,
          legal_name: input.legal_name ?? null,
          english_name: input.english_name ?? null,
          registration_no: input.registration_no ?? null,
          managed: input.managed ?? false,
          ownership_basis: input.ownership_basis,
          base_currency: baseCurrency,
          vintage_year: input.vintage_year ?? null,
          fund_life_years: input.fund_life_years ?? null,
          status,
          mgmt_fee_rate: input.mgmt_fee_rate ?? null,
          carry_rate: input.carry_rate ?? null,
          preferred_return_rate: input.preferred_return_rate ?? null,
          description: input.description ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );

      if (inserted) {
        return inserted;
      }

      const winner = await this.fundRepo.findByCanonicalName(
        workspaceId,
        canonicalName,
        exec,
      );
      if (winner) {
        const updates: { registration_no?: string; english_name?: string } = {};
        if (!winner.registration_no && input.registration_no?.trim()) {
          updates.registration_no = input.registration_no.trim();
        }
        if (!winner.english_name && input.english_name?.trim()) {
          updates.english_name = input.english_name.trim();
        }
        if (Object.keys(updates).length > 0) {
          const updated = await this.fundRepo.update(workspaceId, winner.id, updates, exec);
          return updated ?? winner;
        }
        return winner;
      }

      const reloaded = await this.fundRepo.findByWorkspaceId(workspaceId, exec);
      const matched = reloaded.find(
        (f) =>
          f.canonical_name === canonicalName ||
          isSameBusinessIdentity(f.name, input.name) ||
          (f.legal_name && isSameBusinessIdentity(f.legal_name, input.name)),
      );
      if (matched) {
        const updates: { registration_no?: string; english_name?: string } = {};
        if (!matched.registration_no && input.registration_no?.trim()) {
          updates.registration_no = input.registration_no.trim();
        }
        if (!matched.english_name && input.english_name?.trim()) {
          updates.english_name = input.english_name.trim();
        }
        if (Object.keys(updates).length > 0) {
          const updated = await this.fundRepo.update(workspaceId, matched.id, updates, exec);
          return updated ?? matched;
        }
        return matched;
      }

      throw new InvalidMasterDataError(
        `Failed to get or create fund "${input.name}" in workspace ${workspaceId}`,
      );
    });
  }

  // ===== Assets =====

  async listAssets(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>[]> {
    return this.assetRepo.findByWorkspaceId(workspaceId, executor);
  }

  async getAssetById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'> | undefined> {
    return this.assetRepo.findById(workspaceId, id, executor);
  }

  async createAsset(
    workspaceId: string,
    input: CreateAssetInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Asset name is required');
    }
    const validKinds = [
      'equity',
      'loan',
      'note',
      'safe',
      'real_estate',
      'listed_security',
      'cash',
      'other',
    ];
    if (!validKinds.includes(input.asset_kind)) {
      throw new InvalidMasterDataError(`Invalid asset_kind: ${input.asset_kind}`);
    }

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.assetRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (a) =>
          isSameBusinessIdentity(a.name, input.name) ||
          (a.legal_name && isSameBusinessIdentity(a.legal_name, input.name)),
      );
      if (existing) {
        throw new InvalidMasterDataError(
          `Asset "${input.name}" already exists in workspace ${workspaceId}`,
        );
      }

      return this.assetRepo.create(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: normalizeCanonicalName(input.name),
          legal_name: input.legal_name ?? null,
          english_name: input.english_name ?? null,
          asset_kind: input.asset_kind,
          country: input.country ?? null,
          sector: input.sector ?? null,
          sub_sector: input.sub_sector ?? null,
          instrument_terms: input.instrument_terms ?? {},
          description: input.description ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getOrCreateAsset(
    workspaceId: string,
    input: CreateAssetInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Asset name is required');
    }
    const validKinds = [
      'equity',
      'loan',
      'note',
      'safe',
      'real_estate',
      'listed_security',
      'cash',
      'other',
    ];
    if (!validKinds.includes(input.asset_kind)) {
      throw new InvalidMasterDataError(`Invalid asset_kind: ${input.asset_kind}`);
    }

    const canonicalName = normalizeCanonicalName(input.name);

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.assetRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (a) =>
          a.canonical_name === canonicalName ||
          isSameBusinessIdentity(a.name, input.name) ||
          (a.legal_name && isSameBusinessIdentity(a.legal_name, input.name)),
      );
      if (existing) {
        if (!existing.english_name && input.english_name?.trim()) {
          const updated = await this.assetRepo.update(
            workspaceId,
            existing.id,
            { english_name: input.english_name.trim() },
            exec,
          );
          return updated ?? existing;
        }
        return existing;
      }

      const inserted = await this.assetRepo.insertOnConflictDoNothing(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: canonicalName,
          legal_name: input.legal_name ?? null,
          english_name: input.english_name ?? null,
          asset_kind: input.asset_kind,
          country: input.country ?? null,
          sector: input.sector ?? null,
          sub_sector: input.sub_sector ?? null,
          instrument_terms: input.instrument_terms ?? {},
          description: input.description ?? null,
          created_by: input.created_by ?? null,
        },
        exec,
      );

      if (inserted) {
        return inserted;
      }

      const winner = await this.assetRepo.findByCanonicalName(
        workspaceId,
        canonicalName,
        exec,
      );
      if (winner) {
        if (!winner.english_name && input.english_name?.trim()) {
          const updated = await this.assetRepo.update(
            workspaceId,
            winner.id,
            { english_name: input.english_name.trim() },
            exec,
          );
          return updated ?? winner;
        }
        return winner;
      }

      const reloaded = await this.assetRepo.findByWorkspaceId(workspaceId, exec);
      const matched = reloaded.find(
        (a) =>
          a.canonical_name === canonicalName ||
          isSameBusinessIdentity(a.name, input.name) ||
          (a.legal_name && isSameBusinessIdentity(a.legal_name, input.name)),
      );
      if (matched) {
        if (!matched.english_name && input.english_name?.trim()) {
          const updated = await this.assetRepo.update(
            workspaceId,
            matched.id,
            { english_name: input.english_name.trim() },
            exec,
          );
          return updated ?? matched;
        }
        return matched;
      }

      throw new InvalidMasterDataError(
        `Failed to get or create asset "${input.name}" in workspace ${workspaceId}`,
      );
    });
  }

  async getOrCreateCashAsset(
    workspaceId: string,
    currency: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    const validCurrency = validateCurrency(currency);
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.assetRepo.findSystemCashAsset(
        workspaceId,
        validCurrency,
        exec,
      );
      if (existing) {
        return existing;
      }

      const name = `Cash (${validCurrency})`;
      const canonicalName = normalizeCanonicalName(name);

      try {
        return await this.assetRepo.create(
          {
            workspace_id: workspaceId,
            name,
            canonical_name: canonicalName,
            asset_kind: 'cash',
            instrument_terms: {
              system_cash: true,
              currency: validCurrency,
            },
          },
          exec,
        );
      } catch (err) {
        if (isUniqueViolationOrDuplicateError(err)) {
          const winner = await this.assetRepo.findSystemCashAsset(
            workspaceId,
            validCurrency,
            exec,
          );
          if (winner) {
            return winner;
          }
        }
        throw err;
      }
    });
  }

  // ===== Funding Sources =====

  async listFundingSources(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>[]> {
    return this.fundingSourceRepo.findByWorkspaceId(workspaceId, executor);
  }

  async getFundingSourceById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'> | undefined> {
    return this.fundingSourceRepo.findById(workspaceId, id, executor);
  }

  async createFundingSource(
    workspaceId: string,
    input: CreateFundingSourceInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Funding source name is required');
    }

    const currency = input.currency
      ? validateCurrency(input.currency)
      : null;

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.fundingSourceRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find((s) => isSameBusinessIdentity(s.name, input.name));
      if (existing) {
        throw new InvalidMasterDataError(
          `Funding source "${input.name}" already exists in workspace ${workspaceId}`,
        );
      }

      if (input.owner_investor_id) {
        const owner = await this.investorRepo.findById(
          workspaceId,
          input.owner_investor_id,
          exec,
        );
        if (!owner) {
          throw new WorkspaceMismatchError(
            `Owner investor ${input.owner_investor_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      return this.fundingSourceRepo.create(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: normalizeCanonicalName(input.name),
          source_type: input.source_type ?? null,
          owner_investor_id: input.owner_investor_id ?? null,
          currency,
          created_by: input.created_by ?? null,
        },
        exec,
      );
    });
  }

  async getOrCreateFundingSource(
    workspaceId: string,
    input: CreateFundingSourceInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>> {
    if (!input.name || input.name.trim() === '') {
      throw new InvalidMasterDataError('Funding source name is required');
    }

    const currency = input.currency
      ? validateCurrency(input.currency)
      : null;
    const canonicalName = normalizeCanonicalName(input.name);

    return this.withExecutor(executor, async (exec) => {
      const existingList = await this.fundingSourceRepo.findByWorkspaceId(workspaceId, exec);
      const existing = existingList.find(
        (s) =>
          s.canonical_name === canonicalName ||
          isSameBusinessIdentity(s.name, input.name),
      );
      if (existing) {
        return existing;
      }

      if (input.owner_investor_id) {
        const owner = await this.investorRepo.findById(
          workspaceId,
          input.owner_investor_id,
          exec,
        );
        if (!owner) {
          throw new WorkspaceMismatchError(
            `Owner investor ${input.owner_investor_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      const inserted = await this.fundingSourceRepo.insertOnConflictDoNothing(
        {
          id: input.id,
          workspace_id: workspaceId,
          name: input.name.trim(),
          canonical_name: canonicalName,
          source_type: input.source_type ?? null,
          owner_investor_id: input.owner_investor_id ?? null,
          currency,
          created_by: input.created_by ?? null,
        },
        exec,
      );

      if (inserted) {
        return inserted;
      }

      const winner = await this.fundingSourceRepo.findByCanonicalName(
        workspaceId,
        canonicalName,
        exec,
      );
      if (winner) {
        return winner;
      }

      const reloaded = await this.fundingSourceRepo.findByWorkspaceId(workspaceId, exec);
      const matched = reloaded.find(
        (s) =>
          s.canonical_name === canonicalName ||
          isSameBusinessIdentity(s.name, input.name),
      );
      if (matched) {
        return matched;
      }

      throw new InvalidMasterDataError(
        `Failed to get or create funding source "${input.name}" in workspace ${workspaceId}`,
      );
    });
  }

  async updateInvestor(
    workspaceId: string,
    id: string,
    input: UpdateInvestorInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_investors'>> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.investorRepo.findById(workspaceId, id, exec);
      if (!existing) {
        throw new EntityNotFoundError(
          `Investor ${id} not found in workspace ${workspaceId}`,
        );
      }

      if (input.name !== undefined) {
        const cleanName = input.name.trim();
        if (cleanName === '') {
          throw new InvalidMasterDataError('Investor name cannot be empty');
        }
        const existingList = await this.investorRepo.findByWorkspaceId(workspaceId, exec);
        const duplicate = existingList.find(
          (inv) =>
            inv.id !== id &&
            (isSameBusinessIdentity(inv.name, cleanName) ||
              (inv.legal_name && isSameBusinessIdentity(inv.legal_name, cleanName))),
        );
        if (duplicate) {
          throw new InvalidMasterDataError(
            `Investor "${cleanName}" already exists in workspace ${workspaceId}`,
          );
        }
      }

      if (input.investor_type !== undefined) {
        const validTypes = ['individual', 'institution', 'internal_entity'];
        if (!validTypes.includes(input.investor_type)) {
          throw new InvalidMasterDataError(`Invalid investor_type: ${input.investor_type}`);
        }
      }

      if (
        input.parent_investor_id !== undefined &&
        input.parent_investor_id !== null
      ) {
        if (input.parent_investor_id === id) {
          throw new InvalidMasterDataError('An investor cannot be its own parent');
        }
        const parent = await this.investorRepo.findById(
          workspaceId,
          input.parent_investor_id,
          exec,
        );
        if (!parent) {
          throw new WorkspaceMismatchError(
            `Parent investor ${input.parent_investor_id} does not exist in workspace ${workspaceId}`,
          );
        }

        // Walk up prospective parent chain to reject cycles (A -> B -> A and longer).
        // Bound the walk (stop after 50 hops) so corrupt data cannot hang the request.
        let currentAncestorId: string | null = parent.parent_investor_id ?? null;
        const visited = new Set<string>([id, input.parent_investor_id]);
        let hops = 0;
        while (currentAncestorId && hops < 50) {
          if (currentAncestorId === id) {
            throw new InvalidMasterDataError(
              'Cannot set parent: cycle detected in investor hierarchy',
            );
          }
          if (visited.has(currentAncestorId)) {
            // Cycle in pre-existing corrupt data not involving `id`; stop walk to avoid hanging
            break;
          }
          visited.add(currentAncestorId);
          hops++;
          const ancestor = await this.investorRepo.findById(
            workspaceId,
            currentAncestorId,
            exec,
          );
          if (!ancestor) {
            break;
          }
          currentAncestorId = ancestor.parent_investor_id ?? null;
        }
      }

      const updates: Partial<Tables<'fl_investors'>> = {};
      if (input.name !== undefined) updates.name = input.name.trim();
      if (input.legal_name !== undefined) updates.legal_name = input.legal_name;
      if (input.english_name !== undefined) updates.english_name = input.english_name;
      if (input.investor_type !== undefined)
        updates.investor_type = input.investor_type;
      if (input.country !== undefined) updates.country = input.country;
      if (input.parent_investor_id !== undefined)
        updates.parent_investor_id = input.parent_investor_id;
      if (input.notes !== undefined) updates.notes = input.notes;

      const updated = await this.investorRepo.update(
        workspaceId,
        id,
        updates,
        exec,
      );
      if (!updated) {
        throw new EntityNotFoundError(`Investor ${id} could not be updated`);
      }
      return updated;
    });
  }

  async deleteInvestor(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.investorRepo.findById(workspaceId, id, exec);
      if (!existing) {
        throw new EntityNotFoundError(
          `Investor ${id} not found in workspace ${workspaceId}`,
        );
      }
      await this.investorRepo.delete(workspaceId, id, exec);
    });
  }

  async updateFund(
    workspaceId: string,
    id: string,
    input: UpdateFundInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_funds'>> {
    if (
      input.mgmt_fee_rate !== undefined &&
      input.mgmt_fee_rate !== null &&
      typeof input.mgmt_fee_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'mgmt_fee_rate must be a string, received ' +
          typeof input.mgmt_fee_rate,
      );
    }
    if (
      input.carry_rate !== undefined &&
      input.carry_rate !== null &&
      typeof input.carry_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'carry_rate must be a string, received ' + typeof input.carry_rate,
      );
    }
    if (
      input.preferred_return_rate !== undefined &&
      input.preferred_return_rate !== null &&
      typeof input.preferred_return_rate !== 'string'
    ) {
      throw new InvalidEntryShapeError(
        'preferred_return_rate must be a string, received ' +
          typeof input.preferred_return_rate,
      );
    }

    return this.withExecutor(executor, async (exec) => {
      const existing = await this.fundRepo.findById(workspaceId, id, exec);
      if (!existing) {
        throw new EntityNotFoundError(
          `Fund ${id} not found in workspace ${workspaceId}`,
        );
      }

      if (input.name !== undefined) {
        const cleanName = input.name.trim();
        if (cleanName === '') {
          throw new InvalidMasterDataError('Fund name cannot be empty');
        }
        const existingList = await this.fundRepo.findByWorkspaceId(workspaceId, exec);
        const duplicate = existingList.find(
          (f) =>
            f.id !== id &&
            (isSameBusinessIdentity(f.name, cleanName) ||
              (f.legal_name && isSameBusinessIdentity(f.legal_name, cleanName))),
        );
        if (duplicate) {
          throw new InvalidMasterDataError(
            `Fund "${cleanName}" already exists in workspace ${workspaceId}`,
          );
        }
      }
      if (input.ownership_basis !== undefined) {
        const validBasis = ['units', 'commitment', 'capital_account'];
        if (!validBasis.includes(input.ownership_basis)) {
          throw new InvalidMasterDataError(`Invalid ownership_basis: ${input.ownership_basis}`);
        }
      }
      if (input.base_currency !== undefined) {
        validateCurrency(input.base_currency);
      }
      if (input.status !== undefined) {
        const validStatuses = [
          'raising',
          'investing',
          'harvesting',
          'liquidated',
        ];
        if (!validStatuses.includes(input.status)) {
          throw new InvalidMasterDataError(`Invalid fund status: ${input.status}`);
        }
      }

      const updates: Partial<Tables<'fl_funds'>> = {};
      if (input.name !== undefined) updates.name = input.name.trim();
      if (input.legal_name !== undefined) updates.legal_name = input.legal_name;
      if (input.english_name !== undefined) updates.english_name = input.english_name;
      if (input.registration_no !== undefined)
        updates.registration_no = input.registration_no;
      if (input.managed !== undefined) updates.managed = input.managed;
      if (input.ownership_basis !== undefined)
        updates.ownership_basis = input.ownership_basis;
      if (input.base_currency !== undefined)
        updates.base_currency = validateCurrency(input.base_currency);
      if (input.vintage_year !== undefined)
        updates.vintage_year = input.vintage_year;
      if (input.fund_life_years !== undefined)
        updates.fund_life_years = input.fund_life_years;
      if (input.status !== undefined) updates.status = input.status;
      if (input.mgmt_fee_rate !== undefined)
        updates.mgmt_fee_rate = input.mgmt_fee_rate;
      if (input.carry_rate !== undefined) updates.carry_rate = input.carry_rate;
      if (input.preferred_return_rate !== undefined)
        updates.preferred_return_rate = input.preferred_return_rate;
      if (input.description !== undefined)
        updates.description = input.description;

      const updated = await this.fundRepo.update(
        workspaceId,
        id,
        updates,
        exec,
      );
      if (!updated) {
        throw new EntityNotFoundError(`Fund ${id} could not be updated`);
      }
      return updated;
    });
  }

  async deleteFund(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.fundRepo.findById(workspaceId, id, exec);
      if (!existing) {
        throw new EntityNotFoundError(
          `Fund ${id} not found in workspace ${workspaceId}`,
        );
      }
      await this.fundRepo.delete(workspaceId, id, exec);
    });
  }

  async updateAsset(
    workspaceId: string,
    id: string,
    input: UpdateAssetInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_assets'>> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.assetRepo.findById(workspaceId, id, exec);
      if (!existing) {
        throw new EntityNotFoundError(
          `Asset ${id} not found in workspace ${workspaceId}`,
        );
      }
      if (input.name !== undefined) {
        const cleanName = input.name.trim();
        if (cleanName === '') {
          throw new InvalidMasterDataError('Asset name cannot be empty');
        }
        const existingList = await this.assetRepo.findByWorkspaceId(workspaceId, exec);
        const duplicate = existingList.find(
          (a) =>
            a.id !== id &&
            (isSameBusinessIdentity(a.name, cleanName) ||
              (a.legal_name && isSameBusinessIdentity(a.legal_name, cleanName))),
        );
        if (duplicate) {
          throw new InvalidMasterDataError(
            `Asset "${cleanName}" already exists in workspace ${workspaceId}`,
          );
        }
      }
      if (input.asset_kind !== undefined) {
        const validKinds = [
          'equity',
          'loan',
          'note',
          'safe',
          'real_estate',
          'listed_security',
          'cash',
          'other',
        ];
        if (!validKinds.includes(input.asset_kind)) {
          throw new InvalidMasterDataError(`Invalid asset_kind: ${input.asset_kind}`);
        }
      }

      const updates: Partial<Tables<'fl_assets'>> = {};
      if (input.name !== undefined) updates.name = input.name.trim();
      if (input.legal_name !== undefined) updates.legal_name = input.legal_name;
      if (input.english_name !== undefined)
        updates.english_name = input.english_name;
      if (input.asset_kind !== undefined) updates.asset_kind = input.asset_kind;
      if (input.country !== undefined) updates.country = input.country;
      if (input.sector !== undefined) updates.sector = input.sector;
      if (input.sub_sector !== undefined) updates.sub_sector = input.sub_sector;
      if (input.instrument_terms !== undefined)
        updates.instrument_terms = input.instrument_terms ?? {};
      if (input.description !== undefined)
        updates.description = input.description;

      const updated = await this.assetRepo.update(
        workspaceId,
        id,
        updates,
        exec,
      );
      if (!updated) {
        throw new EntityNotFoundError(`Asset ${id} could not be updated`);
      }
      return updated;
    });
  }

  async deleteAsset(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.assetRepo.findById(workspaceId, id, exec);
      if (!existing) {
        throw new EntityNotFoundError(
          `Asset ${id} not found in workspace ${workspaceId}`,
        );
      }
      await this.assetRepo.delete(workspaceId, id, exec);
    });
  }

  async updateFundingSource(
    workspaceId: string,
    id: string,
    input: UpdateFundingSourceInput,
    executor?: DbClient,
  ): Promise<Tables<'fl_funding_sources'>> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.fundingSourceRepo.findById(
        workspaceId,
        id,
        exec,
      );
      if (!existing) {
        throw new EntityNotFoundError(
          `Funding source ${id} not found in workspace ${workspaceId}`,
        );
      }
      if (input.name !== undefined) {
        const cleanName = input.name.trim();
        if (cleanName === '') {
          throw new InvalidMasterDataError('Funding source name cannot be empty');
        }
        const existingList = await this.fundingSourceRepo.findByWorkspaceId(workspaceId, exec);
        const duplicate = existingList.find(
          (s) => s.id !== id && isSameBusinessIdentity(s.name, cleanName),
        );
        if (duplicate) {
          throw new InvalidMasterDataError(
            `Funding source "${cleanName}" already exists in workspace ${workspaceId}`,
          );
        }
      }

      if (
        input.owner_investor_id !== undefined &&
        input.owner_investor_id !== null
      ) {
        const owner = await this.investorRepo.findById(
          workspaceId,
          input.owner_investor_id,
          exec,
        );
        if (!owner) {
          throw new WorkspaceMismatchError(
            `Owner investor ${input.owner_investor_id} does not exist in workspace ${workspaceId}`,
          );
        }
      }

      const updates: Partial<Tables<'fl_funding_sources'>> = {};
      if (input.name !== undefined) updates.name = input.name.trim();
      if (input.source_type !== undefined)
        updates.source_type = input.source_type;
      if (input.owner_investor_id !== undefined)
        updates.owner_investor_id = input.owner_investor_id;
      if (input.currency !== undefined) {
        updates.currency = input.currency
          ? validateCurrency(input.currency)
          : null;
      }

      const updated = await this.fundingSourceRepo.update(
        workspaceId,
        id,
        updates,
        exec,
      );
      if (!updated) {
        throw new EntityNotFoundError(
          `Funding source ${id} could not be updated`,
        );
      }
      return updated;
    });
  }

  async deleteFundingSource(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    return this.withExecutor(executor, async (exec) => {
      const existing = await this.fundingSourceRepo.findById(
        workspaceId,
        id,
        exec,
      );
      if (!existing) {
        throw new EntityNotFoundError(
          `Funding source ${id} not found in workspace ${workspaceId}`,
        );
      }
      await this.fundingSourceRepo.delete(workspaceId, id, exec);
    });
  }
}
