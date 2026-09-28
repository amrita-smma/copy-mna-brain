import { and, desc, eq, getTableColumns, isNotNull, isNull, sql } from 'drizzle-orm';
import { insightTemplates, users } from '@/lib/db/schema';
import type { DbClient } from './types';

/** A full template row, HTML included. Only `findById` returns one. */
export type InsightTemplateWithHtml = typeof insightTemplates.$inferSelect;
/** A template's metadata: every column except the HTML document. */
export type InsightTemplate = Omit<InsightTemplateWithHtml, 'html'>;
/** A listing row: the metadata plus the creator's display name. */
export type InsightTemplateListItem = InsightTemplate & { created_by_name: string | null };
export type CreateInsightTemplateInput = typeof insightTemplates.$inferInsert;
export type InsightTemplatePatch = Partial<
  Pick<CreateInsightTemplateInput, 'name' | 'description' | 'icon' | 'html'>
>;

// Every read except findById selects these, so a listing or a write's
// RETURNING never carries each template's full HTML.
const { html: _html, ...summaryColumns } = getTableColumns(insightTemplates);

export class InsightTemplateRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private getExecutor(executor?: DbClient): DbClient {
    return executor ?? this.db;
  }

  private byId(id: string) {
    return and(
      eq(insightTemplates.workspace_id, this.workspaceId),
      eq(insightTemplates.id, id),
    );
  }

  /** A live (not soft-deleted) template by id. */
  private byLiveId(id: string) {
    return and(this.byId(id), isNull(insightTemplates.deleted_at));
  }

  private listWhere(deleted: boolean) {
    return this.db
      .select({ ...summaryColumns, created_by_name: users.name })
      .from(insightTemplates)
      .leftJoin(users, eq(users.id, insightTemplates.created_by))
      .where(
        and(
          eq(insightTemplates.workspace_id, this.workspaceId),
          deleted ? isNotNull(insightTemplates.deleted_at) : isNull(insightTemplates.deleted_at),
        ),
      );
  }

  /** The workspace's live templates, newest first, with the creator's name. */
  async list(): Promise<InsightTemplateListItem[]> {
    return this.listWhere(false).orderBy(desc(insightTemplates.created_at));
  }

  /** The workspace's soft-deleted templates, most recently deleted first. */
  async listDeleted(): Promise<InsightTemplateListItem[]> {
    return this.listWhere(true).orderBy(desc(insightTemplates.deleted_at));
  }

  /** The full row, html included. Soft-deleted rows are left out unless `includeDeleted`. */
  async findById(
    id: string,
    options: { includeDeleted?: boolean; executor?: DbClient } = {},
  ): Promise<InsightTemplateWithHtml | null> {
    const [row] = await this.getExecutor(options.executor)
      .select()
      .from(insightTemplates)
      .where(options.includeDeleted ? this.byId(id) : this.byLiveId(id))
      .limit(1);
    return row ?? null;
  }

  /**
   * A live template's id, workspace and name, without its HTML: the check that
   * a template id an insight records still names a live template, and the
   * name its "From template" header shows. Null when missing or soft-deleted.
   */
  async findLiveRefById(
    id: string,
  ): Promise<Pick<InsightTemplate, 'id' | 'workspace_id' | 'name'> | null> {
    const [row] = await this.db
      .select({
        id: insightTemplates.id,
        workspace_id: insightTemplates.workspace_id,
        name: insightTemplates.name,
      })
      .from(insightTemplates)
      .where(this.byLiveId(id))
      .limit(1);
    return row ?? null;
  }

  async insert(
    input: Omit<CreateInsightTemplateInput, 'workspace_id'>,
    executor?: DbClient,
  ): Promise<InsightTemplate> {
    const [row] = await this.getExecutor(executor)
      .insert(insightTemplates)
      .values({
        ...input,
        workspace_id: this.workspaceId,
      })
      .returning(summaryColumns);
    return row;
  }

  /**
   * Patches a live template. The UPDATE takes the row lock, so inside a
   * transaction it serialises concurrent writers to the same template.
   */
  async update(
    id: string,
    patch: InsightTemplatePatch,
    executor?: DbClient,
  ): Promise<InsightTemplate | null> {
    const exec = this.getExecutor(executor);
    if (Object.keys(patch).length === 0) {
      const [row] = await exec
        .select(summaryColumns)
        .from(insightTemplates)
        .where(this.byLiveId(id))
        .limit(1);
      return row ?? null;
    }
    const [row] = await exec
      .update(insightTemplates)
      .set({ ...patch, updated_at: sql`now()` })
      .where(this.byLiveId(id))
      .returning(summaryColumns);
    return row ?? null;
  }

  /** Moves a live template to Recently deleted. Null when no live row matched. */
  async softDelete(id: string): Promise<InsightTemplate | null> {
    const [row] = await this.db
      .update(insightTemplates)
      .set({ deleted_at: sql`now()` })
      .where(this.byLiveId(id))
      .returning(summaryColumns);
    return row ?? null;
  }

  /** Brings a soft-deleted template back. Null when no deleted row matched. */
  async restore(id: string): Promise<InsightTemplate | null> {
    const [row] = await this.db
      .update(insightTemplates)
      .set({ deleted_at: null })
      .where(and(this.byId(id), isNotNull(insightTemplates.deleted_at)))
      .returning(summaryColumns);
    return row ?? null;
  }

  /** Removes the row for good; its versions cascade with it. */
  async hardDelete(id: string): Promise<InsightTemplate | null> {
    const [row] = await this.db
      .delete(insightTemplates)
      .where(this.byId(id))
      .returning(summaryColumns);
    return row ?? null;
  }
}
