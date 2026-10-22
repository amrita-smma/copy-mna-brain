import { describe, expect, it } from 'vitest';
import { normalizeNoteText, sameNote } from './memoryTypes';

describe('normalizeNoteText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeNoteText('  Remind me\n\n on  Fridays. ')).toBe('Remind me on Fridays.');
  });
});

describe('sameNote', () => {
  it('ignores case, spacing and a trailing full stop or bang', () => {
    expect(sameNote('Answer in Bahasa.', 'answer  in bahasa')).toBe(true);
    expect(sameNote('Call me Nico!', 'call me nico')).toBe(true);
  });

  it('keeps different notes apart', () => {
    expect(sameNote('Answer in Bahasa', 'Answer in English')).toBe(false);
  });
});
