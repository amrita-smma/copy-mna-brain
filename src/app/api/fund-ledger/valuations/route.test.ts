import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidCurrencyError,
  InvalidEntryShapeError,
  InvalidValuationTargetError,
  WorkspaceMismatchError,
} from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  getSeriesMock,
  getLatestForTargetsMock,
  recordMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  getSeriesMock: vi.fn(),
  getLatestForTargetsMock: vi.fn(),
  recordMock: vi.fn(),
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
  return new Request('http://localhost/api/fund-ledger/valuations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET & POST /api/fund-ledger/valuations', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getSeriesMock.mockReset();
    getLatestForTargetsMock.mockReset();
    recordMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flValuationService: {
        getSeries: getSeriesMock,
        getLatestForTargets: getLatestForTargetsMock,
        record: recordMock,
      },
    });
  });

  describe('GET', () => {
    it('returns series when series=true query param is present', async () => {
      const mockSeries = [
        { id: 'val-1', asset_id: 'asset-1', as_of_date: '2025-12-31', market_value: '1000.00000000' },
      ];
      getSeriesMock.mockResolvedValueOnce(mockSeries);

      const res = await GET(
        makeGetRequest('http://localhost/api/fund-ledger/valuations?series=true&assetId=asset-1') as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockSeries });
      expect(createDbMock).toHaveBeenCalled();
      expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
      expect(getSeriesMock).toHaveBeenCalledWith('ws-1', {
        assetId: 'asset-1',
        fundId: undefined,
        positionId: undefined,
      });
    });

    it('returns latest valuations for targets and parses asOf', async () => {
      const mockLatest = {
        assets: [{ id: 'val-1', asset_id: 'asset-1' }],
        funds: [{ id: 'val-2', fund_id: 'fund-1' }],
        positions: [],
      };
      getLatestForTargetsMock.mockResolvedValueOnce(mockLatest);

      const res = await GET(
        makeGetRequest(
          'http://localhost/api/fund-ledger/valuations?assetIds=asset-1,asset-2&fundIds=fund-1&asOf=2026-06-30',
        ) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockLatest });
      expect(getLatestForTargetsMock).toHaveBeenCalledWith(
        'ws-1',
        {
          assetIds: ['asset-1', 'asset-2'],
          fundIds: ['fund-1'],
          positionIds: undefined,
        },
        '2026-06-30',
      );
    });

    it('returns 500 on unexpected failure', async () => {
      getLatestForTargetsMock.mockRejectedValueOnce(new Error('Valuation lookup error'));

      const res = await GET(
        makeGetRequest('http://localhost/api/fund-ledger/valuations') as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: 'Valuation lookup error' });
    });
  });

  describe('POST', () => {
    it('records valuation, forwards string values unchanged, and omits caller-supplied id', async () => {
      const created = { id: 'val-auto-id', asset_id: 'asset-1', market_value: '25000000.00000000' };
      recordMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          id: 'caller-id-omitted',
          workspace_id: 'caller-ws-omitted',
          business_event_id: 'caller-event-omitted',
          is_reversal: true,
          created_by: 'caller-user-omitted',
          updated_by: 'caller-user-omitted',
          asset_id: 'asset-1',
          as_of_date: '2026-06-30',
          valuation_method: 'fundraise_round',
          currency: 'USD',
          market_value: '25000000.00000000',
          price_per_unit: '12.50000000',
          units_outstanding: '2000000.00000000',
          gross_value: '25000000.00000000',
          net_value: '25000000.00000000',
          data_status: 'verified',
          notes: 'Series B valuation',
        }) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: created });
      expect(recordMock).toHaveBeenCalledWith('ws-1', {
        asset_id: 'asset-1',
        fund_id: null,
        position_id: null,
        as_of_date: '2026-06-30',
        valuation_method: 'fundraise_round',
        currency: 'USD',
        market_value: '25000000.00000000',
        price_per_unit: '12.50000000',
        units_outstanding: '2000000.00000000',
        gross_value: '25000000.00000000',
        net_value: '25000000.00000000',
        data_status: 'verified',
        source_record_id: null,
        notes: 'Series B valuation',
      });
      expect(typeof recordMock.mock.calls[0][1].market_value).toBe('string');
      expect(recordMock.mock.calls[0][1]).not.toHaveProperty('id');
      expect(recordMock.mock.calls[0][1]).not.toHaveProperty('workspace_id');
      expect(recordMock.mock.calls[0][1]).not.toHaveProperty('business_event_id');
      expect(recordMock.mock.calls[0][1]).not.toHaveProperty('is_reversal');
      expect(recordMock.mock.calls[0][1]).not.toHaveProperty('created_by');
      expect(recordMock.mock.calls[0][1]).not.toHaveProperty('updated_by');
    });

    it('forwards numeric valuation without string coercion, triggering 422 InvalidEntryShapeError', async () => {
      recordMock.mockImplementationOnce((_wsId, input) => {
        if (typeof input.market_value !== 'string' && input.market_value !== null) {
          throw new InvalidEntryShapeError(
            `market_value must be a string, received ${typeof input.market_value}`,
          );
        }
        return Promise.resolve({ id: 'val-1' });
      });

      const res = await POST(
        makePostRequest({
          asset_id: 'asset-1',
          as_of_date: '2026-06-30',
          market_value: 25000000, // Number instead of string
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toBe('market_value must be a string, received number');
      expect(json.error_name).toBe('InvalidEntryShapeError');
      expect(recordMock.mock.calls[0][1].market_value).toBe(25000000);
    });

    it('returns 422 with error_name on InvalidValuationTargetError', async () => {
      recordMock.mockRejectedValueOnce(
        new InvalidValuationTargetError(
          'Valuation must target exactly one of asset_id, fund_id, or position_id.',
        ),
      );

      const res = await POST(
        makePostRequest({
          as_of_date: '2026-06-30',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Valuation must target exactly one');
      expect(json.error_name).toBe('InvalidValuationTargetError');
    });

    it('returns 422 with error_name on WorkspaceMismatchError', async () => {
      recordMock.mockRejectedValueOnce(
        new WorkspaceMismatchError('Asset asset-1 does not exist in workspace ws-1'),
      );

      const res = await POST(
        makePostRequest({
          asset_id: 'asset-1',
          as_of_date: '2026-06-30',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Asset asset-1 does not exist in workspace');
      expect(json.error_name).toBe('WorkspaceMismatchError');
    });

    it('returns 422 with error_name on InvalidCurrencyError', async () => {
      recordMock.mockRejectedValueOnce(
        new InvalidCurrencyError('Invalid currency code: ZZ'),
      );

      const res = await POST(
        makePostRequest({
          asset_id: 'asset-1',
          as_of_date: '2026-06-30',
          currency: 'ZZ',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Invalid currency code');
      expect(json.error_name).toBe('InvalidCurrencyError');
    });

    it('returns 500 on unexpected throw', async () => {
      recordMock.mockRejectedValueOnce(new Error('Internal server timeout'));

      const res = await POST(
        makePostRequest({
          asset_id: 'asset-1',
          as_of_date: '2026-06-30',
        }) as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Internal server timeout');
    });
  });
});
