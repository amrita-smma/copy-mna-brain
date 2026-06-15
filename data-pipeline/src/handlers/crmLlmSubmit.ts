import Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray } from 'drizzle-orm';

import { rawEmails as rawEmailsTable } from '@/lib/db/schema';
import {
  LlmBatchRepository,
  RawEmailEnrichmentRepository,
} from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import {
  EMAIL_EXTRACTION_SCHEMA,
  SYSTEM_PROMPT,
  buildUserPrompt,
  safeCustomId,
  mergePeopleWithCandidates,
  processEmail,
  shouldSkip,
  type Candidate,
  type LlmExtraction,
  type ParsedAddress,
  type ParsedEmail,
  type QueueEntry,
  type SkipReason,
} from '../mboxParser';

export const VAULT_CRM_LLM_SUBMIT_TIMEOUT_SECONDS = 1200; // 20 minutes
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

type RawEmailRow = Tables<'raw_emails'>;

export interface CrmLlmSubmitPayload {
  rawEmailIds?: string[];
  limit?: number;
  mode?: 'batch' | 'sync';
  model?: string;
}

export interface CrmLlmSubmitResult {
  mode: 'batch' | 'sync';
  rows_extracted: number;
  rows_needs_llm: number;
  rows_no_llm: number;
  rows_filtered: number;
  batches_submitted: number;
  requests_submitted: number;
  sync_enriched: number;
  errors: number;
}

/**
 * The mboxParser library uses `Headers = Record<string, string[]>` (multi-value
 * per header name). PR #2's parser stores `Record<string, string>` (first
 * value only). Wrap each value in an array so the library's getHeader/etc.
 * accessors work.
 */
function toLibraryHeaders(
  row: RawEmailRow,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(row.raw_headers ?? {})) {
    if (typeof v === 'string') out[k] = [v];
  }
  return out;
}

const log = (msg: string) => console.log(`[crm-llm-submit] ${msg}`);

/** Convert a `raw_emails` row to the `ParsedEmail` shape `processEmail` expects. */
function toParsedEmail(row: RawEmailRow): ParsedEmail {
  const toAddrs: ParsedAddress[] = (row.to_addresses ?? []).map((addr) => ({
    name: '',
    email: addr,
  }));
  const ccAddrs: ParsedAddress[] = (row.cc_addresses ?? []).map((addr) => ({
    name: '',
    email: addr,
  }));
  return {
    message_id: row.message_id,
    date: row.sent_at,
    sender: {
      name: row.from_display_name ?? '',
      email: row.from_address ?? '',
    },
    recipients: toAddrs,
    cc: ccAddrs,
    subject: row.subject ?? '',
    body: row.body_text,
    // raw_emails doesn't store the post-`-- ` signature block; processEmail's
    // signature heuristic ("last 20 non-empty lines") covers this case.
    signature: '',
  };
}

/** Resolve target rows: either by explicit IDs or by listing pending. */
async function resolveTargets(
  db: DbClient,
  payload: CrmLlmSubmitPayload,
): Promise<RawEmailRow[]> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, payload.limit ?? DEFAULT_LIMIT));
  if (payload.rawEmailIds && payload.rawEmailIds.length > 0) {
    return db
      .select()
      .from(rawEmailsTable)
      .where(inArray(rawEmailsTable.id, payload.rawEmailIds));
  }
  return db
    .select()
    .from(rawEmailsTable)
    .where(eq(rawEmailsTable.llm_status, 'pending'))
    .limit(limit);
}

async function setLlmStatus(
  db: DbClient,
  rawEmailId: string,
  status: 'in_batch' | 'enriched' | 'not_needed' | 'failed',
  enrichedAt?: string,
): Promise<void> {
  await db
    .update(rawEmailsTable)
    .set({
      llm_status: status,
      ...(enrichedAt ? { llm_enriched_at: enrichedAt } : {}),
    })
    .where(eq(rawEmailsTable.id, rawEmailId));
}

/**
 * Mark a row as filtered (newsletter / auto-reply / calendar invite / etc.) —
 * no LLM enrichment, no CRM ingest. Skipped at the listReadyForIngest filter
 * since that only picks `ingest_status='pending'`.
 */
async function markFiltered(
  db: DbClient,
  rawEmailId: string,
  _reason: SkipReason,
): Promise<void> {
  await db
    .update(rawEmailsTable)
    .set({
      llm_status: 'not_needed',
      ingest_status: 'filtered',
    })
    .where(eq(rawEmailsTable.id, rawEmailId));
}

