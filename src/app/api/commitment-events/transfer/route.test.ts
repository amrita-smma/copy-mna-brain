import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  createTransferMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  createTransferMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import {
  FundCommitmentEventScopeError,
  CommitmentNegativeBalanceError,
} from '@/lib/services/fundCommitmentEventService';

function makePostRequest(body: unknown): never {
  return { json: async () => body } as never;
}

describe('/api/commitment-events/transfer route', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('workspace-1');
    createTransferMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      fundCommitmentEventService: {
        createTransfer: createTransferMock,
      },
    });
  });

  it('returns 400 when missing required transfer fields', async () => {
    const res = await POST(makePostRequest({ fundId: 'f1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('required');
    expect(createTransferMock).not.toHaveBeenCalled();
  });

  it('returns 400 when from and to entity are the same', async () => {
    const res = await POST(
      makePostRequest({
        fundId: 'f1',
        fromHoldingEntityId: 'h1',
        toHoldingEntityId: 'h1',
        effectiveDate: '2026-01-01',
        amount: 50,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('different');
    expect(createTransferMock).not.toHaveBeenCalled();
  });

  it('returns 201 on successful transfer creation', async () => {
    const payload = {
      transferGroupId: 'tg-1',
      fromEvent: { id: 'e1', amount: 25 },
      toEvent: { id: 'e2', amount: 25 },
    };
    createTransferMock.mockResolvedValueOnce(payload);

    const res = await POST(
      makePostRequest({
        fundId: 'f1',
        fromHoldingEntityId: 'seller',
        toHoldingEntityId: 'buyer',
        effectiveDate: '2026-01-01',
        amount: 25,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data).toEqual(payload);
  });

  it('returns 400 on seller negative balance error', async () => {
    createTransferMock.mockRejectedValueOnce(
      new CommitmentNegativeBalanceError('Seller balance would be negative'),
    );

    const res = await POST(
      makePostRequest({
        fundId: 'f1',
        fromHoldingEntityId: 'seller',
        toHoldingEntityId: 'buyer',
        effectiveDate: '2026-01-01',
        amount: 25,
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Seller balance would be negative');
  });
});
