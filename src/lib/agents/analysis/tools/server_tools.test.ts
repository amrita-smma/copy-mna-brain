import { describe, expect, it } from 'vitest';

import { MIN_SERVER_TOOL_MAX_USES, SERVER_TOOLS } from './server_tools';

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
