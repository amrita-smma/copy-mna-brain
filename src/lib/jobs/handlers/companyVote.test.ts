import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  deliverInvitations: vi.fn(),
  finalizeConcludedSession: vi.fn(),
}));

vi.mock('@/lib/services/container', () => ({
  createContainer: mocks.createContainer,
}));

import { runCompanyVote } from './companyVote';

const db = {} as never;

describe('runCompanyVote', () => {
  beforeEach(() => {
    mocks.createContainer.mockReset();
    mocks.deliverInvitations.mockReset();
    mocks.finalizeConcludedSession.mockReset();
    mocks.createContainer.mockReturnValue({
      companyVoteService: {
        deliverInvitations: mocks.deliverInvitations,
        finalizeConcludedSession: mocks.finalizeConcludedSession,
      },
    });
  });

  it('builds the container for the payload workspace', async () => {
    mocks.deliverInvitations.mockResolvedValue({ sent: 2, failed: 0 });

    await runCompanyVote({ kind: 'invite', sessionId: 'vs-1', workspaceId: 'ws-1' }, { db });

    expect(mocks.createContainer).toHaveBeenCalledWith(db, 'ws-1');
  });

  it('reports the invitation fan-out counts', async () => {
    mocks.deliverInvitations.mockResolvedValue({ sent: 3, failed: 1 });

    await expect(
      runCompanyVote({ kind: 'invite', sessionId: 'vs-1', workspaceId: 'ws-1' }, { db }),
    ).resolves.toEqual({ kind: 'invite', sessionId: 'vs-1', sent: 3, failed: 1 });
  });

  it('forwards the close reason to the conclusion path', async () => {
    mocks.finalizeConcludedSession.mockResolvedValue(undefined);

    await expect(
      runCompanyVote(
        { kind: 'conclude', sessionId: 'vs-1', reason: 'deadline', workspaceId: 'ws-1' },
        { db },
      ),
    ).resolves.toEqual({ kind: 'conclude', sessionId: 'vs-1' });
    expect(mocks.finalizeConcludedSession).toHaveBeenCalledWith('vs-1', 'deadline');
  });

  it('throws without a sessionId', async () => {
    await expect(
      runCompanyVote({ kind: 'invite', sessionId: '', workspaceId: 'ws-1' }, { db }),
    ).rejects.toThrow(/sessionId/);
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it('throws without a workspaceId — the container cannot be scoped', async () => {
    await expect(
      runCompanyVote({ kind: 'invite', sessionId: 'vs-1' }, { db }),
    ).rejects.toThrow(/workspaceId/);
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it('rejects an unsupported kind', async () => {
    await expect(
      runCompanyVote(
        { kind: 'nope', sessionId: 'vs-1', workspaceId: 'ws-1' } as never,
        { db },
      ),
    ).rejects.toThrow(/unsupported kind nope/);
  });
});