export async function runCrmLlmSubmit(
  payload: CrmLlmSubmitPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<CrmLlmSubmitResult> {
  const mode: 'batch' | 'sync' = payload.mode ?? 'batch';
  const model = payload.model ?? DEFAULT_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const client = new Anthropic({ apiKey });
  const enrichmentRepo = new RawEmailEnrichmentRepository(deps.db);
  const batchRepo = new LlmBatchRepository(deps.db);

  const targets = await resolveTargets(deps.db, payload);
  log(`starting job=${deps.job.id} targets=${targets.length} mode=${mode} model=${model}`);

  const result: CrmLlmSubmitResult = {
    mode,
    rows_extracted: 0,
    rows_needs_llm: 0,
    rows_no_llm: 0,
    rows_filtered: 0,
    batches_submitted: 0,
    requests_submitted: 0,
    sync_enriched: 0,
    errors: 0,
  };

  // Pass 1 — filter, extract candidates per row; partition by needs_llm.
  const queueEntries: QueueEntry[] = [];
  const customIdToRawEmailId: Record<string, string> = {};
  const candidatesByRawEmailId: Record<string, Candidate[]> = {};
  for (const row of targets) {
    try {
      // Filter out auto-replies / newsletters / calendar invites BEFORE
      // spending LLM budget. shouldSkip operates on raw headers + body; we
      // store both on raw_emails so this is a direct call.
      const libHeaders = toLibraryHeaders(row);
      const skip = shouldSkip(libHeaders, row.body_text);
      if (skip.skip) {
        log(`filter ${row.id}: ${skip.reason}`);
        await markFiltered(deps.db, row.id, skip.reason);
        result.rows_filtered++;
        continue;
      }

      const parsed = toParsedEmail(row);
      const enriched = processEmail(parsed, { wantRelatedCompanies: true });
      await enrichmentRepo.upsertExtract(row.id, {
        candidates: enriched.candidates,
        domain_tag: enriched.domain_tag,
        needs_llm: enriched.needs_llm,
        body_snippet: enriched.llm_payload?.body_snippet ?? null,
      });
      result.rows_extracted++;

      if (!enriched.needs_llm || !enriched.llm_payload) {
        await setLlmStatus(deps.db, row.id, 'not_needed');
        result.rows_no_llm++;
        continue;
      }

      const customId = safeCustomId(row.message_id);
      customIdToRawEmailId[customId] = row.id;
      candidatesByRawEmailId[row.id] = enriched.candidates;
      queueEntries.push({
        message_id: row.message_id,
        subject: enriched.subject,
        sender_email: enriched.sender.email,
        domain_tag: enriched.domain_tag,
        payload: enriched.llm_payload,
      });
      result.rows_needs_llm++;
    } catch (err) {
      console.error(`[crm-llm-submit] extract failed for ${row.id}:`, err);
      await setLlmStatus(deps.db, row.id, 'failed').catch(() => undefined);
      result.errors++;
    }
  }

  if (queueEntries.length === 0) {
    log(`done (nothing to send): ${JSON.stringify(result)}`);
    return result;
  }

  if (mode === 'sync') {
    // Sync escape hatch — one messages.create per row.
    for (const entry of queueEntries) {
      const rawEmailId = customIdToRawEmailId[safeCustomId(entry.message_id)];
      try {
        const msg = await client.messages.create({
          model,
          max_tokens: 800,
          temperature: 0,
          system: SYSTEM_PROMPT,
          tools: [
            {
              name: 'extract_email_info',
              description: 'Return structured info extracted from the email.',
              input_schema: EMAIL_EXTRACTION_SCHEMA as unknown as {
                type: 'object';
                [k: string]: unknown;
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'extract_email_info' },
          messages: [{ role: 'user', content: buildUserPrompt(entry) }],
        });
        const toolUse = msg.content.find(
          (b): b is Extract<(typeof msg.content)[number], { type: 'tool_use' }> =>
            b.type === 'tool_use',
        );
        if (!toolUse) throw new Error('no tool_use block in response');
        const llmOut = toolUse.input as LlmExtraction;
        const people = mergePeopleWithCandidates(
          llmOut.people ?? [],
          candidatesByRawEmailId[rawEmailId] ?? [],
        );
        const now = new Date().toISOString();
        await enrichmentRepo.setLlmResult(rawEmailId, {
          topics: llmOut.topics ?? [],
          people,
          related_companies: llmOut.related_companies ?? [],
          llm_model: model,
          llm_batch_id: null,
        });
        await setLlmStatus(deps.db, rawEmailId, 'enriched', now);
        result.sync_enriched++;
      } catch (err) {
        console.error(`[crm-llm-submit] sync enrich failed for ${rawEmailId}:`, err);
        await setLlmStatus(deps.db, rawEmailId, 'failed').catch(() => undefined);
        result.errors++;
      }
    }
    log(`done sync: ${JSON.stringify(result)}`);
    return result;
  }

  // Batch mode — submit one batch and mark rows in_batch.
  const requests = queueEntries.map((entry) => ({
    custom_id: safeCustomId(entry.message_id),
    params: {
      model,
      max_tokens: 800,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: 'extract_email_info',
          description: 'Return structured info extracted from the email.',
          input_schema: EMAIL_EXTRACTION_SCHEMA as unknown as {
            type: 'object';
            [k: string]: unknown;
          },
        },
      ],
      tool_choice: { type: 'tool' as const, name: 'extract_email_info' },
      messages: [{ role: 'user' as const, content: buildUserPrompt(entry) }],
    },
  }));

  let batch;
  try {
    batch = await client.messages.batches.create({
      requests: requests as unknown as Parameters<
        typeof client.messages.batches.create
      >[0]['requests'],
    });
  } catch (err) {
    console.error('[crm-llm-submit] batch create failed:', err);
    // Mark all queued rows back to pending so the next run can retry.
    await deps.db
      .update(rawEmailsTable)
      .set({ llm_status: 'pending' })
      .where(
        and(
          inArray(rawEmailsTable.id, Object.values(customIdToRawEmailId)),
          eq(rawEmailsTable.llm_status, 'pending'),
        ),
      );
    throw err;
  }

  await batchRepo.insert({
    anthropic_batch_id: batch.id,
    status: 'in_progress',
    model,
    request_count: requests.length,
    custom_id_map: customIdToRawEmailId,
    submit_job_id: deps.job.id,
  });

  // Mark the raw_emails rows in_batch.
  const inBatchIds = Object.values(customIdToRawEmailId);
  if (inBatchIds.length > 0) {
    await deps.db
      .update(rawEmailsTable)
      .set({ llm_status: 'in_batch' })
      .where(inArray(rawEmailsTable.id, inBatchIds));
  }

  result.batches_submitted = 1;
  result.requests_submitted = requests.length;
  log(`done batch: ${JSON.stringify(result)} batch_id=${batch.id}`);
  return result;
}
