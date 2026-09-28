import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InsightRepository,
  RoutineInsert,
  RoutineRow,
  RoutineUpdate,
  RoutinesRepository,
} from '@/lib/repositories';
import type { SectorAgentEntry } from '@/lib/agents/sector/registry';
import {
  DuplicateInsightRoutineError,
  RoutineAgentPausedError,
  RoutineInsightNotFoundError,
  RoutineNotFoundError,
  RoutineService,
  RoutineValidationError,
  SystemRoutineError,
} from './routineService';

class MockRoutinesRepository {
  routines: RoutineRow[] = [];
  insertCalls: RoutineInsert[] = [];
  failNextInsertWith: unknown = null;
  activeRefreshRunId: string | null = null;

  async create(data: RoutineInsert): Promise<RoutineRow> {
    this.insertCalls.push(data);
    if (this.failNextInsertWith) {
      const err = this.failNextInsertWith;
      this.failNextInsertWith = null;
      throw err;
    }
    const now = new Date().toISOString();
    const row = {
      workspace_id: 'ws-1',
      timezone: 'UTC',
      agent_name: null,
      priority: 0,
      enabled: true,
      next_fire_at: null,
      last_fired_at: null,
      created_by: null,
      updated_by: null,
      archived_at: null,
      is_system: false,
      insight_id: null,
      paused_reason: null,
      paused_at: null,
      ...data,
      id: `rt-${this.routines.length + 1}`,
      created_at: now,
      updated_at: now,
    } as RoutineRow;
    this.routines.push(row);
    return row;
  }

  async findById(id: string): Promise<RoutineRow | null> {
    return this.routines.find((r) => r.id === id) ?? null;
  }

  async findActiveInsightRefreshRunId(_insightId: string): Promise<string | null> {
    return this.activeRefreshRunId;
  }

  async findActiveByInsightId(insightId: string): Promise<RoutineRow | null> {
    return this.routines.find((r) => r.insight_id === insightId && r.archived_at === null) ?? null;
  }

  async update(id: string, patch: RoutineUpdate): Promise<RoutineRow> {
    const idx = this.routines.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`routine ${id} not found`);
    const updated: RoutineRow = { ...this.routines[idx]!, ...patch, updated_at: new Date().toISOString() };
    this.routines[idx] = updated;
    return updated;
  }
}

class MockInsightRepository {
  insights: Array<{ id: string; workspace_id: string; [key: string]: unknown }> = [];

  async findById(id: string, workspaceId: string) {
    return this.insights.find((ins) => ins.id === id && ins.workspace_id === workspaceId);
  }
}

function sectorAgent(key: string, deprecated: boolean): SectorAgentEntry {
  return { key, handle: `@${key}`, name: key, sector: key, description: '', deprecated } as SectorAgentEntry;
}

// @bangun is deprecated, @minerba is live, anything else is unknown.
const registry = {
  getSectorAgent: (key: string): SectorAgentEntry | undefined =>
    key === 'bangun' || key === 'minerba' ? sectorAgent(key, key === 'bangun') : undefined,
};

