import { GraphRecursionError } from '@langchain/langgraph';
import { toUIMessageStream } from '@ai-sdk/langchain';
import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';
import { SUMMARIZATION_SOURCE } from '@/lib/bots/summary';
import { clipToolOutput } from '@/lib/chat/toolOutputClip';

type LangChainStreamChunk = Parameters<typeof toUIMessageStream>[0] extends AsyncIterable<infer U>
  ? U
  : unknown;

export const RECURSION_LIMIT_ERROR_MESSAGE =
  'This turn hit the step limit. Please try breaking your request into smaller steps.';

export function isGraphRecursionError(error: unknown): boolean {
  if (error instanceof GraphRecursionError) return true;
  if (error && typeof error === 'object') {
    const e = error as { name?: string; lc_error_code?: string; message?: string };
    if (e.name === 'GraphRecursionError' || e.lc_error_code === 'GRAPH_RECURSION_LIMIT') {
      return true;
    }
    if (
      typeof e.message === 'string' &&
      (e.message.includes('Recursion limit') || e.message.includes('GRAPH_RECURSION_LIMIT'))
    ) {
      return true;
    }
  }
  return false;
}

export function extractThinkingDelta(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const c = chunk as { content?: unknown; contentBlocks?: unknown[] };

  for (const list of [c.content, c.contentBlocks]) {
    if (!Array.isArray(list)) continue;
    const parts: string[] = [];
    for (const block of list) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; thinking?: unknown; reasoning?: unknown };
        if (b.type === 'thinking' || b.type === 'thinking_delta' || b.type === 'reasoning') {
          if (typeof b.thinking === 'string') parts.push(b.thinking);
          else if (typeof b.reasoning === 'string') parts.push(b.reasoning);
        }
      }
    }
    if (parts.length > 0) return parts.join('');
  }

  return null;
}

