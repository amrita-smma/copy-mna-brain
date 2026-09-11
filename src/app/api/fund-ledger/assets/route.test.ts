import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMismatchError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listAssetsMock,
  createAssetMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listAssetsMock: vi.fn(),
  createAssetMock: vi.fn(),
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
  return new Request('http://localhost/api/fund-ledger/assets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET & POST /api/fund-ledger/assets', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listAssetsMock.mockReset();
    createAssetMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        listAssets: listAssetsMock,
        createAsset: createAssetMock,
      },
    });
  });

  describe('GET', () => {
    it('returns assets list on success', async () => {
      const mockAssets = [{ id: 'asset-1', name: 'Acme Corp', asset_kind: 'equity' }];
      listAssetsMock.mockResolvedValueOnce(mockAssets);

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockAssets });
      expect(createDbMock).toHaveBeenCalled();
      expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
      expect(listAssetsMock).toHaveBeenCalledWith('ws-1');
    });

    it('returns 500 on unexpected service failure', async () => {
      listAssetsMock.mockRejectedValueOnce(new Error('Asset listing failed'));

      const res = await GET();
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: 'Asset listing failed' });
    });
  });

  describe('POST', () => {
    it('creates asset, passes field-by-field, and omits caller-supplied id', async () => {
      const created = { id: 'asset-123', name: 'Acme Corp', asset_kind: 'equity' };
      createAssetMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          id: 'caller-id-omitted',
          workspace_id: 'caller-ws-omitted',
          business_event_id: 'caller-event-omitted',
          is_reversal: true,
          created_by: 'caller-user-omitted',
          updated_by: 'caller-user-omitted',
          name: 'Acme Corp',
          legal_name: 'Acme Corp Ltd',
          english_name: 'Acme Corp',
          asset_kind: 'equity',
          country: 'USA',
          sector: 'Technology',
          sub_sector: 'SaaS',
          instrument_terms: { round: 'Series A' },
          description: 'Top enterprise SaaS',
        }) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: created });
      expect(createAssetMock).toHaveBeenCalledWith('ws-1', {
        name: 'Acme Corp',
        legal_name: 'Acme Corp Ltd',
        english_name: 'Acme Corp',
        asset_kind: 'equity',
        country: 'USA',
        sector: 'Technology',
        sub_sector: 'SaaS',
        instrument_terms: { round: 'Series A' },
        description: 'Top enterprise SaaS',
      });
      expect(createAssetMock.mock.calls[0][1]).not.toHaveProperty('id');
      expect(createAssetMock.mock.calls[0][1]).not.toHaveProperty('workspace_id');
      expect(createAssetMock.mock.calls[0][1]).not.toHaveProperty('business_event_id');
      expect(createAssetMock.mock.calls[0][1]).not.toHaveProperty('is_reversal');
      expect(createAssetMock.mock.calls[0][1]).not.toHaveProperty('created_by');
      expect(createAssetMock.mock.calls[0][1]).not.toHaveProperty('updated_by');
    });

    it('returns 422 with error_name on typed domain error', async () => {
      createAssetMock.mockRejectedValueOnce(
        new WorkspaceMismatchError('Asset workspace mismatch error'),
      );

      const res = await POST(
        makePostRequest({
          name: 'Acme Corp',
          asset_kind: 'equity',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Asset workspace mismatch error');
      expect(json.error_name).toBe('WorkspaceMismatchError');
    });

    it('returns 500 on unexpected throw', async () => {
      createAssetMock.mockRejectedValueOnce(new Error('Database unavailable'));

      const res = await POST(
        makePostRequest({
          name: 'Beta Corp',
          asset_kind: 'loan',
        }) as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Database unavailable');
    });
  });
});
