import { eq, inArray, sql } from 'drizzle-orm';
import { employerOverrides } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export type EmployerOverride = Tables<'employer_overrides'>;
export type EmployerOverrideInsert = TablesInsert<'employer_overrides'>;

/**
 * Curator-editable domain → name/industry/internal overrides (RFC §6).
 * Replaces the repo-committed `scripts/domains.json`: editable in-app, survives
 * every reprocess, and takes precedence over the LLM classifier.
 */
export class EmployerOverrideRepository {
  constructor(private readonly db: DbClient) {}

  async findByDomain(domain: string): Promise<EmployerOverride | null> {
    const [row] = await this.db
      .select()
      .from(employerOverrides)
      .where(eq(employerOverrides.domain, domain.toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async findManyByDomains(domains: string[]): Promise<EmployerOverride[]> {
    if (domains.length === 0) return [];
    const lowered = domains.map((d) => d.toLowerCase());
    return this.db
      .select()
      .from(employerOverrides)
      .where(inArray(employerOverrides.domain, lowered));
  }

  async listAll(): Promise<EmployerOverride[]> {
    return this.db.select().from(employerOverrides);
  }

  /** Lowercased domains flagged `internal = true` (own-firm senders). */
  async listInternalDomains(): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(employerOverrides)
      .where(eq(employerOverrides.internal, true));
    return rows.map((r) => r.domain);
  }

  /** Lowercased domains flagged `excluded = true` (dropped from ingest). */
  async listExcludedDomains(): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(employerOverrides)
      .where(eq(employerOverrides.excluded, true));
    return rows.map((r) => r.domain);
  }

  /**
   * Upsert a single override (curation write). ON CONFLICT (domain) DO UPDATE
   * stamps edited_by/edited_at so curator intent always wins on reprocess.
   */
  async upsert(row: EmployerOverrideInsert): Promise<EmployerOverride> {
    const [out] = await this.db
      .insert(employerOverrides)
      .values({ ...row, domain: row.domain.toLowerCase() })
      .onConflictDoUpdate({
        target: employerOverrides.domain,
        set: {
          employer_name: sql`EXCLUDED.employer_name`,
          industry: sql`EXCLUDED.industry`,
          internal: sql`EXCLUDED.internal`,
          edited_by: sql`EXCLUDED.edited_by`,
          edited_at: sql`now()`,
        },
      })
      .returning();
    return out;
  }

  async delete(domain: string): Promise<void> {
    await this.db
      .delete(employerOverrides)
      .where(eq(employerOverrides.domain, domain.toLowerCase()));
  }
}
