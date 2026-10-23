/**
 * Ephemeral single-pass email processor (no-S3 cutover).
 *
 * Source-agnostic core: given a raw (already-decompressed) MBOX byte stream
 * plus a stable source identity, it streams messages in batches:
 * privacy filter → bounded sync LLM → CRM upsert (no raw_emails / no
 * body_text) → attachment triage/Smart Files, persisting only a resumable cursor +
 * counters in analytics.email_process_runs.
 *
 * No MBOX bytes are ever read from or written to S3. The Vault poll spools one
 * entry at a time to Lambda /tmp and feeds it here; Smart Files may still store
 * approved deal attachments.
 *
 * Resume: same source_key, in_progress/failed run with fail_count < MAX.
 */

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import {
  streamMboxMessages,
  parseMessage,
  getHeader,
  extractRawAttachmentParts,
  processEmail,
  buildUserPrompt,
  SYSTEM_PROMPT,
  EMAIL_EXTRACTION_SCHEMA,
  runPrivacyFilter,
  isSensitiveAttachmentFilename,
  isOfficeAttachment,
  shouldBypassPdfTriage,
  shouldBypassOfficeTriage,
  clipOfficeTriageText,
  hasEnoughOfficeExtractText,
  OFFICE_TRIAGE_MAX_CHARS,
  type LlmExtraction,
  type ParsedEmail,
  type RawMessage,
  type RawAttachmentPart,
  type Candidate,
} from '../mboxParser';
import { modelSupportsTemperature } from '../lib/modelParams';
import { pipelineLog, pipelineError, custodianHash } from '../lib/pipelineLog';
import { INTERNAL_MAIL_DOMAINS } from '../lib/mailDomains';
import {
  EmployerOverrideRepository,
  UserWorkspaceRepository,
} from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { stripAngleBrackets } from '@/lib/services/googleVaultService';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { MartRepository } from '../repositories';
import {
  inspectPdf,
  officeSizeRefusal,
  xlsxTextPrefix,
  zipEntrySizes,
} from '../lib/attachmentInspect';
import {
  buildNoteOnlyPrompt,
  EMAIL_NOTE_SCHEMA,
  externalAddresses,
  sanitizeEmailNote,
  repairToolInput,
  dropThreadOnlyCompanies,
  type QueueEntry,
} from '../mboxParser/llmEnrich';
import {
  upsertEphemeralCrmBatch,
  upsertEmailNotes,
  type EmailNoteItem,
  type EphemeralCrmMessage,
} from './emailProcessCrm';

export const EMAIL_PROCESS_TIMEOUT_SECONDS = 600;
// Haiku 5.5. Note the extraction calls below force `tool_choice` to a named
// tool: Haiku accepts that, but Opus 5.5 and Sonnet 5.5 reject it with a 400,
// so switching this constant to either of those needs `tool_choice: auto` plus
// `strict: true` on the tool.
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const SOFT_STOP_MS = 480_000;
/** Messages accumulated before bulk dedupe / LLM / CRM. */
export const PROCESS_BATCH_SIZE = 50;
/** Concurrent Anthropic enrich calls within a batch. */
export const LLM_CONCURRENCY = 5;
/** Fail budget (hard + soft) before a source is terminally abandoned. */
export const MAX_PROCESS_FAIL_COUNT = 5;

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

/** Sticky Smart Files types — must match `/api/smart-files` FILE_TYPE_OVERRIDES. */
type SmartFileTypeOverride =
  | 'mom'
  | 'prospectus'
  | 'shopping_list'
  | 'market_study';

/**
 * Map pipeline PDF triage → sticky Smart Files `file_type_override`.
 * Without this, the Smart Files second classifier can mark a real deal PDF as `other`
 * and hard-delete it. `im`/`teaser` pin to `prospectus` (closest sticky
 * deal-target type Smart Files accepts). Financial types have no sticky override.
 */
const SMART_FILE_TYPE_OVERRIDES: Partial<Record<string, SmartFileTypeOverride>> = {
  mom: 'mom',
  shopping_list: 'shopping_list',
  market_study: 'market_study',
  prospectus: 'prospectus',
  im: 'prospectus',
  teaser: 'prospectus',
};

export function smartFileOverrideForDocType(
  docType: string,
): SmartFileTypeOverride | undefined {
  return SMART_FILE_TYPE_OVERRIDES[docType];
}

/**
 * Sticky Smart Files override only when triage confidence is high. Medium/low still
 * upload deal types (without override) so Smart Files can re-classify / drop as other.
 */
export function stickySmartFileOverrideForTriage(
  docType: string,
  confidence: string,
): SmartFileTypeOverride | undefined {
  if (confidence !== 'high') return undefined;
  return smartFileOverrideForDocType(docType);
}

const PDF_TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: {
      type: 'string',
      enum: [
        'prospectus',
        'im',
        'teaser',
        'mom',
        'financial_model',
        'financial_statement',
        'shopping_list',
        'market_study',
        'other',
      ],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['doc_type', 'confidence'],
} as const;

const PDF_TRIAGE_SYSTEM = `You classify M&A deal documents for an investment bank deal-sourcing workflow.
Pick ONE doc_type and a confidence (high|medium|low). Return only the JSON tool call.

Positive categories (deal-related):
- prospectus: document that OFFERS a company/business for sale (CIM/sale prospectus/pitch deck marketing a target).
- im: information memorandum / confidential information memorandum for a live sell-side or buy-side process.
- teaser: short anonymous or named deal teaser for a live process.
- mom: meeting minutes / MoM from a deal meeting (management presentation, buyer update, IC notes).
- financial_model: deal LBO/DCF/3-statement model or valuation workbook tied to a transaction.
- financial_statement: audited or management financials / AFS / P&L / balance sheet for a deal target or process.
- shopping_list: list of multiple deal targets / opportunities being shopped.
- market_study: sector/market landscape prepared for a live mandate or process (not generic news).

Use other for NON-deal material, including:
- invoices, expense/hotel receipts, payroll, HR, CVs, offer letters, passports, personal tax returns
- employee/vendor boilerplate NDAs (employment or supplier confidentiality) — NOT target-process NDAs
- marketing brochures, newsletters, thought-leadership decks with no live process
- buyer/sponsor capability decks that do NOT offer a company for sale
- admin paperwork unrelated to a transaction

Standalone M&A process docs for an active acquisition target (process NDA, teaser, IM, model) stay in the matching deal category — do not mark those as other.`;

/** Operational nouns that make "Project …" a non-deal subject. */
const PROJECT_SUBJECT_NOISE =
  'status|update|sync|meeting|kickoff|review|timeline|plan|management|budget|migration|deployment|setup|admin|tracker';

/**
 * Subject-line heuristic for deal mail (independent of LLM enrich).
 * Avoids `\bim\b` (matches "I'm") and operational "Project update" subjects.
 */
