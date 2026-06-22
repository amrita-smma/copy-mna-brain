import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { domainClassifications, emailAttachments, rawEmails } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from '@/lib/repositories';

export type EmailAttachment = Tables<'email_attachments'>;
export type EmailAttachmentInsert = TablesInsert<'email_attachments'>;

export type AttachmentState =
  | 'metadata_only'
  | 'needs_fetch'
  | 'needs_triage'
  | 'needs_extract'
  | 'done'
  | 'dropped'
  | 'failed';

export type GateReason = 'deal_company' | 'domain_industry' | 'deal_topic';

export class EmailAttachmentRepository {
  constructor(private readonly db: DbClient) {}

  async upsertBatch(rows: EmailAttachmentInsert[]): Promise<EmailAttachment[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(emailAttachments)
      .values(rows)
      .onConflictDoUpdate({
        target: [emailAttachments.message_id, emailAttachments.content_hash],
        set: {
          part_index: sql`EXCLUDED.part_index`,
          filename: sql`EXCLUDED.filename`,
          mime_type: sql`EXCLUDED.mime_type`,
          size_bytes: sql`EXCLUDED.size_bytes`,
          encoding: sql`EXCLUDED.encoding`,
          updated_at: sql`now()`,
        },
      })
      .returning();
  }

