import { describe, expect, it, vi } from 'vitest';
import { routineErrorResponse } from './errorResponse';
import {
  RoutineAgentPausedError,
  RoutineNotFoundError,
} from '@/lib/services/routineService';

describe('routineErrorResponse', () => {
  it('maps a routine paused for a broken agent binding to 409 with the reason', async () => {
    const res = routineErrorResponse(
      new RoutineAgentPausedError(
        'agent_deprecated',
        'Paused — @bangun was deprecated. Rebind the insight to resume.',
      ),
      'tag',
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Paused — @bangun was deprecated. Rebind the insight to resume.',
      pausedReason: 'agent_deprecated',
    });
  });

  it('keeps the existing mappings (404) and hides unexpected errors behind a 500', async () => {
    expect(routineErrorResponse(new RoutineNotFoundError(), 'tag').status).toBe(404);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = routineErrorResponse(new Error('boom'), 'tag');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });
});
