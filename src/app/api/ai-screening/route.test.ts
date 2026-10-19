import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createDbMock, createContainerMock, getActiveWorkspaceIdOrThrowMock, enqueueForCompanyMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdOrThrowMock: vi.fn(),
    enqueueForCompanyMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/agents/analysis', () => ({ getStatelessAgentGraph: vi.fn() }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return { ...actual, getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock };
});

import { POST } from './route';
import { NotPendingConfirmationError } from '@/lib/services/aiScreeningService';

const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/ai-screening', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue('w1');
  enqueueForCompanyMock
    .mockReset()
    .mockResolvedValue({ alreadyQueued: false, trackCount: 2, screeningCount: 5 });
  createContainerMock.mockReset().mockReturnValue({
    aiScreeningService: { enqueueForCompany: enqueueForCompanyMock },
  });
});

describe('POST /api/ai-screening', () => {
  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await post({ companyId: 'c1' });
    expect(res.status).toBe(401);
    expect(enqueueForCompanyMock).not.toHaveBeenCalled();
  });

  it('returns 400 without a companyId', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(enqueueForCompanyMock).not.toHaveBeenCalled();
  });

  it('queues the company’s screening task as the signed-in user', async () => {
    const res = await post({ companyId: 'c1' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      data: { alreadyQueued: false, trackCount: 2, screeningCount: 5 },
    });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');
    expect(enqueueForCompanyMock).toHaveBeenCalledWith('c1', 'user-1');
  });

  it('returns 409 for a company not in Pending Confirmation', async () => {
    enqueueForCompanyMock.mockRejectedValueOnce(new NotPendingConfirmationError());
    const res = await post({ companyId: 'c1' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Pending Confirmation/);
  });
});
