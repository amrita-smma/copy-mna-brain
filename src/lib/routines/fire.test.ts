import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claimDue, markFired, enqueueAgentRun, computeNextFireAt } = vi.hoisted(() => ({
  claimDue: vi.fn(),
  markFired: vi.fn(),
  enqueueAgentRun: vi.fn(),
  computeNextFireAt: vi.fn(),
}));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockRoutinesRepository {
    claimDue = claimDue;
    markFired = markFired;
  }
  return {
    ...actual,
    RoutinesRepository: MockRoutinesRepository,
  };
});

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

vi.mock('./schedule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule')>();
  return { ...actual, computeNextFireAt };
});

import { fireDueRoutines } from './fire';

const fakeDb = {} as never;

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt-1',
    title: 'Daily APAC scan',
    prompt: 'Scan for new APAC companies',
    cron_expression: '0 6 * * *',
    timezone: 'UTC',
    schedule_kind: 'daily',
    schedule_spec: { time: '06:00' },
    agent_name: null,
    priority: 0,
    enabled: true,
    next_fire_at: '2026-05-18T06:00:00.000Z',
    last_fired_at: null,
    ...overrides,
  };
}

describe('fireDueRoutines', () => {
  beforeEach(() => {
    claimDue.mockReset();
    markFired.mockReset();
    enqueueAgentRun.mockReset();
    computeNextFireAt.mockReset();
  });

  it('returns empty when nothing is due', async () => {
    claimDue.mockResolvedValueOnce([]);

    const result = await fireDueRoutines(fakeDb, new Date('2026-05-18T06:00:00Z'));

    expect(result.scanned).toBe(0);
    expect(result.fired).toEqual([]);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('enqueues with cron trigger and routine origin', async () => {
    claimDue.mockResolvedValueOnce([routine()]);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');

    const result = await fireDueRoutines(fakeDb, new Date('2026-05-18T06:00:30Z'));

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        triggerSource: 'cron',
        originRoutineId: 'rt-1',
        triggerMeta: expect.objectContaining({
          routine_id: 'rt-1',
          fired_at: '2026-05-18T06:00:00.000Z',
        }),
        idempotencyKey: 'routine:rt-1:2026-05-18T06:00:00.000Z',
        triggeredByUserId: null,
      }),
    );
    expect(result.fired).toEqual([
      { routineId: 'rt-1', runId: 'run-1', created: true },
    ]);
  });

  it('falls back to "analysis" when routine has no agent_name', async () => {
    claimDue.mockResolvedValueOnce([routine({ agent_name: null })]);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');

    await fireDueRoutines(fakeDb, new Date('2026-05-18T06:00:30Z'));

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ agentName: 'analysis' }),
    );
  });

  it('uses the routine-supplied agent_name when present', async () => {
    claimDue.mockResolvedValueOnce([routine({ agent_name: 'lead_scan' })]);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');

    await fireDueRoutines(fakeDb, new Date('2026-05-18T06:00:30Z'));

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ agentName: 'lead_scan' }),
    );
  });

  it('mirrors prompt into input.prompt and input.instruction', async () => {
    claimDue.mockResolvedValueOnce([routine()]);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');

    await fireDueRoutines(fakeDb, new Date('2026-05-18T06:00:30Z'));

    expect(enqueueAgentRun).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: 'Scan for new APAC companies',
          instruction: 'Scan for new APAC companies',
          title: 'Daily APAC scan',
        }),
      }),
    );
  });

  it('advances next_fire_at via computeNextFireAt and calls markFired', async () => {
    claimDue.mockResolvedValueOnce([routine()]);
    enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
    computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');

    const now = new Date('2026-05-18T06:00:30Z');
    await fireDueRoutines(fakeDb, now);

    // Pass the credited fire instant (the previous next_fire_at) to the
    // cron parser, not "now" — so back-to-back ticks don't reuse the same
    // window.
    expect(computeNextFireAt).toHaveBeenCalledWith(
      '0 6 * * *',
      'UTC',
      new Date('2026-05-18T06:00:00.000Z'),
      { kind: 'daily', spec: { time: '06:00' } },
    );
    expect(markFired).toHaveBeenCalledWith(
      'rt-1',
      now,
      '2026-05-19T06:00:00.000Z',
    );
  });

  it('collects per-routine failures without aborting the batch', async () => {
    const r1 = routine({ id: 'rt-1' });
    const r2 = routine({ id: 'rt-2' });
    claimDue.mockResolvedValueOnce([r1, r2]);
    enqueueAgentRun
      .mockRejectedValueOnce(new Error('enqueue boom'))
      .mockResolvedValueOnce({ runId: 'run-2', created: true });
    computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fireDueRoutines(
      fakeDb,
      new Date('2026-05-18T06:00:30Z'),
    );

    expect(result.scanned).toBe(2);
    expect(result.fired).toEqual([
      { routineId: 'rt-2', runId: 'run-2', created: true },
    ]);
    expect(result.errors).toEqual([
      { routineId: 'rt-1', message: 'enqueue boom' },
    ]);
    errSpy.mockRestore();
  });
});
