import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ChatAnthropic: vi.fn() }));

vi.mock('@langchain/anthropic', () => ({ ChatAnthropic: mocks.ChatAnthropic }));

import { AnthropicMemoryLlm, messageContentToText } from './llm';
import { modelSupportsTemperature } from '@/lib/ai/modelParams';

const build = (model = 'claude-haiku-5-5') =>
  new AnthropicMemoryLlm({ model, apiKey: 'k', maxTokens: 3000 });

beforeEach(() => {
  vi.clearAllMocks();
  // A function expression, not an arrow: the module calls it with `new`.
  mocks.ChatAnthropic.mockImplementation(function () {
    return { invoke: mocks.invoke };
  });
  mocks.invoke.mockResolvedValue({ content: '{"memory": []}' });
});

describe('messageContentToText', () => {
  it('passes a plain string through', () => {
    expect(messageContentToText('hello')).toBe('hello');
  });

  it('joins the text blocks of a structured reply', () => {
    expect(
      messageContentToText([
        { type: 'text', text: '{"memory":' },
        { type: 'text', text: ' []}' },
      ]),
    ).toBe('{"memory": []}');
  });

  it('ignores blocks that are not the answer', () => {
    expect(
      messageContentToText([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'the answer' },
        { type: 'tool_use', name: 'x', input: {} },
      ]),
    ).toBe('the answer');
  });

  it('returns an empty string for anything else', () => {
    expect(messageContentToText(null)).toBe('');
    expect(messageContentToText({ content: 'nope' })).toBe('');
  });
});

describe('AnthropicMemoryLlm', () => {
  it('never sends a temperature the model would reject', () => {
    // mem0's own `anthropic` provider hardcodes `temperature ?? 0.1` and always
    // sends it, which every current family 400s on.
    build();

    const config = mocks.ChatAnthropic.mock.calls[0][0];
    expect(modelSupportsTemperature(config.model)).toBe(false);
    expect(config).not.toHaveProperty('temperature');
  });

  it('still pins temperature where the model accepts one', () => {
    build('claude-haiku-4-5-20251001');

    expect(mocks.ChatAnthropic.mock.calls[0][0].temperature).toBe(0);
  });

  it('always returns a string, which is the contract mem0 relies on', async () => {
    // mem0 runs `extractJson(text)` over this. Returning a LangChain message —
    // which is what its own `langchain` provider does, because `AIMessage`
    // always carries a truthy `tool_calls: []` — dies with
    // `text.replace is not a function` deep inside its extraction.
    mocks.invoke.mockResolvedValue({
      content: [{ type: 'text', text: '{"memory": []}' }],
      tool_calls: [],
    });

    const result = await build().generateResponse([{ role: 'user', content: 'hi' }]);

    expect(typeof result).toBe('string');
    expect(result).toBe('{"memory": []}');
  });

  it('returns a string even when the reply has no usable content', async () => {
    mocks.invoke.mockResolvedValue({ content: [{ type: 'thinking', thinking: 'x' }] });

    expect(await build().generateResponse([{ role: 'user', content: 'hi' }])).toBe('');
  });

  it('passes the messages through with their roles intact', async () => {
    await build().generateResponse([
      { role: 'system', content: 'you extract' },
      { role: 'user', content: 'some notes' },
    ]);

    expect(mocks.invoke).toHaveBeenCalledWith([
      { role: 'system', content: 'you extract' },
      { role: 'user', content: 'some notes' },
    ]);
  });

  it('wraps the same string for generateChat', async () => {
    mocks.invoke.mockResolvedValue({ content: 'hello' });

    expect(await build().generateChat([{ role: 'user', content: 'hi' }])).toEqual({
      content: 'hello',
      role: 'assistant',
    });
  });
});
