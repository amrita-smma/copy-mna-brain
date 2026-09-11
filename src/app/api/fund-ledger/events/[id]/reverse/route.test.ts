import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CannotReverseReversalError,
  EntityNotFoundError,
  EventAlreadyReversedError,
} from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  reverseEventMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  reverseEventMock: vi.fn(),
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
  return new Request('http://localhost/api/fund-ledger/events/evt-1/reverse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const PARAMS = Promise.resolve({ id: 'evt-1' });

describe('POST /api/fund-ledger/events/[id]/reverse', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    reverseEventMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flLedgerService: {
        reverseEvent: reverseEventMock,
      },
    });
  });

  it('reverses event on success with awaited params and omits business_event_id', async () => {
    const result = {
      event: { id: 'evt-reversal', reversal_of_event_id: 'evt-1', status: 'posted' },
      entries: [{ id: 'ent-rev-1', is_reversal: true }],
      allocations: [],
    };
    reverseEventMock.mockResolvedValueOnce(result);

    const res = await POST(
      makePostRequest({
        business_event_id: 'caller-supplied-rev-id',
        description: 'Reversing erroneous event',
        event_date: '2026-01-02',
      }) as never,
      { params: PARAMS },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ data: result });
    expect(createDbMock).toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
    expect(reverseEventMock).toHaveBeenCalledWith('ws-1', 'evt-1', {
      description: 'Reversing erroneous event',
      event_date: '2026-01-02',
    });
    expect(reverseEventMock.mock.calls[0][2]).not.toHaveProperty('business_event_id');
  });

  it('handles empty body gracefully', async () => {
    const result = {
      event: { id: 'evt-reversal', reversal_of_event_id: 'evt-1', status: 'posted' },
      entries: [],
      allocations: [],
    };
    reverseEventMock.mockResolvedValueOnce(result);

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(200);
    expect(reverseEventMock).toHaveBeenCalledWith('ws-1', 'evt-1', {
      description: undefined,
      event_date: undefined,
    });
  });

  it('returns 422 with error_name on EventAlreadyReversedError', async () => {
    reverseEventMock.mockRejectedValueOnce(
      new EventAlreadyReversedError('Event evt-1 has already been reversed'),
    );

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      error: 'Event evt-1 has already been reversed',
      error_name: 'EventAlreadyReversedError',
    });
  });

  it('returns 422 with error_name on CannotReverseReversalError', async () => {
    reverseEventMock.mockRejectedValueOnce(
      new CannotReverseReversalError('Cannot reverse event evt-1 because it is already a reversal'),
    );

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      error: 'Cannot reverse event evt-1 because it is already a reversal',
      error_name: 'CannotReverseReversalError',
    });
  });

  it('returns 422 with error_name on EntityNotFoundError', async () => {
    reverseEventMock.mockRejectedValueOnce(
      new EntityNotFoundError('Business event evt-1 not found in workspace ws-1'),
    );

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({
      error: 'Business event evt-1 not found in workspace ws-1',
      error_name: 'EntityNotFoundError',
    });
  });

  it('returns 500 on unexpected throw', async () => {
    reverseEventMock.mockRejectedValueOnce(new Error('Transaction timeout'));

    const res = await POST(makePostRequest() as never, { params: PARAMS });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Transaction timeout' });
  });
});
