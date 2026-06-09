import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { rawEmailEnrichments, rawEmails } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type RawEmailEnrichment = Tables<'raw_email_enrichments'>;
// Local alias to avoid collision with `RawEmail` already exported from
// `rawEmailRepository.ts` (both surface via the barrel `repositories/index.ts`).
type RawEmailFull = Tables<'raw_emails'>;

export interface ExtractFields {
  candidates: unknown;
  domain_tag: string | null;
  needs_llm: boolean;
  body_snippet: string | null;
}

export interface LlmResultFields {
  topics: string[];
  people: unknown;
  llm_model: string;
  llm_batch_id: string | null;
}

export class RawEmailEnrichmentRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Insert-or-update extract output for a raw_email. Idempotent — re-running
   * the extract step against the same row overwrites the previous candidates /
   * needs_llm flag (cheap, deterministic).
   */
  async upsertExtract(
    rawEmailId: string,
    fields: ExtractFields,
  ): Promise<RawEmailEnrichment> {
    const row: TablesInsert<'raw_email_enrichments'> = {
      raw_email_id: rawEmailId,
      candidates: fields.candidates as RawEmailEnrichment['candidates'],
      domain_tag: fields.domain_tag,
      needs_llm: fields.needs_llm,
      body_snippet: fields.body_snippet,
    };
    const [out] = await this.db
      .insert(rawEmailEnrichments)
      .values(row)
      .onConflictDoUpdate({
        target: rawEmailEnrichments.raw_email_id,
        set: {
          candidates: sql`EXCLUDED.candidates`,
          domain_tag: sql`EXCLUDED.domain_tag`,
          needs_llm: sql`EXCLUDED.needs_llm`,
          body_snippet: sql`EXCLUDED.body_snippet`,
          extracted_at: sql`now()`,
          updated_at: sql`now()`,
        },
      })
      .returning();
    return out;
  }

  async findByRawEmailId(rawEmailId: string): Promise<RawEmailEnrichment | null> {
    const [row] = await this.db
      .select()
      .from(rawEmailEnrichments)
      .where(eq(rawEmailEnrichments.raw_email_id, rawEmailId))
      .limit(1);
    return row ?? null;
  }

  async findByRawEmailIds(ids: string[]): Promise<RawEmailEnrichment[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(rawEmailEnrichments)
      .where(inArray(rawEmailEnrichments.raw_email_id, ids));
  }

  /**
   * Write LLM result (topics + people) for one row and clear the in_batch
   * status. Used by crm_llm_fetch.
   */
  async setLlmResult(
    rawEmailId: string,
    fields: LlmResultFields,
  ): Promise<RawEmailEnrichment> {
    const [row] = await this.db
      .update(rawEmailEnrichments)
      .set({
        topics: fields.topics,
        people: fields.people as RawEmailEnrichment['people'],
        llm_model: fields.llm_model,
        llm_batch_id: fields.llm_batch_id,
        updated_at: new Date().toISOString(),
      })
      .where(eq(rawEmailEnrichments.raw_email_id, rawEmailId))
      .returning();
    if (!row) throw new Error(`raw_email_enrichments for ${rawEmailId} not found`);
    return row;
  }

  /**
   * Raw_emails rows whose extract said needs_llm=true but the LLM step hasn't
   * landed yet. Used by crm_llm_submit to pick up freshly-extracted-but-unsent
   * rows (typically when extract and submit are different jobs).
   */
  async listPendingLlm(limit: number = 100): Promise<RawEmailFull[]> {
    return this.db
      .select()
      .from(rawEmails)
      .innerJoin(
        rawEmailEnrichments,
        eq(rawEmails.id, rawEmailEnrichments.raw_email_id),
      )
      .where(
        and(
          eq(rawEmails.llm_status, 'pending'),
          eq(rawEmailEnrichments.needs_llm, true),
          isNull(rawEmailEnrichments.topics),
        ),
      )
      .limit(limit)
      .then((rows) => rows.map((r) => r.raw_emails as RawEmailFull));
  }

  /**
   * Raw_emails rows ready for crm_ingest: ingest_status='pending' AND
   * llm_status in ('enriched','not_needed').
   */
  async listReadyForIngest(limit: number = 5000): Promise<RawEmailFull[]> {
    return this.db
      .select()
      .from(rawEmails)
      .where(
        and(
          eq(rawEmails.ingest_status, 'pending'),
          inArray(rawEmails.llm_status, ['enriched', 'not_needed']),
          isNotNull(rawEmails.from_address),
        ),
      )
      .orderBy(asc(rawEmails.sent_at))
      .limit(limit);
  }
}
