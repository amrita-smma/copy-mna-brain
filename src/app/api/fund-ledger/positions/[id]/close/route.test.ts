import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityNotFoundError, PositionNotSettledError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  closePositionMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  closePositionMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';

function makePostRequest(body?: unknown): Request {
  return new Request('http://localhost/api/fund-ledger/positions/pos-123/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const PARAMS = Promise.resolve({ id: 'pos-123' });

describe('POST /api/fund-ledger/positions/[id]/close', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    closePositionMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flPositionService: {
        closePosition: closePositionMock,
      },
    });
  });

  it('closes position on success with awaited params', async () => {
    const closed = { id: 'pos-123', status: 'closed', closed_at: '2026-06-01' };
    closePositionMock.mockResolvedValueOnce(closed);

    const res = await POST(
      makePostRequest({ closed_at: '2026-06-01' }) as never,
      { params: PARAMS },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: closed });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(closePositionMock).toHaveBeenCalledWith('ws-1', 'pos-123', '2026-06-01');
  });

  it('handles empty body gracefully', async () => {
    const closed = { id: 'pos-123', status: 'closed', closed_at: '2026-08-23' };
    closePositionMock.mockResolvedValueOnce(closed);

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(200);
    expect(closePositionMock).toHaveBeenCalledWith('ws-1', 'pos-123', undefined);
  });

  it('returns 422 with error_name on PositionNotSettledError', async () => {
    closePositionMock.mockRejectedValueOnce(
      new PositionNotSettledError('Position pos-123 has nonzero remaining quantity (10.00000000)'),
    );

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('nonzero remaining quantity');
    expect(json.error_name).toBe('PositionNotSettledError');
  });

  it('returns 422 with error_name on EntityNotFoundError', async () => {
    closePositionMock.mockRejectedValueOnce(
      new EntityNotFoundError('Position pos-123 not found in workspace ws-1'),
    );

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Position pos-123 not found');
    expect(json.error_name).toBe('EntityNotFoundError');
  });

  it('returns 500 on unexpected throw', async () => {
    closePositionMock.mockRejectedValueOnce(new Error('Unexpected DB error'));

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Unexpected DB error');
  });
});
