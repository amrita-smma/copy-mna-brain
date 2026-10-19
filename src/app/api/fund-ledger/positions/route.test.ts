import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DuplicatePositionError,
  InvalidPositionShapeError,
  WorkspaceMismatchError,
} from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listPositionsMock,
  openPositionMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listPositionsMock: vi.fn(),
  openPositionMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

function makeGetRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/api/fund-ledger/positions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET & POST /api/fund-ledger/positions', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listPositionsMock.mockReset();
    openPositionMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flPositionService: {
        listPositions: listPositionsMock,
        openPosition: openPositionMock,
      },
    });
  });

  describe('GET', () => {
    it('returns filtered positions with omitted params parsed as undefined', async () => {
      const mockPositions = [{ id: 'pos-1', fund_id: 'fund-1', status: 'open' }];
      listPositionsMock.mockResolvedValueOnce(mockPositions);

      const res = await GET(
        makeGetRequest('http://localhost/api/fund-ledger/positions?fundId=fund-1&holderInvestorId=inv-1') as never,
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockPositions });
      expect(listPositionsMock).toHaveBeenCalledWith('ws-1', {
        fundId: 'fund-1',
        holderInvestorId: 'inv-1',
        holderFundId: undefined,
        assetId: undefined,
        holderSourceOfFundId: undefined,
      });
    });

    it('implements tri-state literal "null" parsing for holderSourceOfFundId', async () => {
      const mockPositions = [{ id: 'pos-2', fund_id: 'fund-1', holder_source_of_fund_id: null, status: 'open' }];
      listPositionsMock.mockResolvedValueOnce(mockPositions);

      const res = await GET(
        makeGetRequest('http://localhost/api/fund-ledger/positions?fundId=fund-1&holderSourceOfFundId=null') as never,
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockPositions });
      expect(listPositionsMock).toHaveBeenCalledWith('ws-1', {
        fundId: 'fund-1',
        holderInvestorId: undefined,
        holderFundId: undefined,
        assetId: undefined,
        holderSourceOfFundId: null,
      });
    });

    it('implements tri-state UUID parsing for holderSourceOfFundId', async () => {
      const mockPositions = [{ id: 'pos-3', fund_id: 'fund-1', holder_source_of_fund_id: 'fs-1', status: 'open' }];
      listPositionsMock.mockResolvedValueOnce(mockPositions);

      const res = await GET(
        makeGetRequest('http://localhost/api/fund-ledger/positions?fundId=fund-1&holderSourceOfFundId=fs-1') as never,
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockPositions });
      expect(listPositionsMock).toHaveBeenCalledWith('ws-1', {
        fundId: 'fund-1',
        holderInvestorId: undefined,
        holderFundId: undefined,
        assetId: undefined,
        holderSourceOfFundId: 'fs-1',
      });
    });

    it('returns 500 on unexpected failure', async () => {
      listPositionsMock.mockRejectedValueOnce(new Error('DB failure'));

      const res = await GET(
        makeGetRequest('http://localhost/api/fund-ledger/positions') as never,
      );
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: 'DB failure' });
    });
  });

  describe('POST', () => {
    it('opens position, passes field-by-field including holder_source_of_fund_id, and omits caller-supplied id', async () => {
      const created = { id: 'pos-123', holder_investor_id: 'inv-1', fund_id: 'fund-1', holder_source_of_fund_id: 'fs-1', status: 'open' };
      openPositionMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          id: 'caller-id-omitted',
          workspace_id: 'caller-ws-omitted',
          business_event_id: 'caller-event-omitted',
          is_reversal: true,
          created_by: 'caller-user-omitted',
          updated_by: 'caller-user-omitted',
          holder_investor_id: 'inv-1',
          holder_fund_id: null,
          fund_id: 'fund-1',
          asset_id: null,
          holder_source_of_fund_id: 'fs-1',
          opened_at: '2026-01-01',
          notes: 'LP commitment position',
        }) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: created });
      expect(openPositionMock).toHaveBeenCalledWith('ws-1', {
        holder_investor_id: 'inv-1',
        holder_fund_id: null,
        fund_id: 'fund-1',
        asset_id: null,
        holder_source_of_fund_id: 'fs-1',
        opened_at: '2026-01-01',
        notes: 'LP commitment position',
      });
      expect(openPositionMock.mock.calls[0][1]).not.toHaveProperty('id');
      expect(openPositionMock.mock.calls[0][1]).not.toHaveProperty('workspace_id');
      expect(openPositionMock.mock.calls[0][1]).not.toHaveProperty('business_event_id');
      expect(openPositionMock.mock.calls[0][1]).not.toHaveProperty('is_reversal');
      expect(openPositionMock.mock.calls[0][1]).not.toHaveProperty('created_by');
      expect(openPositionMock.mock.calls[0][1]).not.toHaveProperty('updated_by');
    });

    it('returns 422 with error_name on AllocationSourceMismatchError', async () => {
      const err = new Error('Explicit allocation source does not match position source');
      err.name = 'AllocationSourceMismatchError';
      openPositionMock.mockRejectedValueOnce(err);

      const res = await POST(
        makePostRequest({
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Explicit allocation source does not match position source');
      expect(json.error_name).toBe('AllocationSourceMismatchError');
    });

    it('returns 422 with error_name on InvalidPositionShapeError', async () => {
      openPositionMock.mockRejectedValueOnce(
        new InvalidPositionShapeError('Position must have exactly one holder'),
      );

      const res = await POST(
        makePostRequest({
          fund_id: 'fund-1',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Position must have exactly one holder');
      expect(json.error_name).toBe('InvalidPositionShapeError');
    });

    it('returns 422 with error_name on DuplicatePositionError', async () => {
      openPositionMock.mockRejectedValueOnce(
        new DuplicatePositionError('Position already exists'),
      );

      const res = await POST(
        makePostRequest({
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Position already exists');
      expect(json.error_name).toBe('DuplicatePositionError');
    });

    it('returns 422 with error_name on WorkspaceMismatchError', async () => {
      openPositionMock.mockRejectedValueOnce(
        new WorkspaceMismatchError('Holder investor not in workspace'),
      );

      const res = await POST(
        makePostRequest({
          holder_investor_id: 'inv-other',
          fund_id: 'fund-1',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Holder investor not in workspace');
      expect(json.error_name).toBe('WorkspaceMismatchError');
    });

    it('returns 500 on unexpected throw', async () => {
      openPositionMock.mockRejectedValueOnce(new Error('Server crash'));

      const res = await POST(
        makePostRequest({
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
        }) as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Server crash');
    });
  });
});
