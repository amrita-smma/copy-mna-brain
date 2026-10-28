import { describe, it, expect } from 'vitest';
import { joinTextParts } from './textParts';

describe('joinTextParts', () => {
  it('puts a paragraph break between parts that would otherwise touch', () => {
    expect(
      joinTextParts([
        "I'll start by checking what fund data is available to me and what's on screen.",
        "I can't find it.",
      ]),
    ).toBe("I'll start by checking what fund data is available to me and what's on screen.\n\nI can't find it.");
  });

  it('keeps the seam as-is when either side already has whitespace', () => {
    expect(joinTextParts(['First.\n', 'Second.'])).toBe('First.\nSecond.');
    expect(joinTextParts(['First.', ' Second.'])).toBe('First. Second.');
  });

  it('skips empty parts without adding breaks for them', () => {
    expect(joinTextParts(['', 'One', '', 'Two', ''])).toBe('One\n\nTwo');
  });

  it('returns a single part unchanged and [] as an empty string', () => {
    expect(joinTextParts(['Only'])).toBe('Only');
    expect(joinTextParts([])).toBe('');
  });
});
