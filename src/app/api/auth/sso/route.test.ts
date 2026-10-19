import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  signInMock,
  createDbMock,
  signInWithLauncherTokenMock,
  getAccessibleWorkspacesForUserMock,
} = vi.hoisted(() => ({
  signInMock: vi.fn(),
  createDbMock: vi.fn(),
  signInWithLauncherTokenMock: vi.fn(),
  getAccessibleWorkspacesForUserMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ signIn: signInMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({
  createContainer: () => ({
    authService: { signInWithLauncherToken: signInWithLauncherTokenMock },
    workspaceService: {
      getAccessibleWorkspacesForUser: getAccessibleWorkspacesForUserMock,
    },
  }),
}));

import { GET } from './route';

function makeRequest(url: string): never {
  return { nextUrl: new URL(url, 'https://brain.test') } as never;
}

/** N distinct accessible workspaces, shaped like `MembershipDetail`. */
function workspaces(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    workspaceId: `ws-${i}`,
    workspaceSlug: `ws-${i}`,
  }));
}

describe('GET /api/auth/sso', () => {
  beforeEach(() => {
    signInMock.mockReset().mockResolvedValue('https://brain.test/');
    createDbMock.mockReset().mockReturnValue({});
    signInWithLauncherTokenMock.mockReset().mockResolvedValue({ id: 'u1' });
    getAccessibleWorkspacesForUserMock.mockReset().mockResolvedValue(workspaces(1));
  });

  it('redirects to login when no token is present', async () => {
    const res = await GET(makeRequest('/api/auth/sso'));
    expect(res.headers.get('Location')).toBe('/login?error=launcher-sso');
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('redirects to login when the token fails to authenticate', async () => {
    signInMock.mockResolvedValueOnce('https://brain.test/login?error=CredentialsSignin');
    const res = await GET(makeRequest('/api/auth/sso?token=bad'));
    expect(res.headers.get('Location')).toBe('/login?error=launcher-sso');
  });

  it('redirects to login when signIn throws', async () => {
    signInMock.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(makeRequest('/api/auth/sso?token=bad'));
    expect(res.headers.get('Location')).toBe('/login?error=launcher-sso');
  });

  it('lands a single-workspace user on the requested callback', async () => {
    const res = await GET(makeRequest('/api/auth/sso?token=good&callbackUrl=%2Fchat'));
    expect(res.status).toBe(307);
    expect(res.headers.get('Location')).toBe('/chat');
  });

  it('lands a multi-workspace user on the workspace picker', async () => {
    getAccessibleWorkspacesForUserMock.mockResolvedValueOnce(workspaces(3));
    const res = await GET(makeRequest('/api/auth/sso?token=good&callbackUrl=%2Fchat'));
    expect(res.headers.get('Location')).toBe('/workspace');
  });

  it('honours a workspace-scoped callback without looking up memberships', async () => {
    getAccessibleWorkspacesForUserMock.mockResolvedValueOnce(workspaces(3));
    const res = await GET(
      makeRequest('/api/auth/sso?token=good&callbackUrl=%2Fw%2Facme%2Fpipeline'),
    );
    expect(res.headers.get('Location')).toBe('/w/acme/pipeline');
    expect(getAccessibleWorkspacesForUserMock).not.toHaveBeenCalled();
  });

  it('falls back to the callback when the membership lookup fails', async () => {
    getAccessibleWorkspacesForUserMock.mockRejectedValueOnce(new Error('db down'));
    const res = await GET(makeRequest('/api/auth/sso?token=good&callbackUrl=%2Fchat'));
    expect(res.headers.get('Location')).toBe('/chat');
  });

  it('rejects a cross-origin callback and falls back to the root path', async () => {
    const res = await GET(
      makeRequest('/api/auth/sso?token=good&callbackUrl=https%3A%2F%2Fevil.test'),
    );
    expect(res.headers.get('Location')).toBe('/');
  });
});
