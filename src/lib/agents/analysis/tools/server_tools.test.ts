import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AIMessage } from '@langchain/core/messages';
import { beforeAll, describe, expect, it } from 'vitest';

import { MIN_SERVER_TOOL_MAX_USES, SERVER_TOOLS } from './server_tools';

const SERVER_TOOL_RESULT_TYPES = [
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
] as const;

const byName = (name: string) => SERVER_TOOLS.find((t) => t.name === name);

describe('SERVER_TOOLS', () => {
  it('exposes web_search and web_fetch on the 2026 dynamic-filtering variants', () => {
    expect(byName('web_search')?.type).toBe('web_search_20260209');
    expect(byName('web_fetch')?.type).toBe('web_fetch_20260209');
  });

  it('never declares code_execution, which the 2026 variants run internally', () => {
    expect(SERVER_TOOLS.some((t) => t.name === 'code_execution')).toBe(false);
    expect(SERVER_TOOLS.some((t) => t.type.startsWith('code_execution'))).toBe(false);
  });

  it('gives web_search a max_uses that will not bind during a research turn', () => {
    // A cap of 5 was spent within the first message or two of a thread once the
    // prompts made external search the default, after which every further
    // search returned max_uses_exceeded and the agent fell back to valyu_search.
    expect(byName('web_search')?.max_uses).toBeGreaterThanOrEqual(MIN_SERVER_TOOL_MAX_USES);
  });

  it('gives every server tool an explicit max_uses above the floor', () => {
    for (const tool of SERVER_TOOLS) {
      expect(tool.max_uses, tool.name).toBeGreaterThanOrEqual(MIN_SERVER_TOOL_MAX_USES);
    }
  });
});

/**
 * The 2026 web tools run inside Anthropic's code-execution sandbox, which makes
 * the Copilot's search depend on two things stock @langchain/anthropic@1.3.26
 * gets wrong. `patches/@langchain__anthropic@1.3.26.patch` fixes both; these
 * tests drive the patched module directly, because a node_modules tree that
 * predates the patch reproduces the bugs while every source file still looks
 * correct.
 *
 * 1. The result types. A search returns a `code_execution_tool_result` wrapping
 *    the `web_search_tool_result`, and stock allowlists neither that nor
 *    `web_fetch_tool_result`, so it drops them off the assistant message. The
 *    search still answers; the thread breaks on the NEXT turn, when the replayed
 *    history carries `server_tool_use` blocks whose results are gone and the API
 *    returns 400 "When responding to programmatic tool calling, only tool_result
 *    blocks are allowed."
 *
 * 2. The prefilled input. Stock blanks `input` to "" on every `server_tool_use`
 *    content_block_start, assuming `input_json_delta` events will refill it.
 *    That holds for `code_execution`, which the model writes token by token. It
 *    is false for the nested `web_search` call the sandbox makes: the API sends
 *    that block COMPLETE in content_block_start with zero deltas following, so
 *    the query is blanked and never restored. Every later turn then replays the
 *    search as `{"name":"web_search","input":{}}` — the agent reads its own
 *    history as a malformed call, reports a "formatting issue with the query
 *    input", and concludes web search is unavailable.
 */
describe('@langchain/anthropic patch', () => {
  const entry = createRequire(import.meta.url).resolve('@langchain/anthropic');
  const utilsDir = join(dirname(entry), 'utils');
  const outputsModulePath = pathToFileURL(join(utilsDir, 'message_outputs.js')).href;
  const inputsModulePath = pathToFileURL(join(utilsDir, 'message_inputs.js')).href;

  // Deep import by absolute path: the package's `exports` map publishes only
  // "." and "./package.json", so a bare deep specifier will not resolve.
  let makeChunk: (
    data: Record<string, unknown>,
    fields: Record<string, unknown>,
  ) => { chunk: { content: unknown } } | undefined;
  let convertPayload: (messages: AIMessage[]) => {
    messages: Array<{ content: unknown }>;
  };

  beforeAll(async () => {
    [{ _makeMessageChunkFromAnthropicEvent: makeChunk }, { _convertMessagesToAnthropicPayload: convertPayload }] =
      await Promise.all([import(outputsModulePath), import(inputsModulePath)]);
  });

  const blockStart = (contentBlock: Record<string, unknown>) =>
    makeChunk({ type: 'content_block_start', index: 0, content_block: contentBlock }, {});

  const firstBlock = (result: { chunk: { content: unknown } } | undefined) =>
    (result?.chunk.content as Array<Record<string, unknown>> | undefined)?.[0];

  it.each(SERVER_TOOL_RESULT_TYPES)('keeps a %s block on the assistant message', (type) => {
    const block = firstBlock(blockStart({ type, tool_use_id: 'srvtoolu_1', content: [] }));
    expect(block, 'dropped — run `pnpm install` to apply the patch').toBeDefined();
    expect(block?.type).toBe(type);
  });

  it.each(SERVER_TOOL_RESULT_TYPES)('replays a %s block on the outbound path', (type) => {
    const payload = convertPayload([
      new AIMessage({
        content: [{ type, tool_use_id: 'srvtoolu_1', content: [] }],
      }),
    ]);
    const blocks = payload.messages[0]?.content as Array<{ type: string }> | undefined;
    expect(
      blocks?.some((block) => block.type === type),
      'dropped on replay — run `pnpm install` to apply the patch',
    ).toBe(true);
  });

  it('keeps the query on a sandbox-issued web_search call, which streams no deltas', () => {
    const block = firstBlock(
      blockStart({
        type: 'server_tool_use',
        id: 'srvtoolu_2',
        name: 'web_search',
        input: { query: 'Nippon Soda news' },
        caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_1' },
      }),
    );
    expect(block?.input, 'query blanked — run `pnpm install` to apply the patch').toEqual({
      query: 'Nippon Soda news',
    });
  });

  it.each(['server_tool_use', 'tool_use'])(
    'still blanks an empty %s input so input_json_delta can concatenate onto it',
    (type) => {
      const block = firstBlock(
        blockStart({ type, id: 'srvtoolu_3', name: 'code_execution', input: {} }),
      );
      expect(block?.input).toBe('');
    },
  );
});
