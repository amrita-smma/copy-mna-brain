import { describe, it, expect } from 'vitest';
import {
  countScanCompaniesByTrack,
  countScanSelection,
  estimateScanMinutes,
  InvalidScanNowSelectionError,
  isInScanSelection,
  parseScanNowSelection,
  formatScanEstimate,
  InvalidPendingAutomationError,
  normalizePendingAutomation,
  parsePendingAutomationInput,
  selectedTrackIdsFor,
} from './pendingAutomation';

describe('normalizePendingAutomation', () => {
  it('turns auto promote and auto drop off when auto-scan is off', () => {
    expect(
      normalizePendingAutomation({ autoScan: false, autoPromote: true, autoDrop: true }),
    ).toEqual({ autoScan: false, autoPromote: false, autoDrop: false });
  });

  it('keeps auto promote and auto drop independent while auto-scan is on', () => {
    expect(
      normalizePendingAutomation({ autoScan: true, autoPromote: true, autoDrop: false }),
    ).toEqual({ autoScan: true, autoPromote: true, autoDrop: false });
    expect(
      normalizePendingAutomation({ autoScan: true, autoPromote: false, autoDrop: true }),
    ).toEqual({ autoScan: true, autoPromote: false, autoDrop: true });
  });
});

describe('parsePendingAutomationInput', () => {
  it('accepts three booleans and normalizes them', () => {
    expect(
      parsePendingAutomationInput({ autoScan: false, autoPromote: true, autoDrop: true }),
    ).toEqual({ autoScan: false, autoPromote: false, autoDrop: false });
  });

  it.each([
    null,
    'x',
    {},
    { autoScan: 'yes', autoPromote: false, autoDrop: false },
    { autoScan: true },
    { autoScan: true, autoPromote: true },
  ])('rejects %j', (body) => {
    expect(() => parsePendingAutomationInput(body)).toThrow(InvalidPendingAutomationError);
  });
});

describe('estimateScanMinutes', () => {
  it('returns 0 when there are no companies to scan', () => {
    expect(estimateScanMinutes({ companies: 0, missingCards: 0 })).toBe(0);
  });

  it('counts 54s of AI screening per company, rounded to the nearest minute', () => {
    expect(estimateScanMinutes({ companies: 1, missingCards: 0 })).toBe(1); // 54s
    expect(estimateScanMinutes({ companies: 10, missingCards: 0 })).toBe(9); // 540s
    expect(estimateScanMinutes({ companies: 25, missingCards: 0 })).toBe(23); // 1350s = 22.5 min
  });

  it('adds 93s for each company whose Company Card has to be generated first', () => {
    expect(estimateScanMinutes({ companies: 1, missingCards: 1 })).toBe(2); // 147s = 2.45 min
    expect(estimateScanMinutes({ companies: 10, missingCards: 4 })).toBe(15); // 540 + 372 = 912s
    expect(estimateScanMinutes({ companies: 100, missingCards: 100 })).toBe(245); // 14700s
  });

  it('never counts more missing cards than companies', () => {
    expect(estimateScanMinutes({ companies: 2, missingCards: 5 })).toBe(
      estimateScanMinutes({ companies: 2, missingCards: 2 }),
    );
  });
});

describe('formatScanEstimate', () => {
  it('uses the singular for one minute', () => {
    expect(formatScanEstimate({ companies: 1, missingCards: 0 })).toBe('~1 minute');
  });

  it('reports the total in minutes, even past an hour', () => {
    expect(formatScanEstimate({ companies: 10, missingCards: 4 })).toBe('~15 minutes');
    expect(formatScanEstimate({ companies: 100, missingCards: 0 })).toBe('~90 minutes');
  });

  it('handles an empty bucket', () => {
    expect(formatScanEstimate({ companies: 0, missingCards: 0 })).toBe('less than a minute');
  });
});

const PREVIEW = {
  tracks: [
    { id: 't1', title: 'Healthcare' },
    { id: 't2', title: 'Logistics' },
  ],
  companies: [
    { trackIds: ['t1'], hasCard: true, queued: false },
    { trackIds: ['t1', 't2'], hasCard: false, queued: false },
    { trackIds: ['t2'], hasCard: true, queued: false },
    { trackIds: [], hasCard: false, queued: false },
  ],
};

