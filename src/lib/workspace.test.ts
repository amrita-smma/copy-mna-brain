import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MNA_WORKSPACE_ID, NO_ACTIVE_WORKSPACE_ID } from '@/lib/constants';
import {
  getActiveWorkspaceId,
  getActiveWorkspaceIdOrThrow,
  NoActiveWorkspaceError,
  runWithWorkforceWorkspaceId,
  workspaceSlugFromClaims,
} from './workspace';

const { mockAuth, mockHeaders } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockHeaders: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('next/headers', () => ({ headers: mockHeaders }));

describe('getActiveWorkspaceId', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockHeaders.mockReset();
    // Default: no workspace header on the request — matches every existing
    // caller until a `/w/<slug>/...` URL actually sends one.
    mockHeaders.mockResolvedValue(new Headers());
  });

  it('falls back to MNA_WORKSPACE_ID when there is no request scope (auth() throws)', async () => {
    mockAuth.mockRejectedValueOnce(new Error('headers was called outside a request scope'));

    const result = await getActiveWorkspaceId();

    expect(result).toBe(MNA_WORKSPACE_ID);
  });

  it('returns the session workspaceId when a logged-in user has an active workspace', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1', workspaceId: 'w1' } });

    const result = await getActiveWorkspaceId();

    expect(result).toBe('w1');
  });

  it('fails closed to NO_ACTIVE_WORKSPACE_ID when a logged-in user has no active workspace', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1', workspaceId: null } });

    const result = await getActiveWorkspaceId();

    expect(result).toBe(NO_ACTIVE_WORKSPACE_ID);
  });

  it('falls back to MNA_WORKSPACE_ID when auth() resolves but there is no session/user', async () => {
    mockAuth.mockResolvedValueOnce(null);

    const result = await getActiveWorkspaceId();

    expect(result).toBe(MNA_WORKSPACE_ID);
  });

  it('returns the header-matched workspaceId, not the session-active one, when X-Workspace-Slug matches a membership', async () => {
    mockAuth.mockResolvedValueOnce({
      user: {
        id: 'u1',
        workspaceId: 'w1',
        workspaces: [
          { workspaceId: 'w1', slug: 'togan-vcc' },
          { workspaceId: 'w2', slug: 'aeliana-vcc' },
        ],
      },
    });
    mockHeaders.mockResolvedValueOnce(new Headers({ 'X-Workspace-Slug': 'aeliana-vcc' }));

    const result = await getActiveWorkspaceId();

    expect(result).toBe('w2');
  });

  it('resolves X-Workspace-Id directly against the membership list', async () => {
    mockAuth.mockResolvedValueOnce({
      user: {
        id: 'u1',
        workspaceId: 'w1',
        workspaces: [{ workspaceId: 'w2', slug: 'aeliana-vcc' }],
      },
    });
    mockHeaders.mockResolvedValueOnce(new Headers({ 'X-Workspace-Id': 'w2' }));

    const result = await getActiveWorkspaceId();

    expect(result).toBe('w2');
  });

  it('prefers X-Workspace-Id over X-Workspace-Slug when both are present', async () => {
    mockAuth.mockResolvedValueOnce({
      user: {
        id: 'u1',
        workspaceId: 'w1',
        workspaces: [
          { workspaceId: 'w2', slug: 'aeliana-vcc' },
          { workspaceId: 'w3', slug: 'starhouse' },
        ],
      },
    });
    mockHeaders.mockResolvedValueOnce(
      new Headers({ 'X-Workspace-Id': 'w2', 'X-Workspace-Slug': 'starhouse' }),
    );

    const result = await getActiveWorkspaceId();

    expect(result).toBe('w2');
  });

  it('fails closed to NO_ACTIVE_WORKSPACE_ID when the header does not match any membership', async () => {
    mockAuth.mockResolvedValueOnce({
      user: {
        id: 'u1',
        workspaceId: 'w1',
        workspaces: [{ workspaceId: 'w1', slug: 'togan-vcc' }],
      },
    });
    mockHeaders.mockResolvedValueOnce(new Headers({ 'X-Workspace-Slug': 'not-a-member-here' }));

    const result = await getActiveWorkspaceId();

    expect(result).toBe(NO_ACTIVE_WORKSPACE_ID);
  });
});

