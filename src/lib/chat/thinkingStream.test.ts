import { describe, it, expect, vi } from 'vitest';
import { GraphRecursionError } from '@langchain/langgraph';
import { createUIMessageStream, type UIMessageChunk } from 'ai';
import {
  isGraphRecursionError,
  extractThinkingDelta,
  hasTextContent,
  tapEventStream,
  toThinkingMessageStream,
  normalizeToolInput,
  RECURSION_LIMIT_ERROR_MESSAGE,
} from './thinkingStream';
import { TOOL_OUTPUT_CLIENT_CHARS } from './toolOutputClip';

const modelChunk = (runId: string, content: unknown[]) => ({
  event: 'on_chat_model_stream',
  run_id: runId,
  data: { chunk: { content } },
});
const thinkingEvent = (runId: string, thinking: string) =>
  modelChunk(runId, [{ type: 'thinking', thinking }]);
const toolStart = (runId: string, name: string, input?: unknown) => ({
  event: 'on_tool_start',
  run_id: runId,
  name,
  ...(input === undefined ? {} : { data: { input } }),
});

async function* fromEvents(events: unknown[], failWith?: unknown) {
  yield* events;
  if (failWith) throw failWith;
}

/** Drains tapEventStream; returns the yielded events and the parts written. */
async function tap(events: unknown[]) {
  const written: UIMessageChunk[] = [];
  const yielded: unknown[] = [];
  for await (const item of tapEventStream(fromEvents(events), { write: (p) => written.push(p) })) {
    yielded.push(item);
  }
  return { written, yielded };
}

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

const reasoning = (id: string, delta: string): UIMessageChunk[] => [
  { type: 'reasoning-start', id },
  { type: 'reasoning-delta', id, delta },
  { type: 'reasoning-end', id },
];

describe('isGraphRecursionError', () => {
  it.each([
    ['a real GraphRecursionError', new GraphRecursionError('Recursion limit of 50 reached')],
    ['name GraphRecursionError', { name: 'GraphRecursionError', message: 'x' }],
    ['lc_error_code GRAPH_RECURSION_LIMIT', { lc_error_code: 'GRAPH_RECURSION_LIMIT', message: 'x' }],
    ['a message containing Recursion limit', new Error('Recursion limit exceeded')],
    ['a message containing GRAPH_RECURSION_LIMIT', new Error('stopped: GRAPH_RECURSION_LIMIT')],
  ])('recognises %s', (_label, error) => {
    expect(isGraphRecursionError(error)).toBe(true);
  });

  it.each([
    ['an unrelated Error', new Error('Something else failed')],
    ['the friendly step-limit copy', new Error(RECURSION_LIMIT_ERROR_MESSAGE)],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'error string'],
    ['a number', 123],
  ])('does not match %s', (_label, error) => {
    expect(isGraphRecursionError(error)).toBe(false);
  });
});

describe('extractThinkingDelta', () => {
  it.each([
    ['thinking', { content: [{ type: 'thinking', thinking: 'A' }] }, 'A'],
    ['thinking_delta', { content: [{ type: 'thinking_delta', thinking: 'B' }] }, 'B'],
    ['reasoning', { content: [{ type: 'reasoning', reasoning: 'C' }] }, 'C'],
    ['contentBlocks', { contentBlocks: [{ type: 'thinking', thinking: 'D' }] }, 'D'],
    [
      'multiple parts',
      { content: [{ type: 'thinking', thinking: 'Part 1. ' }, { type: 'thinking', thinking: 'Part 2.' }] },
      'Part 1. Part 2.',
    ],
  ])('extracts %s', (_label, chunk, expected) => {
    expect(extractThinkingDelta(chunk)).toBe(expected);
  });

  it('returns null when chunk has no thinking blocks', () => {
    expect(extractThinkingDelta(null)).toBe(null);
    expect(extractThinkingDelta({})).toBe(null);
    expect(extractThinkingDelta({ content: 'just text' })).toBe(null);
    expect(extractThinkingDelta({ content: [{ type: 'text', text: 'hello' }] })).toBe(null);
  });
});

describe('hasTextContent', () => {
  it.each([
    [{ content: 'Hello' }, true],
    [{ content: '' }, false],
    [{ content: [{ type: 'text', text: 'Hello' }] }, true],
    [{ content: [{ type: 'text', text: '' }] }, false],
    [{ content: [{ type: 'thinking', thinking: 'hmm' }] }, false],
    [null, false],
    [{}, false],
  ])('hasTextContent(%j) is %s', (chunk, expected) => {
    expect(hasTextContent(chunk)).toBe(expected);
  });
});