export function subjectLooksDealRelated(
  subject: string | null | undefined,
): boolean {
  if (!subject) return false;
  const s = subject.trim();
  if (!s) return false;

  if (
    /teaser|\bcim\b|\bloi\b|\bnda\b|information\s+memorandum|confidential\s+information\s+memorandum|mandate|process\s+letter/i.test(
      s,
    )
  ) {
    return true;
  }

  // Delimiter-safe "im" — apostrophe (ASCII or typographic) is NOT a left
  // delimiter (blocks "I'm" / "I’m").
  if (/(?:^|[^a-z0-9'’])im(?:$|[^a-z0-9'’])/i.test(s)) {
    return true;
  }

  // Allow Project Titan / Project-Titan / Project_42; reject Project update etc.
  const projectRe = new RegExp(
    `\\bproject[\\s:_.-]+(?!(?:${PROJECT_SUBJECT_NOISE})\\b)[A-Za-z0-9]`,
    'i',
  );
  return projectRe.test(s);
}

/**
 * Whether email enrichment + subject justify Smart Files attachment triage.
 * Subject signal is independent of llm null (AGY: do not lock out CIM subjects
 * when enrich returns no tool_use). Transient LLM errors never reach here —
 * flushBatch retries those before CRM/attach.
 */
export function hasDealSignal(
  llm: Partial<LlmExtraction> | null | undefined,
  subject: string | null | undefined,
): boolean {
  if (subjectLooksDealRelated(subject)) return true;
  if (!llm) return false;
  if ((llm.topics ?? []).some((t) => t.is_deal_related === true)) return true;
  if (
    (llm.related_companies ?? []).some((rc) =>
      Boolean((rc?.company_name ?? '').trim()),
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Stable identity of a single MBOX unit of work. For Vault this is derived
 * from export_id + zip object name + entry path so a re-download resolves to
 * the same run and resumes from the persisted cursor.
 */
export interface MboxSource {
  sourceKey: string;
  custodianEmail: string;
  exportId?: string | null;
  /**
   * Set for a re-extract export (its `created_at`): emails ingested before this
   * instant are extracted again and replace their old rows, and no attachment
   * goes to Smart Files — the first ingest already delivered them.
   */
  reextractSince?: string | null;
  /** Opens the raw (decompressed) mbox byte stream. Called once per attempt. */
  openStream: () =>
    | Promise<AsyncIterable<Buffer>>
    | AsyncIterable<Buffer>;
}

export interface ProcessOptions {
  model?: string;
  batchSize?: number;
  llmConcurrency?: number;
  /** Soft-stop budget (ms). Clamped to [30s, SOFT_STOP_MS]. */
  softStopMs?: number;
}

export type EmailProcessStatus =
  | 'completed'
  | 'in_progress'
  | 'failed'
  | 'abandoned';

export interface EmailProcessResult {
  run_id: string | null;
  status: EmailProcessStatus;
  messages_seen: number;
  messages_skipped: number;
  messages_ingested: number;
  attachments_uploaded: number;
  message_offset: number;
  fail_count: number;
}

const SCOPE = 'email-process';

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function synthesizeMessageId(parts: {
  from: string;
  date: string;
  subject: string;
  body: string;
}): string {
  const seed = `${parts.from}|${parts.date}|${parts.subject}|${parts.body.slice(0, 512)}`;
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

interface RunRow {
  id: string;
  message_offset: number;
  messages_seen: number;
  messages_skipped: number;
  messages_ingested: number;
  attachments_uploaded: number;
  fail_count: number;
  status: string;
  afd_uploaded_digests: string[];
}

/** Stable content fingerprint for Smart Files upload idempotency across retries. */
export function attachmentContentDigest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseDigestList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof raw === 'string') {
    try {
      return parseDigestList(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeRunRow(row: RunRow & { afd_uploaded_digests?: unknown }): RunRow {
  return {
    ...row,
    afd_uploaded_digests: parseDigestList(row.afd_uploaded_digests),
  };
}

/**
 * Latest run for a source_key, ordered so in_progress wins over failed over
 * completed. Callers use this to cheaply skip already-terminal entries when a
 * Vault ZIP is re-downloaded for resume.
 */
export async function getSourceRunState(
  db: DbClient,
  sourceKey: string,
): Promise<{ status: string; fail_count: number } | null> {
  const rows = queryRows<{ status: string; fail_count: number }>(
    await db.execute(sql`
      SELECT status, COALESCE(fail_count, 0) AS fail_count
      FROM analytics.email_process_runs
      WHERE source_key = ${sourceKey}
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 0
          WHEN 'failed' THEN 1
          WHEN 'completed' THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT 1
    `),
  );
  return rows[0] ?? null;
}

/** True once a source is completed, or terminally abandoned (budget spent). */
export function isSourceTerminal(state: {
  status: string;
  fail_count: number;
} | null): boolean {
  if (!state) return false;
  if (state.status === 'completed') return true;
  return state.fail_count >= MAX_PROCESS_FAIL_COUNT;
}

async function findResumableRun(
  db: DbClient,
  sourceKey: string,
): Promise<RunRow | null> {
  // Resume in_progress soft-stops first; also reclaim failed runs so a hard
  // error does not discard the committed cursor and start a new run at 0.
  // Terminal poison runs (fail_count >= MAX) are ignored so we do not loop.
  const rows = queryRows<RunRow>(
    await db.execute(sql`
      SELECT id, message_offset, messages_seen, messages_skipped,
             messages_ingested, attachments_uploaded,
             COALESCE(fail_count, 0) AS fail_count, status,
             COALESCE(afd_uploaded_digests, '[]'::jsonb) AS afd_uploaded_digests
      FROM analytics.email_process_runs
      WHERE source_key = ${sourceKey}
        AND status IN ('in_progress', 'failed')
        AND COALESCE(fail_count, 0) < ${MAX_PROCESS_FAIL_COUNT}
      ORDER BY
        CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `),
  );
  return rows[0] ? normalizeRunRow(rows[0]) : null;
}

async function ensureRun(db: DbClient, source: MboxSource): Promise<RunRow> {
  const resumed = await findResumableRun(db, source.sourceKey);
  if (resumed) {
    if (resumed.status === 'failed') {
      await db.execute(sql`
        UPDATE analytics.email_process_runs
        SET status = 'in_progress', error_code = NULL, updated_at = now()
        WHERE id = ${resumed.id}::uuid AND status = 'failed'
      `);
    }
    return normalizeRunRow({ ...resumed, status: 'in_progress' });
  }

  const rows = queryRows<RunRow>(
    await db.execute(sql`
      INSERT INTO analytics.email_process_runs
        (export_id, source_key, custodian_email, status)
      VALUES (
        ${source.exportId ?? null},
        ${source.sourceKey},
        ${source.custodianEmail ?? null},
        'in_progress'
      )
      RETURNING id, message_offset, messages_seen, messages_skipped,
                messages_ingested, attachments_uploaded,
                COALESCE(fail_count, 0) AS fail_count, status,
                COALESCE(afd_uploaded_digests, '[]'::jsonb) AS afd_uploaded_digests
    `),
  );
  const row = rows[0];
  if (!row?.id) {
    throw new Error(
      'failed to create email_process_runs row (is analytics.email_process_runs migrated?)',
    );
  }
  return normalizeRunRow(row);
}

async function updateRun(
  db: DbClient,
  id: string,
  fields: {
    status?: string;
    message_offset?: number;
    messages_seen?: number;
    messages_skipped?: number;
    messages_ingested?: number;
    attachments_uploaded?: number;
    error_code?: string | null;
    fail_count?: number;
    afd_uploaded_digests?: string[];
  },
): Promise<void> {
  const digestsJson =
    fields.afd_uploaded_digests !== undefined
      ? JSON.stringify(fields.afd_uploaded_digests)
      : null;
  await db.execute(sql`
    UPDATE analytics.email_process_runs SET
      status = COALESCE(${fields.status ?? null}, status),
      message_offset = COALESCE(${fields.message_offset ?? null}, message_offset),
      messages_seen = COALESCE(${fields.messages_seen ?? null}, messages_seen),
      messages_skipped = COALESCE(${fields.messages_skipped ?? null}, messages_skipped),
      messages_ingested = COALESCE(${fields.messages_ingested ?? null}, messages_ingested),
      attachments_uploaded = COALESCE(${fields.attachments_uploaded ?? null}, attachments_uploaded),
      error_code = COALESCE(${fields.error_code ?? null}, error_code),
      fail_count = COALESCE(${fields.fail_count ?? null}, fail_count),
      afd_uploaded_digests = COALESCE(${digestsJson}::jsonb, afd_uploaded_digests),
      updated_at = now()
    WHERE id = ${id}::uuid
  `);
}

/**
 * Soft LLM/Smart Files retries must consume the same fail budget as hard errors, or a
 * persistent outage retries forever. Returns the new fail_count.
 */
async function bumpSoftFailCount(
  db: DbClient,
  runId: string,
  current: number,
  errorCode: 'llm_retry' | 'afd_retry',
): Promise<number> {
  const next = current + 1;
  await updateRun(db, runId, {
    status: 'in_progress',
    fail_count: next,
    error_code: errorCode,
  });
  return next;
}

/** Persist hard-fail budget on the run row. Returns the new fail_count. */
export async function persistHardFailure(opts: {
  db: DbClient;
  runId: string;
  failCount: number;
  result: EmailProcessResult;
  err: unknown;
}): Promise<number> {
  const nextFailCount = opts.failCount + 1;
  await opts.db
    .execute(sql`
      UPDATE analytics.email_process_runs SET
        status = 'failed',
        message_offset = ${opts.result.message_offset},
        messages_seen = ${opts.result.messages_seen},
        messages_skipped = ${opts.result.messages_skipped},
        messages_ingested = ${opts.result.messages_ingested},
        attachments_uploaded = ${opts.result.attachments_uploaded},
        fail_count = ${nextFailCount},
        error_code = 'process_failed',
        updated_at = now()
      WHERE id = ${opts.runId}::uuid
    `)
    .catch(() => undefined);
  pipelineError(SCOPE, 'failed', opts.err, {
    run_id: opts.runId,
    message_offset: opts.result.message_offset,
    fail_count: nextFailCount,
  });
  return nextFailCount;
}

/**
 * Headers of the message the attachment came from. Forwarded to Smart Files
 * purely so the ingest notification sent back to the custodian can name the
 * email the document arrived on. Never persisted — the `/api/smart-files`
 * route passes it straight through to the outbound email and drops it.
 */
export interface SmartFileEmailContext {
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  receivedAt?: string;
  /** Message-ID of the email; Smart Files keeps it with the sender address
   *  to link the sender to the deals the attachment created or matched. */
  messageId?: string;
}

/** The `email_context` Smart Files receives for one attachment of `item`. */
export function smartFileEmailContext(item: {
  parsed: Pick<ParsedEmail, 'sender' | 'subject' | 'date'>;
  messageId: string;
}): SmartFileEmailContext {
  return {
    senderName: item.parsed.sender?.name ?? undefined,
    senderEmail: item.parsed.sender?.email ?? undefined,
    subject: item.parsed.subject ?? undefined,
    receivedAt: item.parsed.date ?? undefined,
    messageId: item.messageId || undefined,
  };
}

/**
 * Asks the app to regenerate the relationship overviews (and per-deal lines)
 * of contacts whose notes this invocation wrote. Best-effort: the overview is
 * also regenerated when someone opens the contact, so a failure is logged and
 * never fails the run.
 */
export async function requestOverviewRefresh(opts: {
  workspaceIds: string[];
  since: string;
  runId: string;
}): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/api/auth/crm-overviews/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': process.env.ADMIN_SECRET ?? '',
      },
      body: JSON.stringify({ workspaceIds: opts.workspaceIds, since: opts.since }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`overview refresh ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ claimed?: number }>;
    } | null;
    pipelineLog(SCOPE, 'overview_refresh_requested', {
      run_id: opts.runId,
      claimed: (body?.data ?? []).reduce((n, w) => n + (w.claimed ?? 0), 0),
    });
  } catch (err) {
    pipelineError(SCOPE, 'overview_refresh_failed', err, { run_id: opts.runId });
  }
}

async function uploadBytesToSmartFiles(opts: {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  enteredBy: string;
  workspaceId: string;
  fileTypeOverride?: SmartFileTypeOverride;
  emailContext?: SmartFileEmailContext;
}): Promise<{ dropped: boolean }> {
  const base = process.env.INTERNAL_API_URL ?? 'http://localhost:3000';
  const secret = process.env.ADMIN_SECRET ?? '';
  const params = new URLSearchParams({
    fileName: opts.fileName,
    contentType: opts.contentType,
  });
  const urlRes = await fetch(`${base}/api/smart-files/upload-url?${params}`, {
    headers: { 'x-api-secret': secret },
  });
  if (!urlRes.ok) throw new Error(`upload-url ${urlRes.status}`);
  const { data } = (await urlRes.json()) as {
    data: { uploadUrl: string; key: string };
  };
  const put = await fetch(data.uploadUrl, {
    method: 'PUT',
    body: opts.bytes as unknown as BodyInit,
    headers: { 'Content-Type': opts.contentType },
  });
  if (!put.ok) throw new Error(`S3 PUT ${put.status}`);
  const notify = await fetch(`${base}/api/smart-files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': secret,
    },
    body: JSON.stringify({
      key: data.key,
      fileName: opts.fileName,
      contentType: opts.contentType,
      origin_email: true,
      entered_by: opts.enteredBy,
      workspace_id: opts.workspaceId,
      ...(opts.fileTypeOverride
        ? { file_type_override: opts.fileTypeOverride }
        : {}),
      ...(opts.emailContext ? { email_context: opts.emailContext } : {}),
    }),
  });
  if (!notify.ok) throw new Error(`Smart Files notify ${notify.status}`);
  const body = (await notify.json().catch(() => null)) as {
    data?: { dropped?: boolean };
  } | null;
  const dropped = body?.data?.dropped === true;
  // Sticky override should prevent `other` hard-drops. If Smart Files still drops,
  // treat as a hard failure so the cursor retries instead of silently losing
  // a pipeline-approved deal PDF.
  if (dropped && opts.fileTypeOverride) {
    throw new Error(
      `Smart Files dropped origin_email file despite file_type_override=${opts.fileTypeOverride}`,
    );
  }
  return { dropped };
}

async function triagePdfBytes(
  client: Anthropic,
  model: string,
  bytes: Buffer,
): Promise<{ doc_type: string; confidence: string }> {
  const res = await client.messages.create({
    model,
    max_tokens: 128,
    ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
    system: PDF_TRIAGE_SYSTEM,
    tools: [
      {
        name: 'classify_document',
        description: 'Classify the deal document type.',
        input_schema: PDF_TRIAGE_SCHEMA as unknown as {
          type: 'object';
          [k: string]: unknown;
        },
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
              data: bytes.toString('base64'),
            },
          } as Anthropic.DocumentBlockParam,
          { type: 'text', text: 'Classify this document.' },
        ],
      },
    ],
  });
  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('no tool_use in PDF triage');
  }
  return toolUse.input as { doc_type: string; confidence: string };
}

