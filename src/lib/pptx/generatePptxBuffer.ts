import Anthropic from '@anthropic-ai/sdk';
import { sanitizePptxForOfficeOnline } from '@/lib/pptx/sanitizePptx';
import {
  createPptxTrace,
  type PptxTrace,
  type PptxTraceMeta,
} from '@/lib/pptx/pptxLangfuse';

/** Overall wall-clock budget for the skill run (all turns + retries).
 * Kept below chat `maxDuration` (600s) so download/sanitize/send still fit. */
export const PPTX_GENERATION_TIMEOUT_SECONDS = 480;

/** Per-request stream timeout — kept below the overall budget so continuations can fit. */
export const PPTX_TURN_TIMEOUT_SECONDS = 180;

/** Output budget per Messages API turn. PPTX skill runs are tool-heavy. */
export const PPTX_MAX_TOKENS = 64_000;

/** Extra turns when the skill pauses or hits max_tokens before emitting a file. */
export const PPTX_MAX_CONTINUATIONS = 8;

/** Extra attempts beyond the SDK's own retries when Anthropic is overloaded. */
export const PPTX_OVERLOAD_RETRIES = 4;

/**
 * Max raw attachment bytes before base64 (~4/3) + MIME headers.
 * SES raw messages cap at ~10MB; 5.5MB binary ≈ 7.3MB base64, leaving headroom.
 */
export const PPTX_MAX_EMAIL_BYTES = 5_500_000;

const FILES_API_BETA = 'files-api-2025-04-14' as const;
const SKILLS_BETA = 'skills-2025-10-02' as const;

const PPTX_SKILL = {
  type: 'anthropic' as const,
  skill_id: 'pptx',
  version: 'latest',
};

const CODE_EXECUTION_TOOL = {
  type: 'code_execution_20250825' as const,
  name: 'code_execution' as const,
};

const OVERLOAD_BACKOFF_SECONDS = [5, 15, 30, 60] as const;

const anthropic = new Anthropic({ maxRetries: 5 });

type ContentBlock = {
  type: string;
  content?: unknown;
};

type MessageContent = Anthropic.Beta.Messages.BetaMessage['content'];
type UserContent = Anthropic.Beta.Messages.BetaMessageParam['content'];

export function isTransientAnthropicError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    status?: number;
    error?: { type?: string };
    message?: string;
  };
  if (e.status === 429 || e.status === 529) return true;
  if (e.error?.type === 'overloaded_error' || e.error?.type === 'rate_limit_error') {
    return true;
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  return (
    msg.includes('overloaded_error') ||
    msg.includes('"type":"overloaded_error"') ||
    msg.includes('rate_limit_error')
  );
}

export function formatPptxGenerationError(err: unknown): string {
  if (isTransientAnthropicError(err)) {
    return 'Claude is overloaded right now. Please wait a moment and try generating the presentation again.';
  }
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'message' in err
        ? String((err as { message?: unknown }).message)
        : '';
  if (msg.includes('prompt is too long') || msg.includes('maximum')) {
    return 'Presentation context grew too large. Please shorten the brief and try again.';
  }
  if (msg) return msg;
  return 'Failed to generate presentation';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTransientAnthropicRetries<T>(
  fn: () => Promise<T>,
  opts?: {
    maxRetries?: number;
    backoffSeconds?: readonly number[];
    sleepFn?: (ms: number) => Promise<void>;
    /** Abort retries/backoff once this epoch-ms deadline is reached. */
    deadlineMs?: number;
    signal?: AbortSignal;
  },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? PPTX_OVERLOAD_RETRIES;
  const backoff = opts?.backoffSeconds ?? OVERLOAD_BACKOFF_SECONDS;
  const sleepFn = opts?.sleepFn ?? sleep;
  const deadlineMs = opts?.deadlineMs;
  const signal = opts?.signal;

  const assertRunnable = () => {
    if (signal?.aborted) {
      throw new Error('PPTX generation was cancelled.');
    }
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new Error(
        'PPTX skill ran out of time before producing a file. Try a shorter brief.',
      );
    }
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    assertRunnable();
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientAnthropicError(err) || attempt === maxRetries) {
        throw err;
      }
      assertRunnable();
      const delaySec = backoff[Math.min(attempt, backoff.length - 1)] ?? 60;
      const delayMs = delaySec * 1000;
      if (deadlineMs !== undefined) {
        const left = deadlineMs - Date.now();
        if (left <= 0) {
          throw new Error(
            'PPTX skill ran out of time before producing a file. Try a shorter brief.',
          );
        }
        await sleepFn(Math.min(delayMs, left));
      } else {
        await sleepFn(delayMs);
      }
    }
  }
  throw lastError;
}