describe('tapEventStream', () => {
  it('passes events through and closes an unterminated reasoning block at stream end', async () => {
    const { written, yielded } = await tap([thinkingEvent('run-1', 'Initial thoughts')]);

    expect(yielded).toHaveLength(1);
    expect(written).toEqual(reasoning('reasoning-run-1-1', 'Initial thoughts'));
  });

  it.each([
    ['a text chunk', modelChunk('run-1', [{ type: 'text', text: 'Here is the answer' }])],
    ['on_tool_start', toolStart('t', 'web_search')],
  ])('closes the block when followed by %s', async (_label, next) => {
    const { written } = await tap([thinkingEvent('run-1', 'Thinking...'), next]);

    expect(written).toEqual(reasoning('reasoning-run-1-1', 'Thinking...'));
  });

  it('gives two separate thinking runs distinct ids', async () => {
    const { written } = await tap([
      thinkingEvent('run-1', 'First thought'),
      toolStart('t', 'calculator'),
      thinkingEvent('run-2', 'Second thought'),
    ]);

    expect(written).toEqual([
      ...reasoning('reasoning-run-1-1', 'First thought'),
      ...reasoning('reasoning-run-2-2', 'Second thought'),
    ]);
  });

  it("drops a bot thread's summarization model call so its summary never reaches the reply", async () => {
    const summarizing = {
      ...modelChunk('sum-1', [{ type: 'text', text: 'Summary of earlier turns' }]),
      metadata: { lc_source: 'summarization' },
    };
    const reply = modelChunk('r1', [{ type: 'text', text: 'Hello' }]);

    const { yielded, written } = await tap([summarizing, reply]);

    expect(yielded).toEqual([reply]);
    expect(written).toEqual([]);
  });

  it('writes nothing for a chunk with neither thinking nor text', async () => {
    const { written, yielded } = await tap([
      { event: 'on_chat_model_stream', run_id: 'run-1', data: { chunk: {} } },
      { event: 'custom_event', data: { hello: 'world' } },
    ]);

    expect(yielded).toHaveLength(2);
    expect(written).toEqual([]);
  });

  it('rethrows the original GraphRecursionError and closes active reasoning', async () => {
    const written: UIMessageChunk[] = [];
    const originalError = new GraphRecursionError('Recursion limit of 50 reached');

    let caught: unknown;
    try {
      for await (const _ of tapEventStream(
        fromEvents([thinkingEvent('run-1', 'Still thinking...')], originalError),
        { write: (p) => written.push(p) },
      )) {
        // consume
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(originalError);
    expect(written).toContainEqual({ type: 'reasoning-end', id: 'reasoning-run-1-1' });
  });

  it('hands the original GraphRecursionError to the UI stream onError, not a generic error', async () => {
    const recursionError = new GraphRecursionError('Recursion limit of 50 reached');
    const onError = vi.fn(() => RECURSION_LIMIT_ERROR_MESSAGE);

    const chunks = await collectChunks(
      createUIMessageStream({
        onError,
        execute: async ({ writer }) => {
          writer.merge(
            toThinkingMessageStream(
              fromEvents([thinkingEvent('run-1', 'Looping...')], recursionError),
              writer,
            ),
          );
        },
      }),
    );

    expect(onError).toHaveBeenCalledWith(recursionError);
    expect(chunks).toContainEqual({ type: 'error', errorText: RECURSION_LIMIT_ERROR_MESSAGE });
  });
});

describe('normalizeToolInput', () => {
  it.each([
    ['a single string input field', { input: '{"name":"Brief","html":"<p>hi</p>"}' }, { name: 'Brief', html: '<p>hi</p>' }],
    ['a raw JSON object string', '{"foo":"bar"}', { foo: 'bar' }],
    ['a plain object', { a: 1, b: 'two' }, { a: 1, b: 'two' }],
    ['a non-string input field', { input: { nested: true } }, { input: { nested: true } }],
    ['an empty object', {}, {}],
  ])('normalizes %s', (_label, input, expected) => {
    expect(normalizeToolInput(input)).toEqual(expected);
  });

  it.each([
    { input: 'invalid json' },
    { input: '123' },
    { input: '"string"' },
    { input: '[1, 2]' },
    'not-json',
    '[1, 2]',
    null,
    undefined,
    123,
    true,
    [1, 2, 3],
  ])('returns undefined for %j', (input) => {
    expect(normalizeToolInput(input)).toBeUndefined();
  });
});

describe('toThinkingMessageStream reasoning', () => {
  it('emits each thinking block once, via the writer, even when the library also converts it', async () => {
    const written: UIMessageChunk[] = [];
    // A real Anthropic AIMessageChunk exposes thinking in both `content` and
    // the standardised `contentBlocks`; @ai-sdk/langchain reads the latter.
    const chunks = await collectChunks(
      toThinkingMessageStream(
        fromEvents([
          {
            event: 'on_chat_model_stream',
            run_id: 'run-1',
            data: {
              chunk: {
                content: [{ type: 'thinking', thinking: 'plan the query' }],
                contentBlocks: [{ type: 'reasoning', reasoning: 'plan the query' }],
              },
            },
          },
          modelChunk('run-1', [{ type: 'text', text: 'Answer' }]),
        ]),
        { write: (p) => written.push(p) },
      ),
    );

    expect(chunks.filter((c) => c.type.startsWith('reasoning-'))).toEqual([]);
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(written).toEqual(reasoning('reasoning-run-1-1', 'plan the query'));
  });
});

describe('toThinkingMessageStream tool input emission', () => {
  it.each([
    [
      'a JSON-string-wrapped input',
      { input: JSON.stringify({ name: 'Sector Brief', html: '<p>APAC</p>' }) },
      { name: 'Sector Brief', html: '<p>APAC</p>' },
    ],
    ['a plain-object input', { expression: '2 + 2' }, { expression: '2 + 2' }],
  ])('emits tool-input-available right after tool-input-start for %s', async (_label, raw, expected) => {
    const chunks = await collectChunks(
      toThinkingMessageStream(fromEvents([toolStart('tool-run-1', 'some_tool', raw)]), { write: vi.fn() }),
    );

    const startIdx = chunks.findIndex((c) => c.type === 'tool-input-start');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(chunks[startIdx + 1]).toEqual({
      type: 'tool-input-available',
      toolCallId: 'tool-run-1',
      toolName: 'some_tool',
      input: expected,
      dynamic: true,
    });
  });

  it('still emits later tool events when the first event arrives with no data', async () => {
    const chunks = await collectChunks(
      toThinkingMessageStream(
        fromEvents([
          toolStart('tool-run-no-data', 'broken_tool'),
          toolStart('tool-run-2', 'some_tool', { expression: '2 + 2' }),
          { event: 'on_tool_end', run_id: 'tool-run-2', name: 'some_tool', data: { output: '4' } },
        ]),
        { write: vi.fn() },
      ),
    );

    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'tool-input-start', toolCallId: 'tool-run-2', toolName: 'some_tool', dynamic: true },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-run-2',
        toolName: 'some_tool',
        input: { expression: '2 + 2' },
        dynamic: true,
      },
      { type: 'tool-output-available', toolCallId: 'tool-run-2', output: '4' },
      { type: 'finish' },
    ]);
  });

  it('sends a long tool result head-first, named by its ToolMessage call id', async () => {
    const long = 'y'.repeat(TOOL_OUTPUT_CLIENT_CHARS + 1);
    const output = { lc: 1, kwargs: { content: long, tool_call_id: 'toolu_9', name: 'big_tool' } };
    const chunks = await collectChunks(
      toThinkingMessageStream(
        fromEvents([
          toolStart('tool-run-3', 'big_tool', { q: 'all' }),
          { event: 'on_tool_end', run_id: 'tool-run-3', name: 'big_tool', data: { output } },
        ]),
        { write: vi.fn() },
      ),
    );

    expect(chunks).toContainEqual({
      type: 'tool-output-available',
      toolCallId: 'tool-run-3',
      output: {
        kwargs: { content: 'y'.repeat(TOOL_OUTPUT_CLIENT_CHARS) },
        clipped: { fullChars: long.length, toolCallId: 'toolu_9' },
      },
    });
  });

  it('does not emit tool-input-available when the input is unparseable', async () => {
    const chunks = await collectChunks(
      toThinkingMessageStream(
        fromEvents([toolStart('tool-run-bad-json', 'custom_tool', { input: 'invalid{json' })]),
        { write: vi.fn() },
      ),
    );

    expect(chunks.some((c) => c.type === 'tool-input-start')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool-input-available')).toBe(false);
  });
});
