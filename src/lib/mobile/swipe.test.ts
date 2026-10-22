import { describe, it, expect } from 'vitest';
import { LEADING_TRIGGER_PX, TRAY_OPEN_PX, isFullSwipe, resolveSwipe } from './swipe';

const base = { velocityX: 0, rowWidth: 400, hasLeading: true, hasTrailing: true };

describe('resolveSwipe', () => {
  it('runs the leading action once a right swipe passes the trigger', () => {
    expect(resolveSwipe({ ...base, x: LEADING_TRIGGER_PX })).toEqual({ kind: 'leading' });
    expect(resolveSwipe({ ...base, x: LEADING_TRIGGER_PX - 1 })).toEqual({ kind: 'close' });
  });

  it('counts a quick right flick as a full right swipe', () => {
    expect(resolveSwipe({ ...base, x: 30, velocityX: 900 })).toEqual({ kind: 'leading' });
  });

  it('springs back from a right swipe on a row with no leading action', () => {
    expect(resolveSwipe({ ...base, x: 200, hasLeading: false })).toEqual({ kind: 'close' });
  });

  it('runs the primary trailing action on a left swipe past half the row', () => {
    expect(resolveSwipe({ ...base, x: -200 })).toEqual({ kind: 'trailing' });
  });

  it('leaves the trailing actions open on a shorter left swipe', () => {
    expect(resolveSwipe({ ...base, x: -TRAY_OPEN_PX })).toEqual({ kind: 'open' });
    expect(resolveSwipe({ ...base, x: -120 })).toEqual({ kind: 'open' });
  });

  it('springs back from a small left nudge, unless it was flicked', () => {
    expect(resolveSwipe({ ...base, x: -20 })).toEqual({ kind: 'close' });
    expect(resolveSwipe({ ...base, x: -20, velocityX: -900 })).toEqual({ kind: 'open' });
  });

  it('does not run the primary action on a flick alone', () => {
    expect(resolveSwipe({ ...base, x: -150, velocityX: -2000 })).toEqual({ kind: 'open' });
  });

  it('springs back from a left swipe on a row with no trailing actions', () => {
    expect(resolveSwipe({ ...base, x: -300, hasTrailing: false })).toEqual({ kind: 'close' });
  });
});

describe('isFullSwipe', () => {
  it('is true from half the row width leftwards', () => {
    expect(isFullSwipe(-200, 400)).toBe(true);
    expect(isFullSwipe(-199, 400)).toBe(false);
    expect(isFullSwipe(50, 400)).toBe(false);
  });
});
