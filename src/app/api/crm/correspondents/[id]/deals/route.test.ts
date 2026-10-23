import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, getSessionMock, service } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    getSessionMock: vi.fn(),
    service: { addLink: vi.fn() },
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/server/session', () => ({ getSession: getSessionMock }));

import { POST } from './route';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import {
  DealCompanyNotFoundError,
  InvalidDealContactRoleError,
} from '@/lib/services/dealContactService';

const params = { params: Promise.resolve({ id: 'c1' }) };

function post(body: unknown) {
  return new NextRequest('http://localhost/api/crm/correspondents/c1/deals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({ db: true });
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  getSessionMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  service.addLink.mockReset();
  createContainerMock.mockReset().mockReturnValue({ dealContactService: service });
});

describe('POST /api/crm/correspondents/[id]/deals', () => {
  it('adds a manual link as the session user', async () => {
    const data = { companyId: 'co1', correspondentId: 'c1', role: 'source', origin: 'manual', status: 'active' };
    service.addLink.mockResolvedValueOnce(data);

    const res = await POST(post({ companyId: 'co1', role: 'source' }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(service.addLink).toHaveBeenCalledWith('c1', 'co1', 'source', 'u1');
  });

  it('returns 400 without a companyId', async () => {
    const res = await POST(post({ role: 'source' }), params);
    expect(res.status).toBe(400);
    expect(service.addLink).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid role', async () => {
    service.addLink.mockRejectedValueOnce(new InvalidDealContactRoleError('x'));
    const res = await POST(post({ companyId: 'co1', role: 'x' }), params);
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown contact or company', async () => {
    service.addLink.mockRejectedValueOnce(new ContactNotFoundError('c1'));
    expect((await POST(post({ companyId: 'co1', role: 'source' }), params)).status).toBe(404);
    service.addLink.mockRejectedValueOnce(new DealCompanyNotFoundError('co1'));
    expect((await POST(post({ companyId: 'co1', role: 'source' }), params)).status).toBe(404);
  });
});
