import { describe, it, expect } from 'vitest';
import {
  CLICK_BACK_ZONE,
  WHEEL_COOLDOWN_MS,
  WHEEL_GESTURE_GAP_MS,
  WHEEL_THRESHOLD_PX,
  clampPage,
  clickToStep,
  fitPageWidth,
  initialWheelState,
  keyToSlideAction,
  normalizeWheelDelta,
  reduceWheel,
  type WheelState,
} from './pdfSlideNavigation';

describe('clampPage', () => {
  it('keeps a page inside the document bounds', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });

  it('returns 1 for an empty document', () => {
    expect(clampPage(4, 0)).toBe(1);
  });
});

describe('keyToSlideAction', () => {
  it('advances on right/down/page-down/space/enter', () => {
    for (const key of ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n']) {
      expect(keyToSlideAction(key)).toEqual({ type: 'step', step: 1 });
    }
  });

  it('goes back on left/up/page-up/backspace and shift+space', () => {
    for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p']) {
      expect(keyToSlideAction(key)).toEqual({ type: 'step', step: -1 });
    }
    expect(keyToSlideAction(' ', true)).toEqual({ type: 'step', step: -1 });
  });

  it('jumps to the ends on Home/End', () => {
    expect(keyToSlideAction('Home')).toEqual({ type: 'first' });
    expect(keyToSlideAction('End')).toEqual({ type: 'last' });
  });

  it('ignores unrelated keys', () => {
    expect(keyToSlideAction('a')).toBeNull();
    expect(keyToSlideAction('Escape')).toBeNull();
  });
});

describe('normalizeWheelDelta', () => {
  it('converts line and page units to pixels', () => {
    expect(normalizeWheelDelta(3, 0)).toBe(3);
    expect(normalizeWheelDelta(3, 1)).toBe(48);
    expect(normalizeWheelDelta(1, 2)).toBe(800);
  });
});

describe('reduceWheel', () => {
  const wheel = (state: WheelState, deltaY: number, now: number, deltaX = 0) =>
    reduceWheel(state, { deltaX, deltaY, deltaMode: 0, now });

  it('turns one slide forward once the threshold is crossed', () => {
    const result = wheel(initialWheelState(), WHEEL_THRESHOLD_PX + 1, 1000);
    expect(result.step).toBe(1);
  });

  it('turns backwards on negative travel', () => {
    expect(wheel(initialWheelState(), -100, 1000).step).toBe(-1);
  });

  it('accumulates small trackpad deltas within one gesture', () => {
    let state = initialWheelState();
    const steps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = wheel(state, 10, 1000 + i * 16);
      state = r.state;
      steps.push(r.step);
    }
    expect(steps).toEqual([0, 0, 0, 1, 0]);
  });

  it('swallows the inertial tail during the cooldown so one swipe is one slide', () => {
    const first = wheel(initialWheelState(), 120, 1000);
    expect(first.step).toBe(1);
    const tail = wheel(first.state, 120, 1000 + WHEEL_COOLDOWN_MS - 1);
    expect(tail.step).toBe(0);
    const later = wheel(tail.state, 120, 1000 + WHEEL_COOLDOWN_MS + WHEEL_GESTURE_GAP_MS + 1);
    expect(later.step).toBe(1);
  });

  it('resets the accumulator after a pause between gestures', () => {
    const a = wheel(initialWheelState(), 30, 1000);
    expect(a.step).toBe(0);
    const b = wheel(a.state, 30, 1000 + WHEEL_GESTURE_GAP_MS + 1);
    expect(b.step).toBe(0);
  });

  it('uses horizontal travel when it dominates', () => {
    expect(wheel(initialWheelState(), 2, 1000, -100).step).toBe(-1);
  });
});

describe('clickToStep', () => {
  it('goes back when clicking the left zone and advances elsewhere', () => {
    expect(clickToStep(0, 1000)).toBe(-1);
    expect(clickToStep(CLICK_BACK_ZONE * 1000 - 1, 1000)).toBe(-1);
    expect(clickToStep(500, 1000)).toBe(1);
    expect(clickToStep(999, 1000)).toBe(1);
  });

  it('advances when the stage has no width', () => {
    expect(clickToStep(0, 0)).toBe(1);
  });
});

describe('fitPageWidth', () => {
  it('is limited by height for a portrait page in a wide stage', () => {
    expect(fitPageWidth(1600, 900, 1.294)).toBe(Math.floor(900 / 1.294));
  });

  it('is limited by width for a landscape slide in a tall stage', () => {
    expect(fitPageWidth(800, 1000, 0.5625)).toBe(800);
  });

  it('falls back to the stage width for invalid dimensions', () => {
    expect(fitPageWidth(500, 0, 1)).toBe(500);
  });
});
