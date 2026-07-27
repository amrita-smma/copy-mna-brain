/**
 * Ephemeral single-pass email processor (no-S3 cutover).
 *
 * Source-agnostic core: given a raw (already-decompressed) MBOX byte stream
 * plus a stable source identity, it streams messages in batches:
 * privacy filter → bounded sync LLM → CRM upsert (no raw_emails / no
 * body_text) → attachment triage/AFD, persisting only a resumable cursor +
 * counters in analytics.email_process_runs.
 *
 * No MBOX bytes are ever read from or written to S3. The Vault poll spools one
 * entry at a time to Lambda /tmp and feeds it here; AFD may still store
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
  upsertEphemeralCrmBatch,
  type EphemeralCrmMessage,
} from './emailProcessCrm';

export const EMAIL_PROCESS_TIMEOUT_SECONDS = 600;
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
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

/** Sticky AFD types — must match `/api/ai-file-dump` FILE_TYPE_OVERRIDES. */
type AfdFileTypeOverride =
  | 'mom'
  | 'prospectus'
  | 'shopping_list'
  | 'market_study';

/**
 * Map pipeline PDF triage → sticky AFD `file_type_override`.
 * Without this, AFD's second classifier can mark a real deal PDF as `other`
 * and hard-delete it. `im`/`teaser` pin to `prospectus` (closest sticky
 * deal-target type AFD accepts). Financial types have no sticky override.
 */
const AFD_FILE_TYPE_OVERRIDES: Partial<Record<string, AfdFileTypeOverride>> = {
  mom: 'mom',
  shopping_list: 'shopping_list',
  market_study: 'market_study',
  prospectus: 'prospectus',
  im: 'prospectus',
  teaser: 'prospectus',
};

export function afdOverrideForDocType(
  docType: string,
): AfdFileTypeOverride | undefined {
  return AFD_FILE_TYPE_OVERRIDES[docType];
}

/**
 * Sticky AFD override only when triage confidence is high. Medium/low still
 * upload deal types (without override) so AFD can re-classify / drop as other.
 */
