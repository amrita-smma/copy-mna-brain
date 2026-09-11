import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidCurrencyError, InvalidEntryShapeError } from '@/lib/services';

const {
  createDbMock,
  getActiveWorkspaceIdMock,
  createContainerMock,
  listFundsMock,
  createFundMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  createContainerMock: vi.fn(),
  listFundsMock: vi.fn(),
  createFundMock: vi.fn(),
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
  return new Request('http://localhost/api/fund-ledger/funds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET & POST /api/fund-ledger/funds', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    listFundsMock.mockReset();
    createFundMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      flMasterDataService: {
        listFunds: listFundsMock,
        createFund: createFundMock,
      },
    });
  });

  describe('GET', () => {
    it('returns funds list on success', async () => {
      const mockFunds = [{ id: 'fund-1', name: 'Fund I', ownership_basis: 'commitment' }];
      listFundsMock.mockResolvedValueOnce(mockFunds);

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: mockFunds });
      expect(createDbMock).toHaveBeenCalled();
      expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
      expect(listFundsMock).toHaveBeenCalledWith('ws-1');
    });

    it('returns 500 on unexpected service failure', async () => {
      listFundsMock.mockRejectedValueOnce(new Error('DB failure'));

      const res = await GET();
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: 'DB failure' });
    });
  });

  describe('POST', () => {
    it('creates fund, forwards string rates unchanged, and omits caller-supplied id', async () => {
      const created = { id: 'fund-123', name: 'Fund I', ownership_basis: 'commitment' };
      createFundMock.mockResolvedValueOnce(created);

      const res = await POST(
        makePostRequest({
          id: 'untrusted-client-id',
          workspace_id: 'untrusted-ws-id',
          business_event_id: 'untrusted-event-id',
          is_reversal: true,
          created_by: 'untrusted-user',
          updated_by: 'untrusted-user',
          name: 'Fund I',
          legal_name: 'Fund I LP',
          registration_no: 'REG-123',
          managed: true,
          ownership_basis: 'commitment',
          base_currency: 'USD',
          vintage_year: 2024,
          fund_life_years: 10,
          status: 'investing',
          mgmt_fee_rate: '0.020000',
          carry_rate: '0.200000',
          preferred_return_rate: '0.080000',
          description: 'Flagship fund',
        }) as never,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: created });
      expect(createFundMock).toHaveBeenCalledWith('ws-1', {
        name: 'Fund I',
        legal_name: 'Fund I LP',
        english_name: null,
        registration_no: 'REG-123',
        managed: true,
        ownership_basis: 'commitment',
        base_currency: 'USD',
        vintage_year: 2024,
        fund_life_years: 10,
        status: 'investing',
        mgmt_fee_rate: '0.020000',
        carry_rate: '0.200000',
        preferred_return_rate: '0.080000',
        description: 'Flagship fund',
      });
      // String rate was forwarded as a string without mutation
      expect(typeof createFundMock.mock.calls[0][1].mgmt_fee_rate).toBe('string');
      // Ensure caller-supplied internal IDs and audit fields were not passed
      expect(createFundMock.mock.calls[0][1]).not.toHaveProperty('id');
      expect(createFundMock.mock.calls[0][1]).not.toHaveProperty('workspace_id');
      expect(createFundMock.mock.calls[0][1]).not.toHaveProperty('business_event_id');
      expect(createFundMock.mock.calls[0][1]).not.toHaveProperty('is_reversal');
      expect(createFundMock.mock.calls[0][1]).not.toHaveProperty('created_by');
      expect(createFundMock.mock.calls[0][1]).not.toHaveProperty('updated_by');
    });

    it('forwards numeric rate without string coercion, triggering 422 InvalidEntryShapeError', async () => {
      createFundMock.mockImplementationOnce((_wsId, input) => {
        if (typeof input.mgmt_fee_rate !== 'string' && input.mgmt_fee_rate !== null) {
          throw new InvalidEntryShapeError(
            `mgmt_fee_rate must be a string, received ${typeof input.mgmt_fee_rate}`,
          );
        }
        return Promise.resolve({ id: 'fund-1' });
      });

      const res = await POST(
        makePostRequest({
          name: 'Fund I',
          ownership_basis: 'commitment',
          mgmt_fee_rate: 0.02, // Number instead of string
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toBe('mgmt_fee_rate must be a string, received number');
      expect(json.error_name).toBe('InvalidEntryShapeError');
      // Verify raw number reached service without route-level String() conversion
      expect(createFundMock.mock.calls[0][1].mgmt_fee_rate).toBe(0.02);
    });

    it('returns 422 with error_name on InvalidCurrencyError', async () => {
      createFundMock.mockRejectedValueOnce(
        new InvalidCurrencyError('Invalid ISO 4217 currency: INVALID'),
      );

      const res = await POST(
        makePostRequest({
          name: 'Fund I',
          ownership_basis: 'commitment',
          base_currency: 'INVALID',
        }) as never,
      );

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('Invalid ISO 4217 currency');
      expect(json.error_name).toBe('InvalidCurrencyError');
    });

    it('returns 500 on unexpected throw', async () => {
      createFundMock.mockRejectedValueOnce(new Error('Internal DB failure'));

      const res = await POST(
        makePostRequest({
          name: 'Fund II',
          ownership_basis: 'units',
        }) as never,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Internal DB failure');
    });
  });
});