export function extractPptxFileId(content: ContentBlock[]): string | null {
  let lastAnyFileId: string | null = null;
  let lastPptxFileId: string | null = null;

  const takeFromOutputs = (outputs: unknown) => {
    if (!outputs) return;
    const items = Array.isArray(outputs) ? outputs : [outputs];
    for (const output of items) {
      if (!output || typeof output !== 'object' || !('file_id' in output)) continue;
      const id = (output as { file_id?: unknown }).file_id;
      if (typeof id !== 'string' || id.length === 0) continue;
      lastAnyFileId = id;
      const name =
        'filename' in output
          ? (output as { filename?: unknown }).filename
          : 'file_name' in output
            ? (output as { file_name?: unknown }).file_name
            : undefined;
      if (typeof name === 'string' && /\.pptx$/i.test(name)) {
        lastPptxFileId = id;
      }
    }
  };

  for (const block of content) {
    if (
      block.type !== 'bash_code_execution_tool_result' &&
      block.type !== 'code_execution_tool_result'
    ) {
      continue;
    }

    const inner = block.content;

    if (Array.isArray(inner)) {
      takeFromOutputs(inner);
      continue;
    }

    if (!inner || typeof inner !== 'object') continue;

    const result = inner as {
      type?: string;
      content?: unknown;
      file_id?: string;
      filename?: string;
      file_name?: string;
    };

    if (typeof result.file_id === 'string' && result.file_id.length > 0) {
      lastAnyFileId = result.file_id;
      const name = result.filename ?? result.file_name;
      if (typeof name === 'string' && /\.pptx$/i.test(name)) {
        lastPptxFileId = result.file_id;
      }
    }

    if (
      result.type === 'bash_code_execution_result' ||
      result.type === 'code_execution_result' ||
      (result.content != null && typeof result.content === 'object')
    ) {
      takeFromOutputs(result.content);
    }
  }

  // Prefer an explicitly named .pptx when the skill also emitted charts/CSVs.
  return lastPptxFileId ?? lastAnyFileId;
}

export function stripIncompleteTrailingToolUse(
  content: MessageContent,
): MessageContent {
  if (content.length === 0) return content;
  const last = content[content.length - 1];
  if (
    last &&
    typeof last === 'object' &&
    'type' in last &&
    (last.type === 'tool_use' ||
      last.type === 'server_tool_use' ||
      last.type === 'mcp_tool_use')
  ) {
    return content.slice(0, -1);
  }
  return content;
}

function contentPreview(content: MessageContent): string {
  return content.map((b) => ('type' in b ? b.type : 'unknown')).join(', ');
}

function userContentPreview(content: UserContent): string {
  if (typeof content === 'string') return content;
  return content.map((b) => ('type' in b ? b.type : 'unknown')).join(', ');
}

async function downloadAnthropicFile(fileId: string): Promise<Buffer> {
  return withTransientAnthropicRetries(async () => {
    const response = await anthropic.beta.files.download(fileId, {
      betas: [FILES_API_BETA],
    });
    const ab = await response.arrayBuffer();
    return Buffer.from(ab);
  });
}