/**
 * Triage Office attachment text (bounded prefix + filename). Same schema /
 * model / deal types as PDF triage — never sends raw Office bytes to Anthropic.
 */
export async function triageDealDocumentText(
  client: Anthropic,
  model: string,
  opts: { fileName: string; text: string },
): Promise<{ doc_type: string; confidence: string }> {
  const clipped = clipOfficeTriageText(opts.text);
  const res = await client.messages.create({
    model,
    max_tokens: 128,
    ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
    system: PDF_TRIAGE_SYSTEM,
    tools: [
      {
        name: 'classify_document',
        description: 'Classify the deal document type.',
        input_schema: PDF_TRIAGE_SCHEMA as unknown as {
          type: 'object';
          [k: string]: unknown;
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'classify_document' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Filename: ${opts.fileName}\n\nDocument text (prefix):\n${clipped}\n\nClassify this document.`,
          },
        ],
      },
    ],
  });
  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('no tool_use in Office text triage');
  }
  return toolUse.input as { doc_type: string; confidence: string };
}

export type AttachmentTriageOutcome =
  | { kind: 'skip' }
  | { kind: 'upload'; fileTypeOverride?: SmartFileTypeOverride }
  | { kind: 'retry'; err: unknown };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Anthropic rejected the request itself (e.g. a PDF it can't read) — retrying can't help. */
function isRequestRejected(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 400;
}

/**
 * Classify a PDF or Office attachment for Smart Files. Fail closed on extract/triage
 * errors (retry). Skip non-deal, oversized, empty-extract, and non-deal types.
 *
 * Nothing here inflates a whole attachment: a PDF is checked by its object
 * structure only (Anthropic reads the bytes), an Office file's uncompressed
 * XML is sized from the zip directory before extraction, and a workbook is
 * read as a stream up to the triage prefix. A parser that runs the Lambda out
 * of memory would otherwise crash on the same attachment every poll.
 */
export async function triageAttachmentForSmartFiles(opts: {
  mime: string;
  fileName: string;
  bytes: Buffer;
  client: Anthropic;
  model: string;
  extractText?: typeof extractTextFromFile;
  inspectPdfBytes?: typeof inspectPdf;
  readZipSizes?: typeof zipEntrySizes;
  readXlsxPrefix?: typeof xlsxTextPrefix;
}): Promise<AttachmentTriageOutcome> {
  const {
    mime,
    fileName,
    bytes,
    client,
    model,
    extractText = extractTextFromFile,
    inspectPdfBytes = inspectPdf,
    readZipSizes = zipEntrySizes,
    readXlsxPrefix = xlsxTextPrefix,
  } = opts;
  const isPdf =
    mime === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  const isOffice = isOfficeAttachment(mime, fileName);
  if (!isPdf && !isOffice) return { kind: 'skip' };

  if (isPdf) {
    if (shouldBypassPdfTriage(bytes.length)) return { kind: 'skip' };
    // Validate locally before calling Anthropic. Corrupt, encrypted and
    // over-long PDFs fail deterministically, so retrying would eventually
    // abandon the whole mbox source and lose every later message.
    const inspection = await inspectPdfBytes(bytes);
    if ('reason' in inspection) {
      pipelineLog(SCOPE, 'pdf_triage_skip', {
        reason: inspection.reason,
        pages: inspection.pages ?? null,
      });
      return { kind: 'skip' };
    }
    try {
      const triage = await triagePdfBytes(client, model, bytes);
      if (!DEAL_DOC_TYPES.has(triage.doc_type)) return { kind: 'skip' };
      return {
        kind: 'upload',
        fileTypeOverride: stickySmartFileOverrideForTriage(
          triage.doc_type,
          triage.confidence,
        ),
      };
    } catch (err) {
      // The structure check is lenient, so a PDF Anthropic can't read is
      // rejected here — every time, like a local validation failure.
      if (isRequestRejected(err)) {
        pipelineError(SCOPE, 'pdf_triage_rejected', err);
        return { kind: 'skip' };
      }
      return { kind: 'retry', err };
    }
  }

  // Office: size gate → XML size check → extract → empty check → text triage
  if (shouldBypassOfficeTriage(bytes.length)) return { kind: 'skip' };
  const isXlsx = mime === XLSX_MIME || fileName.toLowerCase().endsWith('.xlsx');
  let extracted: string;
  try {
    const refusal = officeSizeRefusal(isXlsx, await readZipSizes(bytes));
    if (refusal) {
      pipelineLog(SCOPE, 'office_triage_skip', { reason: refusal });
      return { kind: 'skip' };
    }
    extracted = isXlsx
      ? await readXlsxPrefix(bytes, OFFICE_TRIAGE_MAX_CHARS)
      : await extractText(bytes, mime, fileName);
  } catch (err) {
    // Corrupt / password-protected / unparseable Office file. This fails the
    // same way on every attempt, so 'retry' would rewind the cursor each poll
    // until the whole source is abandoned and the remaining mail is lost.
    // Skip the upload instead (still fail-closed: untriaged bytes never ship).
    pipelineError(SCOPE, 'office_extract_failed', err);
    return { kind: 'skip' };
  }
  if (!hasEnoughOfficeExtractText(extracted)) return { kind: 'skip' };
  try {
    const triage = await triageDealDocumentText(client, model, {
      fileName,
      text: extracted,
    });
    if (!DEAL_DOC_TYPES.has(triage.doc_type)) return { kind: 'skip' };
    return {
      kind: 'upload',
      fileTypeOverride: stickySmartFileOverrideForTriage(
        triage.doc_type,
        triage.confidence,
      ),
    };
  } catch (err) {
    return { kind: 'retry', err };
  }
}

interface PreparedMessage {
  offset: number;
  raw: RawMessage;
  parsed: ParsedEmail;
  messageId: string;
  fromAddress: string;
  /** Lower-cased To / Cc addresses. */
  toAddresses: string[];
  ccAddresses: string[];
  rawParts: RawAttachmentPart[];
  candidates: Candidate[];
  needsLlm: boolean;
  llmPayload: NonNullable<ReturnType<typeof processEmail>['llm_payload']> | null;
}

/** The LLM queue entry for a message that has an `llmPayload`. */
function queueEntryFor(item: PreparedMessage): QueueEntry {
  return {
    message_id: item.messageId,
    subject: item.parsed.subject ?? '',
    sender_email: item.fromAddress,
    domain_tag: item.fromAddress.split('@')[1] ?? null,
    participants: [
      { role: 'from', address: item.fromAddress },
      ...item.toAddresses.map((address) => ({ role: 'to' as const, address })),
      ...item.ccAddresses.map((address) => ({ role: 'cc' as const, address })),
    ],
    payload: item.llmPayload!,
  };
}

/**
 * Process a single MBOX source end-to-end. No S3 / mbox_files coupling: the
 * caller owns byte delivery (openStream) and cleanup. Never throws for a
 * processing error — hard failures are persisted to the run row and returned
 * as status 'failed' (retryable) or 'abandoned' (budget spent). Only a
 * pre-run infrastructure failure (e.g. ensureRun DB error) propagates.
 */
export async function processMboxSource(
  source: MboxSource,
  opts: ProcessOptions,
  deps: { db: DbClient },
): Promise<EmailProcessResult> {
  const result: EmailProcessResult = {
    run_id: null,
    status: 'failed',
    messages_seen: 0,
    messages_skipped: 0,
    messages_ingested: 0,
    attachments_uploaded: 0,
    message_offset: 0,
    fail_count: 0,
  };

  // Fast terminal short-circuit so re-downloaded ZIP entries are cheap.
  const existingState = await getSourceRunState(deps.db, source.sourceKey);
  if (existingState && isSourceTerminal(existingState)) {
    result.status =
      existingState.status === 'completed' ? 'completed' : 'abandoned';
    result.fail_count = existingState.fail_count;
    pipelineLog(SCOPE, 'source_terminal_skip', {
      source_status: existingState.status,
      fail_count: existingState.fail_count,
    });
    return result;
  }

  const run = await ensureRun(deps.db, source);
  result.run_id = run.id;
  result.status = 'in_progress';
  result.messages_seen = run.messages_seen ?? 0;
  result.messages_skipped = run.messages_skipped ?? 0;
  result.messages_ingested = run.messages_ingested ?? 0;
  result.attachments_uploaded = run.attachments_uploaded ?? 0;
  result.message_offset = run.message_offset;
  let failCount = run.fail_count ?? 0;
  result.fail_count = failCount;
  // Count this attempt before doing any work. A crash that kills the process
  // (out of memory, the Lambda's hard timeout) skips every failure path
  // below, so without this the poll would retry the same entry forever. Batch
  // progress or a clean soft stop gives the attempt back.
  await updateRun(deps.db, run.id, { fail_count: failCount + 1 });
  let attemptCounted = true;
  const uploadedDigests = new Set(run.afd_uploaded_digests);

  const custodianEmail = source.custodianEmail ?? '';
  const reextractSince = source.reextractSince ?? null;

  try {
    if (!custodianEmail || custodianEmail === 'unknown') {
      throw new Error('Unable to resolve MBOX custodian; refusing unscoped CRM writes');
    }
    const workspaceIds = await new UserWorkspaceRepository(
      deps.db,
    ).findWorkspaceIdsBySyncedEmail(custodianEmail);
    if (workspaceIds.length === 0) {
      throw new Error(
        'MBOX custodian is no longer synced to a workspace; refusing CRM and Smart Files writes',
      );
    }
    const primaryWorkspaceId = workspaceIds[0]!;
    const started = Date.now();
    // Notes' created_at is the DB clock; a minute of slack covers skew.
    const notesSince = new Date(started - 60_000).toISOString();
    let notesWritten = false;
    pipelineLog(SCOPE, 'start', {
      run_id: run.id,
      custodian_hash: custodianHash(custodianEmail),
      resume_offset: run.message_offset,
      fail_count: run.fail_count,
      reextract: reextractSince !== null,
    });

    const overrideRepo = new EmployerOverrideRepository(deps.db);
    const excluded = new Set(
      (await overrideRepo.listExcludedDomains()).map((d) => d.toLowerCase()),
    );
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey });
    const model = opts.model ?? DEFAULT_MODEL;
    const batchSize = opts.batchSize ?? PROCESS_BATCH_SIZE;
    const llmConcurrency = opts.llmConcurrency ?? LLM_CONCURRENCY;
    const softStopMs = Math.max(
      30_000,
      Math.min(opts.softStopMs ?? SOFT_STOP_MS, SOFT_STOP_MS),
    );

    let offset = 0;
    const pendingBatch: PreparedMessage[] = [];

    const refreshOverviewsIfNeeded = async (): Promise<void> => {
      if (!notesWritten) return;
      await requestOverviewRefresh({ workspaceIds, since: notesSince, runId: run.id });
    };

    const refreshMartsIfNeeded = async (): Promise<void> => {
      if (result.messages_ingested <= (run.messages_ingested ?? 0)) return;
      try {
        const refreshed = await new MartRepository(deps.db).refreshAll();
        pipelineLog(SCOPE, 'marts_refreshed', {
          run_id: run.id,
          views: refreshed.length,
        });
      } catch (err) {
        pipelineError(SCOPE, 'marts_refresh_failed', err, { run_id: run.id });
      }
    };

    /** Soft-stop requeues; llm/afd retries bump fail_count and may abandon. */
    const finishForResume = async (
      status: 'soft_stop' | 'llm_retry' | 'afd_retry',
    ): Promise<EmailProcessResult> => {
      await refreshMartsIfNeeded();
      await refreshOverviewsIfNeeded();
      if (status === 'llm_retry' || status === 'afd_retry') {
        failCount = await bumpSoftFailCount(deps.db, run.id, failCount, status);
        result.fail_count = failCount;
        if (failCount >= MAX_PROCESS_FAIL_COUNT) {
          result.status = 'abandoned';
          await updateRun(deps.db, run.id, {
            status: 'failed',
            error_code: `${status}_exhausted`,
            message_offset: result.message_offset,
            messages_seen: result.messages_seen,
            messages_skipped: result.messages_skipped,
            messages_ingested: result.messages_ingested,
            attachments_uploaded: result.attachments_uploaded,
            fail_count: failCount,
          });
          pipelineLog(SCOPE, 'abandoned_soft_retry', {
            run_id: run.id,
            fail_count: failCount,
            reason: status,
            message_offset: result.message_offset,
          });
          return result;
        }
      }
      result.status = 'in_progress';
      await updateRun(deps.db, run.id, {
        status: 'in_progress',
        // A soft stop is a clean end of this attempt, not a failure.
        ...(status === 'soft_stop' && attemptCounted ? { fail_count: failCount } : {}),
      });
      pipelineLog(SCOPE, status, {
        run_id: run.id,
        message_offset: result.message_offset,
        fail_count: failCount,
      });
      return result;
    };

    /** One forced tool call; `input` is null when the reply has no tool_use block. */
    const callExtractTool = async (tool: {
      name: string;
      description: string;
      schema: object;
      maxTokens: number;
      prompt: string;
    }): Promise<{ input: unknown; truncated: boolean }> => {
      const msg = await client.messages.create({
        model,
        max_tokens: tool.maxTokens,
        ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: tool.schema as { type: 'object'; [k: string]: unknown },
          },
        ],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: tool.prompt }],
      });
      const toolUse = msg.content.find((b) => b.type === 'tool_use');
      return {
        input: toolUse?.input ?? null,
        truncated: msg.stop_reason === 'max_tokens',
      };
    };

    /**
     * Writes a note for each already-ingested email that has none, one
     * note-only call each. A failed or truncated call skips that email; it
     * never holds the cursor back.
     */
    const backfillMissingNotes = async (
      dupCandidates: PreparedMessage[],
    ): Promise<void> => {
      const candidates = dupCandidates.filter((d) => d.needsLlm && d.llmPayload);
      if (candidates.length === 0) return;
      const noteStatusRows = queryRows<{
        message_id: string;
        id: string;
        has_note: boolean;
      }>(
        await deps.db.execute(sql`
          SELECT e.message_id, e.id, (n.email_id IS NOT NULL) AS has_note
          FROM analytics.emails e
          LEFT JOIN analytics.email_notes n ON n.email_id = e.id
          WHERE e.message_id IN (${sql.join(
            candidates.map((d) => sql`${d.messageId}`),
            sql`, `,
          )})
        `),
      );
      const emailRowByMid = new Map(noteStatusRows.map((r) => [r.message_id, r]));
      const toBackfill = candidates.flatMap((item) => {
        const row = emailRowByMid.get(item.messageId);
        return row && !row.has_note ? [{ item, emailId: row.id }] : [];
      });
      if (toBackfill.length === 0) return;

      const notes = await mapPool(
        toBackfill,
        llmConcurrency,
        async ({ item, emailId }): Promise<EmailNoteItem | null> => {
          try {
            const { input, truncated } = await callExtractTool({
              name: 'extract_email_note',
              description: 'Return structured note extracted from the email.',
              schema: EMAIL_NOTE_SCHEMA,
              maxTokens: 700,
              prompt: buildNoteOnlyPrompt(queueEntryFor(item)),
            });
            if (truncated) {
              pipelineLog(SCOPE, 'backfill_note_truncated', {
                run_id: run.id,
                message_id: item.messageId,
              });
              return null;
            }
            const repaired = repairToolInput(input as { email_note?: unknown } | null);
            return {
              emailId,
              note: sanitizeEmailNote(
                repaired?.email_note,
                externalAddresses(item.fromAddress, item.toAddresses, item.ccAddresses),
              ),
              model,
            };
          } catch (err) {
            pipelineLog(SCOPE, 'backfill_note_failed', {
              run_id: run.id,
              message_id: item.messageId,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          }
        },
      );
      const itemsToWrite = notes.filter((n): n is EmailNoteItem => n !== null);
      if (itemsToWrite.length === 0) return;
      await upsertEmailNotes(deps.db, itemsToWrite);
      notesWritten = true;
    };

    const flushBatch = async (): Promise<
      'ok' | 'soft_stop' | 'llm_retry' | 'afd_retry'
    > => {
      if (pendingBatch.length === 0) return 'ok';
      const batch = pendingBatch.splice(0, pendingBatch.length);
      // Offset before this batch — used if the first fresh message fails LLM.
      const offsetBeforeBatch =
        batch[0] !== undefined ? batch[0].offset - 1 : result.message_offset;

      const mids = batch.map((b) => b.messageId);
      // Re-extract: only rows this re-extract already wrote count as done, so a
      // resume or a second custodian's copy of the email is not extracted twice.
      const existing = queryRows<{ message_id: string }>(
        await deps.db.execute(sql`
          SELECT message_id FROM analytics.emails
          WHERE message_id IN (${sql.join(
            mids.map((m) => sql`${m}`),
            sql`, `,
          )})
          ${reextractSince ? sql`AND created_at >= ${reextractSince}::timestamptz` : sql``}
        `),
      );
      const existingSet = new Set(existing.map((r) => r.message_id));
      const fresh = batch.filter((b) => !existingSet.has(b.messageId));
      result.messages_skipped += batch.length - fresh.length;

      const llmTargets = fresh.filter((b) => b.needsLlm && b.llmPayload);
      const llmOut = await mapPool(llmTargets, llmConcurrency, async (item) => {
        try {
          const { input, truncated } = await callExtractTool({
            name: 'extract_email_info',
            description: 'Return structured info extracted from the email.',
            schema: EMAIL_EXTRACTION_SCHEMA,
            maxTokens: 1500,
            prompt: buildUserPrompt(queueEntryFor(item)),
          });
          if (truncated) {
            throw new Error('LLM response truncated (stop_reason: max_tokens)');
          }
          return {
            messageId: item.messageId,
            llm: dropThreadOnlyCompanies(
              repairToolInput(input as LlmExtraction | null),
              queueEntryFor(item),
            ),
            error: null as string | null,
          };
        } catch (err) {
          pipelineError(SCOPE, 'llm_failed', err, { run_id: run.id });
          return {
            messageId: item.messageId,
            llm: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
      const llmByMid = new Map(llmOut.map((r) => [r.messageId, r]));

      // Commit in stream order up to (but not including) the first LLM failure so
      // transient errors are retried on resume instead of permanently skipped.
      const crmMessages: EphemeralCrmMessage[] = [];
      type AttachQueueEntry = { item: PreparedMessage; allowSmartFiles: boolean };
      const attachQueue: AttachQueueEntry[] = [];
      let llmRetryFrom: PreparedMessage | null = null;
      let lastCommittedOffset = offsetBeforeBatch;

      for (const item of fresh) {
        const llmResult = llmByMid.get(item.messageId);
        if (item.needsLlm && llmResult?.error) {
          llmRetryFrom = item;
          break;
        }
        const llm = llmResult?.llm ?? null;
        if (llm?.is_personal === true) {
          result.messages_skipped++;
          lastCommittedOffset = item.offset;
          continue;
        }
        const senderDomain = item.fromAddress.split('@')[1] ?? '';
        const internal = INTERNAL_MAIL_DOMAINS.has(senderDomain);
        crmMessages.push({
          message_id: item.messageId,
          from_address: item.fromAddress,
          from_display_name: item.parsed.sender?.name ?? null,
          to_addresses: item.toAddresses,
          cc_addresses: item.ccAddresses,
          subject: item.parsed.subject || null,
          sent_at: item.parsed.date ?? new Date().toISOString(),
          in_reply_to:
            stripAngleBrackets(
              getHeader(item.raw.headers, 'in-reply-to') || undefined,
            ) || null,
          custodian_email: custodianEmail,
          direction: internal ? 'outbound' : 'inbound',
          candidates: item.candidates,
          llm,
          model,
        });
        attachQueue.push({
          item,
          allowSmartFiles: hasDealSignal(llm, item.parsed.subject),
        });
        lastCommittedOffset = item.offset;
      }

      // Already-ingested envelopes (CRM committed, then crash before offset /
      // Smart Files): still retry attachments. Do not treat "in analytics.emails" as
      // fully done — that is what created the ghost / missed-Smart Files failure mode.
      // Never advance past an llm_retry cursor via a later existing row.
      const dupCandidates: PreparedMessage[] = [];
      for (const item of batch) {
        if (!existingSet.has(item.messageId)) continue;
        if (llmRetryFrom && item.offset >= llmRetryFrom.offset) continue;
        if (attachQueue.some((a) => a.item.messageId === item.messageId)) continue;
        dupCandidates.push(item);
        if (item.offset > lastCommittedOffset) {
          lastCommittedOffset = item.offset;
        }
      }

      await backfillMissingNotes(dupCandidates);

      // Resume path: same predicate as fresh — subject heuristic on re-parsed
      // mbox + DB deal-topic / related-company evidence (no LLM re-run).
      const dbDealSignalByMid = new Map<string, boolean>();
      if (dupCandidates.length > 0 && !reextractSince) {
        const needDb = dupCandidates.filter(
          (d) => !subjectLooksDealRelated(d.parsed.subject),
        );
        if (needDb.length > 0) {
          const mids = needDb.map((d) => d.messageId);
          const rows = queryRows<{
            message_id: string;
            has_deal_topic: boolean;
            has_related_evidence: boolean;
          }>(
            await deps.db.execute(sql`
              SELECT e.message_id,
                EXISTS (
                  SELECT 1
                  FROM analytics.email_topics et
                  JOIN public.topics t ON t.id = et.topic_id
                  WHERE et.email_id = e.id AND t.is_deal_related = true
                ) AS has_deal_topic,
                EXISTS (
                  SELECT 1
                  FROM analytics.employer_related_company_evidence ev
                  WHERE ev.email_id = e.id
                ) AS has_related_evidence
              FROM analytics.emails e
              WHERE e.message_id IN (${sql.join(
                mids.map((id) => sql`${id}`),
                sql`, `,
              )})
            `),
          );
          for (const r of rows) {
            dbDealSignalByMid.set(
              r.message_id,
              !!r.has_deal_topic || !!r.has_related_evidence,
            );
          }
        }
        for (const item of dupCandidates) {
          const allowSmartFiles =
            subjectLooksDealRelated(item.parsed.subject) ||
            dbDealSignalByMid.get(item.messageId) === true;
          attachQueue.push({ item, allowSmartFiles });
        }
      }

      // Dup-skipped-only batch with nothing to attach still advances past the batch.
      if (fresh.length === 0 && attachQueue.length === 0 && batch.length > 0) {
        lastCommittedOffset =
          batch[batch.length - 1]?.offset ?? lastCommittedOffset;
      }

      if (crmMessages.length > 0) {
        const crm = await upsertEphemeralCrmBatch(crmMessages, {
          db: deps.db,
          replaceBefore: reextractSince,
        });
        result.messages_ingested += crm.emails_inserted;
        if (crm.emails_inserted > 0) notesWritten = true;
      }

      // A re-extract export's run has no record of the digests the first
      // ingest delivered, so delivering here would duplicate Smart Files.
      if (reextractSince) attachQueue.length = 0;

      let afdRetryFromOffset: number | null = null;
      for (const entry of attachQueue) {
        if (afdRetryFromOffset !== null) break;
        const item = entry.item;

        if (!entry.allowSmartFiles) {
          pipelineLog(SCOPE, 'afd_deal_signal_skip', {
            run_id: run.id,
            custodian_hash: custodianHash(custodianEmail),
            reason: 'no_deal_signal',
          });
          continue;
        }

        // Two-phase per message: finish ALL PDF/Office triage before any Smart Files
        // upload. Otherwise a later triage failure rewinds the message and
        // re-uploads earlier attachments under new S3 keys (duplicate rows).
        type PendingUpload = {
          bytes: Buffer;
          fileName: string;
          contentType: string;
          digest: string;
          fileTypeOverride?: SmartFileTypeOverride;
        };
        const pending: PendingUpload[] = [];
        let triageFailed = false;

        for (const part of item.rawParts) {
          const mime = (part.mime_type || '').toLowerCase();
          const fname = part.filename || 'attachment.bin';
          // Per-file gate (privacyFilter step 03) — never whole-email drop.
          // Sensitive filenames are rejected before extract / triage.
          if (isSensitiveAttachmentFilename(fname)) {
            continue;
          }
          let decoded: Buffer;
          try {
            const enc = (part.encoding || '').toLowerCase();
            decoded =
              enc === 'base64'
                ? Buffer.from(part.body.replace(/\s+/g, ''), 'base64')
                : Buffer.from(part.body, 'utf8');
          } catch {
            continue;
          }
          const isPdf =
            mime === 'application/pdf' || fname.toLowerCase().endsWith('.pdf');
          const isOffice = isOfficeAttachment(mime, fname);
          if (!isPdf && !isOffice) continue;

          const digest = attachmentContentDigest(decoded);
          // Skip before triage: an already-delivered digest must not re-call
          // Anthropic on afd_retry, or a flaky re-triage can burn fail budget
          // and block later attachments that still need upload.
          if (uploadedDigests.has(digest)) continue;

          // Logged before parsing: if an attachment ever kills the Lambda, the
          // last line names its type and size (never its filename).
          pipelineLog(SCOPE, 'attachment_triage', {
            run_id: run.id,
            kind: isPdf ? 'pdf' : 'office',
            ext: fname.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? null,
            bytes: decoded.length,
          });
          const outcome = await triageAttachmentForSmartFiles({
            mime,
            fileName: fname,
            bytes: decoded,
            client,
            model,
          });
          if (outcome.kind === 'skip') continue;
          if (outcome.kind === 'retry') {
            // Fail closed for upload (never send untriaged bytes), but rewind
            // so a transient Anthropic/extract outage can retry this attachment.
            pipelineError(SCOPE, 'attachment_triage_failed', outcome.err, {
              run_id: run.id,
            });
            triageFailed = true;
            afdRetryFromOffset = item.offset;
            break;
          }

          pending.push({
            bytes: decoded,
            fileName: fname,
            contentType: mime || 'application/octet-stream',
            digest,
            fileTypeOverride: outcome.fileTypeOverride,
          });
        }

        if (triageFailed) break;

        for (const upload of pending) {
          try {
            const uploaded = await uploadBytesToSmartFiles({
              bytes: upload.bytes,
              fileName: upload.fileName,
              contentType: upload.contentType,
              enteredBy: custodianEmail,
              workspaceId: primaryWorkspaceId,
              fileTypeOverride: upload.fileTypeOverride,
              emailContext: smartFileEmailContext(item),
            });
            uploadedDigests.add(upload.digest);
            // Persist immediately so a crash between attachments still skips
            // already-delivered digests on the next poll.
            await updateRun(deps.db, run.id, {
              afd_uploaded_digests: [...uploadedDigests],
            });
            // Non-sticky types (e.g. financial_*) may still be privacy-dropped
            // by Smart Files as `other` — do not count those as successful uploads.
            if (!uploaded.dropped) result.attachments_uploaded++;
          } catch (err) {
            pipelineError(SCOPE, 'afd_upload_failed', err, { run_id: run.id });
            afdRetryFromOffset = item.offset;
            break;
          }
        }
      }

      if (afdRetryFromOffset !== null) {
        lastCommittedOffset = Math.min(
          lastCommittedOffset,
          afdRetryFromOffset - 1,
        );
      }

      result.message_offset = lastCommittedOffset;
      await updateRun(deps.db, run.id, {
        status: 'in_progress',
        message_offset: lastCommittedOffset,
        messages_seen: result.messages_seen,
        messages_skipped: result.messages_skipped,
        messages_ingested: result.messages_ingested,
        attachments_uploaded: result.attachments_uploaded,
      });

      if (afdRetryFromOffset !== null) {
        pipelineLog(SCOPE, 'afd_retry', {
          run_id: run.id,
          message_offset: lastCommittedOffset,
          failed_at_offset: afdRetryFromOffset,
        });
        return 'afd_retry';
      }

      if (llmRetryFrom) {
        pipelineLog(SCOPE, 'llm_retry', {
          run_id: run.id,
          message_offset: lastCommittedOffset,
          failed_message_id: llmRetryFrom.messageId,
        });
        return 'llm_retry';
      }

      // Successful batch progress clears soft-retry budget so intermittent
      // Smart Files/LLM blips across a large mbox do not accumulate to abandon.
      if (failCount > 0 || attemptCounted) {
        failCount = 0;
        attemptCounted = false;
        result.fail_count = 0;
        await updateRun(deps.db, run.id, { fail_count: 0 });
      }

      if (Date.now() - started > softStopMs) return 'soft_stop';
      return 'ok';
    };

    const stream = await source.openStream();

    for await (const raw of streamMboxMessages(stream)) {
      if (offset < run.message_offset) {
        offset++;
        continue;
      }
      if (Date.now() - started > softStopMs) {
        const flushStatus = await flushBatch();
        if (flushStatus === 'llm_retry' || flushStatus === 'afd_retry') {
          return finishForResume(flushStatus);
        }
        result.message_offset = offset;
        await updateRun(deps.db, run.id, {
          status: 'in_progress',
          message_offset: offset,
          messages_seen: result.messages_seen,
          messages_skipped: result.messages_skipped,
          messages_ingested: result.messages_ingested,
          attachments_uploaded: result.attachments_uploaded,
        });
        return finishForResume('soft_stop');
      }

      result.messages_seen++;
      offset++;

      const rawParts = extractRawAttachmentParts(raw.headers, raw.rawBody);
      const filenames = rawParts
        .map((a) => a.filename)
        .filter((n): n is string => !!n);
      const filter = runPrivacyFilter(raw.headers, raw.rawBody, {
        ourDomains: INTERNAL_MAIL_DOMAINS,
        dropInternalOnly: true,
        excludedDomains: excluded,
        attachmentFilenames: filenames,
      });
      if (filter.skip) {
        result.messages_skipped++;
        // Only past what is already committed: a hard failure persists this
        // cursor, and moving it past messages still in pendingBatch would make
        // the retry skip them for good.
        if (pendingBatch.length === 0) result.message_offset = offset;
        continue;
      }

      const parsed = parseMessage(raw);
      const fromAddress = (parsed.sender?.email ?? '').toLowerCase();
      if (!fromAddress) {
        result.messages_skipped++;
        continue;
      }

      let messageId = stripAngleBrackets(parsed.message_id || undefined) || null;
      if (!messageId) {
        messageId = synthesizeMessageId({
          from: fromAddress,
          date: parsed.date ?? '',
          subject: parsed.subject ?? '',
          body: parsed.body,
        });
      }

      const enriched = processEmail(
        { ...parsed, message_id: messageId },
        { wantRelatedCompanies: true },
      );
      pendingBatch.push({
        offset,
        raw,
        parsed,
        messageId,
        fromAddress,
        toAddresses: (parsed.recipients ?? []).map((a) => a.email.toLowerCase()),
        ccAddresses: (parsed.cc ?? []).map((a) => a.email.toLowerCase()),
        rawParts,
        candidates: enriched.candidates ?? [],
        needsLlm: enriched.needs_llm,
        llmPayload: enriched.llm_payload,
      });

      if (pendingBatch.length >= batchSize) {
        const status = await flushBatch();
        if (
          status === 'soft_stop' ||
          status === 'llm_retry' ||
          status === 'afd_retry'
        ) {
          return finishForResume(status);
        }
      }
    }

    const finalFlush = await flushBatch();
    if (
      finalFlush === 'llm_retry' ||
      finalFlush === 'afd_retry' ||
      finalFlush === 'soft_stop'
    ) {
      return finishForResume(finalFlush);
    }

    result.status = 'completed';
    await updateRun(deps.db, run.id, {
      status: 'completed',
      fail_count: failCount,
      message_offset: offset,
      messages_seen: result.messages_seen,
      messages_skipped: result.messages_skipped,
      messages_ingested: result.messages_ingested,
      attachments_uploaded: result.attachments_uploaded,
    });

    await refreshMartsIfNeeded();
    // After the marts: the overview prompt reads the interaction totals.
    await refreshOverviewsIfNeeded();

    pipelineLog(SCOPE, 'done', {
      run_id: run.id,
      messages_seen: result.messages_seen,
      messages_skipped: result.messages_skipped,
      messages_ingested: result.messages_ingested,
      attachments_uploaded: result.attachments_uploaded,
    });
    return result;
  } catch (err) {
    // Persist counters but keep the last *committed* cursor. Using the live
    // stream offset would skip a batch whose CRM txn just rolled back.
    const nextFail = await persistHardFailure({
      db: deps.db,
      runId: run.id,
      failCount,
      result,
      err,
    });
    result.fail_count = nextFail;
    result.status = nextFail >= MAX_PROCESS_FAIL_COUNT ? 'abandoned' : 'failed';
    return result;
  }
}
