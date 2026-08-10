import { describe, expect, it } from 'vitest';
import { SMART_FILES_TABS, isSmartFilesTab } from './smartFilesTabs';

describe('isSmartFilesTab', () => {
  it('accepts every canonical tab slug', () => {
    for (const tab of SMART_FILES_TABS) {
      expect(isSmartFilesTab(tab)).toBe(true);
    }
  });

  it('rejects unknown or nested path segments', () => {
    expect(isSmartFilesTab('')).toBe(false);
    expect(isSmartFilesTab('shopping-list')).toBe(false);
    expect(isSmartFilesTab('MoM')).toBe(false);
    expect(isSmartFilesTab('junk')).toBe(false);
  });
});
