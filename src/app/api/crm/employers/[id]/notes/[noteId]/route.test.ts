import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, authMock, service } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    authMock: vi.fn(),
    service: { updateNote: vi.fn(), deleteNote: vi.fn() },
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/auth', () => ({ auth: authMock }));

import { DELETE, PATCH } from './route';
import { EmployerNoteNotFoundError } from '@/lib/services/crmService';

const params = { params: Promise.resolve({ id: 'e1', noteId: 'n1' }) };
const url = 'http://localhost/api/crm/employers/e1/notes/n1';

function patch(body: unknown) {
  return new NextRequest(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({ db: true });
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  service.updateNote.mockReset();
  service.deleteNote.mockReset().mockResolvedValue(undefined);
  createContainerMock.mockReset().mockReturnValue({ crmService: service });
});

describe('PATCH /api/crm/employers/[id]/notes/[noteId]', () => {
  it('edits the note as the signed-in user', async () => {
    service.updateNote.mockResolvedValueOnce({ id: 'n1', content: 'new' });
    const res = await PATCH(patch({ content: 'new' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'n1', content: 'new' } });
    expect(service.updateNote).toHaveBeenCalledWith('n1', 'new', 'u1');
  });

  it('returns 400 for blank content and writes nothing', async () => {
    expect((await PATCH(patch({ content: '   ' }), params)).status).toBe(400);
    expect(service.updateNote).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing or deleted note', async () => {
    service.updateNote.mockRejectedValueOnce(new EmployerNoteNotFoundError('n1'));
    expect((await PATCH(patch({ content: 'x' }), params)).status).toBe(404);
  });
});

describe('DELETE /api/crm/employers/[id]/notes/[noteId]', () => {
  it('soft-deletes the note as the signed-in user', async () => {
    const res = await DELETE(new NextRequest(url, { method: 'DELETE' }), params);
    expect(res.status).toBe(200);
    expect(service.deleteNote).toHaveBeenCalledWith('n1', 'u1');
  });

  it('returns 404 when there is nothing to delete', async () => {
    service.deleteNote.mockRejectedValueOnce(new EmployerNoteNotFoundError('n1'));
    const res = await DELETE(new NextRequest(url, { method: 'DELETE' }), params);
    expect(res.status).toBe(404);
  });
});