async function createPptxSkillMessage(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  opts?: {
    containerId?: string;
    includeFilesBeta?: boolean;
    /** Per-request timeout override (ms). */
    timeoutMs?: number;
    /** Overall wall-clock deadline (epoch ms) enforced across overload retries. */
    deadlineMs?: number;
    signal?: AbortSignal;
  },
): Promise<Anthropic.Beta.Messages.BetaMessage> {
  const betas: string[] = [SKILLS_BETA];
  if (opts?.includeFilesBeta) betas.push(FILES_API_BETA);

  return withTransientAnthropicRetries(
    async () => {
      if (opts?.signal?.aborted) {
        throw new Error('PPTX generation was cancelled.');
      }
      const turnCap = opts?.timeoutMs ?? PPTX_TURN_TIMEOUT_SECONDS * 1000;
      let timeoutMs = turnCap;
      if (opts?.deadlineMs !== undefined) {
        const left = opts.deadlineMs - Date.now();
        if (left < 5_000) {
          throw new Error(
            'PPTX skill ran out of time before producing a file. Try a shorter brief.',
          );
        }
        timeoutMs = Math.min(turnCap, left);
      }
      const stream = anthropic.beta.messages.stream(
        {
          model: 'claude-sonnet-5',
          max_tokens: PPTX_MAX_TOKENS,
          betas: betas as never,
          container: opts?.containerId
            ? { id: opts.containerId, skills: [PPTX_SKILL] }
            : { skills: [PPTX_SKILL] },
          messages,
          tools: [CODE_EXECUTION_TOOL],
        },
        { timeout: timeoutMs, signal: opts?.signal },
      );
      return stream.finalMessage();
    },
    { deadlineMs: opts?.deadlineMs, signal: opts?.signal },
  );
}

const CONTINUE_PROMPT =
  'Continue the in-progress deck already in this container. Finish remaining work, save the completed .pptx, and stop. Do not restart from scratch or reprint prior tool output.';

/**
 * Run the Anthropic pptx skill, continuing across pause_turn / max_tokens until
 * a file_id appears or we exhaust continuations / the overall wall-clock budget.
 */
