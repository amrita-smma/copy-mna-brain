import { describe, it, expect } from 'vitest';
import { modelSupportsTemperature } from './modelParams';

describe('modelSupportsTemperature', () => {
  it('returns false for models that reject sampling params', () => {
    expect(modelSupportsTemperature('claude-sonnet-5')).toBe(false);
    expect(modelSupportsTemperature('claude-sonnet-5-20260101')).toBe(false);
    expect(modelSupportsTemperature('claude-opus-4-7')).toBe(false);
    expect(modelSupportsTemperature('claude-opus-4-8')).toBe(false);
    expect(modelSupportsTemperature('claude-fable-5')).toBe(false);
  });

  it('returns true for models that still accept temperature', () => {
    expect(modelSupportsTemperature('claude-haiku-4-5-20251001')).toBe(true);
    expect(modelSupportsTemperature('claude-haiku-4-5')).toBe(true);
    expect(modelSupportsTemperature('claude-sonnet-4-6')).toBe(true);
  });
});
