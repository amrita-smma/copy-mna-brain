import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { companies, criterias, investmentThesis, screenings } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

type ScreeningWithRelations = Pick<
  Tables<'screenings'>,
  'id' | 'company_id' | 'criteria_id' | 'track_id' | 'state' | 'result' | 'remarks' | 'created_at' | 'updated_at'
> & {
  company: Pick<Tables<'companies'>, 'target' | 'project_name' | 'pipeline_stage'> | null;
  criterias: Pick<Tables<'criterias'>, 'id' | 'name' | 'prompt'> | null;
  track: Pick<Tables<'investment_thesis'>, 'id' | 'title'> | null;
};

type PreparedScreening = Pick<
  Tables<'screenings'>,
  'id' | 'company_id' | 'criteria_id' | 'track_id'
>;

/** One per-track screening group: a (company, track) pair and its criteria. */
export interface ScreeningGroupInput {
  companyId: string;
  trackId: string;
  criteriaIds: string[];
}

export class ScreeningRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /** Companies belonging to this workspace — used to scope screenings (a
   * child of companies with no workspace_id column of its own). */
  private workspaceCompanyIds() {
    return this.db.select({ id: companies.id }).from(companies).where(eq(companies.workspace_id, this.workspaceId));
  }

  async findAllWithRelations(opts: {
    companyId?: string;
    onlyL0?: boolean;
  } = {}): Promise<ScreeningWithRelations[]> {
    const workspaceCond = eq(companies.workspace_id, this.workspaceId);
    const whereExpr = opts.companyId
      ? and(eq(screenings.company_id, opts.companyId), workspaceCond)
      : workspaceCond;

    const rows = await this.db
      .select({
        id: screenings.id,
        company_id: screenings.company_id,
        criteria_id: screenings.criteria_id,
        track_id: screenings.track_id,
        state: screenings.state,
        result: screenings.result,
        remarks: screenings.remarks,
        created_at: screenings.created_at,
        updated_at: screenings.updated_at,
        company_target: companies.target,
        company_project_name: companies.project_name,
        company_pipeline_stage: companies.pipeline_stage,
        criteria_id_inner: criterias.id,
        criteria_name: criterias.name,
        criteria_prompt: criterias.prompt,
        track_id_inner: investmentThesis.id,
        track_title: investmentThesis.title,
      })
      .from(screenings)
      .innerJoin(companies, eq(companies.id, screenings.company_id))
      .leftJoin(criterias, eq(criterias.id, screenings.criteria_id))
      .leftJoin(investmentThesis, eq(investmentThesis.id, screenings.track_id))
      .where(whereExpr)
      .orderBy(desc(screenings.created_at));

    const mapped: ScreeningWithRelations[] = rows.map((r) => ({
      id: r.id,
      company_id: r.company_id,
      criteria_id: r.criteria_id,
      track_id: r.track_id,
      state: r.state,
      result: r.result,
      remarks: r.remarks,
      created_at: r.created_at,
      updated_at: r.updated_at,
      company:
        r.company_target === null &&
        r.company_project_name === null &&
        r.company_pipeline_stage === null
          ? null
          : {
              target: r.company_target,
              project_name: r.company_project_name,
              pipeline_stage: r.company_pipeline_stage,
            },
      criterias:
        r.criteria_id_inner === null
          ? null
          : { id: r.criteria_id_inner, name: r.criteria_name!, prompt: r.criteria_prompt! },
      track:
        r.track_id_inner === null
          ? null
          : { id: r.track_id_inner, title: r.track_title! },
    }));

    if (opts.onlyL0) {
      return mapped.filter((row) => row.company?.pipeline_stage === 'L0');
    }
    return mapped;
  }

  /**
   * Every screening row for these companies, ordered by company then track so
   * callers can group in one pass. Batched counterpart of
   * `findAllWithRelations({ companyId })` without the joins.
   */
  async findByCompanyIds(
    companyIds: string[],
  ): Promise<
    Pick<Tables<'screenings'>, 'id' | 'company_id' | 'criteria_id' | 'track_id' | 'state' | 'result'>[]
  > {
    if (companyIds.length === 0) return [];
    return this.db
      .select({
        id: screenings.id,
        company_id: screenings.company_id,
        criteria_id: screenings.criteria_id,
        track_id: screenings.track_id,
        state: screenings.state,
        result: screenings.result,
      })
      .from(screenings)
      .where(
        and(
          inArray(screenings.company_id, companyIds),
          inArray(screenings.company_id, this.workspaceCompanyIds()),
        ),
      )
      .orderBy(screenings.company_id, screenings.track_id);
  }

  async insert(data: TablesInsert<'screenings'>): Promise<Tables<'screenings'>> {
    const [row] = await this.db.insert(screenings).values(data).returning();
    return row;
  }

  async update(id: string, updates: TablesUpdate<'screenings'>): Promise<Tables<'screenings'>> {
    const [row] = await this.db
      .update(screenings)
      .set(updates)
      .where(and(eq(screenings.id, id), inArray(screenings.company_id, this.workspaceCompanyIds())))
      .returning();
    if (!row) throw new Error(`Screening ${id} not found`);
    return row;
  }

  /**
   * Idempotent terminal write used as a safety net when a job ends without
   * the AI screening handler having written a result (pre-handler throws,
   * orphaned timeouts, stuck-cleanup sweep). The WHERE clause guarantees
   * we never clobber a real result that did get written.
   */
  async markFailedIfPending(
    id: string,
    remarks: string,
  ): Promise<Tables<'screenings'> | null> {
    const [row] = await this.db
      .update(screenings)
      .set({
        state: 'failed',
        result: 'error',
        remarks,
      } as TablesUpdate<'screenings'>)
      .where(
        and(
          eq(screenings.id, id),
          eq(screenings.state, 'pending'),
          inArray(screenings.company_id, this.workspaceCompanyIds()),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * For each (companyId, trackId, criteriaId) triple in the given groups: reset
   * to pending if it exists, otherwise insert. Returns the final row id +
   * company_id + criteria_id + track_id for each triple.
   */
  async upsertOrReset(groups: ScreeningGroupInput[]): Promise<PreparedScreening[]> {
    const returning = {
      id: screenings.id,
      company_id: screenings.company_id,
      criteria_id: screenings.criteria_id,
      track_id: screenings.track_id,
    };
    const entries: PreparedScreening[] = [];

    for (const { companyId, trackId, criteriaIds } of groups) {
      for (const criteriaId of criteriaIds) {
        const [existing] = await this.db
          .select({ id: screenings.id })
          .from(screenings)
          .where(
            and(
              eq(screenings.company_id, companyId),
              trackId === null
                ? isNull(screenings.track_id)
                : eq(screenings.track_id, trackId),
              eq(screenings.criteria_id, criteriaId),
              inArray(screenings.company_id, this.workspaceCompanyIds()),
            ),
          )
          .limit(1);

        if (existing) {
          const [updated] = await this.db
            .update(screenings)
            .set({ state: 'pending', result: null, remarks: null } as TablesUpdate<'screenings'>)
            .where(eq(screenings.id, existing.id))
            .returning(returning);
          entries.push(updated);
        } else {
          const [inserted] = await this.db
            .insert(screenings)
            .values({
              company_id: companyId,
              criteria_id: criteriaId,
              track_id: trackId,
              state: 'pending',
            } as TablesInsert<'screenings'>)
            .returning(returning);
          entries.push(inserted);
        }
      }
    }

    return entries;
  }
}
