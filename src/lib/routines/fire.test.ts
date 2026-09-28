import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  claimDue,
  markFired,
  findInsightRefreshTargetsByIds,
  pause,
  findActiveRunRoutineIds,
  advanceSchedule,
  pauseForDeprecatedAgents,
  enqueueAgentRun,
  computeNextFireAt,
  runWithWorkforceWorkspaceId,
} = vi.hoisted(() => ({
  pauseForDeprecatedAgents: vi.fn(),
  claimDue: vi.fn(),
  markFired: vi.fn(),
  findInsightRefreshTargetsByIds: vi.fn(),
  pause: vi.fn(),
  findActiveRunRoutineIds: vi.fn(),
  advanceSchedule: vi.fn(),
  enqueueAgentRun: vi.fn(),
  computeNextFireAt: vi.fn(),
  runWithWorkforceWorkspaceId: vi.fn((_ws: string, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockRoutinesRepository {
    claimDue = claimDue;
    markFired = markFired;
    findInsightRefreshTargetsByIds = findInsightRefreshTargetsByIds;
    pause = pause;
    findActiveRunRoutineIds = findActiveRunRoutineIds;
    advanceSchedule = advanceSchedule;
    pauseForDeprecatedAgents = pauseForDeprecatedAgents;
  }
  return {
    ...actual,
    RoutinesRepository: MockRoutinesRepository,
  };
});

vi.mock('@/lib/workforce', () => ({ enqueueAgentRun }));

vi.mock('@/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace')>();
  return {
    ...actual,
    runWithWorkforceWorkspaceId,
  };
});

vi.mock('./schedule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule')>();
  return { ...actual, computeNextFireAt };
});

import { fireDueRoutines } from './fire';
import { INSIGHT_REFRESH_SOURCES_PARAGRAPH } from './insightRefresh';

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
    workspace_id: 'workspace-default',
    insight_id: null,
    ...overrides,
  };
}

