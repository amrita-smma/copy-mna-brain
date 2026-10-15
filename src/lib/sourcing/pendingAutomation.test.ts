import { describe, it, expect } from 'vitest';
import {
  InvalidPendingAutomationError,
  normalizePendingAutomation,
  parsePendingAutomationInput,
} from './pendingAutomation';

describe('normalizePendingAutomation', () => {
  it('turns auto drop/promote off when auto-scan is off', () => {
    expect(normalizePendingAutomation({ autoScan: false, autoDropPromote: true })).toEqual({
      autoScan: false,
      autoDropPromote: false,
    });
  });

  it('keeps both on together', () => {
    expect(normalizePendingAutomation({ autoScan: true, autoDropPromote: true })).toEqual({
      autoScan: true,
      autoDropPromote: true,
    });
  });
});

describe('parsePendingAutomationInput', () => {
  it('accepts two booleans and normalizes them', () => {
    expect(parsePendingAutomationInput({ autoScan: false, autoDropPromote: true })).toEqual({
      autoScan: false,
      autoDropPromote: false,
    });
  });

  it.each([null, 'x', {}, { autoScan: 'yes', autoDropPromote: false }, { autoScan: true }])(
    'rejects %j',
    (body) => {
      expect(() => parsePendingAutomationInput(body)).toThrow(InvalidPendingAutomationError);
    },
  );
});
