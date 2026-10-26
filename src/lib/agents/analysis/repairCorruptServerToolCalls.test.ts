import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  CORRUPT_SERVER_TOOL_PLACEHOLDER,
  stripCorruptServerToolCalls,
} from './repairCorruptServerToolCalls';

const nestedSearch = (input: unknown, id = 'srv_search') => ({
  type: 'server_tool_use',
  id,
  name: 'web_search',
  input,
  caller: { type: 'code_execution_20260120', tool_id: 'srv_code' },
});

const searchResult = (toolUseId = 'srv_search') => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  content: [{ type: 'web_search_result', title: 't', url: 'u', encrypted_content: 'x' }],
});

const codeBlock = {
  type: 'server_tool_use',
  id: 'srv_code',
  name: 'code_execution',
  input: { code: 'r = await web_search({"query": "Nippon Soda news"})' },
};

const codeResult = {
  type: 'code_execution_tool_result',
  tool_use_id: 'srv_code',
  content: { type: 'code_execution_result', stdout: '...', stderr: '', return_code: 0 },
};

describe('stripCorruptServerToolCalls', () => {
  it('returns [] for a healthy thread without touching it', () => {
    const messages = [
      new HumanMessage({ id: 'h1', content: 'search for X' }),
      new AIMessage({
        id: 'a1',
        content: [codeBlock, nestedSearch({ query: 'Nippon Soda news' }), searchResult(), codeResult],
      }),
    ];
    expect(stripCorruptServerToolCalls(messages)).toEqual([]);
  });

  it.each([{}, '', null, undefined])(
    'strips a server_tool_use with blanked input (%j) and its paired result',
    (input) => {
      const messages = [
        new AIMessage({
          id: 'a1',
          content: [codeBlock, nestedSearch(input), searchResult(), codeResult, { type: 'text', text: 'done' }],
        }),
      ];
      const [replacement] = stripCorruptServerToolCalls(messages);
      expect(replacement.id).toBe('a1');
      const types = (replacement.content as Array<{ type: string; id?: string }>).map((b) => b.type);
      expect(types).toEqual(['server_tool_use', 'code_execution_tool_result', 'text']);
    },
  );

  it('cascades to nested calls whose caller was stripped', () => {
    const blankedCode = { ...codeBlock, input: {} };
    const messages = [
      new AIMessage({
        id: 'a1',
        content: [blankedCode, nestedSearch({ query: 'q' }), searchResult(), codeResult],
      }),
    ];
    const [replacement] = stripCorruptServerToolCalls(messages);
    expect(replacement.content).toEqual([
      { type: 'text', text: CORRUPT_SERVER_TOOL_PLACEHOLDER },
    ]);
  });

  it('leaves a text placeholder rather than an empty assistant message', () => {
    const messages = [
      new AIMessage({ id: 'a1', content: [nestedSearch({}), searchResult()] }),
    ];
    const [replacement] = stripCorruptServerToolCalls(messages);
    expect(replacement.content).toEqual([
      { type: 'text', text: CORRUPT_SERVER_TOOL_PLACEHOLDER },
    ]);
  });

  it('strips a server tool call a cut-off turn left without its result block', () => {
    // A direct web_search the stream never finished: the 400 "found without a
    // corresponding web_search_tool_result block" on the next turn.
    const direct = { type: 'server_tool_use', id: 'srv_direct', name: 'web_search', input: { query: 'Nippon Soda news' } };
    const messages = [
      new AIMessage({ id: 'a1', content: [{ type: 'text', text: 'Let me check.' }, direct] }),
    ];
    const [replacement] = stripCorruptServerToolCalls(messages);
    expect(replacement.id).toBe('a1');
    expect(replacement.content).toEqual([{ type: 'text', text: 'Let me check.' }]);
  });

  it('strips an unanswered nested search and keeps the code block that issued it', () => {
    const messages = [
      new AIMessage({ id: 'a1', content: [codeBlock, nestedSearch({ query: 'q' }), codeResult] }),
    ];
    const [replacement] = stripCorruptServerToolCalls(messages);
    expect(replacement.content).toEqual([codeBlock, codeResult]);
  });

  it('leaves the placeholder when the unanswered call was the whole message', () => {
    const direct = { type: 'server_tool_use', id: 'srv_direct', name: 'web_search', input: { query: 'q' } };
    const [replacement] = stripCorruptServerToolCalls([new AIMessage({ id: 'a1', content: [direct] })]);
    expect(replacement.content).toEqual([{ type: 'text', text: CORRUPT_SERVER_TOOL_PLACEHOLDER }]);
  });

  it('skips messages without an id so the reducer never appends a duplicate', () => {
    const messages = [new AIMessage({ content: [nestedSearch({}), searchResult()] })];
    expect(stripCorruptServerToolCalls(messages)).toEqual([]);
  });

  it('ignores human messages and string-content assistant messages', () => {
    const messages = [
      new HumanMessage({ id: 'h1', content: 'hello' }),
      new AIMessage({ id: 'a1', content: 'plain text answer' }),
    ];
    expect(stripCorruptServerToolCalls(messages)).toEqual([]);
  });

  it('preserves tool_calls and kwargs on the replacement', () => {
    const messages = [
      new AIMessage({
        id: 'a1',
        content: [nestedSearch({}), searchResult(), { type: 'text', text: 'ok' }],
        tool_calls: [{ id: 'tc1', name: 'get_companies', args: { q: 'x' } }],
        additional_kwargs: { foo: 'bar' },
      }),
    ];
    const [replacement] = stripCorruptServerToolCalls(messages);
    expect(replacement.tool_calls).toHaveLength(1);
    expect(replacement.additional_kwargs).toMatchObject({ foo: 'bar' });
    expect(replacement.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
