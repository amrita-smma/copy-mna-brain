import { describe, expect, it } from 'vitest';
import { InvalidOccurredAtError, normalizeOccurredAt } from './occurredAt';

describe('normalizeOccurredAt', () => {
  it('returns undefined when nothing was supplied so the column default stamps the row', () => {
    expect(normalizeOccurredAt(undefined)).toBeUndefined();
    expect(normalizeOccurredAt(null)).toBeUndefined();
  });

  it('treats an empty or whitespace-only string as "not supplied"', () => {
    expect(normalizeOccurredAt('')).toBeUndefined();
    expect(normalizeOccurredAt('   ')).toBeUndefined();
  });

  it('normalizes a datetime-local value to an ISO string', () => {
    expect(normalizeOccurredAt('2026-10-12T11:39:00Z')).toBe('2026-10-12T11:39:00.000Z');
  });

  it('accepts a date-only value', () => {
    expect(normalizeOccurredAt('2026-10-12')).toBe('2026-10-12T00:00:00.000Z');
  });

  it('throws on an unparseable string', () => {
    expect(() => normalizeOccurredAt('last tuesday')).toThrow(InvalidOccurredAtError);
  });

  it('throws on a non-string value', () => {
    expect(() => normalizeOccurredAt(1760000000000)).toThrow(InvalidOccurredAtError);
  });
});
