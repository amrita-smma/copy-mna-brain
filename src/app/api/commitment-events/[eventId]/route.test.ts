import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getEventMock,
  updateEventMock,
  deleteEventMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getEventMock: vi.fn(),
  updateEventMock: vi.fn(),
  deleteEventMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET, PATCH, DELETE } from './route';
import {
  FundCommitmentEventNotFoundError,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
} from '@/lib/services/fundCommitmentEventService';

function makePatchRequest(body: unknown): never {
  return { json: async () => body } as never;
}

describe('/api/commitment-events/[eventId] route', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('workspace-1');
    getEventMock.mockReset();
    updateEventMock.mockReset();
    deleteEventMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      fundCommitmentEventService: {
        getEvent: getEventMock,
        updateEvent: updateEventMock,
        deleteEvent: deleteEventMock,
      },
    });
  });

  describe('GET', () => {
    it('returns event data when found', async () => {
      const event = { id: 'e1', amount: 100 };
      getEventMock.mockResolvedValueOnce(event);

      const res = await GET({} as never, { params: Promise.resolve({ eventId: 'e1' }) });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toEqual(event);
    });

    it('returns 404 when event not found', async () => {
      getEventMock.mockRejectedValueOnce(new FundCommitmentEventNotFoundError('e1'));

      const res = await GET({} as never, { params: Promise.resolve({ eventId: 'e1' }) });
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.error).toContain('not found');
    });
  });

  describe('PATCH', () => {
    it('updates event data and returns updated event', async () => {
      const updated = { id: 'e1', amount: 120 };
      updateEventMock.mockResolvedValueOnce(updated);

      const res = await PATCH(makePatchRequest({ amount: 120 }), {
        params: Promise.resolve({ eventId: 'e1' }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toEqual(updated);
    });

    it('returns 400 when eventType is invalid enum value', async () => {
      const res = await PATCH(makePatchRequest({ eventType: 'invalid_enum' }), {
        params: Promise.resolve({ eventId: 'e1' }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('Invalid event type');
    });

    it('returns 400 when amount is invalid', async () => {
      const res = await PATCH(makePatchRequest({ amount: -10 }), {
        params: Promise.resolve({ eventId: 'e1' }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('positive');
    });

    it('returns 400 when attempting invalid transfer modification', async () => {
      updateEventMock.mockRejectedValueOnce(
        new InvalidCommitmentEventError('Cannot change event type of a transfer event'),
      );

      const res = await PATCH(makePatchRequest({ eventType: 'reduction' }), {
        params: Promise.resolve({ eventId: 'e1' }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('transfer event');
    });

    it('returns 400 when balance becomes negative', async () => {
      updateEventMock.mockRejectedValueOnce(
        new CommitmentNegativeBalanceError('Balance would be negative'),
      );

      const res = await PATCH(makePatchRequest({ amount: 10 }), {
        params: Promise.resolve({ eventId: 'e1' }),
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Balance would be negative');
    });
  });

  describe('DELETE', () => {
    it('deletes event and returns success', async () => {
      deleteEventMock.mockResolvedValueOnce(undefined);

      const res = await DELETE({} as never, { params: Promise.resolve({ eventId: 'e1' }) });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toEqual({ success: true });
    });

    it('returns 404 when deleting nonexistent event', async () => {
      deleteEventMock.mockRejectedValueOnce(new FundCommitmentEventNotFoundError('e1'));

      const res = await DELETE({} as never, { params: Promise.resolve({ eventId: 'e1' }) });
      const json = await res.json();

      expect(res.status).toBe(404);
    });
  });
});
