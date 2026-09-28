import { describe, it, expect } from 'vitest';
import { GENERAL_CHAT_AGENT, describeChatAgent, toChatAgentKey } from './chatAgentKey';

describe('toChatAgentKey', () => {
  it('keeps a registry key', () => {
    expect(toChatAgentKey('bangun')).toBe('bangun');
  });

  it.each([[null], [undefined], [''], ['general'], ['retired-agent']])(
    'reads %s as the general CoPilot',
    (value) => {
      expect(toChatAgentKey(value)).toBe(GENERAL_CHAT_AGENT);
    },
  );
});

describe('describeChatAgent', () => {
  it('names a sector agent by handle and name', () => {
    expect(describeChatAgent('bangun')).toEqual({
      key: 'bangun',
      label: '@bangun · Construction and Property Development Agent',
      handle: '@bangun',
    });
  });

  it('names the general CoPilot', () => {
    expect(describeChatAgent('general')).toEqual({
      key: 'general',
      label: 'General CoPilot',
      handle: null,
    });
  });
});
