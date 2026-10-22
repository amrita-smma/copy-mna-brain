import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { RoutinesRepository } from './routinesRepository';

const dialect = new PgDialect();

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    leftJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
}

describe('RoutinesRepository', () => {
  let mockDb: MockDb;
  let repo: RoutinesRepository;

  beforeEach(() => {
    mockDb = makeMockDb();
    repo = new RoutinesRepository(mockDb as never, 'workspace-1');
  });

  it('create returns the inserted row', async () => {
    const row = { id: 'rt-1', title: 'Daily scan' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.create({
      title: 'Daily scan',
      prompt: 'Scan',
      schedule_kind: 'daily',
      schedule_spec: { time: '06:00' },
      cron_expression: '0 6 * * *',
      timezone: 'UTC',
      created_by: 'user-1',
    } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledTimes(1);
  });

  it('findById returns the row when found', async () => {
    const row = { id: 'rt-1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    expect(await repo.findById('rt-1')).toEqual(row);
  });

  it('findById returns null when not found', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    expect(await repo.findById('missing')).toBeNull();
  });

  it('findById scopes the lookup to this workspace (or system-wide rows)', async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: 'rt-1' }]);

    await repo.findById('rt-1');

    expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    expect(mockDb.where).not.toHaveBeenCalledWith(undefined);
  });

  it('update scopes the write to this workspace (or system-wide rows), not by id alone', async () => {
    mockDb.returning.mockResolvedValueOnce([{ id: 'rt-1', title: 'x' }]);

    await repo.update('rt-1', { title: 'x' });

    expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
    expect(mockDb.where).not.toHaveBeenCalledWith(undefined);
  });

  it('a repository bound to a different workspace cannot update this workspace\'s routine', async () => {
    const otherDb = makeMockDb();
    const otherRepo = new RoutinesRepository(otherDb as never, 'workspace-2');
    otherDb.returning.mockResolvedValueOnce([]);

    await expect(otherRepo.update('rt-owned-by-workspace-1', { title: 'hijacked' })).rejects.toThrow(
      /not found/,
    );
  });

  it('findSystemRoutineByTitle scopes to this workspace only (no legacy-NULL fallback)', async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: 'rt-system-1', is_system: true }]);

    const result = await repo.findSystemRoutineByTitle('Market Scanning');

    expect(result).toEqual({ id: 'rt-system-1', is_system: true });
    expect(mockDb.where).toHaveBeenCalledWith(expect.anything());
  });

  it('findSystemRoutineByTitle returns null when this workspace has no matching routine', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    expect(await repo.findSystemRoutineByTitle('Market Scanning')).toBeNull();
  });

  it('findActiveByInsightId returns the row, or null when there is none', async () => {
    const row = { id: 'rt-1', insight_id: 'ins-1' };
    mockDb.limit.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);

    expect(await repo.findActiveByInsightId('ins-1')).toEqual(row);
    expect(await repo.findActiveByInsightId('missing-insight')).toBeNull();
  });

  it('findActiveByInsightIds([]) returns [] without calling db.select', async () => {
    expect(await repo.findActiveByInsightIds([])).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('findActiveByInsightIds reads every insight\'s active routine in one workspace-scoped query, ordered by insight_id', async () => {
    const rows = [
      { id: 'rt-1', insight_id: 'ins-1' },
      { id: 'rt-2', insight_id: 'ins-2' },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    expect(await repo.findActiveByInsightIds(['ins-1', 'ins-2', 'ins-3'])).toEqual(rows);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    const where = dialect.sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
    expect(where.sql).toContain('"routines"."workspace_id" = $1');
    expect(where.sql).toContain('"routines"."insight_id" in ($2, $3, $4)');
    expect(where.sql).toContain('"routines"."archived_at" is null');
    expect(where.params).toEqual(['workspace-1', 'ins-1', 'ins-2', 'ins-3']);
    const order = dialect.sqlToQuery(mockDb.orderBy.mock.calls[0][0] as SQL);
    expect(order.sql).toBe('"routines"."insight_id" asc');
  });

  it.each(['findInsightNamesByIds', 'findInsightRefreshTargetsByIds'] as const)(
    '%s([]) returns an empty Map without calling db.select',
    async (method) => {
      expect(await repo[method]([])).toEqual(new Map());
      expect(mockDb.select).not.toHaveBeenCalled();
    },
  );

  it('findInsightNamesByIds maps rows to a Map', async () => {
    mockDb.where.mockResolvedValueOnce([
      { id: 'ins-1', name: 'APAC Market' },
      { id: 'ins-2', name: 'US SaaS' },
    ]);

    expect(await repo.findInsightNamesByIds(['ins-1', 'ins-2'])).toEqual(
      new Map([
        ['ins-1', 'APAC Market'],
        ['ins-2', 'US SaaS'],
      ]),
    );
  });

  it('findInsightRefreshTargetsByIds maps rows incl. archived: true when archived_at set', async () => {
    mockDb.where.mockResolvedValueOnce([
      { id: 'ins-1', name: 'APAC Market', archived_at: null, agent_key: 'minerba' },
      { id: 'ins-2', name: 'US SaaS', archived_at: '2026-05-18T00:00:00Z', agent_key: null },
    ]);

    const result = await repo.findInsightRefreshTargetsByIds(['ins-1', 'ins-2']);

    expect(result).toEqual(
      new Map([
        ['ins-1', { name: 'APAC Market', archived: false, agentKey: 'minerba' }],
        ['ins-2', { name: 'US SaaS', archived: true, agentKey: null }],
      ]),
    );
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.objectContaining({ agent_key: expect.anything() }),
    );
  });

  it('list() selects via a left join and returns insight_name and insight_agent_key flat', async () => {
    const rows = [
      { id: 'rt-2', title: 'Routine 2', insight_name: 'Insight B' },
      { id: 'rt-1', title: 'Routine 1', insight_name: null },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    expect(await repo.list()).toEqual(rows);
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(1);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    expect(mockDb.select).toHaveBeenCalledWith(
      expect.objectContaining({ insight_name: expect.anything(), insight_agent_key: expect.anything() }),
    );
  });

  it('list with includeArchived skips the archived filter', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.list({ includeArchived: true });

    // Still workspace-scoped (this workspace's routines plus system-wide ones),
    // just without the archived_at filter.
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    expect(mockDb.where).not.toHaveBeenCalledWith(undefined);
  });

  it('list() leaves out bot routines', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);
    await repo.list();
    expect(dialect.sqlToQuery(mockDb.where.mock.calls[0][0] as SQL).sql).toContain('"routines"."bot_id" is null');
  });

  it('findWorkforceRoutineById hides a bot routine', async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: 'rt-1', bot_id: 'bot-1' }]);
    expect(await repo.findWorkforceRoutineById('rt-1')).toBeNull();
    mockDb.limit.mockResolvedValueOnce([{ id: 'rt-2', bot_id: null }]);
    expect(await repo.findWorkforceRoutineById('rt-2')).toEqual({ id: 'rt-2', bot_id: null });
  });

  it("listForBot reads the bot's live routines in this workspace with their creators' names", async () => {
    mockDb.orderBy.mockResolvedValueOnce([{ id: 'rt-1', created_by_name: 'Ana' }]);

    expect(await repo.listForBot('bot-1')).toEqual([{ id: 'rt-1', created_by_name: 'Ana' }]);

    const where = dialect.sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
    expect(where.sql).toContain('"routines"."workspace_id" = $1');
    expect(where.sql).toContain('"routines"."bot_id" = $2');
    expect(where.sql).toContain('"routines"."archived_at" is null');
    expect(where.params).toEqual(['workspace-1', 'bot-1']);
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(1);
  });

  it("listForBot and findForBot narrow to one creator's routines when asked (Brain Bot)", async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);
    await repo.listForBot('bot-1', { createdBy: 'ana' });
    const list = dialect.sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
    expect(list.sql).toContain('"routines"."created_by" = $3');
    expect(list.params).toEqual(['workspace-1', 'bot-1', 'ana']);

    mockDb.limit.mockResolvedValueOnce([]);
    expect(await repo.findForBot('bot-1', 'rt-1', { createdBy: 'ana' })).toBeNull();
    const find = dialect.sqlToQuery(mockDb.where.mock.calls[1][0] as SQL);
    expect(find.sql).toContain('"routines"."created_by" = $');
    expect(find.params).toContain('ana');
  });

  it('advanceIfDue fires only while the routine is still due at that instant', async () => {
    mockDb.returning.mockResolvedValueOnce([{ id: 'rt-1' }]).mockResolvedValueOnce([]);
    const firedAt = new Date('2026-05-18T06:00:30Z');

    expect(await repo.advanceIfDue('rt-1', '2026-05-18T06:00:00Z', firedAt, '2026-05-19T06:00:00Z')).toBe(true);
    expect(await repo.advanceIfDue('rt-1', '2026-05-18T06:00:00Z', firedAt, '2026-05-19T06:00:00Z')).toBe(false);

    expect(mockDb.set).toHaveBeenCalledWith({
      last_fired_at: '2026-05-18T06:00:30.000Z',
      next_fire_at: '2026-05-19T06:00:00Z',
    });
    const where = dialect.sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
    expect(where.sql).toContain('"routines"."next_fire_at" = $2');
    expect(where.params).toEqual(['rt-1', '2026-05-18T06:00:00Z']);
  });

  it('update throws when row is missing', async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    await expect(repo.update('missing', { title: 'x' })).rejects.toThrow(/not found/);
  });

  it('archive sets archived_at and disables the routine', async () => {
    const row = { id: 'rt-1', enabled: false, archived_at: 'NOW' };
    mockDb.returning.mockResolvedValueOnce([row]);

    await repo.archive('rt-1');

    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, archived_at: expect.any(String) }),
    );
  });

  it('markFired writes last_fired_at and next_fire_at', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    const firedAt = new Date('2026-05-18T06:00:30Z');
    await repo.markFired('rt-1', firedAt, '2026-05-19T06:00:00.000Z');

    expect(mockDb.set).toHaveBeenCalledWith({
      last_fired_at: '2026-05-18T06:00:30.000Z',
      next_fire_at: '2026-05-19T06:00:00.000Z',
    });
  });

  it('advanceSchedule writes only next_fire_at (no last_fired_at)', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.advanceSchedule('rt-1', '2026-05-19T06:00:00.000Z');

    expect(mockDb.set).toHaveBeenCalledWith({
      next_fire_at: '2026-05-19T06:00:00.000Z',
    });
  });

  it('findActiveRunRoutineIds([]) returns an empty Set without querying', async () => {
    const selectDistinct = vi.fn().mockReturnThis();
    const db = { ...mockDb, selectDistinct };
    const result = await new RoutinesRepository(db as never, 'workspace-1').findActiveRunRoutineIds([]);

    expect(result).toEqual(new Set());
    expect(selectDistinct).not.toHaveBeenCalled();
  });

  it('findActiveRunRoutineIds returns the routines with a non-terminal run in one query', async () => {
    const selectDistinct = vi.fn().mockReturnThis();
    const db = { ...mockDb, selectDistinct };
    mockDb.orderBy.mockResolvedValueOnce([
      { origin_routine_id: 'rt-1' },
      { origin_routine_id: 'rt-3' },
    ]);

    const result = await new RoutinesRepository(db as never, 'workspace-1').findActiveRunRoutineIds([
      'rt-1',
      'rt-2',
      'rt-3',
    ]);

    expect(result).toEqual(new Set(['rt-1', 'rt-3']));
    expect(selectDistinct).toHaveBeenCalledTimes(1);
    const where = new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
    expect(where.sql).toContain('"origin_routine_id" in');
    expect(where.sql).toContain('"status" in');
    expect(where.params).toEqual(
      expect.arrayContaining([
        'rt-1',
        'rt-2',
        'rt-3',
        'pending',
        'running',
        'waiting_for_human_input',
        'resume_ready',
      ]),
    );
    expect(where.params).not.toContain('succeeded');
    expect(where.params).not.toContain('failed');
  });

  it('findActiveInsightRefreshRunId returns the newest live refresh run of the insight, workspace-scoped', async () => {
    mockDb.limit.mockResolvedValueOnce([{ id: 'run-7' }]).mockResolvedValueOnce([]);

    expect(await repo.findActiveInsightRefreshRunId('ins-1')).toBe('run-7');
    expect(mockDb.limit).toHaveBeenCalledWith(1);
    const where = new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
    expect(where.sql).toContain('"workspace_id" =');
    expect(where.sql).toContain('"status" in');
    expect(where.sql).toContain("->>'insight_id'");
    expect(where.params).toEqual(expect.arrayContaining(['workspace-1', 'ins-1', 'pending', 'running']));
    expect(where.params).not.toContain('succeeded');
    expect(await repo.findActiveInsightRefreshRunId('ins-1')).toBeNull();
  });

  it('pause updates enabled: false filtered by id only', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.pause('rt-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({
      enabled: false,
      updated_at: expect.anything(),
    });
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  describe('pauseForDeprecatedAgents (MB-560)', () => {
    it('returns [] without querying for an empty key list', async () => {
      expect(await repo.pauseForDeprecatedAgents([])).toEqual([]);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('pauses in one UPDATE … FROM insights: only enabled, non-archived routines whose insight is bound to a listed key', async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 'rt-1' }, { id: 'rt-2' }]);

      const result = await repo.pauseForDeprecatedAgents(['bangun', 'dikti']);

      expect(result).toEqual(['rt-1', 'rt-2']);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.from).toHaveBeenCalledTimes(1);
      expect(mockDb.set).toHaveBeenCalledWith({
        enabled: false,
        paused_reason: 'agent_deprecated',
        paused_at: expect.anything(),
        updated_at: expect.anything(),
      });
      const where = new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
      expect(where.sql).toContain('"routines"."insight_id" = "insights"."id"');
      expect(where.sql).toContain('"routines"."enabled" = $');
      expect(where.sql).toContain('"routines"."archived_at" is null');
      expect(where.sql).toContain('"insights"."agent_key" in');
      expect(where.params).toEqual(expect.arrayContaining([true, 'bangun', 'dikti']));
      // Unscoped: the cron tick spans workspaces.
      expect(where.sql).not.toContain('workspace_id');
    });
  });

  describe('resumeFromAgentPause (MB-560)', () => {
    it('re-enables, clears the reason and sets next_fire_at — guarded on a reason being set and this workspace only', async () => {
      const row = { id: 'rt-1', enabled: true, paused_reason: null };
      mockDb.returning.mockResolvedValueOnce([row]);

      const result = await repo.resumeFromAgentPause('rt-1', '2026-10-01T09:00:00.000Z');

      expect(result).toEqual(row);
      expect(mockDb.set).toHaveBeenCalledWith({
        enabled: true,
        paused_reason: null,
        paused_at: null,
        next_fire_at: '2026-10-01T09:00:00.000Z',
        updated_at: expect.anything(),
      });
      const where = new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);
      expect(where.sql).toContain('"routines"."paused_reason" is not null');
      expect(where.sql).toContain('"routines"."workspace_id" = $');
      expect(where.sql).toContain('"routines"."archived_at" is null');
      // Strict workspace — no legacy NULL-workspace fallback.
      expect(where.sql).not.toContain('"routines"."workspace_id" is null');
      expect(where.params).toEqual(expect.arrayContaining(['rt-1', 'workspace-1']));
    });

    it('returns null when nothing matched (e.g. a manual pause)', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      expect(await repo.resumeFromAgentPause('rt-1', '2026-10-01T09:00:00.000Z')).toBeNull();
    });
  });

  it('claimDue returns [] when advisory lock is contended', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: MockDb) => Promise<unknown>) => {
      const tx = makeMockDb();
      tx.execute.mockResolvedValueOnce({ rows: [{ locked: false }] });
      return fn(tx);
    });

    const result = await repo.claimDue(new Date('2026-05-18T06:00:30Z'));

    expect(result).toEqual([]);
  });

  it('claimDue returns due rows when lock acquired', async () => {
    const due = [{ id: 'rt-1' }, { id: 'rt-2' }];
    mockDb.transaction.mockImplementationOnce(async (fn: (tx: MockDb) => Promise<unknown>) => {
      const tx = makeMockDb();
      tx.execute.mockResolvedValueOnce({ rows: [{ locked: true }] });
      tx.limit.mockResolvedValueOnce(due);
      return fn(tx);
    });

    const result = await repo.claimDue(new Date('2026-05-18T06:00:30Z'));

    expect(result).toEqual(due);
  });

  it('countRuns returns the count for the routine', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 7 }] });

    expect(await repo.countRuns('rt-1')).toBe(7);
  });

  it('countRuns returns 0 when execute returns empty', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });

    expect(await repo.countRuns('rt-1')).toBe(0);
  });

  it('listRuns returns rows ordered newest-first', async () => {
    const rows = [{ id: 'q-2' }, { id: 'q-1' }];
    mockDb.limit.mockResolvedValueOnce(rows);

    expect(await repo.listRuns('rt-1')).toEqual(rows);
  });
});
