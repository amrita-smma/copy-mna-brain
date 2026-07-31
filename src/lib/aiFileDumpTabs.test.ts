import { describe, expect, it } from 'vitest';
import { AI_FILE_DUMP_TABS, isAiFileDumpTab } from './aiFileDumpTabs';

describe('isAiFileDumpTab', () => {
  it('accepts every canonical tab slug', () => {
    for (const tab of AI_FILE_DUMP_TABS) {
      expect(isAiFileDumpTab(tab)).toBe(true);
    }
  });

  it('rejects unknown or nested path segments', () => {
    expect(isAiFileDumpTab('')).toBe(false);
    expect(isAiFileDumpTab('shopping-list')).toBe(false);
    expect(isAiFileDumpTab('MoM')).toBe(false);
    expect(isAiFileDumpTab('junk')).toBe(false);
  });
});
