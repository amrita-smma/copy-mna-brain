import { and, desc, eq } from 'drizzle-orm';
import { companies, criterias, screenings } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

type ScreeningWithRelations = Pick<
  Tables<'screenings'>,
  'id' | 'company_id' | 'criteria_id' | 'state' | 'result' | 'remarks' | 'created_at' | 'updated_at'
> & {
  company: Pick<Tables<'companies'>, 'target' | 'project_name' | 'pipeline_stage'> | null;
  criterias: Pick<Tables<'criterias'>, 'id' | 'name' | 'prompt'> | null;
};

type PreparedScreening = Pick<Tables<'screenings'>, 'id' | 'company_id' | 'criteria_id'>;

export class ScreeningRepository {
  constructor(private readonly db: DbClient) {}

  async findAllWithRelations(opts: {
    companyId?: string;
    onlyL0?: boolean;
  } = {}): Promise<ScreeningWithRelations[]> {
    const whereExpr = opts.companyId ? eq(screenings.company_id, opts.companyId) : undefined;

    const rows = await this.db
      .select({
        id: screenings.id,
        company_id: screenings.company_id,
        criteria_id: screenings.criteria_id,
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
      })
      .from(screenings)
      .leftJoin(companies, eq(companies.id, screenings.company_id))
      .leftJoin(criterias, eq(criterias.id, screenings.criteria_id))
      .where(whereExpr)
      .orderBy(desc(screenings.created_at));

    const mapped: ScreeningWithRelations[] = rows.map((r) => ({
      id: r.id,
      company_id: r.company_id,
      criteria_id: r.criteria_id,
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
    }));

    if (opts.onlyL0) {
      return mapped.filter((row) => row.company?.pipeline_stage === 'L0');
    }
    return mapped;
  }

  async insert(data: TablesInsert<'screenings'>): Promise<Tables<'screenings'>> {
    const [row] = await this.db.insert(screenings).values(data).returning();
    return row;
  }

  async update(id: string, updates: TablesUpdate<'screenings'>): Promise<Tables<'screenings'>> {
    const [row] = await this.db
      .update(screenings)
      .set(updates)
      .where(eq(screenings.id, id))
      .returning();
    if (!row) throw new Error(`Screening ${id} not found`);
    return row;
  }

  /**
   * For each (companyId, criteriaId) pair: reset to pending if it exists, otherwise insert.
   * Returns the final row id + company_id + criteria_id for each pair.
   */
  async upsertOrReset(
    companyIds: string[],
    criteriaIds: string[],
  ): Promise<PreparedScreening[]> {
    const entries: PreparedScreening[] = [];

    for (const companyId of companyIds) {
      for (const criteriaId of criteriaIds) {
        const [existing] = await this.db
          .select({
            id: screenings.id,
            company_id: screenings.company_id,
            criteria_id: screenings.criteria_id,
          })
          .from(screenings)
          .where(
            and(eq(screenings.company_id, companyId), eq(screenings.criteria_id, criteriaId)),
          )
          .limit(1);

        if (existing) {
          const [updated] = await this.db
            .update(screenings)
            .set({ state: 'pending', result: null, remarks: null } as TablesUpdate<'screenings'>)
            .where(eq(screenings.id, existing.id))
            .returning({
              id: screenings.id,
              company_id: screenings.company_id,
              criteria_id: screenings.criteria_id,
            });
          entries.push(updated);
        } else {
          const [inserted] = await this.db
            .insert(screenings)
            .values({
              company_id: companyId,
              criteria_id: criteriaId,
              state: 'pending',
            } as TablesInsert<'screenings'>)
            .returning({
              id: screenings.id,
              company_id: screenings.company_id,
              criteria_id: screenings.criteria_id,
            });
          entries.push(inserted);
        }
      }
    }

    return entries;
  }
}
