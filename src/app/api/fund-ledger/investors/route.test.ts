import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMismatchError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listInvestorsMock,
  createInvestorMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listInvestorsMock: vi.fn(),
  createInvestorMock: vi.fn(),
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
  return new Request('http://localhost/api/fund-ledger/investors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET & POST /api/fund-ledger/investors', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listInvestorsMock.mockReset();
    createInvestorMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        listInvestors: listInvestorsMock,
        createInvestor: createInvestorMock,
      },
    });
  });

  describe('GET', () => {
    it('returns investors list on success', async () => {
      const mockInvestors = [{ id: 'inv-1', name: 'LP One', investor_type: 'institution' }];
      listInvestorsMock.mockResolvedValueOnce(mockInvestors);

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockInvestors });
      expect(createDbMock).toHaveBeenCalled();
      expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
      expect(listInvestorsMock).toHaveBeenCalledWith('ws-1');
    });

    it('returns 500 on unexpected service failure', async () => {
      listInvestorsMock.mockRejectedValueOnce(new Error('Unexpected DB outage'));

      const res = await GET();
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: 'Unexpected DB outage' });
    });
  });

  describe('POST', () => {
    it('creates investor, passes field-by-field, and omits caller-supplied id', async () => {
      const created = { id: 'auto-generated-id', name: 'LP One', investor_type: 'individual' };
      createInvestorMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          id: 'caller-supplied-id-to-omit',
          workspace_id: 'caller-ws-omitted',
          business_event_id: 'caller-event-omitted',
          is_reversal: true,
          created_by: 'caller-user-omitted',
          updated_by: 'caller-user-omitted',
          name: 'LP One',
          legal_name: 'LP One LLC',
          investor_type: 'individual',
          country: 'USA',
          parent_investor_id: null,
          notes: 'Important investor',
        }) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: created });
      expect(createInvestorMock).toHaveBeenCalledWith('ws-1', {
        name: 'LP One',
        legal_name: 'LP One LLC',
        english_name: null,
        investor_type: 'individual',
        country: 'USA',
        parent_investor_id: null,
        notes: 'Important investor',
      });
      // Ensure caller-supplied internal IDs and audit fields were not passed
      expect(createInvestorMock.mock.calls[0][1]).not.toHaveProperty('id');
      expect(createInvestorMock.mock.calls[0][1]).not.toHaveProperty('workspace_id');
      expect(createInvestorMock.mock.calls[0][1]).not.toHaveProperty('business_event_id');
      expect(createInvestorMock.mock.calls[0][1]).not.toHaveProperty('is_reversal');
      expect(createInvestorMock.mock.calls[0][1]).not.toHaveProperty('created_by');
      expect(createInvestorMock.mock.calls[0][1]).not.toHaveProperty('updated_by');
    });

    it('returns 422 with error_name on typed domain error', async () => {
      createInvestorMock.mockRejectedValueOnce(
        new WorkspaceMismatchError('Parent investor parent-1 does not exist in workspace ws-1'),
      );

      const res = await POST(
        makePostRequest({
          name: 'LP Two',
          investor_type: 'individual',
          parent_investor_id: 'parent-1',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Parent investor parent-1 does not exist in workspace ws-1');
      expect(json.error_name).toBe('WorkspaceMismatchError');
    });

    it('returns 500 on unexpected throw', async () => {
      createInvestorMock.mockRejectedValueOnce(new Error('Connection terminated'));

      const res = await POST(
        makePostRequest({
          name: 'LP Three',
          investor_type: 'institution',
        }) as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Connection terminated');
    });
  });
});
