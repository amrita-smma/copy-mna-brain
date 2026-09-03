import { describe, it, expect } from 'vitest';
import { parseCsv, toFeedInput } from './import-rss-feeds';

describe('parseCsv', () => {
  it('maps each row onto the header keys', () => {
    const rows = parseCsv('category,source_name\nnew_funding,Mint\n');
    expect(rows).toEqual([{ category: 'new_funding', source_name: 'Mint' }]);
  });

  it('keeps commas that appear inside quoted fields', () => {
    const rows = parseCsv('source_name,notes\n"Reuters","Wire, global"\n');
    expect(rows[0].notes).toBe('Wire, global');
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('source_name\n"The ""Economist"""\n');
    expect(rows[0].source_name).toBe('The "Economist"');
  });

  it('ignores blank trailing lines', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toHaveLength(1);
  });
});

describe('toFeedInput', () => {
  it('treats OK and REPAIRED validation verdicts as active feeds', () => {
    expect(toFeedInput({ status: 'OK' } as never).status).toBe('active');
    expect(toFeedInput({ status: 'REPAIRED' } as never).status).toBe('active');
    expect(toFeedInput({} as never).status).toBe('active');
  });

  it('imports failed feeds as dead so they are on record but never polled', () => {
    expect(toFeedInput({ status: 'DEAD' } as never).status).toBe('dead');
  });

  it('normalises empty optional columns to null', () => {
    const input = toFeedInput({ category: 'new_funding', region: '', notes: '' } as never);
    expect(input.region).toBeNull();
    expect(input.notes).toBeNull();
  });
});
