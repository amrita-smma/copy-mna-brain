/**
 * mem0's `LLM` interface, implemented over `ChatAnthropic`.
 *
 * Neither of mem0's own providers works against the current Claude models:
 *
 * - `anthropic` hardcodes `config.temperature ?? 0.1` and always sends the
 *   field. Every current family 400s on it ("`temperature` is deprecated for
 *   this model"), and because `??` treats an explicit `undefined` as absent,
 *   no config value can switch it off.
 * - `langchain` looks like the way round that — pass your own model — but its
 *   `generateResponse` returns an OBJECT whenever the reply has a `tool_calls`
 *   array. LangChain's `AIMessage` always carries `tool_calls: []`, and an
 *   empty array is truthy, so that branch fires on every ChatAnthropic
 *   response. mem0 then calls `extractJson(text)` on it and dies with
 *   `text.replace is not a function`.
 *
 * So the LLM is ours, the same way the vector store is. The contract mem0
 * actually relies on is narrow: `generateResponse` must return a **string** it
 * can pull JSON out of. That is the one thing this guarantees.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { DISABLED_THINKING } from '@/lib/ai/thinking';
import { modelSupportsTemperature } from '@/lib/ai/modelParams';

/** mem0's `LLMResponse`, restated so nothing here imports types from `mem0ai/oss`. */
export interface MemoryLlmResponse {
  content: string;
  role: string;
}

export interface MemoryLlmOptions {
  model: string;
  apiKey?: string;
  maxTokens: number;
}

/**
 * The text of a LangChain reply, whatever shape it arrives in.
 *
 * `content` is a string for a plain completion, but an array of typed blocks
 * when the model emits anything structured — and only the `text` blocks are the
 * answer. Returning the array (or a JSON dump of it) is what breaks mem0.
 */
export function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

export class AnthropicMemoryLlm {
  private readonly llm: ChatAnthropic;

  constructor({ model, apiKey, maxTokens }: MemoryLlmOptions) {
    this.llm = new ChatAnthropic({
      model,
      anthropicApiKey: apiKey,
      maxTokens,
      // Omitted entirely for the families that reject it; 0 where it is still
      // accepted, so the same input does not extract two different ways.
      ...(modelSupportsTemperature(model) ? { temperature: 0 } : {}),
      // Deciding whether a statement is already known is a short, structured
      // call — the same configuration the app's other one-shot Haiku calls use.
      thinking: DISABLED_THINKING,
      outputConfig: { effort: 'low' },
    });
  }

  /**
   * Always a string. mem0 runs `extractJson()` over this, so returning anything
   * else fails deep inside its extraction with an unhelpful message.
   *
   * `tools` is accepted and ignored: mem0 only passes it on paths this app does
   * not use, and binding them would reintroduce the `tool_calls` shape that
   * broke its own adapter.
   */
  async generateResponse(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const reply = await this.llm.invoke(
      messages.map((message) => ({ role: message.role, content: message.content })),
    );
    return messageContentToText(reply.content);
  }

  async generateChat(
    messages: Array<{ role: string; content: string }>,
  ): Promise<MemoryLlmResponse> {
    return { content: await this.generateResponse(messages), role: 'assistant' };
  }
}
