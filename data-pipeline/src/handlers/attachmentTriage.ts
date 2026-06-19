import Anthropic from '@anthropic-ai/sdk';
import { EmailAttachmentRepository } from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { downloadFile } from '@/lib/s3';

export const ATTACHMENT_TRIAGE_TIMEOUT_SECONDS = 600;
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_LIMIT = 500;

// Doc types that proceed to AFD upload.
const DEAL_DOC_TYPES = new Set([
  'prospectus',
  'im',
  'teaser',
  'mom',
  'financial_model',
  'financial_statement',
  'shopping_list',
  'market_study',
]);

// Non-PDF MIME types that bypass Haiku triage and go directly to AFD.
// AFD extracts text from these formats and runs its own classification.
const DIRECT_UPLOAD_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export interface AttachmentTriagePayload {
  limit?: number;
  model?: string;
}

export interface AttachmentTriageResult {
  evaluated: number;
  classified_deal: number;
  classified_other: number;
  promoted_direct: number;
  dropped_unsupported: number;
  failed: number;
}

const log = (msg: string) => console.log(`[attachment-triage] ${msg}`);

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: {
      type: 'string',
      enum: ['prospectus', 'im', 'teaser', 'mom', 'financial_model', 'financial_statement', 'shopping_list', 'market_study', 'other'],
      description: 'The type of deal document',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'Confidence in the classification',
    },
  },
  required: ['doc_type', 'confidence'],
} as const;

const SYSTEM_PROMPT = `You classify M&A deal documents.

Categories:
- prospectus: full prospectus or offering memorandum
- im: information memorandum / CIM
- teaser: one-pager or short teaser
- mom: minutes of meeting
- financial_model: financial model, DCF, LBO, or valuation model
- financial_statement: audited or management accounts, P&L, balance sheet
- shopping_list: target list or deal pipeline of companies being considered for acquisition
- market_study: market landscape, sector overview, or industry analysis
- other: anything else (NDA, legal agreements, presentations without financials, etc.)

Return only the JSON tool call.`;

async function triageDocument(
  client: Anthropic,
  model: string,
  s3Key: string,
  s3Bucket: string,
): Promise<{ doc_type: string; confidence: string }> {
  const pdfBytes = await downloadFile(s3Key, s3Bucket);
  const base64Data = pdfBytes.toString('base64');

  const res = await client.messages.create({
    model,
    max_tokens: 128,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'classify_document',
        description: 'Classify the deal document type.',
        input_schema: TRIAGE_SCHEMA as unknown as { type: 'object'; [k: string]: unknown },
      },
    ],
    tool_choice: { type: 'tool', name: 'classify_document' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Data,
            },
          } as Anthropic.DocumentBlockParam,
          { type: 'text', text: 'Classify this document.' },
        ],
      },
    ],
  });

  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('no tool_use block in triage response');
  }
  const input = toolUse.input as { doc_type: string; confidence: string };
  return { doc_type: input.doc_type ?? 'other', confidence: input.confidence ?? 'low' };
}

export async function runAttachmentTriage(
  payload: AttachmentTriagePayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<AttachmentTriageResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const limit = Math.max(1, payload.limit ?? DEFAULT_LIMIT);
  const model = payload.model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const repo = new EmailAttachmentRepository(deps.db);

  log(`starting job=${deps.job.id} limit=${limit} model=${model}`);

  const result: AttachmentTriageResult = {
    evaluated: 0,
    classified_deal: 0,
    classified_other: 0,
    promoted_direct: 0,
    dropped_unsupported: 0,
    failed: 0,
  };

  // List distinct content_hashes in needs_triage state.
  const groups = await repo.listDistinctNeedsTriageHashes(limit);

  if (groups.length === 0) {
    log('nothing to triage');
    return result;
  }

  log(`distinct docs to triage: ${groups.length}`);

  for (const group of groups) {
    result.evaluated++;

    // Non-PDF Office docs bypass Haiku (no document content block), then AFD
    // extracts text and classifies them.
    if (group.mime_type !== 'application/pdf') {
      if (DIRECT_UPLOAD_MIMES.has(group.mime_type ?? '')) {
        await repo.promoteToUpload(group.ids);
        result.promoted_direct++;
        log(`promoted ${group.ids.length} rows directly to upload (mime: ${group.mime_type})`);
      } else {
        await repo.markDropped(group.ids);
        for (const id of group.ids) {
          await repo.markFailed(id, 'unsupported_type_v1');
        }
        result.dropped_unsupported++;
        log(`dropped ${group.ids.length} rows (unsupported mime: ${group.mime_type})`);
      }
      continue;
    }

    try {
      const { doc_type, confidence } = await triageDocument(
        client, model, group.s3_key, group.s3_bucket,
      );

      const isDealDoc = DEAL_DOC_TYPES.has(doc_type);
      const nextState = isDealDoc ? 'needs_extract' : 'dropped';

      await repo.setDocType(group.ids, { doc_type, triage_confidence: confidence, nextState });

      if (isDealDoc) {
        result.classified_deal++;
        log(`classified ${group.ids.length} rows → ${doc_type} (${confidence})`);
      } else {
        result.classified_other++;
        log(`classified ${group.ids.length} rows → other/dropped (${doc_type})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`triage failed for hash=${group.content_hash.slice(0, 8)}: ${msg}`);
      for (const id of group.ids) {
        await repo.markFailed(id, `triage_error: ${msg}`);
      }
      result.failed++;
    }
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