export function hasTextContent(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const c = chunk as { content?: unknown };
  if (typeof c.content === 'string') return c.content.length > 0;
  if (Array.isArray(c.content)) {
    return c.content.some(
      (b) =>
        b &&
        typeof b === 'object' &&
        (b as { type?: string; text?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string' &&
        (b as { text: string }).text.length > 0,
    );
  }
  return false;
}

/**
 * Taps `on_chat_model_stream` events to extract Anthropic thinking blocks
 * dropped by `@ai-sdk/langchain`, writing them to the UI stream as reasoning parts.
 */
export async function* tapEventStream<T = LangChainStreamChunk>(
  eventStream: AsyncIterable<unknown>,
  writer: Pick<UIMessageStreamWriter, 'write'>,
): AsyncGenerator<T, void, unknown> {
  let activeReasoningId: string | null = null;
  let reasoningIndex = 0;

  const closeReasoning = () => {
    if (activeReasoningId) {
      writer.write({ type: 'reasoning-end', id: activeReasoningId });
      activeReasoningId = null;
    }
  };

  try {
    for await (const event of eventStream) {
      if (event && typeof event === 'object') {
        // A permanent bot thread's summarization middleware calls a model
        // mid-turn; its output is a checkpoint summary, not a reply.
        if ((event as { metadata?: { lc_source?: unknown } }).metadata?.lc_source === SUMMARIZATION_SOURCE) {
          continue;
        }
        const eventName = (event as { event?: string }).event;

        if (eventName === 'on_chat_model_stream') {
          const chunk = (event as { data?: { chunk?: unknown } }).data?.chunk;
          const runId = (event as { run_id?: string }).run_id;
          const thinking = extractThinkingDelta(chunk);

          if (thinking) {
            if (!activeReasoningId) {
              reasoningIndex++;
              activeReasoningId = runId
                ? `reasoning-${runId}-${reasoningIndex}`
                : `reasoning-${Date.now()}-${reasoningIndex}`;
              writer.write({ type: 'reasoning-start', id: activeReasoningId });
            }
            writer.write({
              type: 'reasoning-delta',
              id: activeReasoningId,
              delta: thinking,
            });
          } else if (hasTextContent(chunk)) {
            closeReasoning();
          }
        } else if (eventName === 'on_tool_start' || eventName === 'on_chat_model_end') {
          closeReasoning();
        }
      }

      yield event as T;
    }
  } finally {
    closeReasoning();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalizeToolInput(input: unknown): unknown {
  if (isPlainObject(input)) {
    const keys = Object.keys(input);
    if (keys.length === 1 && keys[0] === 'input' && typeof input.input === 'string') {
      try {
        const parsed = JSON.parse(input.input);
        return isPlainObject(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    return input;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return isPlainObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isReasoningChunk(chunk: UIMessageChunk): boolean {
  return (
    chunk.type === 'reasoning-start' ||
    chunk.type === 'reasoning-delta' ||
    chunk.type === 'reasoning-end'
  );
}

/**
 * Converts a LangChain event stream with thinking blocks into a UI message stream,
 * preserving original error instances (e.g. `GraphRecursionError`) for `onError`.
 */
export function toThinkingMessageStream(
  eventStream: AsyncIterable<unknown>,
  writer: Pick<UIMessageStreamWriter, 'write'>,
): ReadableStream<UIMessageChunk> {
  let streamError: unknown = null;
  const toolInputs = new Map<string, unknown>();

  async function* captureErrorStream(): AsyncGenerator<LangChainStreamChunk, void, unknown> {
    try {
      for await (const chunk of tapEventStream<LangChainStreamChunk>(eventStream, writer)) {
        if (chunk && typeof chunk === 'object') {
          const event = chunk as { event?: string; run_id?: string; data?: { input?: unknown } };
          if (event.event === 'on_tool_start' && typeof event.run_id === 'string') {
            const normalized = normalizeToolInput(event.data?.input);
            if (normalized !== undefined) {
              toolInputs.set(event.run_id, normalized);
            }
          }
          // `toUIMessageStream` picks its stream type from the first event, and
          // only reads it as a stream event when `data` is null or an object. A
          // first event with no `data` would switch it to "model" mode and drop
          // every later event, so give it `data: null`, which it already skips.
          if (typeof event.event === 'string' && typeof event.data !== 'object') {
            yield { ...event, data: null } as LangChainStreamChunk;
            continue;
          }
        }
        yield chunk;
      }
    } catch (err) {
      streamError = err;
      throw err;
    }
  }

  const rawStream = toUIMessageStream(captureErrorStream() as Parameters<typeof toUIMessageStream>[0]);
  const reader = rawStream.getReader();

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      let result = await reader.read();
      // `tapEventStream` already writes thinking as reasoning parts. Newer
      // `@ai-sdk/langchain` versions also emit their own reasoning chunks for
      // the same blocks, which renders every thinking block twice — drop theirs.
      while (!result.done && isReasoningChunk(result.value)) {
        result = await reader.read();
      }
      const { done, value } = result;
      if (done) {
        controller.close();
        return;
      }
      if (value.type === 'error') {
        controller.error(streamError ?? new Error(value.errorText));
        return;
      }
      // A tool result reaches the browser head-first: the trace shows at
      // most TOOL_OUTPUT_CLIENT_CHARS of it and fetches the rest from the
      // stored reply on demand, so that is all the client is sent.
      controller.enqueue(
        value.type === 'tool-output-available'
          ? ({ ...value, output: clipToolOutput(value.output) } as UIMessageChunk)
          : value,
      );
      if (
        value.type === 'tool-input-start' &&
        'toolCallId' in value &&
        typeof value.toolCallId === 'string'
      ) {
        const toolCallId = value.toolCallId;
        if (toolInputs.has(toolCallId)) {
          const input = toolInputs.get(toolCallId);
          toolInputs.delete(toolCallId);
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId,
            toolName: (value as { toolName?: string }).toolName ?? '',
            input,
            dynamic: true,
          } as UIMessageChunk);
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}


