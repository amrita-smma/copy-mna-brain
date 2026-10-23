import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, authMock, service } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    authMock: vi.fn(),
    service: { setPrimaryContact: vi.fn() },
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/auth', () => ({ auth: authMock }));

import { PUT } from './route';
import { CorrespondentNotFoundError } from '@/lib/services/crmService';

const params = { params: Promise.resolve({ id: 'e1' }) };

function put(body: unknown) {
  return new NextRequest('http://localhost/api/crm/employers/e1/primary-contact', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({ db: true });
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  service.setPrimaryContact.mockReset().mockResolvedValue(undefined);
  createContainerMock.mockReset().mockReturnValue({ crmService: service });
});

describe('PUT /api/crm/employers/[id]/primary-contact', () => {
  it("records the workspace's pick as the signed-in user", async () => {
    const res = await PUT(put({ correspondent_id: 'c2' }), params);
    expect(res.status).toBe(200);
    expect(service.setPrimaryContact).toHaveBeenCalledWith('e1', 'c2', 'u1');
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
  });

  it('accepts null to go back to the default PIC', async () => {
    const res = await PUT(put({ correspondent_id: null }), params);
    expect(res.status).toBe(200);
    expect(service.setPrimaryContact).toHaveBeenCalledWith('e1', null, 'u1');
  });

  it('returns 400 for a missing or non-string id', async () => {
    expect((await PUT(put({}), params)).status).toBe(400);
    expect((await PUT(put({ correspondent_id: 42 }), params)).status).toBe(400);
    expect(service.setPrimaryContact).not.toHaveBeenCalled();
  });

  it('returns 404 when the contact is not visible here or not at this firm', async () => {
    service.setPrimaryContact.mockRejectedValueOnce(new CorrespondentNotFoundError('c2'));
    const res = await PUT(put({ correspondent_id: 'c2' }), params);
    expect(res.status).toBe(404);
  });
});
