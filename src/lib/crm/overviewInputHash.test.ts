import { describe, it, expect } from 'vitest';
import { overviewInputHash } from './overviewInputHash';

describe('overviewInputHash', () => {
  it('is the notes-only form when the contact has no deal links', () => {
    expect(overviewInputHash({ noteCount: 3, latestEmailId: 'e3', dealCompanyIds: [] })).toBe('3:e3');
    expect(overviewInputHash({ noteCount: 0, latestEmailId: null, dealCompanyIds: [] })).toBe('0:');
  });

  it('changes when a deal is linked or removed, whatever the order', () => {
    const one = overviewInputHash({ noteCount: 3, latestEmailId: 'e3', dealCompanyIds: ['b', 'a'] });
    expect(one).toMatch(/^3:e3:[0-9a-f]{12}$/);
    expect(overviewInputHash({ noteCount: 3, latestEmailId: 'e3', dealCompanyIds: ['a', 'b'] })).toBe(one);
    expect(overviewInputHash({ noteCount: 3, latestEmailId: 'e3', dealCompanyIds: ['a'] })).not.toBe(one);
  });
});
