import { describe, expect, it, vi } from 'vitest';
import { TrackMatchingService } from './trackMatchingService';
import type { JobDispatcher } from './jobDispatcher';

describe('TrackMatchingService.dispatch', () => {
  it('dispatches a track_matching job for the company', async () => {
    const dispatch = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const service = new TrackMatchingService(
      { dispatch } as unknown as JobDispatcher,
      {} as never,
      'workspace-1',
    );

    const result = await service.dispatch({ companyId: 'c1' });

    expect(result).toEqual({ jobId: 'job-1' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const arg = dispatch.mock.calls[0][0];
    expect(arg.type).toBe('track_matching');
    expect(arg.payload).toEqual({ companyId: 'c1' });
    expect(typeof arg.work).toBe('function');
  });
});
