import { eq, inArray, sql } from 'drizzle-orm';
import { domainClassifications } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type DomainClassification = Tables<'domain_classifications'>;
export type DomainClassificationInsert = TablesInsert<'domain_classifications'>;

export class DomainClassificationRepository {
  constructor(private readonly db: DbClient) {}

  async findByDomain(domain: string): Promise<DomainClassification | null> {
    const [row] = await this.db
      .select()
      .from(domainClassifications)
      .where(eq(domainClassifications.domain, domain.toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async findManyByDomains(domains: string[]): Promise<DomainClassification[]> {
    if (domains.length === 0) return [];
    const lowered = domains.map((d) => d.toLowerCase());
    return this.db
      .select()
      .from(domainClassifications)
      .where(inArray(domainClassifications.domain, lowered));
  }

  /**
   * Subset of `allDomains` that don't have a classification row yet. Used by
   * crm_domain_classify to decide what to send to the LLM.
   */
  async listUnknownDomains(allDomains: string[]): Promise<string[]> {
    if (allDomains.length === 0) return [];
    const known = await this.findManyByDomains(allDomains);
    const knownSet = new Set(known.map((r) => r.domain));
    return allDomains
      .map((d) => d.toLowerCase())
      .filter((d) => !knownSet.has(d));
  }

  /**
   * Bulk upsert. ON CONFLICT (domain) DO UPDATE overwrites every field with
   * the new value, since re-running classification means we explicitly want
   * to refresh.
   */
  async upsertBatch(
    rows: DomainClassificationInsert[],
  ): Promise<DomainClassification[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(domainClassifications)
      .values(rows)
      .onConflictDoUpdate({
        target: domainClassifications.domain,
        set: {
          name: sql`EXCLUDED.name`,
          industry: sql`EXCLUDED.industry`,
          confidence: sql`EXCLUDED.confidence`,
          source: sql`EXCLUDED.source`,
          classified_at: sql`now()`,
        },
      })
      .returning();
  }
}
