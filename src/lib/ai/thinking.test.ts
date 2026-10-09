import { describe, it, expect } from 'vitest';
import { BETWEEN_TOOLS_THINKING, DISABLED_THINKING } from './thinking';

describe('thinking config constants', () => {
  it('BETWEEN_TOOLS_THINKING is the bare between_tools config', () => {
    // Sonnet 5.5 rejects `between_tools` sent with any other field
    // (`display`, `budget_tokens`, `block_binding`) — keep it a lone `type`.
    expect(BETWEEN_TOOLS_THINKING).toEqual({ type: 'between_tools' });
    expect(Object.keys(BETWEEN_TOOLS_THINKING as object)).toEqual(['type']);
  });

  it('DISABLED_THINKING is the bare disabled config', () => {
    expect(DISABLED_THINKING).toEqual({ type: 'disabled' });
  });
});