export async function runPptxSkillUntilFileId(
  initialContent: UserContent,
  opts?: {
    createMessage?: typeof createPptxSkillMessage;
    maxContinuations?: number;
    includeFilesBeta?: boolean;
    trace?: PptxTrace;
    turnNamePrefix?: string;
    /** Absolute deadline (epoch ms). Defaults to now + PPTX_GENERATION_TIMEOUT_SECONDS. */
    deadlineMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ fileId: string; stopReason: string | null }> {
  const createMessage = opts?.createMessage ?? createPptxSkillMessage;
  const maxContinuations = opts?.maxContinuations ?? PPTX_MAX_CONTINUATIONS;
  const includeFilesBeta = opts?.includeFilesBeta ?? false;
  const turnPrefix = opts?.turnNamePrefix ?? 'pptx-skill';
  const trace = opts?.trace;
  const signal = opts?.signal;
  const deadlineMs =
    opts?.deadlineMs ?? Date.now() + PPTX_GENERATION_TIMEOUT_SECONDS * 1000;

  const remainingTimeoutMs = () => {
    if (signal?.aborted) {
      throw new Error('PPTX generation was cancelled.');
    }
    const left = deadlineMs - Date.now();
    if (left < 5_000) {
      throw new Error(
        'PPTX skill ran out of time before producing a file. Try a shorter brief.',
      );
    }
    return Math.min(PPTX_TURN_TIMEOUT_SECONDS * 1000, left);
  };

  const firstInputPreview =
    typeof initialContent === 'string'
      ? initialContent
      : userContentPreview(initialContent);

  const gen0 = trace?.startGeneration({
    name: `${turnPrefix}-turn-0`,
    model: 'claude-sonnet-5',
    input: firstInputPreview,
  });

  let response: Anthropic.Beta.Messages.BetaMessage;
  try {
    response = await createMessage([{ role: 'user', content: initialContent }], {
      includeFilesBeta,
      timeoutMs: remainingTimeoutMs(),
      deadlineMs,
      signal,
    });
    gen0?.end({
      output: contentPreview(response.content),
      metadata: {
        stop_reason: response.stop_reason,
        container_id: response.container?.id,
      },
    });
  } catch (err) {
    gen0?.end({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  let fileId = extractPptxFileId(response.content as ContentBlock[]);

  for (
    let i = 0;
    i < maxContinuations &&
    !fileId &&
    (response.stop_reason === 'pause_turn' || response.stop_reason === 'max_tokens');
    i++
  ) {
    const containerId = response.container?.id;
    if (!containerId) {
      throw new Error(
        `PPTX skill continuation missing container id (stop_reason=${response.stop_reason}; blocks=${contentPreview(response.content)})`,
      );
    }

    const gen = trace?.startGeneration({
      name: `${turnPrefix}-turn-${i + 1}`,
      model: 'claude-sonnet-5',
      input: CONTINUE_PROMPT,
      metadata: { container_id: containerId },
    });

    try {
      response = await createMessage(
        [{ role: 'user', content: CONTINUE_PROMPT }],
        {
          containerId,
          includeFilesBeta,
          timeoutMs: remainingTimeoutMs(),
          deadlineMs,
          signal,
        },
      );
      gen?.end({
        output: contentPreview(response.content),
        metadata: {
          stop_reason: response.stop_reason,
          container_id: response.container?.id,
        },
      });
    } catch (err) {
      gen?.end({
        level: 'ERROR',
        statusMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    fileId = extractPptxFileId(response.content as ContentBlock[]);
  }

  if (!fileId) {
    throw new Error(
      `PPTX skill did not return a file_id (stop_reason=${response.stop_reason}; blocks=${contentPreview(response.content)})`,
    );
  }

  return { fileId, stopReason: response.stop_reason };
}

export type GeneratePptxBufferResult = {
  buffer: Buffer;
  removedPartNames: string[];
};

/**
 * Generate a sanitized PPTX buffer from a free-form skill prompt (no S3).
 */
export async function generatePptxBuffer(
  prompt: string,
  opts?: {
    traceMeta?: Partial<PptxTraceMeta>;
    onHeartbeat?: () => void | Promise<void>;
    /** Max allowed binary size (defaults to {@link PPTX_MAX_EMAIL_BYTES}). */
    maxBytes?: number;
    signal?: AbortSignal;
  },
): Promise<GeneratePptxBufferResult> {
  const maxBytes = opts?.maxBytes ?? PPTX_MAX_EMAIL_BYTES;
  const trace = createPptxTrace('agent_pptx_presentation', {
    mode: 'agent_presentation',
    ...opts?.traceMeta,
  });

  const heartbeat = opts?.onHeartbeat;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (heartbeat) {
    heartbeatTimer = setInterval(() => {
      void Promise.resolve(heartbeat()).catch(() => {});
    }, 60_000);
  }

  try {
    let fileId: string;
    let rawBuffer: Buffer;
    try {
      ({ fileId } = await runPptxSkillUntilFileId(prompt, {
        trace,
        turnNamePrefix: 'generate',
        signal: opts?.signal,
      }));
      rawBuffer = await downloadAnthropicFile(fileId);
    } catch (err) {
      throw new Error(formatPptxGenerationError(err));
    }

    if (rawBuffer.length < 100) {
      throw new Error('Downloaded PPTX file is empty or too small');
    }

    const { buffer, removedPartNames } = await sanitizePptxForOfficeOnline(rawBuffer);
    if (removedPartNames.length > 0) {
      console.warn(
        `[generatePptxBuffer] stripped ${removedPartNames.length} missing Content_Types part(s):`,
        removedPartNames.join(', '),
      );
    }

    if (buffer.length > maxBytes) {
      const fmtMb = (n: number) => (n / 1_000_000).toFixed(1);
      throw new Error(
        `Generated presentation is too large to email (${fmtMb(buffer.length)}MB). SES limits the total raw message to about 10MB (≈${fmtMb(maxBytes)}MB of attachments available here). Shorten the brief, drop other attachments, or reduce imagery and try again.`,
      );
    }

    trace.update({
      metadata: { bytes: buffer.length, output_file_id: fileId },
      output: `pptx:${buffer.length}b`,
    });
    trace.end({ output: `pptx:${buffer.length}b` });
    return { buffer, removedPartNames };
  } catch (err) {
    trace.end({
      level: 'ERROR',
      statusMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await trace.flush();
  }
}
