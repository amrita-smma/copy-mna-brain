import { describe, expect, it } from 'vitest';
import { isDealLive, isDealLiveOverridden } from './dealStatus';

describe('isDealLive', () => {
  it('derives live from a non-empty advisor when no override is set', () => {
    expect(isDealLive({ advisor: 'Goldman Sachs' })).toBe(true);
    expect(isDealLive({ advisor: 'Goldman Sachs', is_live: null })).toBe(true);
  });

  it('is not live without an advisor and no override', () => {
    expect(isDealLive({})).toBe(false);
    expect(isDealLive({ advisor: null })).toBe(false);
    expect(isDealLive({ advisor: '   ' })).toBe(false);
  });

  it('honours an explicit true override even without an advisor', () => {
    expect(isDealLive({ is_live: true })).toBe(true);
    expect(isDealLive({ advisor: null, is_live: true })).toBe(true);
  });

  it('honours an explicit false override even with an advisor', () => {
    expect(isDealLive({ advisor: 'JP Morgan', is_live: false })).toBe(false);
  });
});

describe('isDealLiveOverridden', () => {
  it('is true only when is_live is explicitly set', () => {
    expect(isDealLiveOverridden({ is_live: true })).toBe(true);
    expect(isDealLiveOverridden({ is_live: false })).toBe(true);
    expect(isDealLiveOverridden({ is_live: null })).toBe(false);
    expect(isDealLiveOverridden({ advisor: 'Goldman Sachs' })).toBe(false);
  });
});
