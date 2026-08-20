import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listEventsMock,
  createEventMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listEventsMock: vi.fn(),
  createEventMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET, POST } from './route';
import {
  FundCommitmentEventScopeError,
  CommitmentNegativeBalanceError,
  InvalidCommitmentEventError,
} from '@/lib/services/fundCommitmentEventService';

function makeGetRequest(url: string): never {
  return { url } as never;
}

function makePostRequest(body: unknown): never {
  return { json: async () => body } as never;
}

describe('/api/commitment-events route', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('workspace-1');
    listEventsMock.mockReset();
    createEventMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      fundCommitmentEventService: {
        listEvents: listEventsMock,
        createEvent: createEventMock,
      },
    });
  });

  describe('GET', () => {
    it('returns commitment events list', async () => {
      const mockEvents = [{ id: 'e1', amount: 100, runningBalance: 100 }];
      listEventsMock.mockResolvedValueOnce(mockEvents);

      const res = await GET(makeGetRequest('http://localhost/api/commitment-events?fundId=f1'));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toEqual(mockEvents);
      expect(listEventsMock).toHaveBeenCalledWith({ fundId: 'f1', holdingEntityId: undefined });
    });

    it('returns 500 when listing fails', async () => {
      listEventsMock.mockRejectedValueOnce(new Error('DB failure'));

      const res = await GET(makeGetRequest('http://localhost/api/commitment-events'));
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.error).toBe('DB failure');
    });
  });

  describe('POST', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await POST(makePostRequest({ fundId: 'f1' }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('required');
      expect(createEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 when eventType is invalid enum value', async () => {
      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'not_a_valid_type',
          amount: 100,
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('Invalid event type');
      expect(createEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 when attempting to create transfer_in or transfer_out via generic POST', async () => {
      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'transfer_in',
          amount: 100,
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('POST /api/commitment-events/transfer');
      expect(createEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 when caller supplies transferGroupId', async () => {
      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'additional_commitment',
          amount: 100,
          transferGroupId: 'forged-group',
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('Caller-supplied transferGroupId');
      expect(createEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 when amount is not positive', async () => {
      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'initial_commitment',
          amount: -50,
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('positive');
      expect(createEventMock).not.toHaveBeenCalled();
    });

    it('returns 201 on successful event creation', async () => {
      const created = { id: 'e1', amount: 100 };
      createEventMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'initial_commitment',
          amount: 100,
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.data).toEqual(created);
    });

    it('returns 400 when currency mismatch occurs', async () => {
      createEventMock.mockRejectedValueOnce(
        new InvalidCommitmentEventError('Currency mismatch: ledger is in USD, but got EUR'),
      );

      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'additional_commitment',
          amount: 100,
          currency: 'EUR',
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toContain('Currency mismatch');
    });

    it('returns 400 when scope error occurs', async () => {
      createEventMock.mockRejectedValueOnce(new FundCommitmentEventScopeError('Fund not found'));

      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'initial_commitment',
          amount: 100,
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Fund not found');
    });

    it('returns 400 when negative balance error occurs', async () => {
      createEventMock.mockRejectedValueOnce(
        new CommitmentNegativeBalanceError('Balance would be negative'),
      );

      const res = await POST(
        makePostRequest({
          fundId: 'f1',
          holdingEntityId: 'h1',
          effectiveDate: '2026-01-01',
          eventType: 'reduction',
          amount: 100,
        }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('Balance would be negative');
    });
  });
});
