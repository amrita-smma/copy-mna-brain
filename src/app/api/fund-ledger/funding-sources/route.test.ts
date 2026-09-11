import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidCurrencyError, WorkspaceMismatchError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listFundingSourcesMock,
  createFundingSourceMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listFundingSourcesMock: vi.fn(),
  createFundingSourceMock: vi.fn(),
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

import { GET, POST } from './route';

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/api/fund-ledger/funding-sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET & POST /api/fund-ledger/funding-sources', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listFundingSourcesMock.mockReset();
    createFundingSourceMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        listFundingSources: listFundingSourcesMock,
        createFundingSource: createFundingSourceMock,
      },
    });
  });

  describe('GET', () => {
    it('returns funding sources list on success', async () => {
      const mockSources = [{ id: 'fs-1', name: 'Primary Bank Account', currency: 'USD' }];
      listFundingSourcesMock.mockResolvedValueOnce(mockSources);

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockSources });
      expect(createDbMock).toHaveBeenCalled();
      expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
      expect(listFundingSourcesMock).toHaveBeenCalledWith('ws-1');
    });

    it('returns 500 on unexpected service failure', async () => {
      listFundingSourcesMock.mockRejectedValueOnce(new Error('Failed to list funding sources'));

      const res = await GET();
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: 'Failed to list funding sources' });
    });
  });

  describe('POST', () => {
    it('creates funding source, passes field-by-field, and omits caller-supplied id', async () => {
      const created = { id: 'fs-123', name: 'Primary Bank', currency: 'USD' };
      createFundingSourceMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          id: 'caller-id-omitted',
          workspace_id: 'caller-ws-omitted',
          business_event_id: 'caller-event-omitted',
          is_reversal: true,
          created_by: 'caller-user-omitted',
          updated_by: 'caller-user-omitted',
          name: 'Primary Bank',
          source_type: 'bank_account',
          owner_investor_id: 'inv-1',
          currency: 'USD',
        }) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: created });
      expect(createFundingSourceMock).toHaveBeenCalledWith('ws-1', {
        name: 'Primary Bank',
        source_type: 'bank_account',
        owner_investor_id: 'inv-1',
        currency: 'USD',
      });
      expect(createFundingSourceMock.mock.calls[0][1]).not.toHaveProperty('id');
      expect(createFundingSourceMock.mock.calls[0][1]).not.toHaveProperty('workspace_id');
      expect(createFundingSourceMock.mock.calls[0][1]).not.toHaveProperty('business_event_id');
      expect(createFundingSourceMock.mock.calls[0][1]).not.toHaveProperty('is_reversal');
      expect(createFundingSourceMock.mock.calls[0][1]).not.toHaveProperty('created_by');
      expect(createFundingSourceMock.mock.calls[0][1]).not.toHaveProperty('updated_by');
    });

    it('returns 422 with error_name on WorkspaceMismatchError', async () => {
      createFundingSourceMock.mockRejectedValueOnce(
        new WorkspaceMismatchError('Owner investor inv-1 does not exist in workspace ws-1'),
      );

      const res = await POST(
        makePostRequest({
          name: 'Primary Bank',
          owner_investor_id: 'inv-1',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Owner investor inv-1 does not exist in workspace ws-1');
      expect(json.error_name).toBe('WorkspaceMismatchError');
    });

    it('returns 422 with error_name on InvalidCurrencyError', async () => {
      createFundingSourceMock.mockRejectedValueOnce(
        new InvalidCurrencyError('Invalid currency: XYZ'),
      );

      const res = await POST(
        makePostRequest({
          name: 'Primary Bank',
          currency: 'XYZ',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Invalid currency: XYZ');
      expect(json.error_name).toBe('InvalidCurrencyError');
    });

    it('returns 500 on unexpected throw', async () => {
      createFundingSourceMock.mockRejectedValueOnce(new Error('Unexpected write failure'));

      const res = await POST(
        makePostRequest({
          name: 'Primary Bank',
        }) as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Unexpected write failure');
    });
  });
});