describe('RoutineService', () => {
  const WORKSPACE_ID = 'ws-1';
  const USER_ID = 'u-1';
  const enqueue = vi.fn();
  let routinesRepo: MockRoutinesRepository;
  let insightRepo: MockInsightRepository;
  let service: RoutineService;

  const createInput = (overrides: Record<string, unknown> = {}) => ({
    title: 'Routine',
    prompt: 'Prompt',
    schedule_kind: 'daily' as const,
    schedule_spec: { time: '09:00' },
    timezone: 'UTC',
    ...overrides,
  });
  const seedRoutine = (overrides: Partial<RoutineInsert> = {}) =>
    routinesRepo.create({ ...createInput(), cron_expression: '0 9 * * *', ...overrides } as RoutineInsert);
  const addInsight = (fields: Record<string, unknown> = {}) =>
    insightRepo.insights.push({ id: 'ins-1', workspace_id: WORKSPACE_ID, name: 'Q', agent_key: null, archived_at: null, ...fields });

  beforeEach(() => {
    routinesRepo = new MockRoutinesRepository();
    insightRepo = new MockInsightRepository();
    enqueue.mockReset().mockResolvedValue({ runId: 'run-new', created: true });
    service = new RoutineService(
      routinesRepo as unknown as RoutinesRepository,
      insightRepo as unknown as InsightRepository,
      WORKSPACE_ID,
      registry,
      enqueue,
    );
  });

  it('create rejects an insight from another workspace (insightRepo.findById -> undefined) with RoutineInsightNotFoundError and never inserts', async () => {
    addInsight({ id: 'ins-other', workspace_id: 'ws-other' });

    await expect(
      service.create(createInput({ insight_id: 'ins-other' }), USER_ID),
    ).rejects.toBeInstanceOf(RoutineInsightNotFoundError);

    expect(routinesRepo.insertCalls).toHaveLength(0);
  });

  it('create rejects a second active routine for the same insight with DuplicateInsightRoutineError and never inserts', async () => {
    addInsight();
    await seedRoutine({ insight_id: 'ins-1' });
    routinesRepo.insertCalls = [];

    const promise = service.create(createInput({ insight_id: 'ins-1' }), USER_ID);

    await expect(promise).rejects.toBeInstanceOf(DuplicateInsightRoutineError);
    await expect(promise).rejects.toMatchObject({ insightId: 'ins-1' });
    expect(routinesRepo.insertCalls).toHaveLength(0);
  });

  it.each([
    ['a bare code', { code: '23505' }],
    ['a cause.code', { cause: { code: '23505' } }],
  ])('create maps a 23505 unique violation on insert (%s) to DuplicateInsightRoutineError', async (_label, err) => {
    addInsight();
    routinesRepo.failNextInsertWith = err;

    await expect(service.create(createInput({ insight_id: 'ins-1' }), USER_ID)).rejects.toMatchObject({
      name: 'DuplicateInsightRoutineError',
      insightId: 'ins-1',
    });
  });

  it('create allows an empty prompt for an insight routine and stores insight_id', async () => {
    addInsight();

    const created = await service.create(createInput({ prompt: '', insight_id: 'ins-1' }), USER_ID);

    expect(created).toMatchObject({ insight_id: 'ins-1', prompt: '' });
    expect(routinesRepo.insertCalls[0]?.insight_id).toBe('ins-1');
  });

  it('create rejects an empty prompt for a plain routine with RoutineValidationError', async () => {
    await expect(service.create(createInput({ prompt: '   ' }), USER_ID)).rejects.toBeInstanceOf(
      RoutineValidationError,
    );

    expect(routinesRepo.insertCalls).toHaveLength(0);
  });

  it('update does not report a duplicate against the routine itself', async () => {
    addInsight();
    const existing = await seedRoutine({ insight_id: 'ins-1' });

    const updated = await service.update(existing.id, { title: 'New Title', insight_id: 'ins-1' }, USER_ID);

    expect(updated).toMatchObject({ title: 'New Title', insight_id: 'ins-1' });
  });

  it('update throws SystemRoutineError for an is_system routine and RoutineNotFoundError for a missing one', async () => {
    const sysRow = await seedRoutine();
    sysRow.is_system = true;

    await expect(service.update(sysRow.id, { title: 'Try Modify' }, USER_ID)).rejects.toBeInstanceOf(
      SystemRoutineError,
    );
    await expect(service.update('missing-id', { title: 'Try Modify' }, USER_ID)).rejects.toBeInstanceOf(
      RoutineNotFoundError,
    );
  });

  it('update recomputes next_fire_at when resuming a paused routine, and leaves it alone on a plain rename', async () => {
    const initialFireAt = '2020-01-01T00:00:00.000Z';
    const paused = await seedRoutine({ enabled: false, next_fire_at: initialFireAt });

    const renamed = await service.update(paused.id, { title: 'Renamed Routine' }, USER_ID);
    expect(renamed.next_fire_at).toBe(initialFireAt);

    const resumed = await service.update(paused.id, { enabled: true }, USER_ID);
    expect(new Date(resumed.next_fire_at!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('getActiveForInsight throws RoutineInsightNotFoundError for a cross-workspace insight', async () => {
    addInsight({ id: 'ins-cross', workspace_id: 'ws-other' });

    await expect(service.getActiveForInsight('ins-cross')).rejects.toBeInstanceOf(RoutineInsightNotFoundError);
  });

  describe('agent pauses (MB-560)', () => {
    const insightRoutine = (overrides: Partial<RoutineInsert> = {}) =>
      seedRoutine({ prompt: '', insight_id: 'ins-1', next_fire_at: '2020-01-01T00:00:00.000Z', ...overrides });

    it('prepareManualRun refuses a routine paused for agent_deprecated with the reason in plain words', async () => {
      addInsight({ agent_key: 'bangun' });
      const rt = await insightRoutine({ enabled: false, paused_reason: 'agent_deprecated' });

      const err = await service.prepareManualRun(rt.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RoutineAgentPausedError);
      expect(err).toMatchObject({
        reason: 'agent_deprecated',
        message: 'Paused — @bangun was deprecated. Rebind the insight to resume.',
      });
    });

    it('prepareManualRun refuses an agent_incompatible pause the same way', async () => {
      addInsight({ agent_key: 'minerba' });
      const rt = await insightRoutine({ enabled: false, paused_reason: 'agent_incompatible' });

      await expect(service.prepareManualRun(rt.id)).rejects.toMatchObject({ reason: 'agent_incompatible' });
    });

    it('prepareManualRun refuses a still-enabled routine whose insight is bound to a deprecated agent the sweep has not reached yet', async () => {
      addInsight({ agent_key: 'bangun' });
      const rt = await insightRoutine();

      await expect(service.prepareManualRun(rt.id)).rejects.toBeInstanceOf(RoutineAgentPausedError);
    });

    it('prepareManualRun resolves the insight name and the bound agent, and general for an unbound or unknown binding', async () => {
      addInsight({ name: 'Coal Q3', agent_key: 'minerba' });
      const rt = await insightRoutine();
      await expect(service.prepareManualRun(rt.id)).resolves.toMatchObject({
        insightName: 'Coal Q3',
        agentKey: 'minerba',
      });

      for (const agentKey of [null, 'retired']) {
        insightRepo.insights[0]!.agent_key = agentKey;
        await expect(service.prepareManualRun(rt.id)).resolves.toMatchObject({ agentKey: 'general' });
      }
    });

    it('prepareManualRun gives no agent for a routine with no insight, and 404s a missing one', async () => {
      const rt = await seedRoutine();
      await expect(service.prepareManualRun(rt.id)).resolves.toMatchObject({ insightName: null, agentKey: null });
      await expect(service.prepareManualRun('nope')).rejects.toBeInstanceOf(RoutineNotFoundError);
    });

    it('update refuses to switch a system-paused routine back on, and leaves it paused', async () => {
      addInsight({ agent_key: 'bangun' });
      const rt = await insightRoutine({ enabled: false, paused_reason: 'agent_deprecated' });

      await expect(service.update(rt.id, { enabled: true }, USER_ID)).rejects.toBeInstanceOf(
        RoutineAgentPausedError,
      );
      expect(routinesRepo.routines[0]).toMatchObject({ enabled: false, paused_reason: 'agent_deprecated' });
    });

    it('update still allows editing a system-paused routine without switching it on', async () => {
      const rt = await insightRoutine({ enabled: false, paused_reason: 'agent_deprecated' });

      const updated = await service.update(rt.id, { title: 'Renamed' }, USER_ID);
      expect(updated).toMatchObject({ title: 'Renamed', enabled: false, paused_reason: 'agent_deprecated' });
    });
  });

  describe('runInsightRefreshNow (MB-552)', () => {
    const routineFor = (overrides: Partial<RoutineInsert> = {}) =>
      seedRoutine({
        title: 'Weekly refresh',
        prompt: 'Update the quota table',
        schedule_kind: 'weekly',
        schedule_spec: { day: 1, time: '09:00' },
        cron_expression: '0 9 * * 1',
        timezone: 'Asia/Jakarta',
        insight_id: 'ins-1',
        priority: 3,
        ...overrides,
      });

    it('without a routine, queues a one-off refresh carrying insight_id, the resolved agent_key and the flag', async () => {
      addInsight({ name: 'Coal cohort', agent_key: 'minerba' });

      const result = await service.runInsightRefreshNow('ins-1', USER_ID);

      expect(result).toEqual({ runId: 'run-new', created: true, routineId: null });
      expect(enqueue).toHaveBeenCalledTimes(1);
      const call = enqueue.mock.calls[0][0];
      expect(call).toMatchObject({
        agentName: 'analysis',
        triggerSource: 'api',
        originRoutineId: null,
        triggeredByUserId: USER_ID,
        triggerMeta: { insight_id: 'ins-1', manual: true, insight_refresh: true },
        input: { insight_id: 'ins-1', agent_key: 'minerba', insight_refresh: true, title: 'Refresh: Coal cohort' },
      });
      expect(call.input.prompt).toContain('(insight_id: ins-1)');
    });

    it('with an active routine, queues exactly what force-run queues, with the routine as origin', async () => {
      addInsight({ name: 'Coal cohort', agent_key: 'minerba' });
      const rt = await routineFor();

      const result = await service.runInsightRefreshNow('ins-1', USER_ID);

      expect(result).toEqual({ runId: 'run-new', created: true, routineId: rt.id });
      const call = enqueue.mock.calls[0][0];
      expect(call).toMatchObject({
        agentName: 'analysis',
        triggerSource: 'api',
        originRoutineId: rt.id,
        priority: 3,
        triggeredByUserId: USER_ID,
        triggerMeta: { routine_id: rt.id, manual: true, insight_id: 'ins-1' },
        input: { title: 'Weekly refresh', insight_id: 'ins-1', agent_key: 'minerba' },
      });
      expect(call.input).not.toHaveProperty('insight_refresh');
      expect(call.input.prompt).toContain('Update the quota table');
    });

    it('refuses a routine the system paused for a deprecated agent, before any enqueue', async () => {
      addInsight({ agent_key: 'bangun' });
      await routineFor({ enabled: false, paused_reason: 'agent_deprecated' });

      await expect(service.runInsightRefreshNow('ins-1', USER_ID)).rejects.toBeInstanceOf(RoutineAgentPausedError);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('refuses a one-off refresh on a deprecated binding', async () => {
      addInsight({ agent_key: 'bangun' });

      await expect(service.runInsightRefreshNow('ins-1', USER_ID)).rejects.toMatchObject({ reason: 'agent_deprecated' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('adds no second run while a refresh of the insight is live, and returns the live run', async () => {
      addInsight();
      routinesRepo.activeRefreshRunId = 'run-live';

      await expect(service.runInsightRefreshNow('ins-1', USER_ID)).resolves.toEqual({
        runId: 'run-live',
        created: false,
        routineId: null,
      });

      const rt = await routineFor();
      await expect(service.runInsightRefreshNow('ins-1', USER_ID)).resolves.toEqual({
        runId: 'run-live',
        created: false,
        routineId: rt.id,
      });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('404s an insight that is missing, archived or in another workspace', async () => {
      addInsight({ id: 'ins-a', archived_at: '2026-01-01' });
      addInsight({ id: 'ins-b', workspace_id: 'ws-other' });
      for (const id of ['ins-a', 'ins-b', 'ins-none']) {
        await expect(service.runInsightRefreshNow(id, USER_ID)).rejects.toBeInstanceOf(RoutineInsightNotFoundError);
      }
      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
