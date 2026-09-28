import { describe, expect, it } from 'vitest';
import { formatTemplateUsage } from './templateUsage';

describe('formatTemplateUsage', () => {
  it('says nothing when no insight came from the template', () => {
    expect(formatTemplateUsage(0)).toBeNull();
    expect(formatTemplateUsage(undefined)).toBeNull();
    expect(formatTemplateUsage(null)).toBeNull();
  });

  it('uses the singular for one insight', () => {
    expect(formatTemplateUsage(1)).toBe('Used by 1 insight');
  });

  it('uses the plural, with thousands separators, for more', () => {
    expect(formatTemplateUsage(3)).toBe('Used by 3 insights');
    expect(formatTemplateUsage(1200)).toBe('Used by 1,200 insights');
  });
});