export function stickyAfdOverrideForTriage(
  docType: string,
  confidence: string,
): AfdFileTypeOverride | undefined {
  if (confidence !== 'high') return undefined;
  return afdOverrideForDocType(docType);
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

const PDF_TRIAGE_SYSTEM = `You classify M&A deal documents.
Categories: prospectus, im, teaser, mom, financial_model, financial_statement, shopping_list, market_study, other.
Return only the JSON tool call.`;

/**
 * Stable identity of a single MBOX unit of work. For Vault this is derived
 * from export_id + zip object name + entry path so a re-download resolves to
 * the same run and resumes from the persisted cursor.
 */
export interface MboxSource {
  sourceKey: string;
  custodianEmail: string;
  exportId?: string | null;
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

/** Stable content fingerprint for AFD upload idempotency across retries. */
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
 * Soft LLM/AFD retries must consume the same fail budget as hard errors, or a
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

async function uploadBytesToAfd(opts: {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  enteredBy: string;
  workspaceId: string;
  fileTypeOverride?: AfdFileTypeOverride;
}): Promise<{ dropped: boolean }> {
  const base = process.env.INTERNAL_API_URL ?? 'http://localhost:3000';
  const secret = process.env.ADMIN_SECRET ?? '';
  const params = new URLSearchParams({
    fileName: opts.fileName,
    contentType: opts.contentType,
  });
  const urlRes = await fetch(`${base}/api/ai-file-dump/upload-url?${params}`, {
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
  const notify = await fetch(`${base}/api/ai-file-dump`, {
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
    }),
  });
  if (!notify.ok) throw new Error(`AFD notify ${notify.status}`);
  const body = (await notify.json().catch(() => null)) as {
    data?: { dropped?: boolean };
  } | null;
  const dropped = body?.data?.dropped === true;
  // Sticky override should prevent `other` hard-drops. If AFD still drops,
  // treat as a hard failure so the cursor retries instead of silently losing
  // a pipeline-approved deal PDF.
  if (dropped && opts.fileTypeOverride) {
    throw new Error(
      `AFD dropped origin_email file despite file_type_override=${opts.fileTypeOverride}`,
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
  | { kind: 'upload'; fileTypeOverride?: AfdFileTypeOverride }
  | { kind: 'retry'; err: unknown };

/**
 * Classify a PDF or Office attachment for AFD. Fail closed on extract/triage
 * errors (retry). Skip non-deal, oversized, empty-extract, and non-deal types.
 */
export async function triageAttachmentForAfd(opts: {
  mime: string;
  fileName: string;
  bytes: Buffer;
  client: Anthropic;
  model: string;
  extractText?: typeof extractTextFromFile;
}): Promise<AttachmentTriageOutcome> {
  const {
    mime,
    fileName,
    bytes,
    client,
    model,
    extractText = extractTextFromFile,
  } = opts;
  const isPdf =
    mime === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  const isOffice = isOfficeAttachment(mime, fileName);
  if (!isPdf && !isOffice) return { kind: 'skip' };

  if (isPdf) {
    if (shouldBypassPdfTriage(bytes.length)) return { kind: 'skip' };
    try {
      // Validate locally before calling Anthropic. Corrupt or encrypted PDFs
      // fail deterministically, so retrying would eventually abandon the
      // whole mbox source and lose every later message.
      await extractText(bytes, 'application/pdf', fileName);
    } catch (err) {
      pipelineError(SCOPE, 'pdf_extract_failed', err);
      return { kind: 'skip' };
    }
    try {
      const triage = await triagePdfBytes(client, model, bytes);
      if (!DEAL_DOC_TYPES.has(triage.doc_type)) return { kind: 'skip' };
      return {
        kind: 'upload',
        fileTypeOverride: stickyAfdOverrideForTriage(
          triage.doc_type,
          triage.confidence,
        ),
      };
    } catch (err) {
      return { kind: 'retry', err };
    }
  }

  // Office: size gate → extract → empty check → text triage → deal-only upload
  if (shouldBypassOfficeTriage(bytes.length)) return { kind: 'skip' };
  let extracted: string;
  try {
    extracted = await extractText(bytes, mime, fileName);
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
      fileTypeOverride: stickyAfdOverrideForTriage(
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
  rawParts: RawAttachmentPart[];
  candidates: Candidate[];
  needsLlm: boolean;
  llmPayload: NonNullable<ReturnType<typeof processEmail>['llm_payload']> | null;
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
  const uploadedDigests = new Set(run.afd_uploaded_digests);

  const custodianEmail = source.custodianEmail ?? '';

  try {
    if (!custodianEmail || custodianEmail === 'unknown') {
      throw new Error('Unable to resolve MBOX custodian; refusing unscoped CRM writes');
    }
    const workspaceIds = await new UserWorkspaceRepository(
      deps.db,
    ).findWorkspaceIdsBySyncedEmail(custodianEmail);
    if (workspaceIds.length === 0) {
      throw new Error(
        'MBOX custodian is no longer synced to a workspace; refusing CRM and AFD writes',
      );
    }
    const primaryWorkspaceId = workspaceIds[0]!;
    const started = Date.now();
    pipelineLog(SCOPE, 'start', {
      run_id: run.id,
      custodian_hash: custodianHash(custodianEmail),
      resume_offset: run.message_offset,
      fail_count: run.fail_count,
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
      await updateRun(deps.db, run.id, { status: 'in_progress' });
      pipelineLog(SCOPE, status, {
        run_id: run.id,
        message_offset: result.message_offset,
        fail_count: failCount,
      });
      return result;
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
      const existing = queryRows<{ message_id: string }>(
        await deps.db.execute(sql`
          SELECT message_id FROM analytics.emails
          WHERE message_id IN (${sql.join(
            mids.map((m) => sql`${m}`),
            sql`, `,
          )})
        `),
      );
      const existingSet = new Set(existing.map((r) => r.message_id));
      const fresh = batch.filter((b) => !existingSet.has(b.messageId));
      result.messages_skipped += batch.length - fresh.length;

      const llmTargets = fresh.filter((b) => b.needsLlm && b.llmPayload);
      const llmOut = await mapPool(llmTargets, llmConcurrency, async (item) => {
        try {
          const entry = {
            message_id: item.messageId,
            subject: item.parsed.subject ?? '',
            sender_email: item.fromAddress,
            domain_tag: item.fromAddress.split('@')[1] ?? null,
            payload: item.llmPayload!,
          };
          const msg = await client.messages.create({
            model,
            max_tokens: 800,
            ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
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
            (b): b is Extract<
              (typeof msg.content)[number],
              { type: 'tool_use' }
            > => b.type === 'tool_use',
          );
          return {
            messageId: item.messageId,
            llm: toolUse ? (toolUse.input as LlmExtraction) : null,
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
      const attachQueue: PreparedMessage[] = [];
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
        const toAddrs = (item.parsed.recipients ?? []).map((a) =>
          a.email.toLowerCase(),
        );
        const ccAddrs = (item.parsed.cc ?? []).map((a) => a.email.toLowerCase());
        crmMessages.push({
          message_id: item.messageId,
          from_address: item.fromAddress,
          from_display_name: item.parsed.sender?.name ?? null,
          to_addresses: toAddrs,
          cc_addresses: ccAddrs,
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
        });
        attachQueue.push(item);
        lastCommittedOffset = item.offset;
      }

      // Already-ingested envelopes (CRM committed, then crash before offset /
      // AFD): still retry attachments. Do not treat "in analytics.emails" as
      // fully done — that is what created the ghost / missed-AFD failure mode.
      // Never advance past an llm_retry cursor via a later existing row.
      for (const item of batch) {
        if (!existingSet.has(item.messageId)) continue;
        if (llmRetryFrom && item.offset >= llmRetryFrom.offset) continue;
        if (attachQueue.some((a) => a.messageId === item.messageId)) continue;
        attachQueue.push(item);
        if (item.offset > lastCommittedOffset) {
          lastCommittedOffset = item.offset;
        }
      }

      // Dup-skipped-only batch with nothing to attach still advances past the batch.
      if (fresh.length === 0 && attachQueue.length === 0 && batch.length > 0) {
        lastCommittedOffset =
          batch[batch.length - 1]?.offset ?? lastCommittedOffset;
      }

      if (crmMessages.length > 0) {
        const crm = await upsertEphemeralCrmBatch(crmMessages, { db: deps.db });
        result.messages_ingested += crm.emails_inserted;
      }

      let afdRetryFromOffset: number | null = null;
      for (const item of attachQueue) {
        if (afdRetryFromOffset !== null) break;

        // Two-phase per message: finish ALL PDF/Office triage before any AFD
        // upload. Otherwise a later triage failure rewinds the message and
        // re-uploads earlier attachments under new S3 keys (duplicate rows).
        type PendingUpload = {
          bytes: Buffer;
          fileName: string;
          contentType: string;
          digest: string;
          fileTypeOverride?: AfdFileTypeOverride;
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

          const outcome = await triageAttachmentForAfd({
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
            const uploaded = await uploadBytesToAfd({
              bytes: upload.bytes,
              fileName: upload.fileName,
              contentType: upload.contentType,
              enteredBy: custodianEmail,
              workspaceId: primaryWorkspaceId,
              fileTypeOverride: upload.fileTypeOverride,
            });
            uploadedDigests.add(upload.digest);
            // Persist immediately so a crash between attachments still skips
            // already-delivered digests on the next poll.
            await updateRun(deps.db, run.id, {
              afd_uploaded_digests: [...uploadedDigests],
            });
            // Non-sticky types (e.g. financial_*) may still be privacy-dropped
            // by AFD as `other` — do not count those as successful uploads.
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
      // AFD/LLM blips across a large mbox do not accumulate to abandon.
      if (failCount > 0) {
        failCount = 0;
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
        result.message_offset = offset;
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

      const enriched = processEmail({ ...parsed, message_id: messageId }, {});
      pendingBatch.push({
        offset,
        raw,
        parsed,
        messageId,
        fromAddress,
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
      message_offset: offset,
      messages_seen: result.messages_seen,
      messages_skipped: result.messages_skipped,
      messages_ingested: result.messages_ingested,
      attachments_uploaded: result.attachments_uploaded,
    });

    await refreshMartsIfNeeded();

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
