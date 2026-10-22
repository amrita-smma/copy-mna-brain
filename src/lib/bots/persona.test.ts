import { describe, it, expect } from 'vitest';
import { personaText } from './persona';

describe('personaText', () => {
  it("returns the owner's text, trimmed", () => {
    expect(personaText('  ## Focus\n\nDeals.  ')).toBe('## Focus\n\nDeals.');
  });

  it('is blank for a new bot', () => {
    expect(personaText('')).toBe('');
    expect(personaText(null)).toBe('');
    expect(personaText(undefined)).toBe('');
  });

  it('drops the managed block personas carried before the fixed instructions moved into code', () => {
    const legacy =
      '<!-- managed:start (written by the app from the bot settings) -->\n# Scout\n\n## Skills\n\n- CRM\n<!-- managed:end -->\n\nBe brief.\n';
    expect(personaText(legacy)).toBe('Be brief.');
  });
});
