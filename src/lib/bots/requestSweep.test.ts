import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  findStaleBotRequests: vi.fn(),
  createContainer: vi.fn(),
  sweep: vi.fn(),
  workspaceDuring: [] as string[],
}));

vi.mock('@/lib/repositories', () => ({ findStaleBotRequests: m.findStaleBotRequests }));
vi.mock('@/lib/services/container', () => ({ createContainer: m.createContainer }));

import { sweepBotRequests } from './requestSweep';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { BOT_REQUEST_TIMEOUT_SECONDS } from '@/lib/services/botRequestService';

describe('sweepBotRequests', () => {
  beforeEach(() => {
    m.findStaleBotRequests.mockReset();
    m.sweep.mockReset();
    m.workspaceDuring.length = 0;
    m.createContainer.mockReset().mockReturnValue({ botRequestService: { sweep: m.sweep } });
    m.sweep.mockImplementation(async () => {
      m.workspaceDuring.push(await getActiveWorkspaceId());
      return 2;
    });
  });

  it('sweeps each workspace that has stale requests through its own container, inside that workspace', async () => {
    m.findStaleBotRequests.mockResolvedValue([
      { id: 'r1', workspace_id: 'ws-1' },
      { id: 'r2', workspace_id: 'ws-2' },
      { id: 'r3', workspace_id: 'ws-1' },
    ]);

    await expect(sweepBotRequests({} as never)).resolves.toEqual({ timedOut: 4, workspaces: 2 });

    expect(m.findStaleBotRequests).toHaveBeenCalledWith({}, BOT_REQUEST_TIMEOUT_SECONDS, expect.any(Number));
    expect(m.createContainer.mock.calls.map((c) => c[1])).toEqual(['ws-1', 'ws-2']);
    expect(m.workspaceDuring).toEqual(['ws-1', 'ws-2']);
  });

  it('does nothing when no request is stale, and survives one workspace failing', async () => {
    m.findStaleBotRequests.mockResolvedValueOnce([]);
    await expect(sweepBotRequests({} as never)).resolves.toEqual({ timedOut: 0, workspaces: 0 });
    expect(m.createContainer).not.toHaveBeenCalled();

    m.findStaleBotRequests.mockResolvedValueOnce([
      { id: 'r1', workspace_id: 'ws-1' },
      { id: 'r2', workspace_id: 'ws-2' },
    ]);
    m.sweep.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sweepBotRequests({} as never)).resolves.toEqual({ timedOut: 1, workspaces: 2 });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
