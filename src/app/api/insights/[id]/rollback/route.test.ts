import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { rollbackMock } = vi.hoisted(() => ({ rollbackMock: vi.fn() }));

vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-test-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({ insightService: { rollback: rollbackMock } })),
}));

import { POST } from './route';

const params = () => ({ params: Promise.resolve({ id: 'insight-1' }) });
const post = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/insights/insight-1/rollback', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    params(),
  );

beforeEach(() => {
  rollbackMock.mockReset();
});

describe('POST /api/insights/[id]/rollback', () => {
  it('rolls back to an integer version for the session user', async () => {
    rollbackMock.mockResolvedValueOnce({ id: 'insight-1', latest_version_no: 4 });

    const res = await post({ toVersionNo: 2 });

    expect(res.status).toBe(200);
    expect(rollbackMock).toHaveBeenCalledWith({
      workspaceId: 'ws-test-1',
      insightId: 'insight-1',
      toVersionNo: 2,
      userId: 'u1',
    });
  });

  it.each([
    ['a fractional version', { toVersionNo: 1.5 }],
    ['version 0', { toVersionNo: 0 }],
    ['a missing version', {}],
    ['a JSON null body', null],
  ])('returns 400 for %s without calling the service', async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(rollbackMock).not.toHaveBeenCalled();
  });
});
