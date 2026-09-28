import { ChatAnthropic } from '@langchain/anthropic';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getLangfuseCallbacks } from '@/lib/langfuse';
import { logger } from '../logger';
import { z } from 'zod';

export type StructuredOutputClient =
  | {
      withStructuredOutput: (
        schema: z.ZodType<unknown> | Record<string, unknown>,
        config?: { name?: string },
      ) => {
        invoke: (messages: BaseMessage[] | string) => Promise<unknown>;
      };
      invoke?: (messages: BaseMessage[] | string) => Promise<unknown>;
    }
  | {
      withStructuredOutput?: (
        schema: z.ZodType<unknown> | Record<string, unknown>,
        config?: { name?: string },
      ) => {
        invoke: (messages: BaseMessage[] | string) => Promise<unknown>;
      };
      invoke: (messages: BaseMessage[] | string) => Promise<unknown>;
    };

export type LLMClientOverride = StructuredOutputClient | ChatAnthropic;

export interface StructuredOutputOptions<T> {
  schema: z.ZodType<T>;
  systemPrompt?: string;
  prompt: string | BaseMessage[];
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  maxTokens?: number;
  maxRetries?: number;
  toolName?: string;
  llmOverride?: LLMClientOverride;
}

export class StructuredOutputError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Invokes an LLM with strict Zod schema validation using LangChain / Anthropic structured output (forced tool calling).
 * Detects malformed / truncated responses and retries within a bounded policy.
 */
export async function invokeStructuredOutput<T>(options: StructuredOutputOptions<T>): Promise<T> {
  const {
    schema,
    systemPrompt,
    prompt,
    model = 'claude-sonnet-5',
    effort = 'low',
    maxTokens = 32000,
    maxRetries = 2,
    toolName = 'extract_structured_data',
    llmOverride,
  } = options;

  let llm = llmOverride;
  if (!llm) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }

    const supportsEffort = !model.toLowerCase().includes('haiku');

    llm = new ChatAnthropic({
      model,
      anthropicApiKey: apiKey,
      temperature: undefined,
      maxTokens,
      streaming: true,
      callbacks: getLangfuseCallbacks(),
      // Anthropic defaults to high effort when output_config is omitted; low effort is sufficient for schema-constrained output.
      // Haiku models reject output_config.effort, so omit outputConfig when unsupported.
      ...(supportsEffort ? { outputConfig: { effort } } : {}),
    });
  }

  const structuredLlm = typeof llm.withStructuredOutput === 'function'
    ? llm.withStructuredOutput(schema, { name: toolName })
    : llm;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const messages: BaseMessage[] = [];
      if (systemPrompt) {
        messages.push(new SystemMessage(systemPrompt));
      }
      if (typeof prompt === 'string') {
        messages.push(new HumanMessage(prompt));
      } else {
        messages.push(...prompt);
      }

      if (attempt > 1 && lastError) {
        messages.push(
          new HumanMessage(
            `Previous response validation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}. Please ensure the output strictly conforms to the requested schema.`,
          ),
        );
      }

      const response = await structuredLlm.invoke(messages);
      // Validate schema strictly
      const parsed = schema.parse(response);
      return parsed;
    } catch (err) {
      lastError = err;
      logger.warn(`[structuredOutput] Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt > maxRetries) {
        break;
      }
    }
  }

  throw new StructuredOutputError(
    `Structured output invocation failed after ${maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError,
  );
}