describe('selectedTrackIdsFor', () => {
  it('returns the selected tracks the company is matched to, each kept separately', () => {
    expect(
      selectedTrackIdsFor(['t1', 't2', 't3'], { trackIds: ['t3', 't1'], includeUnmatched: false }),
    ).toEqual(['t1', 't3']);
  });

  it('returns [] for an unmatched company', () => {
    expect(selectedTrackIdsFor([], { trackIds: ['t1'], includeUnmatched: true })).toEqual([]);
  });
});

describe('isInScanSelection', () => {
  it('includes a company matched to any selected track', () => {
    expect(isInScanSelection(['t1', 't2'], { trackIds: ['t2'], includeUnmatched: false })).toBe(true);
    expect(isInScanSelection(['t1'], { trackIds: ['t2'], includeUnmatched: true })).toBe(false);
  });

  it('includes an unmatched company only when unmatched is selected', () => {
    expect(isInScanSelection([], { trackIds: ['t1'], includeUnmatched: false })).toBe(false);
    expect(isInScanSelection([], { trackIds: [], includeUnmatched: true })).toBe(true);
  });
});

describe('countScanCompaniesByTrack', () => {
  it('counts queued companies too, so each track lists every company matched to it', () => {
    const preview = {
      ...PREVIEW,
      companies: PREVIEW.companies.map((c) => ({ ...c, queued: true })),
    };
    expect(countScanCompaniesByTrack(preview).tracks.map((t) => t.companies)).toEqual([2, 2]);
  });

  it('counts a company under every track it is matched to, and the unmatched separately', () => {
    expect(countScanCompaniesByTrack(PREVIEW)).toEqual({
      tracks: [
        { id: 't1', title: 'Healthcare', companies: 2 },
        { id: 't2', title: 'Logistics', companies: 2 },
      ],
      unmatched: 1,
    });
  });
});

describe('countScanSelection', () => {
  it('counts a company in several selected tracks once', () => {
    expect(
      countScanSelection(PREVIEW, { trackIds: ['t1', 't2'], includeUnmatched: false }),
    ).toEqual({ companies: 3, missingCards: 1, alreadyQueued: 0 });
  });

  it('adds the unmatched companies when selected', () => {
    expect(
      countScanSelection(PREVIEW, { trackIds: ['t1'], includeUnmatched: true }),
    ).toEqual({ companies: 3, missingCards: 2, alreadyQueued: 0 });
  });

  it('leaves out companies already queued, counting them separately', () => {
    const preview = {
      ...PREVIEW,
      companies: PREVIEW.companies.map((c, i) => ({ ...c, queued: i === 1 })),
    };
    expect(
      countScanSelection(preview, { trackIds: ['t1', 't2'], includeUnmatched: false }),
    ).toEqual({ companies: 2, missingCards: 0, alreadyQueued: 1 });
  });

  it('is zero for an empty selection', () => {
    expect(countScanSelection(PREVIEW, { trackIds: [], includeUnmatched: false })).toEqual({
      companies: 0,
      missingCards: 0,
      alreadyQueued: 0,
    });
  });
});

describe('parseScanNowSelection', () => {
  it('returns null for no body', () => {
    expect(parseScanNowSelection(null)).toBeNull();
    expect(parseScanNowSelection(undefined)).toBeNull();
  });

  it('accepts track ids and the unmatched flag, de-duplicating ids', () => {
    expect(parseScanNowSelection({ trackIds: ['t1', 't1', 't2'], includeUnmatched: false })).toEqual({
      trackIds: ['t1', 't2'],
      includeUnmatched: false,
    });
  });

  it('rejects a malformed selection', () => {
    expect(() => parseScanNowSelection('t1')).toThrow(InvalidScanNowSelectionError);
    expect(() => parseScanNowSelection({ trackIds: [1], includeUnmatched: true })).toThrow(
      InvalidScanNowSelectionError,
    );
    expect(() => parseScanNowSelection({ trackIds: ['t1'] })).toThrow(InvalidScanNowSelectionError);
  });
});
