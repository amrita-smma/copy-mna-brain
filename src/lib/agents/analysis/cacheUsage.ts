/**
 * Prompt-cache accounting for one model call, read off the `on_chat_model_end`
 * event the agent's event stream emits.
 *
 * Anthropic reports how much of the prompt was served from cache on every
 * response. Logging it per call is what makes the cache behaviour checkable:
 * on the second and later turns of a thread, `cacheRead` should cover at
 * least the fixed prefix (tools + system prompt), and a turn-one `cacheWrite`
 * followed by `cacheRead` of the same size on the next call is the signature
 * of a working prefix. A string of calls with `cacheRead: 0` means the prefix
 * is changing between calls.
 */

export interface CacheUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache. */
  cacheRead: number;
  /** Tokens written to the cache on this call. */
  cacheWrite: number;
}

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The usage of the model call an `on_chat_model_end` event closes, or null
 * when the event carries none (a mocked model, a provider that does not
 * report usage). Reads LangChain's normalized `usage_metadata` first and
 * falls back to Anthropic's raw `response_metadata.usage`.
 */
export function cacheUsageFromModelEnd(event: unknown): CacheUsage | null {
  if (!event || typeof event !== 'object') return null;
  const output = (event as { data?: { output?: unknown } }).data?.output;
  if (!output || typeof output !== 'object') return null;
  const message = output as {
    usage_metadata?: UsageMetadata;
    response_metadata?: { usage?: AnthropicUsage };
  };

  const normalized = message.usage_metadata;
  if (normalized && typeof normalized === 'object') {
    return {
      inputTokens: num(normalized.input_tokens),
      outputTokens: num(normalized.output_tokens),
      cacheRead: num(normalized.input_token_details?.cache_read),
      cacheWrite: num(normalized.input_token_details?.cache_creation),
    };
  }

  const raw = message.response_metadata?.usage;
  if (raw && typeof raw === 'object') {
    return {
      inputTokens: num(raw.input_tokens),
      outputTokens: num(raw.output_tokens),
      cacheRead: num(raw.cache_read_input_tokens),
      cacheWrite: num(raw.cache_creation_input_tokens),
    };
  }
  return null;
}

/** One log line per model call: `call=2 in=1200 cache_read=24500 cache_write=0 out=310`. */
export function formatCacheUsage(call: number, usage: CacheUsage): string {
  return `call=${call} in=${usage.inputTokens} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} out=${usage.outputTokens}`;
}
