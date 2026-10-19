import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityNotFoundError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  reopenPositionMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  reopenPositionMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';

function makePostRequest(): Request {
  return new Request('http://localhost/api/fund-ledger/positions/pos-123/reopen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

const PARAMS = Promise.resolve({ id: 'pos-123' });

describe('POST /api/fund-ledger/positions/[id]/reopen', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    reopenPositionMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flPositionService: {
        reopenPosition: reopenPositionMock,
      },
    });
  });

  it('reopens position on success with awaited params', async () => {
    const reopened = { id: 'pos-123', status: 'open', closed_at: null };
    reopenPositionMock.mockResolvedValueOnce(reopened);

    const res = await POST(
      makePostRequest() as never,
      { params: PARAMS },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: reopened });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(reopenPositionMock).toHaveBeenCalledWith('ws-1', 'pos-123');
  });

  it('returns 422 with error_name on EntityNotFoundError', async () => {
    reopenPositionMock.mockRejectedValueOnce(
      new EntityNotFoundError('Position pos-123 not found in workspace ws-1'),
    );

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Position pos-123 not found');
    expect(json.error_name).toBe('EntityNotFoundError');
  });

  it('returns 500 on unexpected throw', async () => {
    reopenPositionMock.mockRejectedValueOnce(new Error('Unexpected DB error'));

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Unexpected DB error');
  });
});
