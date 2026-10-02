import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { flOwnershipChanges, flCorporateActions } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

/**
 * Data access for funding rounds and their per-position changes. A
 * participation has no workspace column of its own; every read of it is
 * scoped through its parent round's `workspace_id`.
 */
export class FlCorporateActionRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async createAction(
    data: TablesInsert<'fl_corporate_actions'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_corporate_actions'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flCorporateActions)
      .values(data)
      .returning();
    return row;
  }

  async findActionById(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_corporate_actions'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .select()
      .from(flCorporateActions)
      .where(
        and(
          eq(flCorporateActions.workspace_id, workspaceId),
          eq(flCorporateActions.id, id),
        ),
      )
      .limit(1);
    return row;
  }

  /** Rounds for many assets, ordered by asset then date so callers group in one pass. */
  async findActionsByAssetIds(
    workspaceId: string,
    assetIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_corporate_actions'>[]> {
    if (assetIds.length === 0) return [];
    return this.getExecutor(executor)
      .select()
      .from(flCorporateActions)
      .where(
        and(
          eq(flCorporateActions.workspace_id, workspaceId),
          inArray(flCorporateActions.asset_id, assetIds),
        ),
      )
      .orderBy(
        asc(flCorporateActions.asset_id),
        asc(flCorporateActions.action_date),
        asc(flCorporateActions.created_at),
        asc(flCorporateActions.id),
      );
  }

  async updateAction(
    workspaceId: string,
    id: string,
    updates: TablesUpdate<'fl_corporate_actions'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_corporate_actions'> | undefined> {
    const [row] = await this.getExecutor(executor)
      .update(flCorporateActions)
      .set({ ...updates, updated_at: sql`now()` })
      .where(
        and(
          eq(flCorporateActions.workspace_id, workspaceId),
          eq(flCorporateActions.id, id),
        ),
      )
      .returning();
    return row;
  }

  /** Deletes the round; its changes go with it (ON DELETE CASCADE). */
  async deleteAction(
    workspaceId: string,
    id: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(flCorporateActions)
      .where(
        and(
          eq(flCorporateActions.workspace_id, workspaceId),
          eq(flCorporateActions.id, id),
        ),
      );
  }

  /** Participations for many rounds, ordered by round so callers group in one pass. */
  async findChangesByActionIds(
    workspaceId: string,
    roundIds: string[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ownership_changes'>[]> {
    if (roundIds.length === 0) return [];
    const rows = await this.getExecutor(executor)
      .select({ participation: flOwnershipChanges })
      .from(flOwnershipChanges)
      .innerJoin(
        flCorporateActions,
        eq(flOwnershipChanges.corporate_action_id, flCorporateActions.id),
      )
      .where(
        and(
          eq(flCorporateActions.workspace_id, workspaceId),
          inArray(flOwnershipChanges.corporate_action_id, roundIds),
        ),
      )
      .orderBy(
        asc(flOwnershipChanges.corporate_action_id),
        asc(flOwnershipChanges.id),
      );
    return rows.map(
      (r: { participation: Tables<'fl_ownership_changes'> }) => r.participation,
    );
  }

  async insertChanges(
    rows: TablesInsert<'fl_ownership_changes'>[],
    executor?: DbClient,
  ): Promise<Tables<'fl_ownership_changes'>[]> {
    if (rows.length === 0) return [];
    return this.getExecutor(executor)
      .insert(flOwnershipChanges)
      .values(rows)
      .returning();
  }

  async deleteChangesByActionId(
    roundId: string,
    executor?: DbClient,
  ): Promise<void> {
    await this.getExecutor(executor)
      .delete(flOwnershipChanges)
      .where(eq(flOwnershipChanges.corporate_action_id, roundId));
  }
}
