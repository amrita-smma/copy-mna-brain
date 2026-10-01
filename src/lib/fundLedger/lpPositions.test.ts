import { describe, expect, it } from 'vitest';
import { isFundLpPosition } from './lpPositions';

describe('isFundLpPosition', () => {
  const managed = { id: 'f-hua', managed: true };
  const external = { id: 'f-ext', managed: false };

  it('counts an outside investor holding the fund', () => {
    expect(isFundLpPosition({ fund_id: 'f-hua', holder_investor_id: 'inv-1' }, managed)).toBe(true);
    expect(isFundLpPosition({ fund_id: 'f-ext', holder_investor_id: 'inv-1' }, external)).toBe(true);
  });

  it('counts a managed fund holding another managed fund as its LP', () => {
    expect(isFundLpPosition({ fund_id: 'f-hua', holder_fund_id: 'f-yue' }, managed)).toBe(true);
  });

  it('does not count our managed fund\'s position in an external fund as that fund\'s LP', () => {
    expect(isFundLpPosition({ fund_id: 'f-ext', holder_fund_id: 'f-yue' }, external)).toBe(false);
  });

  it('ignores positions in other funds, asset positions, holderless positions and self-holding', () => {
    expect(isFundLpPosition({ fund_id: 'f-other', holder_investor_id: 'inv-1' }, managed)).toBe(false);
    expect(isFundLpPosition({ fund_id: 'f-hua', asset_id: 'a-1', holder_fund_id: 'f-yue' }, managed)).toBe(false);
    expect(isFundLpPosition({ fund_id: 'f-hua' }, managed)).toBe(false);
    expect(isFundLpPosition({ fund_id: 'f-hua', holder_fund_id: 'f-hua' }, managed)).toBe(false);
  });
});
