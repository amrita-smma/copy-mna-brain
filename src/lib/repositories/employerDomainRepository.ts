import { eq, inArray, sql } from 'drizzle-orm';
import { employerDomains } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export type EmployerDomain = Tables<'employer_domains'>;
export type EmployerDomainInsert = TablesInsert<'employer_domains'>;

/**
 * Durable domain → employer map (RFC §6). The single source of truth for
 * email-sourced employer identity: a domain is resolved once and persisted
 * here, then reused on every reprocess so facts always re-attach to the same
 * `employer_id`.
 */
export class EmployerDomainRepository {
  constructor(private readonly db: DbClient) {}

  async findByDomain(domain: string): Promise<EmployerDomain | null> {
    const [row] = await this.db
      .select()
      .from(employerDomains)
      .where(eq(employerDomains.domain, domain.toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async findManyByDomains(domains: string[]): Promise<EmployerDomain[]> {
    if (domains.length === 0) return [];
    const lowered = domains.map((d) => d.toLowerCase());
    return this.db
      .select()
      .from(employerDomains)
      .where(inArray(employerDomains.domain, lowered));
  }

  /** All persisted domain → employer mappings as a `Map<domain, employer_id>`. */
  async loadMap(): Promise<Map<string, string>> {
    const rows = await this.db.select().from(employerDomains);
    return new Map(rows.map((r) => [r.domain, r.employer_id]));
  }

  /**
   * Persist new domain → employer mappings. ON CONFLICT (domain) DO NOTHING:
   * an existing mapping is authoritative and must NOT be re-pointed by a
   * reprocess (resolve-once). Re-pointing is a deliberate curation action, not
   * an ingest side-effect. Returns the rows that were actually inserted.
   */
  async persistMany(rows: EmployerDomainInsert[]): Promise<EmployerDomain[]> {
    if (rows.length === 0) return [];
    const normalized = rows.map((r) => ({ ...r, domain: r.domain.toLowerCase() }));
    return this.db
      .insert(employerDomains)
      .values(normalized)
      .onConflictDoNothing({ target: employerDomains.domain })
      .returning();
  }

  /** Move a domain to a different employer (deliberate curation). */
  async repoint(domain: string, employerId: string): Promise<void> {
    await this.db
      .update(employerDomains)
      .set({ employer_id: employerId, source: sql`'manual'` })
      .where(eq(employerDomains.domain, domain.toLowerCase()));
  }
}
