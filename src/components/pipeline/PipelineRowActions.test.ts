import { describe, expect, it, vi } from 'vitest';
import { pipelineMoveItems, screeningMoveItem } from './PipelineRowActions';

const base = {
  isDropped: false,
  promoteTarget: 'L1',
  demoteTarget: 'unreviewed',
  onPromote: vi.fn(),
  onDemote: vi.fn(),
  onDrop: vi.fn(),
  onRestore: vi.fn(),
  code: (key: string) => key,
};

describe('screeningMoveItem', () => {
  it('offers Run AI Screening, enabled even before any track is matched', () => {
    const onRun = vi.fn();
    const item = screeningMoveItem({ running: false, onRun });

    expect(item).toMatchObject({ key: 'screening', label: 'Run AI Screening' });
    expect(item.disabled).toBeFalsy();
    item.onSelect();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('shows a disabled running state while a screening is in flight', () => {
    expect(screeningMoveItem({ running: true, onRun: vi.fn() })).toMatchObject({
      label: 'AI Screening Running',
      disabled: true,
    });
  });
});

describe('pipelineMoveItems', () => {
  it('has no AI screening item unless the row passes one (L0 and later rows do not)', () => {
    const keys = pipelineMoveItems(base).map((i) => i.key);
    expect(keys).toEqual(['drop', 'next', 'back']);
  });

  it('appends Run AI Screening when given one', () => {
    const keys = pipelineMoveItems({
      ...base,
      screening: { running: false, onRun: vi.fn() },
    }).map((i) => i.key);
    expect(keys).toEqual(['drop', 'next', 'back', 'screening']);
  });

  it('only offers Restore on a dropped row', () => {
    const keys = pipelineMoveItems({
      ...base,
      isDropped: true,
      screening: { running: false, onRun: vi.fn() },
    }).map((i) => i.key);
    expect(keys).toEqual(['restore']);
  });
});
