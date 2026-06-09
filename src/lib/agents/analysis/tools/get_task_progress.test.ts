import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listFiltered, createDb } = vi.hoisted(() => ({
  listFiltered: vi.fn(),
  createDb: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb }));

vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {
    listFiltered = listFiltered;
  },
}));

import { getTaskProgress } from './get_task_progress';

beforeEach(() => {
  listFiltered.mockReset();
  createDb.mockReset().mockReturnValue({});
});

afterEach(() => vi.clearAllMocks());

describe('getTaskProgress', () => {
  it('returns a "no tasks" message when the queue is empty', async () => {
    listFiltered.mockResolvedValue([]);

    const result = (await getTaskProgress.invoke({})) as string;

    expect(result).toBe('No Workforce tasks found.');
    expect(listFiltered).toHaveBeenCalledWith({
      status: undefined,
      agentName: undefined,
      limit: 10,
    });
  });

  it('mentions the active scope when filtering returns nothing', async () => {
    listFiltered.mockResolvedValue([]);

    const result = (await getTaskProgress.invoke({
      status: 'active',
      agent_name: 'chat_handoff',
    })) as string;

    expect(result).toContain('No Workforce tasks found matching');
    expect(result).toContain('status="active"');
    expect(result).toContain('agent="chat_handoff"');
  });

  it('expands the "active" group into the five in-flight statuses', async () => {
    listFiltered.mockResolvedValue([]);

    await getTaskProgress.invoke({ status: 'active' });

    expect(listFiltered).toHaveBeenCalledWith({
      status: [
        'pending',
        'running',
        'waiting_for_human_input',
        'waiting_for_subagent',
        'resume_ready',
      ],
      agentName: undefined,
      limit: 10,
    });
  });

  it('expands the "errored" group into failed/rejected/timed_out', async () => {
    listFiltered.mockResolvedValue([]);

    await getTaskProgress.invoke({ status: 'errored' });

    expect(listFiltered).toHaveBeenCalledWith({
      status: ['failed', 'rejected', 'timed_out'],
      agentName: undefined,
      limit: 10,
    });
  });

  it('passes a specific workforce status through unchanged', async () => {
    listFiltered.mockResolvedValue([]);

    await getTaskProgress.invoke({ status: 'waiting_for_human_input' });

    expect(listFiltered).toHaveBeenCalledWith({
      status: 'waiting_for_human_input',
      agentName: undefined,
      limit: 10,
    });
  });

  it('caps the limit at 25 and floors at 1', async () => {
    listFiltered.mockResolvedValue([]);

    await getTaskProgress.invoke({ limit: 999 });
    expect(listFiltered).toHaveBeenLastCalledWith({
      status: undefined,
      agentName: undefined,
      limit: 25,
    });

    await getTaskProgress.invoke({ limit: 0 });
    expect(listFiltered).toHaveBeenLastCalledWith({
      status: undefined,
      agentName: undefined,
      limit: 1,
    });
  });

  it('renders id, agent, status, and timestamps for each row', async () => {
    listFiltered.mockResolvedValue([
      {
        id: 'row-1',
        agent_name: 'chat_handoff',
        title: 'Korean CMP outbound search',
        status: 'running',
        created_at: '2026-06-08T10:00:00Z',
        started_at: '2026-06-08T10:00:05Z',
        ended_at: null,
        last_heartbeat_at: '2026-06-08T10:01:30Z',
        resume_reason: null,
        error: null,
      },
    ]);

    const result = (await getTaskProgress.invoke({})) as string;

    expect(result).toContain('### 1. Korean CMP outbound search');
    expect(result).toContain('**ID:** row-1');
    expect(result).toContain('**Agent:** chat_handoff');
    expect(result).toContain('**Status:** running');
    expect(result).toContain('**Created:** 2026-06-08T10:00:00Z');
    expect(result).toContain('**Last heartbeat:** 2026-06-08T10:01:30Z');
  });

  it('surfaces resume_reason for tasks waiting on human input', async () => {
    listFiltered.mockResolvedValue([
      {
        id: 'row-2',
        agent_name: 'chat_handoff',
        title: 'Promote Acme to L1',
        status: 'waiting_for_human_input',
        created_at: '2026-06-08T09:00:00Z',
        started_at: '2026-06-08T09:00:01Z',
        ended_at: null,
        last_heartbeat_at: null,
        resume_reason: 'HITL: approve promote_to_l1',
        error: null,
      },
    ]);

    const result = (await getTaskProgress.invoke({})) as string;

    expect(result).toContain('**Waiting reason:** HITL: approve promote_to_l1');
  });

  it('summarises a structured error payload for failed rows', async () => {
    listFiltered.mockResolvedValue([
      {
        id: 'row-3',
        agent_name: 'chat_handoff',
        title: 'Stale outbound search',
        status: 'failed',
        created_at: '2026-06-07T12:00:00Z',
        started_at: '2026-06-07T12:00:01Z',
        ended_at: '2026-06-07T12:05:00Z',
        last_heartbeat_at: null,
        resume_reason: null,
        error: { code: 'timeout', message: 'web_search exhausted retries' },
      },
    ]);

    const result = (await getTaskProgress.invoke({})) as string;

    expect(result).toContain('**Error:** web_search exhausted retries');
  });

  it('falls back to "(untitled)" when title is missing', async () => {
    listFiltered.mockResolvedValue([
      {
        id: 'row-4',
        agent_name: 'chat_handoff',
        title: null,
        status: 'pending',
        created_at: '2026-06-08T11:00:00Z',
        started_at: null,
        ended_at: null,
        last_heartbeat_at: null,
        resume_reason: null,
        error: null,
      },
    ]);

    const result = (await getTaskProgress.invoke({})) as string;

    expect(result).toContain('### 1. (untitled)');
  });

  it('returns a formatted error when the repository throws', async () => {
    listFiltered.mockRejectedValue(new Error('boom'));

    const result = (await getTaskProgress.invoke({})) as string;

    expect(result).toBe('**Error:** boom');
  });
});
