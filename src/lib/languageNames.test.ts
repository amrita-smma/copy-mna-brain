import { describe, it, expect } from 'vitest';
import { languageLabel } from './languageNames';

describe('languageLabel', () => {
  it('resolves ISO 639-1 codes the detector emits', () => {
    expect(languageLabel('ja')).toBe('Japanese');
    expect(languageLabel('de')).toBe('German');
    expect(languageLabel('zh')).toBe('Chinese');
    expect(languageLabel('en')).toBe('English');
  });

  it('returns null for a missing or blank code', () => {
    // A row whose language was never determined must render no "from …"
    // clause at all, rather than an empty one.
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel(undefined)).toBeNull();
    expect(languageLabel('   ')).toBeNull();
  });

  it('falls back to the raw value for a structurally invalid tag', () => {
    // `Intl.DisplayNames.of` throws on these; degrading beats throwing inside
    // a render.
    expect(languageLabel('!!')).toBe('!!');
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(languageLabel(' ko ')).toBe('Korean');
  });
});