describe('fireDueRoutines', () => {
  beforeEach(() => {
    claimDue.mockReset();
    markFired.mockReset();
    findInsightRefreshTargetsByIds.mockReset().mockResolvedValue(new Map());
    pause.mockReset();
    findActiveRunRoutineIds.mockReset().mockResolvedValue(new Set());
    advanceSchedule.mockReset();
    pauseForDeprecatedAgents.mockReset().mockResolvedValue([]);
    enqueueAgentRun.mockReset();
    computeNextFireAt.mockReset();
    runWithWorkforceWorkspaceId.mockReset().mockImplementation((_ws: string, fn: () => unknown) => fn());
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

  describe('insight refresh routines', () => {
    const NOW = new Date('2026-05-18T06:00:30Z');
    const targets = (entries: Array<[string, Record<string, unknown>]>) =>
      findInsightRefreshTargetsByIds.mockResolvedValueOnce(
        new Map(entries.map(([id, t]) => [id, { archived: false, agentKey: null, ...t }])),
      );

    beforeEach(() => {
      enqueueAgentRun.mockResolvedValue({ runId: 'run-x', created: true });
      computeNextFireAt.mockReturnValue('2026-05-19T06:00:00.000Z');
    });

    it('insight routine → enqueue gets triggerMeta.insight_id, input.insight_id, wrapped prompt', async () => {
      claimDue.mockResolvedValueOnce([
        routine({ id: 'rt-ins', title: 'Refresh Competitors', prompt: 'Check new announcements', insight_id: 'ins-123' }),
      ]);
      targets([['ins-123', { name: 'Competitor Landscape' }]]);

      await fireDueRoutines(fakeDb, NOW);

      const prompt =
        'This is a scheduled refresh of the insight "Competitor Landscape" (insight_id: ins-123).\n\nCheck new announcements\n\n' +
        INSIGHT_REFRESH_SOURCES_PARAGRAPH;
      expect(enqueueAgentRun).toHaveBeenCalledWith(
        fakeDb,
        expect.objectContaining({
          triggerMeta: { routine_id: 'rt-ins', fired_at: '2026-05-18T06:00:00.000Z', insight_id: 'ins-123' },
          input: {
            title: 'Refresh Competitors',
            instruction: prompt,
            prompt,
            insight_id: 'ins-123',
            agent_key: 'general',
          },
          idempotencyKey: 'routine:rt-ins:2026-05-18T06:00:00.000Z',
        }),
      );
    });

    it('archived-insight routine → not enqueued, pause called, markFired NOT called, listed in skipped, other due routines still fire', async () => {
      claimDue.mockResolvedValueOnce([
        routine({ id: 'rt-archived', insight_id: 'ins-archived' }),
        routine({ id: 'rt-active', insight_id: 'ins-active' }),
      ]);
      targets([
        ['ins-archived', { name: 'Old Insight', archived: true }],
        ['ins-active', { name: 'Active Insight' }],
      ]);
      enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-active', created: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await fireDueRoutines(fakeDb, NOW);

      expect(pause).toHaveBeenCalledTimes(1);
      expect(pause).toHaveBeenCalledWith('rt-archived');
      expect(markFired).not.toHaveBeenCalledWith('rt-archived', expect.anything(), expect.anything());
      expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
      expect(result.skipped).toEqual([{ routineId: 'rt-archived', reason: 'insight is archived; routine paused' }]);
      expect(result.fired).toEqual([{ routineId: 'rt-active', runId: 'run-active', created: true }]);
      warnSpy.mockRestore();
    });

    it("enqueue runs inside the routine's workspace context", async () => {
      claimDue.mockResolvedValueOnce([routine({ workspace_id: 'ws-special' })]);

      await fireDueRoutines(fakeDb, NOW);

      expect(runWithWorkforceWorkspaceId).toHaveBeenCalledWith('ws-special', expect.any(Function));
    });

    it("persists the insight's bound sector agent on the run input, and general for unbound or unknown bindings (MB-560), in one batched lookup", async () => {
      claimDue.mockResolvedValueOnce([
        routine({ id: 'rt-a', insight_id: 'ins-a' }),
        routine({ id: 'rt-b', insight_id: 'ins-b' }),
        routine({ id: 'rt-c', insight_id: 'ins-c' }),
        routine({ id: 'rt-d' }),
      ]);
      targets([
        ['ins-a', { name: 'A', agentKey: 'minerba' }],
        ['ins-b', { name: 'B' }],
        ['ins-c', { name: 'C', agentKey: 'retired' }],
      ]);

      await fireDueRoutines(fakeDb, NOW);

      const inputs = enqueueAgentRun.mock.calls.map((c) => (c[1] as { input: Record<string, unknown> }).input);
      expect(inputs[0]).toMatchObject({ insight_id: 'ins-a', agent_key: 'minerba' });
      expect(inputs[1]).toMatchObject({ insight_id: 'ins-b', agent_key: 'general' });
      expect(inputs[2]).toMatchObject({ insight_id: 'ins-c', agent_key: 'general' });
      // A routine with no insight carries no agent key.
      expect(inputs[3]).not.toHaveProperty('agent_key');
      expect(findInsightRefreshTargetsByIds).toHaveBeenCalledTimes(1);
      expect(findInsightRefreshTargetsByIds).toHaveBeenCalledWith(['ins-a', 'ins-b', 'ins-c']);
    });
  });

  describe('no stacking (MB-561)', () => {
    const NOW = new Date('2026-05-18T06:00:30Z');

    beforeEach(() => {
      computeNextFireAt.mockReturnValue('2026-05-19T06:00:00.000Z');
    });

    it('skips a routine whose previous run is still active, advances next_fire_at, and fires the others', async () => {
      const busy = routine({ id: 'rt-busy' });
      claimDue.mockResolvedValueOnce([busy, routine({ id: 'rt-idle' })]);
      findActiveRunRoutineIds.mockResolvedValueOnce(new Set(['rt-busy']));
      enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-idle', created: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await fireDueRoutines(fakeDb, NOW);

      expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
      expect(result.skipped).toEqual([
        { routineId: 'rt-busy', reason: 'previous run still active; not stacking another run' },
      ]);
      expect(result.fired).toEqual([{ routineId: 'rt-idle', runId: 'run-idle', created: true }]);
      // Advanced past the credited fire instant, but not recorded as a fire.
      expect(computeNextFireAt).toHaveBeenCalledWith(
        busy.cron_expression,
        busy.timezone,
        new Date('2026-05-18T06:00:00.000Z'),
        expect.objectContaining({ kind: 'daily' }),
      );
      expect(advanceSchedule).toHaveBeenCalledWith('rt-busy', '2026-05-19T06:00:00.000Z');
      expect(markFired).not.toHaveBeenCalledWith('rt-busy', expect.anything(), expect.anything());
      warnSpy.mockRestore();
    });

    it('looks up active runs for every due routine in one batched query', async () => {
      claimDue.mockResolvedValueOnce([routine({ id: 'rt-a' }), routine({ id: 'rt-b' }), routine({ id: 'rt-c' })]);
      enqueueAgentRun.mockResolvedValue({ runId: 'run-x', created: true });

      await fireDueRoutines(fakeDb, NOW);

      expect(findActiveRunRoutineIds).toHaveBeenCalledTimes(1);
      expect(findActiveRunRoutineIds).toHaveBeenCalledWith(['rt-a', 'rt-b', 'rt-c']);
      expect(advanceSchedule).not.toHaveBeenCalled();
    });

    it('an archived-insight routine is paused, not treated as an active-run skip', async () => {
      claimDue.mockResolvedValueOnce([routine({ id: 'rt-arch', insight_id: 'ins-arch' })]);
      findInsightRefreshTargetsByIds.mockResolvedValueOnce(new Map([['ins-arch', { name: 'Old', archived: true }]]));
      findActiveRunRoutineIds.mockResolvedValueOnce(new Set(['rt-arch']));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await fireDueRoutines(fakeDb, NOW);

      expect(pause).toHaveBeenCalledWith('rt-arch');
      expect(advanceSchedule).not.toHaveBeenCalled();
      expect(result.skipped).toEqual([{ routineId: 'rt-arch', reason: 'insight is archived; routine paused' }]);
      warnSpy.mockRestore();
    });
  });

  describe('deprecated-agent sweep (MB-560)', () => {
    const NOW = new Date('2026-05-18T06:00:30Z');
    const deprecatedAgentKeys = () => ['bangun'];

    it('sweeps the injected deprecated keys before selecting due routines', async () => {
      pauseForDeprecatedAgents.mockResolvedValueOnce(['rt-dep']);
      claimDue.mockResolvedValueOnce([]);

      const result = await fireDueRoutines(fakeDb, NOW, { deprecatedAgentKeys });

      expect(pauseForDeprecatedAgents).toHaveBeenCalledWith(['bangun']);
      expect(pauseForDeprecatedAgents.mock.invocationCallOrder[0]).toBeLessThan(
        claimDue.mock.invocationCallOrder[0],
      );
      expect(result.pausedForDeprecatedAgent).toEqual(['rt-dep']);
    });

    it('a routine the sweep just paused is not fired: claimDue (enabled only) no longer returns it', async () => {
      // Model the DB: the sweep disables rt-dep, and claimDue returns enabled routines only.
      const rows = [routine({ id: 'rt-dep', insight_id: 'ins-dep' }), routine({ id: 'rt-ok' })];
      pauseForDeprecatedAgents.mockImplementationOnce(async () => {
        rows[0] = { ...rows[0], enabled: false };
        return ['rt-dep'];
      });
      claimDue.mockImplementationOnce(async () => rows.filter((r) => r.enabled));
      enqueueAgentRun.mockResolvedValue({ runId: 'run', created: true });
      computeNextFireAt.mockReturnValue('2026-05-19T06:00:00.000Z');

      const result = await fireDueRoutines(fakeDb, NOW, { deprecatedAgentKeys });

      expect(result.fired.map((f) => f.routineId)).toEqual(['rt-ok']);
      expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    });

    it('passes the shipped registry list by default (no deprecated agent today → empty list)', async () => {
      claimDue.mockResolvedValueOnce([]);

      await fireDueRoutines(fakeDb, NOW);

      expect(pauseForDeprecatedAgents).toHaveBeenCalledWith([]);
    });

    it('a failed sweep is logged and the tick still fires due routines', async () => {
      pauseForDeprecatedAgents.mockRejectedValueOnce(new Error('db blip'));
      claimDue.mockResolvedValueOnce([routine()]);
      enqueueAgentRun.mockResolvedValueOnce({ runId: 'run-1', created: true });
      computeNextFireAt.mockReturnValueOnce('2026-05-19T06:00:00.000Z');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await fireDueRoutines(fakeDb, NOW, { deprecatedAgentKeys });

      expect(result.pausedForDeprecatedAgent).toEqual([]);
      expect(result.fired).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
