import { describe, expect, it } from 'vitest';
import {
  DEDICATED_FILE_TYPES,
  SMART_FILES_TABS,
  SMART_FILES_TAB_LABELS,
  SMART_FILES_UPLOAD_CATEGORIES,
  isSmartFilesTab,
} from './smartFilesTabs';

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

describe('SMART_FILES_TABS', () => {
  it('includes the bond issuance and financial statement categories', () => {
    expect(SMART_FILES_TABS).toContain('bond_issuance');
    expect(SMART_FILES_TABS).toContain('financial_statement');
  });

  it('keeps "other" last so it reads as the catch-all bucket', () => {
    expect(SMART_FILES_TABS[SMART_FILES_TABS.length - 1]).toBe('other');
  });

  it('labels every tab', () => {
    for (const tab of SMART_FILES_TABS) {
      expect(SMART_FILES_TAB_LABELS[tab]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('DEDICATED_FILE_TYPES', () => {
  it('is every tab except the "other" catch-all', () => {
    expect([...DEDICATED_FILE_TYPES]).toEqual(
      SMART_FILES_TABS.filter((tab) => tab !== 'other'),
    );
    expect(DEDICATED_FILE_TYPES as readonly string[]).not.toContain('other');
  });
});

describe('SMART_FILES_UPLOAD_CATEGORIES', () => {
  it('omits banker_communications, which is driven by the export format', () => {
    expect(SMART_FILES_UPLOAD_CATEGORIES as readonly string[]).not.toContain(
      'banker_communications',
    );
  });

  it('offers every other category, including the two new ones', () => {
    expect([...SMART_FILES_UPLOAD_CATEGORIES]).toEqual(
      SMART_FILES_TABS.filter((tab) => tab !== 'banker_communications'),
    );
    expect(SMART_FILES_UPLOAD_CATEGORIES as readonly string[]).toContain('bond_issuance');
    expect(SMART_FILES_UPLOAD_CATEGORIES as readonly string[]).toContain(
      'financial_statement',
    );
  });
});
