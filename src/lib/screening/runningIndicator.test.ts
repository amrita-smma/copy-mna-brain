import { describe, expect, it } from 'vitest';
import { mergeRunningScreeningCompanyIds } from './runningIndicator';
import type { ScreeningTaskStatus } from '@/lib/services/aiScreeningService';

const task = (
  companyId: string,
  status: ScreeningTaskStatus['status'],
): ScreeningTaskStatus => ({
  companyId,
  companyName: 'Co',
  pipelineStage: 'unreviewed',
  runId: 'run-1',
  status,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  endedAt: null,
});

describe('mergeRunningScreeningCompanyIds', () => {
  it('includes companies with an active AI Workforce screening task and no pending rows yet', () => {
    const ids = mergeRunningScreeningCompanyIds([], [], [task('c-pending-scan', 'running')]);
    expect([...ids]).toEqual(['c-pending-scan']);
  });

  it('does not treat a finished workforce task as running', () => {
    const ids = mergeRunningScreeningCompanyIds([], [], [task('c1', 'succeeded')]);
    expect([...ids]).toEqual([]);
  });

  it('unions screenings SSE, optimistic starting, and active tasks without duplicates', () => {
    const ids = mergeRunningScreeningCompanyIds(
      ['c1'],
      ['c2'],
      [task('c2', 'pending'), task('c3', 'running')],
    );
    expect([...ids].sort()).toEqual(['c1', 'c2', 'c3']);
  });
});
