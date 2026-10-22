import { describe, it, expect } from 'vitest';
import { PREVIOUS_TURN_CHARS, recallQueryFor, SHORT_QUERY_CHARS } from './recallQuery';

describe('recallQueryFor', () => {
  it('searches with the message alone when it carries its own context', () => {
    const long = 'How does the Indonesian coal mandate we discussed compare with the nickel targets?';
    expect(long.length).toBeGreaterThan(SHORT_QUERY_CHARS);
    expect(recallQueryFor(long, 'Earlier question')).toBe(long);
  });

  it('prepends the previous user turn to a short follow-up', () => {
    expect(recallQueryFor('ok do that', 'Find me Indonesian coal targets under $50m')).toBe(
      'Find me Indonesian coal targets under $50m\nok do that',
    );
  });

  it('clips a long previous turn', () => {
    const previous = 'x'.repeat(PREVIOUS_TURN_CHARS + 50);
    const query = recallQueryFor('and them?', previous);
    expect(query.startsWith('x'.repeat(PREVIOUS_TURN_CHARS))).toBe(true);
    expect(query).toContain('…\nand them?');
  });

  it('uses the message alone when there is no previous turn', () => {
    expect(recallQueryFor('ok do that')).toBe('ok do that');
    expect(recallQueryFor('ok do that', '   ')).toBe('ok do that');
  });

  it('falls back to the previous turn for an empty message, and to nothing at all', () => {
    expect(recallQueryFor('   ', 'What about Acme?')).toBe('What about Acme?');
    expect(recallQueryFor('')).toBe('');
  });
});
