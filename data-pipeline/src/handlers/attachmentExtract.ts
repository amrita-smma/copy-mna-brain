import Anthropic from '@anthropic-ai/sdk';
import { EmailAttachmentRepository } from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { downloadFile } from '@/lib/s3';

export const ATTACHMENT_EXTRACT_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_LIMIT = 200;

export interface AttachmentExtractPayload {
  limit?: number;
  model?: string;
}

export interface AttachmentExtractResult {
  evaluated: number;
  extracted: number;
  failed: number;
}

const log = (msg: string) => console.log(`[attachment-extract] ${msg}`);

// All fields nullable and non-required — never force the model to fabricate.
// Revenue/EBITDA will be null on teasers and MoMs; that is correct output.
// Financial figures are in the document's native currency (set `currency` field);
// no USD conversion — that happens downstream if needed.
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    company_name: {
      type: ['string', 'null'],
      description: 'Name of the target or issuing company',
    },
    currency: {
      type: ['string', 'null'],
      description: 'Primary currency of financial figures in this document (e.g. USD, IDR, RMB, SGD)',
    },
    revenue_mn: {
      type: ['number', 'null'],
      description: 'Most recent annual revenue in the document\'s native currency (millions)',
    },
    revenue_prior_year_mn: {
      type: ['number', 'null'],
      description: 'Prior year annual revenue in the document\'s native currency (millions), if stated',
    },
    ebitda_mn: {
      type: ['number', 'null'],
      description: 'EBITDA in the document\'s native currency (millions), as explicitly stated',
    },
    ebitda_margin_pct: {
      type: ['number', 'null'],
      description: 'EBITDA margin as a percentage, if explicitly stated (e.g. 18.2 for 18.2%)',
    },
    net_income_mn: {
      type: ['number', 'null'],
      description: 'Net income or net profit/loss in the document\'s native currency (millions)',
    },
    net_debt_mn: {
      type: ['number', 'null'],
      description: 'Net debt in the document\'s native currency (millions), if stated',
    },
    valuation_mn: {
      type: ['number', 'null'],
      description: 'Enterprise value or asking price in the document\'s native currency (millions)',
    },
    deal_size_mn: {
      type: ['number', 'null'],
      description: 'Transaction size or equity consideration in the document\'s native currency (millions)',
    },
    equity_stake_pct: {
      type: ['number', 'null'],
      description: 'Percentage equity stake being transacted (e.g. 40 for 40%), if stated',
    },
    fiscal_period: {
      type: ['string', 'null'],
      description: 'Fiscal year or period the figures refer to (e.g. "FY2024", "H1 2024")',
    },
    deal_stage: {
      type: ['string', 'null'],
      description: 'Stage of the transaction if mentioned (e.g. "pre-LOI", "due diligence", "signed")',
    },
    industry: {
      type: ['string', 'null'],
      description: 'Industry or sector of the target company',
    },
    key_dates: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'Important dates mentioned (e.g. bid deadline, closing date)',
    },
    counterparties: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'Names of buyers, sellers, advisors, or other parties mentioned',
    },
    summary: {
      type: ['string', 'null'],
      description: 'One or two sentence description of the deal or document',
    },
  },
  // No required fields — the model must be free to emit null for anything
  // not explicitly present in the document.
} as const;

const SYSTEM_PROMPT = `You extract structured deal information from M&A documents.

Rules:
- Transcribe only figures and facts explicitly stated in the document.
- Do NOT calculate, infer, or estimate any field.
- Do NOT convert currencies — report figures in the document's stated currency and set the currency field accordingly.
- Use null for any field not present, unclear, or not explicitly stated.
- If a figure is ambiguous or unverifiable, use null.
- For MoM and teasers, most financial fields will be null — that is correct.`;

async function extractDocument(
  client: Anthropic,
  model: string,
  s3Key: string,
  s3Bucket: string,
  docType: string | null,
): Promise<unknown> {
  const pdfBytes = await downloadFile(s3Key, s3Bucket);
  const base64Data = pdfBytes.toString('base64');

  const docTypeHint = docType ? ` This document has been classified as: ${docType}.` : '';

  const res = await client.messages.create({
    model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'extract_deal_info',
        description: 'Extract structured deal information from the document.',
        input_schema: EXTRACT_SCHEMA as unknown as { type: 'object'; [k: string]: unknown },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_deal_info' },
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
          {
            type: 'text',
            text: `Extract deal information from this document.${docTypeHint} Return null for any field not explicitly stated.`,
          },
        ],
      },
    ],
  });

  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('no tool_use block in extraction response');
  }
  return toolUse.input;
}

export async function runAttachmentExtract(
  payload: AttachmentExtractPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<AttachmentExtractResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const limit = Math.max(1, payload.limit ?? DEFAULT_LIMIT);
  const model = payload.model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const repo = new EmailAttachmentRepository(deps.db);

  log(`starting job=${deps.job.id} limit=${limit} model=${model}`);

  const result: AttachmentExtractResult = {
    evaluated: 0,
    extracted: 0,
    failed: 0,
  };

  const groups = await repo.listDistinctNeedsExtractHashes(limit);

  if (groups.length === 0) {
    log('nothing to extract');
    return result;
  }

  log(`distinct docs to extract: ${groups.length}`);

  for (const group of groups) {
    result.evaluated++;

    try {
      const extracted = await extractDocument(
        client, model, group.s3_key, group.s3_bucket, group.doc_type,
      );

      await repo.markExtracted(group.ids, extracted);
      result.extracted++;
      log(`extracted ${group.ids.length} rows (hash=${group.content_hash.slice(0, 8)} type=${group.doc_type})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`extract failed for hash=${group.content_hash.slice(0, 8)}: ${msg}`);
      for (const id of group.ids) {
        await repo.markFailed(id, `extract_error: ${msg}`);
      }
      result.failed++;
    }
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
