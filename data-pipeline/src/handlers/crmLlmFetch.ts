import Anthropic from '@anthropic-ai/sdk';
import { eq, inArray } from 'drizzle-orm';

import { rawEmails as rawEmailsTable } from '@/lib/db/schema';
import {
  LlmBatchRepository,
  RawEmailEnrichmentRepository,
} from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import {
  mergePeopleWithCandidates,
  type Candidate,
  type LlmExtraction,
} from '../mboxParser';

export const VAULT_CRM_LLM_FETCH_TIMEOUT_SECONDS = 600; // 10 minutes

export interface CrmLlmFetchResult {
  batches_polled: number;
  batches_fetched: number;
  batches_failed: number;
  rows_enriched: number;
  rows_failed: number;
}

const log = (msg: string) => console.log(`[crm-llm-fetch] ${msg}`);

export async function runCrmLlmFetch(
  _payload: Record<string, unknown>,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<CrmLlmFetchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const client = new Anthropic({ apiKey });
  const batchRepo = new LlmBatchRepository(deps.db);
  const enrichmentRepo = new RawEmailEnrichmentRepository(deps.db);

  const inFlight = await batchRepo.listInProgress();
  log(`starting job=${deps.job.id} in_flight=${inFlight.length}`);

  const result: CrmLlmFetchResult = {
    batches_polled: 0,
    batches_fetched: 0,
    batches_failed: 0,
    rows_enriched: 0,
    rows_failed: 0,
  };

  for (const batch of inFlight) {
    result.batches_polled++;
    let remote;
    try {
      remote = await client.messages.batches.retrieve(batch.anthropic_batch_id);
    } catch (err) {
      console.error(`[crm-llm-fetch] retrieve failed for ${batch.anthropic_batch_id}:`, err);
      continue;
    }

    if (remote.processing_status === 'in_progress') {
      log(`batch ${batch.anthropic_batch_id} still in_progress`);
      continue;
    }

    if (remote.processing_status !== 'ended') {
      // Anything else (canceling, expired, etc.) — mark failed.
      const msg = `unexpected processing_status=${remote.processing_status}`;
      console.error(`[crm-llm-fetch] ${batch.anthropic_batch_id}: ${msg}`);
      await batchRepo.markFailed(batch.id, msg).catch(() => undefined);
      // Drop the raw_emails rows back to 'pending' so the next submit picks them up.
      const ids = Object.values(batch.custom_id_map ?? {});
      if (ids.length > 0) {
        await deps.db
          .update(rawEmailsTable)
          .set({ llm_status: 'pending' })
          .where(inArray(rawEmailsTable.id, ids));
      }
      result.batches_failed++;
      continue;
    }

    // Ended — mark ended, fetch results, write enrichment.
    await batchRepo.markEnded(batch.id, new Date().toISOString());

    // Load candidates for the rows this batch covers (needed for mergePeople).
    const rawEmailIds = Object.values(batch.custom_id_map ?? {});
    const enrichmentsForBatch = await enrichmentRepo.findByRawEmailIds(rawEmailIds);
    const candidatesById = new Map<string, Candidate[]>();
    for (const e of enrichmentsForBatch) {
      candidatesById.set(e.raw_email_id, (e.candidates as Candidate[]) ?? []);
    }

    let resultsStream;
    try {
      resultsStream = await client.messages.batches.results(batch.anthropic_batch_id);
    } catch (err) {
      console.error(`[crm-llm-fetch] results stream failed for ${batch.anthropic_batch_id}:`, err);
      await batchRepo.markFailed(batch.id, `results fetch error: ${(err as Error).message}`);
      result.batches_failed++;
      continue;
    }

    let batchRowsEnriched = 0;
    let batchRowsFailed = 0;
    for await (const item of resultsStream) {
      const rawEmailId = batch.custom_id_map?.[item.custom_id];
      if (!rawEmailId) {
        console.error(`[crm-llm-fetch] no raw_email mapping for custom_id=${item.custom_id}`);
        continue;
      }

      if (item.result.type !== 'succeeded') {
        await deps.db
          .update(rawEmailsTable)
          .set({ llm_status: 'failed' })
          .where(eq(rawEmailsTable.id, rawEmailId));
        batchRowsFailed++;
        continue;
      }

      try {
        const msg = item.result.message;
        const toolUse = msg.content.find(
          (b): b is Extract<(typeof msg.content)[number], { type: 'tool_use' }> =>
            b.type === 'tool_use',
        );
        if (!toolUse) throw new Error('no tool_use block in response');
        const llmOut = toolUse.input as LlmExtraction;
        const people = mergePeopleWithCandidates(
          llmOut.people ?? [],
          candidatesById.get(rawEmailId) ?? [],
        );
        const now = new Date().toISOString();
        await enrichmentRepo.setLlmResult(rawEmailId, {
          topics: llmOut.topics ?? [],
          people,
          llm_model: batch.model,
          llm_batch_id: batch.id,
        });
        await deps.db
          .update(rawEmailsTable)
          .set({ llm_status: 'enriched', llm_enriched_at: now })
          .where(eq(rawEmailsTable.id, rawEmailId));
        batchRowsEnriched++;
      } catch (err) {
        console.error(`[crm-llm-fetch] enrich row ${rawEmailId} failed:`, err);
        await deps.db
          .update(rawEmailsTable)
          .set({ llm_status: 'failed' })
          .where(eq(rawEmailsTable.id, rawEmailId));
        batchRowsFailed++;
      }
    }

    await batchRepo.markFetched(batch.id, deps.job.id);
    log(
      `batch ${batch.anthropic_batch_id}: enriched=${batchRowsEnriched} failed=${batchRowsFailed}`,
    );
    result.batches_fetched++;
    result.rows_enriched += batchRowsEnriched;
    result.rows_failed += batchRowsFailed;
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
