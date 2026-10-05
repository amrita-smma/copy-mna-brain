import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailNotificationService, deriveApprovalDetails } from './emailNotificationService';
import type { NotificationDeps, InsightRefreshedNotice } from './emailNotificationService';

const APP_URL = 'https://app.example.com';

function makeDeps(overrides: {
  run?: Record<string, unknown> | null;
  routine?: Record<string, unknown> | null;
  users?: Array<{ id: string; name: string; email: string | null }>;
  workspaceSlug?: string | null;
}): {
  deps: NotificationDeps;
  enqueue: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findRoutine: ReturnType<typeof vi.fn>;
  findByIds: ReturnType<typeof vi.fn>;
  findWorkspace: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn().mockResolvedValue({ messageId: 'm' });
  const findById = vi.fn().mockResolvedValue(overrides.run ?? null);
  const findRoutine = vi.fn().mockResolvedValue(overrides.routine ?? null);
  const findByIds = vi.fn().mockResolvedValue(overrides.users ?? []);
  const workspaceSlug = overrides.workspaceSlug === undefined ? 'togan-vcc' : overrides.workspaceSlug;
  const findWorkspace = vi.fn().mockResolvedValue(workspaceSlug ? { slug: workspaceSlug } : undefined);
  const deps: NotificationDeps = {
    workforceRepo: { findById } as never,
    routinesRepo: { findById: findRoutine } as never,
    userRepo: { findByIds } as never,
    workspaceRepo: { findById: findWorkspace } as never,
    enqueue,
    appUrl: APP_URL,
  };
  return { deps, enqueue, findById, findRoutine, findByIds, findWorkspace };
}

