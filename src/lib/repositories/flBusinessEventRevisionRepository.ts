import { and, asc, eq, sql } from 'drizzle-orm';
import {
  flBusinessEventRevisions,
  type BusinessEventRevisionSnapshot,
} from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export type { BusinessEventRevisionSnapshot };

export class FlBusinessEventRevisionRepository {
  constructor(private readonly db: DbClient) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  async create(
    input: TablesInsert<'fl_business_event_revisions'>,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_event_revisions'>> {
    const [row] = await this.getExecutor(executor)
      .insert(flBusinessEventRevisions)
      .values(input)
      .returning();
    return row;
  }

  async findByBusinessEventId(
    workspaceId: string,
    businessEventId: string,
    executor?: DbClient,
  ): Promise<Tables<'fl_business_event_revisions'>[]> {
    return this.getExecutor(executor)
      .select()
      .from(flBusinessEventRevisions)
      .where(
        and(
          eq(flBusinessEventRevisions.workspace_id, workspaceId),
          eq(flBusinessEventRevisions.business_event_id, businessEventId),
        ),
      )
      .orderBy(asc(flBusinessEventRevisions.revision_no));
  }

  async nextRevisionNo(
    workspaceId: string,
    businessEventId: string,
    executor?: DbClient,
  ): Promise<number> {
    const [result] = await this.getExecutor(executor)
      .select({
        next: sql<number | null>`coalesce(max(${flBusinessEventRevisions.revision_no}), 0) + 1`,
      })
      .from(flBusinessEventRevisions)
      .where(
        and(
          eq(flBusinessEventRevisions.workspace_id, workspaceId),
          eq(flBusinessEventRevisions.business_event_id, businessEventId),
        ),
      );

    if (!result || result.next == null) {
      return 1;
    }
    return Number(result.next);
  }
}
