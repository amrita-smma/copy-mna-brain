import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EntityNotFoundError,
  InvalidPositionShapeError,
  PositionNotSettledError,
} from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  closePositionsMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  closePositionsMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services')>();
  return {
    ...actual,
    createContainer: createContainerMock,
  };
});

import { POST } from './route';

function makePostRequest(body?: unknown): Request {
  return new Request('http://localhost/api/fund-ledger/positions/batch-close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/fund-ledger/positions/batch-close', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    closePositionsMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flPositionService: {
        closePositions: closePositionsMock,
      },
    });
  });

  it('closes positions on success with array of position_ids and closed_at', async () => {
    const closed = [
      { id: 'pos-1', status: 'closed', closed_at: '2026-06-01' },
      { id: 'pos-2', status: 'closed', closed_at: '2026-06-01' },
    ];
    closePositionsMock.mockResolvedValueOnce(closed);

    const res = await POST(
      makePostRequest({
        position_ids: ['pos-1', 'pos-2'],
        closed_at: '2026-06-01',
      }) as never,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: closed });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(closePositionsMock).toHaveBeenCalledWith(
      'ws-1',
      ['pos-1', 'pos-2'],
      '2026-06-01',
    );
  });

  it('rejects missing position_ids field with 422 InvalidPositionShapeError', async () => {
    const res = await POST(
      makePostRequest({ closed_at: '2026-06-01' }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(json.error).toContain('Missing required field: position_ids');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('rejects empty position_ids array with 422 InvalidPositionShapeError', async () => {
    const res = await POST(
      makePostRequest({ position_ids: [] }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(json.error).toContain('non-empty array');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('rejects non-array position_ids with 422 InvalidPositionShapeError', async () => {
    const res = await POST(
      makePostRequest({ position_ids: 'pos-1' }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('rejects non-string or whitespace-only elements in position_ids with 422', async () => {
    const res = await POST(
      makePostRequest({ position_ids: ['pos-1', 123] }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(json.error).toContain('non-empty string IDs');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate position IDs in position_ids with 422', async () => {
    const res = await POST(
      makePostRequest({ position_ids: ['pos-1', 'pos-1'] }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(json.error).toContain('Duplicate position ID');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('rejects non-string closed_at with 422', async () => {
    const res = await POST(
      makePostRequest({ position_ids: ['pos-1'], closed_at: 12345 }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(json.error).toContain('closed_at must be a string');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('rejects malformed / empty body with 422', async () => {
    const res = await POST(makePostRequest() as never);

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error_name).toBe('InvalidPositionShapeError');
    expect(closePositionsMock).not.toHaveBeenCalled();
  });

  it('returns 422 with error_name on PositionNotSettledError (atomic rejection)', async () => {
    closePositionsMock.mockRejectedValueOnce(
      new PositionNotSettledError(
        'Position pos-2 has nonzero remaining quantity (10.00000000)',
      ),
    );

    const res = await POST(
      makePostRequest({ position_ids: ['pos-1', 'pos-2'] }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('nonzero remaining quantity');
    expect(json.error_name).toBe('PositionNotSettledError');
  });

  it('returns 422 with error_name on EntityNotFoundError when position not found', async () => {
    closePositionsMock.mockRejectedValueOnce(
      new EntityNotFoundError('Position pos-missing not found in workspace ws-1'),
    );

    const res = await POST(
      makePostRequest({ position_ids: ['pos-missing'] }) as never,
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain('Position pos-missing not found');
    expect(json.error_name).toBe('EntityNotFoundError');
  });

  it('returns 500 on unexpected throw', async () => {
    closePositionsMock.mockRejectedValueOnce(new Error('Unexpected DB error'));

    const res = await POST(
      makePostRequest({ position_ids: ['pos-1'] }) as never,
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Unexpected DB error');
  });
});