describe('EmailNotificationService', () => {
  beforeEach(() => {
    process.env.TASK_NOTIFICATIONS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.TASK_NOTIFICATIONS_ENABLED;
    vi.clearAllMocks();
  });

  it('is a no-op when the feature flag env var is off', async () => {
    delete process.env.TASK_NOTIFICATIONS_ENABLED;
    const { deps, enqueue, findById } = makeDeps({
      run: { id: 'r1', trigger_source: 'chat', triggered_by_user_id: 'u1', title: 'T' },
      users: [{ id: 'u1', name: 'A', email: 'a@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    expect(await svc.notifyTaskCompleted('r1')).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it('enqueues task_completed to the triggering user with a workspace-scoped deep link', async () => {
    const { deps, enqueue, findWorkspace } = makeDeps({
      run: {
        id: 'r1',
        trigger_source: 'chat',
        triggered_by_user_id: 'u1',
        title: 'Project Maple screening',
        output: { final_message: 'All done.' },
        workspace_id: 'ws1',
      },
      users: [{ id: 'u1', name: 'Ana', email: 'ana@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    const ok = await svc.notifyTaskCompleted('r1');
    expect(ok).toBe(true);
    expect(findWorkspace).toHaveBeenCalledWith('ws1');
    expect(enqueue).toHaveBeenCalledWith({
      kind: 'task_completed',
      to: 'ana@e.com',
      taskName: 'Project Maple screening',
      taskUrl: `${APP_URL}/w/togan-vcc/ai-workforce/tasks/r1`,
      summary: 'All done.',
    });
  });

  it('falls back to the un-prefixed URL when the workspace lookup fails to resolve a slug', async () => {
    const { deps, enqueue } = makeDeps({
      run: {
        id: 'r1',
        trigger_source: 'chat',
        triggered_by_user_id: 'u1',
        title: 'Project Maple screening',
        workspace_id: 'ws-deleted',
      },
      users: [{ id: 'u1', name: 'Ana', email: 'ana@e.com' }],
      workspaceSlug: null,
    });
    const svc = new EmailNotificationService(deps);
    await svc.notifyTaskCompleted('r1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ taskUrl: `${APP_URL}/ai-workforce/tasks/r1` }),
    );
  });

  it('falls back to the un-prefixed URL when the workspace lookup throws', async () => {
    const { deps, enqueue } = makeDeps({
      run: {
        id: 'r1',
        trigger_source: 'chat',
        triggered_by_user_id: 'u1',
        title: 'Project Maple screening',
        workspace_id: 'ws1',
      },
      users: [{ id: 'u1', name: 'Ana', email: 'ana@e.com' }],
    });
    deps.workspaceRepo = { findById: vi.fn().mockRejectedValue(new Error('db down')) } as never;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new EmailNotificationService(deps);
    await svc.notifyTaskCompleted('r1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ taskUrl: `${APP_URL}/ai-workforce/tasks/r1` }),
    );
    errSpy.mockRestore();
  });

  it('builds SUMMARY rows from timestamps and RESULTS rows from structured output', async () => {
    const { deps, enqueue } = makeDeps({
      run: {
        id: 'r1',
        trigger_source: 'chat',
        triggered_by_user_id: 'u1',
        title: 'Project Maple Screening',
        input: { prompt: 'Screen 5 inbound targets' },
        started_at: '2026-04-28T14:15:00.000Z',
        ended_at: '2026-04-28T14:42:00.000Z',
        output: {
          final_message: 'done',
          results: [
            { label: 'Companies screened', value: 5 },
            { label: 'Pass L0 (Financial)', value: '4 (80%)', highlight: true },
          ],
        },
      },
      users: [{ id: 'u1', name: 'A', email: 'a@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    await svc.notifyTaskCompleted('r1');
    const payload = enqueue.mock.calls[0][0];
    expect(payload.finishedAtLabel).toBe('Finished at 2:42 PM on April 28, 2026');
    expect(payload.summaryRows).toEqual([
      { label: 'Task', value: 'Screen 5 inbound targets' },
      { label: 'Started', value: 'April 28, 2:15 PM' },
      { label: 'Completed', value: 'April 28, 2:42 PM' },
      { label: 'Duration', value: '27 minutes' },
    ]);
    expect(payload.resultRows).toEqual([
      { label: 'Companies screened', value: '5', highlight: false },
      { label: 'Pass L0 (Financial)', value: '4 (80%)', highlight: true },
    ]);
  });

  it('skips task_completed for cron runs (digest covers them)', async () => {
    const { deps, enqueue } = makeDeps({
      run: { id: 'r1', trigger_source: 'cron', origin_routine_id: 'ro1', title: 'T' },
      routine: { id: 'ro1', created_by: 'u9' },
      users: [{ id: 'u9', name: 'Owner', email: 'owner@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    expect(await svc.notifyTaskCompleted('r1')).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('resolves a cron run recipient via the routine creator for waiting notifications', async () => {
    const { deps, enqueue, findRoutine } = makeDeps({
      run: { id: 'r1', trigger_source: 'cron', triggered_by_user_id: null, origin_routine_id: 'ro1', title: 'Daily scan', workspace_id: 'ws1' },
      routine: { id: 'ro1', created_by: 'u9' },
      users: [{ id: 'u9', name: 'Owner', email: 'owner@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    const ok = await svc.notifyTaskWaitingApproval('r1', {
      action: 'Promote NovaSpec to L2',
    });
    expect(ok).toBe(true);
    expect(findRoutine).toHaveBeenCalledWith('ro1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task_waiting_approval',
        to: 'owner@e.com',
        action: 'Promote NovaSpec to L2',
        taskName: 'Daily scan',
        taskUrl: `${APP_URL}/w/togan-vcc/ai-workforce/tasks/r1`,
      }),
    );
  });

  it('sends the waiting email to the asked user (the insight owner), not the routine creator', async () => {
    const { deps, enqueue, findRoutine, findByIds } = makeDeps({
      run: { id: 'r1', trigger_source: 'cron', triggered_by_user_id: null, origin_routine_id: 'ro1', title: 'Weekly pulse refresh', workspace_id: 'ws1' },
      routine: { id: 'ro1', created_by: 'u9' },
      users: [{ id: 'owner-1', name: 'Insight Owner', email: 'insight.owner@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    const ok = await svc.notifyTaskWaitingApproval('r1', {
      action: 'Use the Q2 figures?',
      toolName: 'ask_owner',
      toolArgs: {
        question: 'Use the Q2 figures?',
        recommendation: 'Use Q2 and flag the gap',
        rationale: 'Q3 report is gone',
      },
      recipientUserId: 'owner-1',
    });
    expect(ok).toBe(true);
    expect(findByIds).toHaveBeenCalledWith(['owner-1']);
    expect(findRoutine).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task_waiting_approval',
        to: 'insight.owner@e.com',
        action: 'Use the Q2 figures?',
        proposedAction: 'Recommended answer: Use Q2 and flag the gap',
        reason: 'Q3 report is gone',
      }),
    );
  });

  it('builds the structured proposal card from a promote_to_l1 interrupt', async () => {
    const { deps, enqueue } = makeDeps({
      run: { id: 'r1', trigger_source: 'chat', triggered_by_user_id: 'u1', title: 'Project Maple screening' },
      users: [{ id: 'u1', name: 'A', email: 'a@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    await svc.notifyTaskWaitingApproval('r1', {
      action: 'Promote NovaSpec Materials from L0 to the next stage?',
      toolName: 'promote_to_l1',
      toolArgs: { company_name: 'NovaSpec Materials', reason: 'Passes all L1 criteria' },
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task_waiting_approval',
        action: 'Promote NovaSpec Materials to the next stage',
        company: 'NovaSpec Materials',
        proposedAction: 'Move to the stage after L0',
        reason: 'Passes all L1 criteria',
        changeField: 'Pipeline Stage',
        beforeValue: 'L0',
        afterValue: 'Next stage',
      }),
    );
  });

  it('marks task_failed as cancelled and pulls the reason from the error payload', async () => {
    const { deps, enqueue } = makeDeps({
      run: {
        id: 'r1',
        trigger_source: 'chat',
        triggered_by_user_id: 'u1',
        title: 'T',
        error: { code: 'cancelled_by_user', reason: 'changed my mind' },
      },
      users: [{ id: 'u1', name: 'A', email: 'a@e.com' }],
    });
    const svc = new EmailNotificationService(deps);
    await svc.notifyTaskFailed('r1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task_failed', cancelled: true, reason: 'changed my mind' }),
    );
  });

  it('returns false when the recipient has no email on file', async () => {
    const { deps, enqueue } = makeDeps({
      run: { id: 'r1', trigger_source: 'chat', triggered_by_user_id: 'u1', title: 'T' },
      users: [{ id: 'u1', name: 'A', email: null }],
    });
    const svc = new EmailNotificationService(deps);
    expect(await svc.notifyTaskCompleted('r1')).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('falls back to a default task name and no link when title/appUrl are missing', async () => {
    const enqueue = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailNotificationService({
      workforceRepo: {
        findById: vi.fn().mockResolvedValue({
          id: 'r1',
          trigger_source: 'chat',
          triggered_by_user_id: 'u1',
          title: null,
        }),
      } as never,
      routinesRepo: { findById: vi.fn() } as never,
      userRepo: { findByIds: vi.fn().mockResolvedValue([{ id: 'u1', name: 'A', email: 'a@e.com' }]) } as never,
      workspaceRepo: { findById: vi.fn() } as never,
      enqueue,
      appUrl: '',
    });
    await svc.notifyTaskCompleted('r1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: 'Your task', taskUrl: undefined }),
    );
  });

  it('never throws when the repo lookup fails (best-effort)', async () => {
    const { deps, enqueue } = makeDeps({});
    deps.workforceRepo = {
      findById: vi.fn().mockRejectedValue(new Error('db down')),
    } as never;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new EmailNotificationService(deps);
    await expect(svc.notifyTaskCompleted('r1')).resolves.toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  describe('notifyInsightRefreshed', () => {
    const NOTICE: InsightRefreshedNotice = {
      workspaceId: 'ws1',
      insightId: 'ins-1',
      insightName: 'Japan Target Analysis',
      versionNo: 2,
      ownerUserId: 'u-owner',
    };
    const OWNER = { id: 'u-owner', name: 'Alice', email: 'alice@example.com' };

    it('enqueues insight_refreshed to the owner email with the slugged link', async () => {
      const { deps, enqueue, findWorkspace, findByIds } = makeDeps({ users: [OWNER] });

      expect(await new EmailNotificationService(deps).notifyInsightRefreshed(NOTICE)).toBe(true);
      expect(findByIds).toHaveBeenCalledWith(['u-owner']);
      expect(findWorkspace).toHaveBeenCalledWith('ws1');
      expect(enqueue).toHaveBeenCalledWith({
        kind: 'insight_refreshed',
        to: 'alice@example.com',
        insightName: 'Japan Target Analysis',
        versionNo: 2,
        insightUrl: `${APP_URL}/w/togan-vcc/insight/ins-1`,
      });
    });

    it.each([
      ['the notifications flag is off', { ...OWNER }, NOTICE, true],
      ['there is no owner', { ...OWNER }, { ...NOTICE, ownerUserId: null }, false],
      ['the owner has no email', { ...OWNER, email: null }, NOTICE, false],
    ])('returns false without enqueueing when %s', async (_label, owner, notice, flagOff) => {
      if (flagOff) delete process.env.TASK_NOTIFICATIONS_ENABLED;
      const { deps, enqueue } = makeDeps({ users: [owner] });

      expect(await new EmailNotificationService(deps).notifyInsightRefreshed(notice)).toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('falls back to the un-prefixed link when the workspace lookup throws', async () => {
      const { deps, enqueue } = makeDeps({ users: [OWNER] });
      deps.workspaceRepo = { findById: vi.fn().mockRejectedValue(new Error('db connection lost')) } as never;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(await new EmailNotificationService(deps).notifyInsightRefreshed(NOTICE)).toBe(true);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ insightUrl: `${APP_URL}/insight/ins-1` }));
      errSpy.mockRestore();
    });

    it('enqueue throws → resolves false (never throws)', async () => {
      const { deps, enqueue } = makeDeps({ users: [OWNER] });
      enqueue.mockRejectedValue(new Error('queue down'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(new EmailNotificationService(deps).notifyInsightRefreshed(NOTICE)).resolves.toBe(false);
      errSpy.mockRestore();
    });
  });
});

describe('deriveApprovalDetails', () => {
  it('maps a promote_to_l1 call to the L0 → next-stage proposal card', () => {
    expect(
      deriveApprovalDetails('promote_to_l1', {
        company_name: 'NovaSpec Materials',
        reason: 'Passes all L1 criteria',
      }),
    ).toEqual({
      action: 'Promote NovaSpec Materials to the next stage',
      company: 'NovaSpec Materials',
      proposedAction: 'Move to the stage after L0',
      reason: 'Passes all L1 criteria',
      changeField: 'Pipeline Stage',
      beforeValue: 'L0',
      afterValue: 'Next stage',
    });
  });

  it('appends an optional note to the reason', () => {
    const d = deriveApprovalDetails('promote_to_l1', {
      company_name: 'X',
      reason: 'strong',
      note: 'weak FY24',
    });
    expect(d.reason).toBe('strong\n\nNote: weak FY24');
  });

  it('returns {} for tools without a structured layout', () => {
    expect(deriveApprovalDetails('some_other_tool', { foo: 'bar' })).toEqual({});
    expect(deriveApprovalDetails(undefined, undefined)).toEqual({});
  });
});
