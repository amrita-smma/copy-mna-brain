import { describe, it, expect } from 'vitest';
import {
  estimateScanMinutes,
  formatScanEstimate,
  InvalidPendingAutomationError,
  normalizePendingAutomation,
  parsePendingAutomationInput,
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
