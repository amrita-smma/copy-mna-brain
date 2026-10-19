import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, getActiveWorkspaceIdMock, createContainerMock, recordConsentMock } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    createContainerMock: vi.fn(),
    recordConsentMock: vi.fn(),
  }),
);

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return {
    ...actual,
    getActiveWorkspaceId: getActiveWorkspaceIdMock,
  };
});
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';

const USER_ID = 'user-1';

function makeRequest(): never {
  return {} as never;
}

describe('POST /api/consent', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('workspace-1');
    recordConsentMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({ consentService: { recordConsent: recordConsentMock } });
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(recordConsentMock).not.toHaveBeenCalled();
  });

  it('records consent for the authenticated user', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    recordConsentMock.mockResolvedValueOnce({ id: 'c1', user_id: USER_ID, policy_version: 'v1' });

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(createContainerMock).toHaveBeenCalledWith({}, 'workspace-1');
    expect(recordConsentMock).toHaveBeenCalledWith(USER_ID);
    const body = await res.json();
    expect(body).toEqual({ data: { id: 'c1', user_id: USER_ID, policy_version: 'v1' } });
  });

  it('returns 500 when the service throws', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    recordConsentMock.mockRejectedValueOnce(new Error('db down'));

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('db down');
  });
});
