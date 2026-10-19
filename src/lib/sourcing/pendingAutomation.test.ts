import { describe, it, expect } from 'vitest';
import {
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
    // The retired combined field is not accepted in place of the split ones.
    { autoScan: true, autoDropPromote: true },
    { autoScan: true, autoPromote: true },
  ])('rejects %j', (body) => {
    expect(() => parsePendingAutomationInput(body)).toThrow(InvalidPendingAutomationError);
  });
});