describe('getActiveWorkspaceIdOrThrow', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockHeaders.mockReset();
    mockHeaders.mockResolvedValue(new Headers());
  });

  it('returns the workspace id when one is actively resolved', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1', workspaceId: 'w1' } });

    const result = await getActiveWorkspaceIdOrThrow();

    expect(result).toBe('w1');
  });

  it('throws NoActiveWorkspaceError instead of returning NO_ACTIVE_WORKSPACE_ID', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1', workspaceId: null } });

    await expect(getActiveWorkspaceIdOrThrow()).rejects.toThrow(NoActiveWorkspaceError);
  });
});

describe('runWithWorkforceWorkspaceId', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockHeaders.mockReset();
    mockHeaders.mockResolvedValue(new Headers());
  });

  it('resolves to the run-scoped workspace id, without consulting auth() at all', async () => {
    mockAuth.mockRejectedValue(new Error('should not be called'));

    const result = await runWithWorkforceWorkspaceId('run-ws-1', () =>
      getActiveWorkspaceId(),
    );

    expect(result).toBe('run-ws-1');
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('survives an async hop inside the wrapped function', async () => {
    const result = await runWithWorkforceWorkspaceId('run-ws-2', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getActiveWorkspaceId();
    });

    expect(result).toBe('run-ws-2');
  });

  it('does not leak into calls made outside the wrapped function', async () => {
    mockAuth.mockResolvedValueOnce(null);

    await runWithWorkforceWorkspaceId('run-ws-3', () => getActiveWorkspaceId());
    const outside = await getActiveWorkspaceId();

    expect(outside).toBe(MNA_WORKSPACE_ID);
  });

  it('wins over a present X-Workspace-Slug header — the ALS context is checked first and never falls through to auth()', async () => {
    mockAuth.mockRejectedValue(new Error('should not be called'));
    mockHeaders.mockResolvedValue(new Headers({ 'X-Workspace-Slug': 'someone-elses-workspace' }));

    const result = await runWithWorkforceWorkspaceId('run-ws-4', () => getActiveWorkspaceId());

    expect(result).toBe('run-ws-4');
    expect(mockAuth).not.toHaveBeenCalled();
  });
});

describe('workspaceSlugFromClaims', () => {
  const claims = [
    { workspaceId: 'w1', slug: 'acme' },
    { workspaceId: 'w2', slug: 'globex' },
  ];

  it('returns the slug of the matching claim', () => {
    expect(workspaceSlugFromClaims(claims, 'w2')).toBe('globex');
  });

  it('returns null when the workspace is not among the claims', () => {
    expect(workspaceSlugFromClaims(claims, 'w3')).toBeNull();
  });

  it('returns null when there are no claims (a caller with no session)', () => {
    expect(workspaceSlugFromClaims(undefined, 'w1')).toBeNull();
    expect(workspaceSlugFromClaims([], 'w1')).toBeNull();
  });

  it('returns null when the matching claim has a blank slug', () => {
    expect(workspaceSlugFromClaims([{ workspaceId: 'w1', slug: '  ' }], 'w1')).toBeNull();
    expect(workspaceSlugFromClaims([{ workspaceId: 'w1', slug: '' }], 'w1')).toBeNull();
  });

  it('returns null instead of throwing when claims is not an array', () => {
    expect(workspaceSlugFromClaims({ workspaceId: 'w1', slug: 'acme' } as never, 'w1')).toBeNull();
  });

  it('returns null for the fail-closed sentinel rather than guessing a slug', () => {
    expect(
      workspaceSlugFromClaims(
        [{ workspaceId: NO_ACTIVE_WORKSPACE_ID, slug: 'somehow' }],
        NO_ACTIVE_WORKSPACE_ID,
      ),
    ).toBeNull();
  });
});
