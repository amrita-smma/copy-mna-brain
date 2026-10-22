import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  findUnembeddedChatMessages: vi.fn(),
  queueEmbeddings: vi.fn(),
  createContainer: vi.fn(),
  workspacesSeen: [] as string[],
}));

vi.mock('@/lib/repositories', () => ({ findUnembeddedChatMessages: m.findUnembeddedChatMessages }));
vi.mock('@/lib/services/container', () => ({ createContainer: m.createContainer }));
vi.mock('@/lib/workspace', () => ({
  runWithWorkforceWorkspaceId: async (workspaceId: string, fn: () => Promise<unknown>) => {
    m.workspacesSeen.push(workspaceId);
    return fn();
  },
}));

import { EMBEDDING_SWEEP_BATCH, sweepUnembeddedChatMessages } from './embeddingSweep';

describe('sweepUnembeddedChatMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.workspacesSeen.length = 0;
    m.createContainer.mockReturnValue({ chatHistoryService: { queueEmbeddings: m.queueEmbeddings } });
    m.queueEmbeddings.mockImplementation(async (ids: string[]) => ids.length);
  });

  it('queues each workspace’s unembedded exchanges through that workspace’s container', async () => {
    m.findUnembeddedChatMessages.mockResolvedValue([
      { id: 'm1', workspace_id: 'ws-a' },
      { id: 'm2', workspace_id: 'ws-b' },
      { id: 'm3', workspace_id: 'ws-a' },
    ]);

    const out = await sweepUnembeddedChatMessages({} as never);

    expect(out).toEqual({ queued: 3, workspaces: 2 });
    expect(m.findUnembeddedChatMessages).toHaveBeenCalledWith({}, EMBEDDING_SWEEP_BATCH);
    expect(m.createContainer).toHaveBeenCalledWith({}, 'ws-a');
    expect(m.createContainer).toHaveBeenCalledWith({}, 'ws-b');
    expect(m.queueEmbeddings).toHaveBeenCalledWith(['m1', 'm3']);
    expect(m.queueEmbeddings).toHaveBeenCalledWith(['m2']);
    expect(m.workspacesSeen.sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('does nothing when every exchange has its vector', async () => {
    m.findUnembeddedChatMessages.mockResolvedValue([]);
    expect(await sweepUnembeddedChatMessages({} as never)).toEqual({ queued: 0, workspaces: 0 });
    expect(m.createContainer).not.toHaveBeenCalled();
  });

  it('keeps going when one workspace fails to queue', async () => {
    m.findUnembeddedChatMessages.mockResolvedValue([
      { id: 'm1', workspace_id: 'ws-a' },
      { id: 'm2', workspace_id: 'ws-b' },
    ]);
    m.queueEmbeddings.mockRejectedValueOnce(new Error('no AWS')).mockResolvedValueOnce(1);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await sweepUnembeddedChatMessages({} as never)).toEqual({ queued: 1, workspaces: 2 });
    spy.mockRestore();
  });
});
