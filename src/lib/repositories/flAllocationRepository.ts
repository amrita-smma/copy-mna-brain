import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  flFundingSources,
  flLedgerEntries,
  flLedgerEntryFundingAllocations,
  flPositions,
} from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class FlAllocationRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    data: TablesInsert<'fl_ledger_entry_funding_allocations'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flLedgerEntryFundingAllocations)
      .values(data)
      .returning();
    return row;
  }

  async insert(
    data: TablesInsert<'fl_ledger_entry_funding_allocations'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>> {
    return this.create(data, executor);
  }

  async createMany(
    allocations: TablesInsert<'fl_ledger_entry_funding_allocations'>[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>[]> {
    if (allocations.length === 0) return [];
    return this.getExecutor(executor)
      .insert(flLedgerEntryFundingAllocations)
      .values(allocations)
      .returning();
  }

  async findById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'> | undefined> {
    const rows = await this.getExecutor(executor)
      .select({ allocation: flLedgerEntryFundingAllocations })
      .from(flLedgerEntryFundingAllocations)
      .innerJoin(
        flLedgerEntries,
        eq(
          flLedgerEntryFundingAllocations.ledger_entry_id,
          flLedgerEntries.id,
        ),
      )
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          eq(flLedgerEntryFundingAllocations.id, id),
        ),
      )
      .limit(1);
    return rows[0]?.allocation;
  }

  async findByLedgerEntryIds(
    workspaceId: string,
    ledgerEntryIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>[]> {
    if (ledgerEntryIds.length === 0) return [];
    const rows = await this.getExecutor(executor)
      .select({ allocation: flLedgerEntryFundingAllocations })
      .from(flLedgerEntryFundingAllocations)
      .innerJoin(
        flLedgerEntries,
        eq(
          flLedgerEntryFundingAllocations.ledger_entry_id,
          flLedgerEntries.id,
        ),
      )
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(
        and(
          eq(flPositions.workspace_id, workspaceId),
          inArray(
            flLedgerEntryFundingAllocations.ledger_entry_id,
            ledgerEntryIds,
          ),
        ),
      )
      .orderBy(
        asc(flLedgerEntryFundingAllocations.ledger_entry_id),
        asc(flLedgerEntryFundingAllocations.id),
      );
    return rows.map((r: { allocation: Tables<'fl_ledger_entry_funding_allocations'> }) => r.allocation);
  }

  async findByFundingSourceIds(
    workspaceId: string,
    fundingSourceIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>[]> {
    if (fundingSourceIds.length === 0) return [];
    const rows = await this.getExecutor(executor)
      .select({ allocation: flLedgerEntryFundingAllocations })
      .from(flLedgerEntryFundingAllocations)
      .innerJoin(
        flFundingSources,
        eq(
          flLedgerEntryFundingAllocations.funding_source_id,
          flFundingSources.id,
        ),
      )
      .where(
        and(
          eq(flFundingSources.workspace_id, workspaceId),
          inArray(
            flLedgerEntryFundingAllocations.funding_source_id,
            fundingSourceIds,
          ),
        ),
      )
      .orderBy(
        asc(flLedgerEntryFundingAllocations.funding_source_id),
        asc(flLedgerEntryFundingAllocations.id),
      );
    return rows.map((r: { allocation: Tables<'fl_ledger_entry_funding_allocations'> }) => r.allocation);
  }

  async findByWorkspaceId(
    workspaceId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_ledger_entry_funding_allocations'>[]> {
    const rows = await this.getExecutor(executor)
      .select({ allocation: flLedgerEntryFundingAllocations })
      .from(flLedgerEntryFundingAllocations)
      .innerJoin(
        flLedgerEntries,
        eq(
          flLedgerEntryFundingAllocations.ledger_entry_id,
          flLedgerEntries.id,
        ),
      )
      .innerJoin(
        flPositions,
        eq(flLedgerEntries.position_id, flPositions.id),
      )
      .where(eq(flPositions.workspace_id, workspaceId))
      .orderBy(
        asc(flLedgerEntryFundingAllocations.ledger_entry_id),
        asc(flLedgerEntryFundingAllocations.id),
      );
    return rows.map((r: { allocation: Tables<'fl_ledger_entry_funding_allocations'> }) => r.allocation);
  }

  async delete(id: string, executor?: DbClient): Promise<void> {
    await this.getExecutor(executor)
      .delete(flLedgerEntryFundingAllocations)
      .where(eq(flLedgerEntryFundingAllocations.id, id));
  }

  async deleteByLedgerEntryId(
    ledgerEntryId: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(flLedgerEntryFundingAllocations)
      .where(
        eq(flLedgerEntryFundingAllocations.ledger_entry_id, ledgerEntryId),
      );
  }

  async deleteByLedgerEntryIds(
    ledgerEntryIds: string[],
    executor?: DbClient,
  ): Promise<void> {
    if (ledgerEntryIds.length === 0) return;
    await this.getExecutor(executor)
      .delete(flLedgerEntryFundingAllocations)
      .where(
        inArray(
          flLedgerEntryFundingAllocations.ledger_entry_id,
          ledgerEntryIds,
        ),
      );
  }
}
