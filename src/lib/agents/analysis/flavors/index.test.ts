import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// The flavor modules import the real tools barrel, which reaches the agent
// module through the workforce trigger — stub it so the tool arrays are
// populated rather than undefined at import time (same as coreTools.test.ts).
vi.mock('@/lib/agents/analysis', () => ({
  getStatelessAgentGraph: vi.fn(),
  getWorkforceAgentGraphForEffort: vi.fn(),
  getAgentGraph: vi.fn(),
  createLocalAgent: vi.fn(),
  AgentGraph: vi.fn(),
}));

import { COPILOT_FLAVORS, getCopilotFlavor } from './index';
import {
  COPILOT_AGENT_KEYS,
  DEFAULT_COPILOT_AGENT,
  isCopilotAgentType,
  type CopilotAgentType,
} from './keys';
import { workforceToolList } from '../workforce';

const names = (list: ReadonlyArray<{ name: string }>) => list.map((t) => t.name);

describe('COPILOT_FLAVORS', () => {
  it('has one entry per key, and every entry knows its own key', () => {
    expect(Object.keys(COPILOT_FLAVORS).sort()).toEqual([...COPILOT_AGENT_KEYS].sort());
    for (const key of COPILOT_AGENT_KEYS) {
      expect(COPILOT_FLAVORS[key].key, key).toBe(key);
    }
  });

  it('gives every flavor a non-empty prompt and tool list, with no tool registered twice', () => {
    for (const key of COPILOT_AGENT_KEYS) {
      const flavor = COPILOT_FLAVORS[key];
      expect(flavor.systemPrompt.trim(), key).not.toBe('');
      const toolList = flavor.toolList();
      expect(toolList.length, key).toBeGreaterThan(0);
      // createAgent rejects two tools registered under one name.
      const toolNames = names(toolList);
      expect(new Set(toolNames).size, key).toBe(toolNames.length);
    }
  });

  // A module-scope `[...tools]` throws at Next build time when the flavor
  // module evaluates while `tools/index.ts` is mid-initialization — the tools
  // module sits in an import cycle with services and job handlers. See
  // ./lazyToolList. vitest mocks the tools barrel, so only this invariant
  // (and the build) catches a regression.
  it('builds every tool list lazily rather than at module-evaluation time', () => {
    for (const key of COPILOT_AGENT_KEYS) {
      expect(typeof COPILOT_FLAVORS[key].toolList, key).toBe('function');
    }
    // The workforce list spreads the same arrays and sits on the same cycle.
    expect(typeof workforceToolList).toBe('function');
  });

  it('memoizes a flavor tool list, so repeated resolution is the same array', () => {
    const flavor = COPILOT_FLAVORS.mna;
    expect(flavor.toolList()).toBe(flavor.toolList());
    // @minority is @mna's factory, not a copy of its result.
    expect(COPILOT_FLAVORS.minority.toolList()).toBe(flavor.toolList());
  });

  it('gives every flavor its own prompt — no two flavors share one', () => {
    const prompts = COPILOT_AGENT_KEYS.map((k) => COPILOT_FLAVORS[k].systemPrompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});

describe('getCopilotFlavor', () => {
  it('resolves every shipped key to its own flavor', () => {
    for (const key of COPILOT_AGENT_KEYS) {
      expect(getCopilotFlavor(key).key, key).toBe(key);
    }
  });

  // `workspaces.copilot_agent` is a plain text column: a row written by a newer
  // deploy, or by hand, must not take the chat down.
  it('falls back to the default flavor for a key this build does not know', () => {
    expect(getCopilotFlavor('nope' as CopilotAgentType).key).toBe(DEFAULT_COPILOT_AGENT);
  });
});

describe('isCopilotAgentType', () => {
  it('accepts registry keys and rejects anything else', () => {
    expect(isCopilotAgentType('mna')).toBe(true);
    expect(isCopilotAgentType('crowdfunding')).toBe(true);
    expect(isCopilotAgentType('sector')).toBe(false);
    expect(isCopilotAgentType(undefined)).toBe(false);
    expect(isCopilotAgentType(42)).toBe(false);
  });
});

describe('keys module dependencies', () => {
  // workspaceService validates `copilot_agent` against this list. It is a
  // service imported by routes, so a LangChain (or tool module) import
  // reachable from here would drag the agent stack into every one of them.
  it('keys.ts imports nothing', () => {
    const src = readFileSync(join(__dirname, 'keys.ts'), 'utf8');
    expect(src.match(/(?:import|export)[^'"`;]*?from\s+['"][^'"]+['"]/g)).toBeNull();
    // Guard against a vacuous pass: the scanner does see real imports.
    const withImports = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(withImports.match(/(?:import|export)[^'"`;]*?from\s+['"][^'"]+['"]/g)).not.toBeNull();
  });
});
