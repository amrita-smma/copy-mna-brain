import { describe, it, expect } from 'vitest';
import { MOBILE_CHIP_LIMIT, chipOverflowLayout } from './ChipOverflow';

describe('chipOverflowLayout', () => {
  it('shows every chip on desktop', () => {
    expect(chipOverflowLayout(false, 5, false)).toEqual({
      collapsible: false,
      shownCount: 5,
      hiddenCount: 2,
    });
  });

  it('folds on mobile until expanded', () => {
    expect(chipOverflowLayout(true, 5, false)).toEqual({
      collapsible: true,
      shownCount: MOBILE_CHIP_LIMIT,
      hiddenCount: 2,
    });
    expect(chipOverflowLayout(true, 5, true)).toEqual({
      collapsible: true,
      shownCount: 5,
      hiddenCount: 2,
    });
  });

  it('does not collapse when at or below the limit', () => {
    expect(chipOverflowLayout(true, MOBILE_CHIP_LIMIT, false).collapsible).toBe(false);
    expect(chipOverflowLayout(true, 2, false).shownCount).toBe(2);
  });
});
