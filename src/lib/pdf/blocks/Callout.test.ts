import { describe, it, expect } from 'vitest';
import { calloutPalette } from './Callout';
import { COLOR } from '../theme';
import type { CalloutTone } from '../types';

describe('calloutPalette', () => {
  it('inverts only the takeaway tone, so a summary cannot be mistaken for an aside', () => {
    const takeaway = calloutPalette('takeaway');
    expect(takeaway.bg).toBe(COLOR.brandNavy);
    expect(takeaway.body).toBe(COLOR.white);
    // No left rule: the whole panel is the accent.
    expect(takeaway.rule).toBeNull();

    for (const tone of ['warning', 'info', 'positive'] as const) {
      const palette = calloutPalette(tone);
      expect(palette.bg).not.toBe(COLOR.brandNavy);
      expect(palette.body).toBe(COLOR.text);
      expect(palette.rule).not.toBeNull();
    }
  });

  it('is amber for warning, which is also what an unrecognised tone falls back to', () => {
    const warning = calloutPalette('warning');
    expect(warning.bg).toBe(COLOR.calloutWarnBg);
    expect(warning.rule).toBe(COLOR.brandOrange);
    expect(warning.label).toBe(COLOR.brandOrangeDeep);
    // The agent schema constrains `tone`, but the renderer is reachable
    // directly and must not return an undefined palette.
    expect(calloutPalette('nonsense' as CalloutTone)).toEqual(warning);
  });

  it('never paints body text in the surface it sits on', () => {
    for (const tone of ['warning', 'takeaway', 'info', 'positive'] as const) {
      const palette = calloutPalette(tone);
      expect(palette.body).not.toBe(palette.bg);
      expect(palette.label).not.toBe(palette.bg);
      expect(palette.divider).not.toBe(palette.bg);
    }
  });
});