  async listByState(state: AttachmentState, limit: number): Promise<EmailAttachment[]> {
    return this.db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.state, state))
      .limit(limit);
  }

  async promoteToFetch(ids: string[], gateReason: GateReason): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(emailAttachments)
      .set({ state: 'needs_fetch', gate_reason: gateReason, updated_at: sql`now()` })
      .where(and(inArray(emailAttachments.id, ids), eq(emailAttachments.state, 'metadata_only')));
  }

  async markDropped(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(emailAttachments)
      .set({ state: 'dropped', updated_at: sql`now()` })
      .where(inArray(emailAttachments.id, ids));
  }

  // Promotes non-PDF types (e.g. PPTX) that bypass Haiku triage directly to
  // needs_extract so attachmentUpload can pick them up.
  async promoteToUpload(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(emailAttachments)
      .set({ state: 'needs_extract', triaged_at: sql`now()`, updated_at: sql`now()` })
      .where(inArray(emailAttachments.id, ids));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(emailAttachments)
      .set({ state: 'failed', error, updated_at: sql`now()` })
      .where(eq(emailAttachments.id, id));
  }

  async listFetchTargetsByFile(limit: number): Promise<{ file_id: string; ids: string[] }[]> {
    const rows = await this.db
      .select({ id: emailAttachments.id, file_id: emailAttachments.file_id })
      .from(emailAttachments)
      .where(eq(emailAttachments.state, 'needs_fetch'))
      .limit(limit);

    const byFile = new Map<string, string[]>();
    for (const row of rows) {
      const arr = byFile.get(row.file_id) ?? [];
      arr.push(row.id);
      byFile.set(row.file_id, arr);
    }
    return Array.from(byFile.entries()).map(([file_id, ids]) => ({ file_id, ids }));
  }

  async findById(id: string): Promise<EmailAttachment | null> {
    const [row] = await this.db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.id, id))
      .limit(1);
    return row ?? null;
  }

  // ── P2: fetch ─────────────────────────────────────────────────────────────

  async listNeedsFetch(limit: number): Promise<EmailAttachment[]> {
    return this.db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.state, 'needs_fetch'))
      .limit(limit);
  }

  async markFetched(
    id: string,
    opts: { s3_bucket: string; s3_key: string; size_bytes: number },
  ): Promise<void> {
    await this.db
      .update(emailAttachments)
      .set({
        state: 'needs_triage',
        s3_bucket: opts.s3_bucket,
        s3_key: opts.s3_key,
        size_bytes: opts.size_bytes,
        fetched_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(emailAttachments.id, id));
  }

  // Find an already-uploaded attachment by content_hash (cross-email dedup).
  async findUploadedByHash(contentHash: string): Promise<EmailAttachment | null> {
    const [row] = await this.db
      .select()
      .from(emailAttachments)
      .where(
        and(
          eq(emailAttachments.content_hash, contentHash),
          isNotNull(emailAttachments.s3_key),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // ── P2: triage ────────────────────────────────────────────────────────────

  // Returns needs_triage rows grouped by content_hash (deduplicated).
  // Triage runs once per distinct document; verdict fans back to all rows.
  async listDistinctNeedsTriageHashes(limit: number): Promise<
    { content_hash: string; mime_type: string | null; s3_key: string; s3_bucket: string; ids: string[] }[]
  > {
    const rows = await this.db
      .select({
        id: emailAttachments.id,
        content_hash: emailAttachments.content_hash,
        mime_type: emailAttachments.mime_type,
        s3_key: emailAttachments.s3_key,
        s3_bucket: emailAttachments.s3_bucket,
      })
      .from(emailAttachments)
      .where(
        and(
          eq(emailAttachments.state, 'needs_triage'),
          isNotNull(emailAttachments.s3_key),
        ),
      )
      .limit(limit);

    const grouped = new Map<
      string,
      { content_hash: string; mime_type: string | null; s3_key: string; s3_bucket: string; ids: string[] }
    >();
    for (const row of rows) {
      if (!row.s3_key || !row.s3_bucket) continue;
      const entry = grouped.get(row.content_hash) ?? {
        content_hash: row.content_hash,
        mime_type: row.mime_type,
        s3_key: row.s3_key,
        s3_bucket: row.s3_bucket,
        ids: [],
      };
      entry.ids.push(row.id);
      grouped.set(row.content_hash, entry);
    }
    return Array.from(grouped.values());
  }

  async setDocType(
    ids: string[],
    opts: { doc_type: string; triage_confidence: string; nextState: AttachmentState },
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(emailAttachments)
      .set({
        state: opts.nextState,
        doc_type: opts.doc_type,
        triage_confidence: opts.triage_confidence,
        triaged_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(inArray(emailAttachments.id, ids));
  }

  // ── P3: extract ───────────────────────────────────────────────────────────

  async listDistinctNeedsExtractHashes(limit: number): Promise<
    { content_hash: string; doc_type: string | null; mime_type: string | null; filename: string | null; s3_key: string; s3_bucket: string; banker_source: string | null; ids: string[] }[]
  > {
    const rows = await this.db
      .select({
        id: emailAttachments.id,
        content_hash: emailAttachments.content_hash,
        doc_type: emailAttachments.doc_type,
        mime_type: emailAttachments.mime_type,
        filename: emailAttachments.filename,
        s3_key: emailAttachments.s3_key,
        s3_bucket: emailAttachments.s3_bucket,
        // Prefer the resolved firm, then fall back through sender identity.
        banker_source: sql<string | null>`
          case
            when nullif(${domainClassifications.name}, '') is not null
              then nullif(${domainClassifications.name}, '')
            when nullif(lower(split_part(${rawEmails.from_address}, '@', 2)), '') is not null
              then nullif(lower(split_part(${rawEmails.from_address}, '@', 2)), '')
            when nullif(${rawEmails.from_display_name}, '') is not null
              then nullif(${rawEmails.from_display_name}, '')
            else ${rawEmails.from_address}
          end
        `,
      })
      .from(emailAttachments)
      .leftJoin(rawEmails, eq(rawEmails.message_id, emailAttachments.message_id))
      .leftJoin(
        domainClassifications,
        sql`lower(split_part(${rawEmails.from_address}, '@', 2)) = ${domainClassifications.domain}`,
      )
      .where(
        and(
          eq(emailAttachments.state, 'needs_extract'),
          isNotNull(emailAttachments.s3_key),
        ),
      )
      .limit(limit);

    const grouped = new Map<
      string,
      { content_hash: string; doc_type: string | null; mime_type: string | null; filename: string | null; s3_key: string; s3_bucket: string; banker_source: string | null; ids: string[] }
    >();
    for (const row of rows) {
      if (!row.s3_key || !row.s3_bucket) continue;
      const entry = grouped.get(row.content_hash) ?? {
        content_hash: row.content_hash,
        doc_type: row.doc_type,
        mime_type: row.mime_type,
        filename: row.filename,
        s3_key: row.s3_key,
        s3_bucket: row.s3_bucket,
        banker_source: row.banker_source,
        ids: [],
      };
      entry.ids.push(row.id);
      grouped.set(row.content_hash, entry);
    }
    return Array.from(grouped.values());
  }

  async markExtracted(ids: string[], extracted: unknown): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(emailAttachments)
      .set({
        state: 'done',
        extracted: extracted as EmailAttachment['extracted'],
        extracted_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(inArray(emailAttachments.id, ids));
  }

  async findDoneByHash(contentHash: string): Promise<EmailAttachment | null> {
    const [row] = await this.db
      .select()
      .from(emailAttachments)
      .where(
        and(
          eq(emailAttachments.content_hash, contentHash),
          eq(emailAttachments.state, 'done'),
          sql`${emailAttachments.extracted}->>'afd_key' IS NOT NULL`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findByMessageIdAndHash(messageId: string, contentHash: string): Promise<EmailAttachment | null> {
    const [row] = await this.db
      .select()
      .from(emailAttachments)
      .where(
        and(
          eq(emailAttachments.message_id, messageId),
          eq(emailAttachments.content_hash, contentHash),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
