import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiRequest: apiRequestMock,
}));

import {
  getPortfolio,
  listFunds,
  getFund,
  createFund,
  updateFund,
  getFundRollup,
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  listInvestors,
  getInvestor,
  createInvestor,
  updateInvestor,
  deleteInvestor,
  listFundingSources,
  getFundingSource,
  createFundingSource,
  updateFundingSource,
  deleteFundingSource,
  listPositions,
  getPosition,
  openPosition,
  closePosition,
  closePositions,
  reopenPosition,
  postEvent,
  getEvent,
  updateEvent,
  reverseEvent,
  listEntries,
  listValuations,
  getValuation,
  recordValuation,
  updateValuation,
  deleteValuation,
  shiftDecimal,
  multiplyDecimalStrings,
  addDecimalStrings,
  toRawAmountString,
  saveHoldingTransaction,
  deleteHoldingTransaction,
  saveHoldingValuation,
  listCommitmentEvents,
  createCommitmentEvent,
  createCommitmentTransfer,
  updateCommitmentEvent,
  deleteCommitmentEvent,
  triggerAiOpinion,
  clearAiOpinion,
  getAiOpinion,
} from './fundLedger';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
} from '@/lib/sellProceedsDestination';

describe('fundLedger API client', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  describe('Decimal String Helpers', () => {
    it('shiftDecimal shifts decimal points accurately without binary float inaccuracies', () => {
      expect(shiftDecimal('1.5', 6)).toBe('1500000');
      expect(shiftDecimal('1500000', -6)).toBe('1.5');
      expect(shiftDecimal('0.000001', 6)).toBe('1');
      expect(shiftDecimal('1', -6)).toBe('0.000001');
      expect(shiftDecimal('123456789012345678.123456', 6)).toBe('123456789012345678123456');
      expect(shiftDecimal('123456789012345678123456', -6)).toBe('123456789012345678.123456');
      expect(shiftDecimal('-2.75', 6)).toBe('-2750000');
      expect(shiftDecimal('0', 6)).toBe('0');
      expect(shiftDecimal('0.0', -6)).toBe('0');
    });

    it('multiplyDecimalStrings computes exact products for large and fractional numbers', () => {
      expect(multiplyDecimalStrings('12.5', '50000')).toBe('625000');
      expect(multiplyDecimalStrings('0.00001', '0.00002')).toBe('0.0000000002');
      expect(multiplyDecimalStrings('999999999', '999999999')).toBe('999999998000000001');
      expect(multiplyDecimalStrings('-10', '5')).toBe('-50');
      expect(multiplyDecimalStrings('0', '12345')).toBe('0');
    });

    it('addDecimalStrings sums exact decimal values', () => {
      expect(addDecimalStrings('1.5', '2.75')).toBe('4.25');
      expect(addDecimalStrings('1000', '-250')).toBe('750');
      expect(addDecimalStrings('0.00000001', '0.00000002')).toBe('0.00000003');
    });

    it('toRawAmountString handles unscaled and million-scaled values', () => {
      expect(toRawAmountString('2.5', true)).toBe('2500000');
      expect(toRawAmountString(2.5, true)).toBe('2500000');
      expect(toRawAmountString('1000', false)).toBe('1000');
      expect(toRawAmountString(null, true)).toBeNull();
    });

    it('expands scientific notation deterministically before shifting decimal point', () => {
      // 0.0000001 (in JS number is 1e-7) million -> 0.1 raw
      expect(toRawAmountString(0.0000001, true)).toBe('0.1');
      expect(toRawAmountString('1e-7', true)).toBe('0.1');
      expect(toRawAmountString('1.234e-5', true)).toBe('12.34');
      // Large exponent
      expect(toRawAmountString(1e21, false)).toBe('1000000000000000000000');
      expect(toRawAmountString('1e21', false)).toBe('1000000000000000000000');
      expect(toRawAmountString('-2.5e-3', false)).toBe('-0.0025');
    });

    it('rejects malformed decimal inputs by returning null in toRawAmountString', () => {
      expect(toRawAmountString('abc', false)).toBeNull();
      expect(toRawAmountString('1.2.3', false)).toBeNull();
      expect(toRawAmountString('--5', false)).toBeNull();
      expect(toRawAmountString('1e2e3', false)).toBeNull();
      expect(toRawAmountString('1.23e', false)).toBeNull();
      expect(toRawAmountString('', false)).toBeNull();
      expect(toRawAmountString(undefined, false)).toBeNull();
    });
  });

  describe('getPortfolio', () => {
    it('requests /api/fund-ledger/portfolio without asOf and returns unwrapped portfolio', async () => {
      const mockPortfolio = {
        managed_funds: [{ id: 'f1', name: 'Fund 1' }],
        funds: [],
        assets: [],
        positions: [],
        entries: [],
      };
      apiRequestMock.mockResolvedValueOnce(mockPortfolio);
      const res = await getPortfolio();
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/portfolio');
      expect(res).toEqual(mockPortfolio);
      expect(res.managed_funds).toEqual([{ id: 'f1', name: 'Fund 1' }]);
    });

    it('requests /api/fund-ledger/portfolio with asOf param', async () => {
      apiRequestMock.mockResolvedValueOnce({ funds: [], positions: [], entries: [] });
      const res = await getPortfolio('2026-06-30');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/portfolio?asOf=2026-06-30');
      expect(res).toEqual({ funds: [], positions: [], entries: [] });
    });
  });

  describe('Funds', () => {
    it('listFunds calls GET /api/fund-ledger/funds and returns unwrapped array', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'f1' }]);
      const res = await listFunds();
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funds');
      expect(res).toEqual([{ id: 'f1' }]);
    });

    it('getFund calls GET /api/fund-ledger/funds/:id and returns unwrapped fund', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'f1' });
      const res = await getFund('f1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funds/f1');
      expect(res).toEqual({ id: 'f1' });
    });

    it('createFund calls POST /api/fund-ledger/funds with JSON body and returns unwrapped fund', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'f1', name: 'Fund 1' });
      const input = { name: 'Fund 1', managed: true, ownership_basis: 'commitment' as const };
      const res = await createFund(input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funds', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'f1', name: 'Fund 1' });
    });

    it('updateFund calls PATCH /api/fund-ledger/funds/:id with JSON body and returns unwrapped fund', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'f1', name: 'Fund Updated' });
      const input = { name: 'Fund Updated' };
      const res = await updateFund('f1', input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funds/f1', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'f1', name: 'Fund Updated' });
    });

    it('getFundRollup calls GET /api/fund-ledger/funds/:id/rollup and returns unwrapped rollup', async () => {
      apiRequestMock.mockResolvedValueOnce({ fmv: '100' });
      const res = await getFundRollup('f1', '2026-06-30');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funds/f1/rollup?asOf=2026-06-30');
      expect(res).toEqual({ fmv: '100' });
    });
  });

  describe('Assets', () => {
    it('listAssets calls GET /api/fund-ledger/assets and returns unwrapped array', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'a1' }]);
      const res = await listAssets();
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets');
      expect(res).toEqual([{ id: 'a1' }]);
    });

    it('getAsset calls GET /api/fund-ledger/assets/:id and returns unwrapped asset', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'a1', name: 'Asset 1' });
      const res = await getAsset('a1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/a1');
      expect(res).toEqual({ id: 'a1', name: 'Asset 1' });
    });

    it('createAsset calls POST /api/fund-ledger/assets and returns unwrapped asset', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'a1', name: 'Asset 1' });
      const input = { name: 'Asset 1', asset_kind: 'equity' as const };
      const res = await createAsset(input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'a1', name: 'Asset 1' });
    });

    it('updateAsset calls PATCH /api/fund-ledger/assets/:id and returns unwrapped asset', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'a1', name: 'Asset Updated' });
      const input = { name: 'Asset Updated' };
      const res = await updateAsset('a1', input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/a1', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'a1', name: 'Asset Updated' });
    });
  });

  describe('Investors', () => {
    it('listInvestors calls GET /api/fund-ledger/investors and returns unwrapped array', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'inv-1', name: 'Alice' }]);
      const res = await listInvestors();
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/investors');
      expect(res).toEqual([{ id: 'inv-1', name: 'Alice' }]);
    });

    it('getInvestor calls GET /api/fund-ledger/investors/:id and returns unwrapped investor', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'inv-1', name: 'Alice' });
      const res = await getInvestor('inv-1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/investors/inv-1');
      expect(res).toEqual({ id: 'inv-1', name: 'Alice' });
    });

    it('createInvestor calls POST /api/fund-ledger/investors and returns unwrapped investor', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'inv-1', name: 'Alice' });
      const input = { name: 'Alice', investor_type: 'individual' as const };
      const res = await createInvestor(input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/investors', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'inv-1', name: 'Alice' });
    });

    it('updateInvestor calls PATCH /api/fund-ledger/investors/:id and returns unwrapped investor', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'inv-1', name: 'Alice Updated' });
      const input = { name: 'Alice Updated' };
      const res = await updateInvestor('inv-1', input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/investors/inv-1', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'inv-1', name: 'Alice Updated' });
    });

    it('deleteInvestor calls DELETE /api/fund-ledger/investors/:id', async () => {
      apiRequestMock.mockResolvedValueOnce({ success: true });
      await deleteInvestor('inv-1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/investors/inv-1', {
        method: 'DELETE',
      });
    });

    it('deleteInvestor surfaces error when FK RESTRICT or server rejects', async () => {
      apiRequestMock.mockRejectedValueOnce(new Error('violates foreign key constraint'));
      await expect(deleteInvestor('inv-in-use')).rejects.toThrow('violates foreign key constraint');
    });
  });

  describe('Funding Sources', () => {
    it('listFundingSources calls GET /api/fund-ledger/funding-sources and returns unwrapped array', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'src-1', name: 'Treasury' }]);
      const res = await listFundingSources();
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funding-sources');
      expect(res).toEqual([{ id: 'src-1', name: 'Treasury' }]);
    });

    it('getFundingSource calls GET /api/fund-ledger/funding-sources/:id and returns unwrapped source', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'src-1', name: 'Treasury' });
      const res = await getFundingSource('src-1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funding-sources/src-1');
      expect(res).toEqual({ id: 'src-1', name: 'Treasury' });
    });

    it('createFundingSource calls POST /api/fund-ledger/funding-sources and returns unwrapped source', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'src-1', name: 'Treasury' });
      const input = { name: 'Treasury', source_type: 'bank' };
      const res = await createFundingSource(input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funding-sources', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'src-1', name: 'Treasury' });
    });

    it('updateFundingSource calls PATCH /api/fund-ledger/funding-sources/:id and returns unwrapped source', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'src-1', name: 'Treasury Renamed' });
      const input = { name: 'Treasury Renamed' };
      const res = await updateFundingSource('src-1', input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funding-sources/src-1', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'src-1', name: 'Treasury Renamed' });
    });

    it('deleteFundingSource calls DELETE /api/fund-ledger/funding-sources/:id', async () => {
      apiRequestMock.mockResolvedValueOnce({ success: true });
      await deleteFundingSource('src-1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/funding-sources/src-1', {
        method: 'DELETE',
      });
    });

    it('deleteFundingSource surfaces error when FK RESTRICT or server rejects', async () => {
      apiRequestMock.mockRejectedValueOnce(new Error('violates foreign key constraint'));
      await expect(deleteFundingSource('src-in-use')).rejects.toThrow('violates foreign key constraint');
    });
  });

  describe('Positions', () => {
    it('listPositions passes filters in query string, supporting tri-state NULL and omitted semantics', async () => {
      apiRequestMock.mockResolvedValueOnce([]);
      await listPositions({ fundId: 'f1', holderInvestorId: 'inv1' });
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/api/fund-ledger/positions?fundId=f1&holderInvestorId=inv1',
      );

      // Tri-state null
      apiRequestMock.mockResolvedValueOnce([]);
      await listPositions({ fundId: 'f1', holderSourceOfFundId: null });
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/api/fund-ledger/positions?fundId=f1&holderSourceOfFundId=null',
      );

      // Tri-state UUID
      apiRequestMock.mockResolvedValueOnce([]);
      await listPositions({ fundId: 'f1', holderSourceOfFundId: 'fs-1' });
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/api/fund-ledger/positions?fundId=f1&holderSourceOfFundId=fs-1',
      );
    });

    it('getPosition calls GET /api/fund-ledger/positions/:id and returns unwrapped position', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'p1' });
      const res = await getPosition('p1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/positions/p1');
      expect(res).toEqual({ id: 'p1' });
    });

    it('openPosition calls POST /api/fund-ledger/positions with holder_source_of_fund_id', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'p1' });
      const input = { holder_fund_id: 'f1', asset_id: 'a1', holder_source_of_fund_id: 'fs-1' };
      const res = await openPosition(input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/positions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ id: 'p1' });
    });

    it('closePosition calls POST /api/fund-ledger/positions/:id/close', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'p1', status: 'closed' });
      const res = await closePosition('p1', { closed_at: '2026-06-01' });
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/positions/p1/close', {
        method: 'POST',
        body: JSON.stringify({ closed_at: '2026-06-01' }),
      });
      expect(res).toEqual({ id: 'p1', status: 'closed' });
    });

    it('closePositions sends one batch HTTP request for all selected position IDs', async () => {
      const closed = [
        { id: 'p1', status: 'closed' },
        { id: 'p2', status: 'closed' },
      ];
      apiRequestMock.mockResolvedValueOnce(closed);

      const res = await closePositions(['p1', 'p2'], { closed_at: '2026-06-01' });

      expect(apiRequestMock).toHaveBeenCalledTimes(1);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/positions/batch-close', {
        method: 'POST',
        body: JSON.stringify({
          position_ids: ['p1', 'p2'],
          closed_at: '2026-06-01',
        }),
      });
      expect(res).toEqual(closed);
    });

    it('closePositions returns empty array without making HTTP request when positionIds is empty', async () => {
      const res = await closePositions([]);
      expect(res).toEqual([]);
      expect(apiRequestMock).not.toHaveBeenCalled();
    });

    it('reopenPosition calls POST /api/fund-ledger/positions/:id/reopen', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'p1', status: 'open' });
      const res = await reopenPosition('p1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/positions/p1/reopen', {
        method: 'POST',
      });
      expect(res).toEqual({ id: 'p1', status: 'open' });
    });
  });

  describe('Events & Entries', () => {
    it('listEntries formats exact positionIds, limit, and offset query parameters', async () => {
      apiRequestMock.mockResolvedValueOnce([]);
      await listEntries({ positionIds: ['p1', 'p2'], limit: 50, offset: 10 });
      expect(apiRequestMock).toHaveBeenCalledWith(
        '/api/fund-ledger/entries?positionIds=p1%2Cp2&limit=50&offset=10',
      );
    });

    it('listEntries returns empty array without network call when positionIds is empty', async () => {
      const res = await listEntries({ positionIds: [] });
      expect(res).toEqual([]);
      expect(apiRequestMock).not.toHaveBeenCalled();
    });

    it('postEvent calls POST /api/fund-ledger/events and returns unwrapped event', async () => {
      apiRequestMock.mockResolvedValueOnce({ event: { id: 'ev1' } });
      const input = {
        event_date: '2026-01-01',
        description: 'Investment',
        entries: [
          {
            position_id: 'p1',
            entry_date: '2026-01-01',
            entry_type: 'buy' as const,
            commitment_delta: '0',
            quantity_delta: '100',
            cash_delta: '-1000',
            currency: 'USD',
          },
        ],
      };
      const res = await postEvent(input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ event: { id: 'ev1' } });
    });

    it('getEvent calls GET /api/fund-ledger/events/:id and returns unwrapped event and entries', async () => {
      apiRequestMock.mockResolvedValueOnce({
        event: { id: 'ev1' },
        entries: [{ id: 'entry1' }],
      });
      const res = await getEvent('ev1');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events/ev1');
      expect(res).toEqual({
        event: { id: 'ev1' },
        entries: [{ id: 'entry1' }],
      });
    });

    it('updateEvent calls PATCH /api/fund-ledger/events/:id and returns unwrapped result', async () => {
      apiRequestMock.mockResolvedValueOnce({ event: { id: 'ev1' } });
      const input = {
        event_date: '2026-01-01',
        entries: [],
      };
      const res = await updateEvent('ev1', input);
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events/ev1', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      expect(res).toEqual({ event: { id: 'ev1' } });
    });

    it('reverseEvent calls DELETE /api/fund-ledger/events/:id and returns unwrapped result', async () => {
      apiRequestMock.mockResolvedValueOnce({ event: { id: 'ev-rev' } });
      const res = await reverseEvent('ev1', { description: 'Reversal' });
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events/ev1', {
        method: 'DELETE',
        body: JSON.stringify({ description: 'Reversal' }),
      });
      expect(res).toEqual({ event: { id: 'ev-rev' } });
    });
  });

  describe('saveHoldingTransaction & deleteHoldingTransaction', () => {
    it('derives value from pps * shares when value is omitted and formats pps/fx as normalized decimal strings', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }]) // listPositions
        .mockResolvedValueOnce({ event: { id: 'ev-1' } }); // postEvent

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-02-01',
        type: 'Buy',
        shares: '0.05', // 50,000 shares
        pps: 20.5, // numeric pps routed through decimal normalizer -> '20.5'
        fx: ' 1.150 ', // fx string routed through decimal normalizer -> '1.15'
      });

      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events', {
        method: 'POST',
        body: JSON.stringify({
          event_date: '2026-02-01',
          description: 'Buy',
          entries: [
            {
              position_id: 'pos-1',
              entry_date: '2026-02-01',
              entry_type: 'buy',
              sub_type: null,
              commitment_delta: '0',
              quantity_delta: '50000',
              cash_delta: '-1025000',
              currency: 'USD',
              price_per_unit: '20.5',
              fx_rate: '1.15',
              notes: null,
            },
          ],
        }),
      });
    });

    it('rejects invalid or non-numeric pps and fx values by omitting them', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }])
        .mockResolvedValueOnce({ event: { id: 'ev-1' } });

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-02-01',
        type: 'Buy',
        value: '1.0',
        shares: '0.05',
        pps: 'invalid_pps' as any,
        fx: 'invalid_fx' as any,
      });

      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events', {
        method: 'POST',
        body: expect.stringContaining('"price_per_unit":null'),
      });
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events', {
        method: 'POST',
        body: expect.stringContaining('"fx_rate":null'),
      });
    });

    it('persists explicit sub_type for cash_in_fund and distributed_to_investor destinations', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }])
        .mockResolvedValueOnce({ event: { id: 'ev-1' } });

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-03-01',
        type: 'Sell',
        value: '500000',
        sellProceedsDestination: 'cash_in_fund',
      });

      expect(apiRequestMock).toHaveBeenLastCalledWith('/api/fund-ledger/events', {
        method: 'POST',
        body: expect.stringContaining(`"sub_type":"${SUB_TYPE_DIVESTMENT_CASH_IN_FUND}"`),
      });

      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }])
        .mockResolvedValueOnce({ event: { id: 'ev-2' } });

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-03-02',
        type: 'Sell',
        value: '300000',
        sellProceedsDestination: 'distributed_to_investor',
      });

      expect(apiRequestMock).toHaveBeenLastCalledWith('/api/fund-ledger/events', {
        method: 'POST',
        body: expect.stringContaining(`"sub_type":"${SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR}"`),
      });
    });

    it('saveHoldingValuation normalizes pps through toRawAmountString scale 0', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'val-1' });

      await saveHoldingValuation('asset-1', false, {
        asOfDate: '2026-03-31',
        mv: '2.5',
        cost: '2.0',
        pps: 15.75,
        sharesOut: '0.1',
      });

      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/valuations', {
        method: 'POST',
        body: JSON.stringify({
          asset_id: 'asset-1',
          fund_id: null,
          as_of_date: '2026-03-31',
          market_value: '2500000',
          price_per_unit: '15.75',
          units_outstanding: '100000',
          gross_value: '2000000',
          currency: 'USD',
          notes: null,
        }),
      });
    });

    it('preserves quarterly display metadata when saving a valuation', async () => {
      apiRequestMock.mockResolvedValueOnce({ id: 'val-1' });

      await saveHoldingValuation('asset-1', false, {
        id: 'val-1',
        asOfDate: '2026-03-31',
        q: 'Q1 2026',
        mv: 2.5,
        shPct: 1.5682790039999999,
        moic: 1.04,
        xirr: 12.5,
        notes: 'Audited mark',
      });

      const body = JSON.parse(String(apiRequestMock.mock.calls[0][1]?.body));
      expect(body.notes).toBe(
        'Audited mark | source_meta: {"period_label":"Q1 2026","shareholding_pct":1.5682790039999999,"gross_moic":1.04,"gross_xirr":12.5}',
      );
    });

    it('rejects buy with zero cash value before API call', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'pos-1' }]);
      await expect(
        saveHoldingTransaction('fund-1', 'asset-1', false, {
          date: '2026-02-01',
          type: 'Buy',
          value: '0',
          shares: '0.05',
        }),
      ).rejects.toThrow('Buy transaction requires a non-zero cash value');
    });

    it.each(['Buy', 'Sell'] as const)('posts a value-only %s with zero quantity', async (type) => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-value-only', fund_id: null }])
        .mockResolvedValueOnce({ event: { id: 'event-value-only' } });

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-02-01', type, value: '1.25', shares: null,
      });

      const post = apiRequestMock.mock.calls.find(([url, init]) =>
        url === '/api/fund-ledger/events' && init?.method === 'POST');
      const body = JSON.parse(String(post![1]?.body));
      expect(body.entries[0].cash_delta).toBe(type === 'Buy' ? '-1250000' : '1250000');
      expect(body.entries[0].quantity_delta).toBe('0');
    });

    it('edits the exact position and preserves all explicit allocations', async () => {
      const originalEntry = {
        id: 'entry-1', business_event_id: 'event-99', position_id: 'pos-exact',
        entry_type: 'buy', sub_type: null, commitment_delta: '0', quantity_delta: '1',
        cash_delta: '-100', currency: 'USD', fx_rate: null, price_per_unit: null,
        counterparty_position_id: null, data_status: 'verified', source_record_id: null,
        notes: null,
      };
      apiRequestMock
        .mockResolvedValueOnce({ id: 'pos-exact', fund_id: null }) // getPosition
        .mockResolvedValueOnce([originalEntry])
        .mockResolvedValueOnce({
          event: { id: 'event-99', source_record_id: null }, entries: [originalEntry], allocations: [],
        })
        .mockResolvedValueOnce({ event: { id: 'replacement' } });

      await saveHoldingTransaction('fund-1', 'asset-shared', false, {
        positionId: 'pos-exact', date: '2026-02-01', type: 'Buy', value: '0.0006',
        allocations: [
          { fundingSourceId: 'fs-1', amount: '100' },
          { fundingSourceId: 'fs-2', amount: '200' },
          { fundingSourceId: 'fs-3', amount: '300' },
        ],
      }, 'entry-1');

      expect(apiRequestMock).toHaveBeenNthCalledWith(1, '/api/fund-ledger/positions/pos-exact');
      const patchCall = apiRequestMock.mock.calls.find(([url, init]) =>
        url === '/api/fund-ledger/events/event-99' && init?.method === 'PATCH');
      const body = JSON.parse(String(patchCall![1]?.body));
      expect(body.entries[0].position_id).toBe('pos-exact');
      expect(body.entries[0].allocations).toEqual([
        { funding_source_id: 'fs-1', amount: '100' },
        { funding_source_id: 'fs-2', amount: '200' },
        { funding_source_id: 'fs-3', amount: '300' },
      ]);
    });

    it('drops the derived cash leg from a replacement and keeps the row it mirrors', async () => {
      // The service derives fund-cash legs from the primary rows and pairs them
      // by a transient index, so sending one back is rejected outright with
      // "cash_movement without primary_entry_index or counterparty_position_id
      // must have sub_type = opening_balance". The replacement omits it.
      const target = {
        id: 'entry-1', business_event_id: 'event-99', position_id: 'pos-1',
        entry_type: 'paid_in', sub_type: 'capital_call', commitment_delta: '0.00000000',
        quantity_delta: '100000.00000000', cash_delta: '-100000.00000000', currency: 'USD',
        fx_rate: '1.00000000', price_per_unit: null, counterparty_position_id: null,
        data_status: 'verified', source_record_id: null, notes: null,
      };
      const derivedLeg = {
        ...target, id: 'entry-2', position_id: 'cash-pos', entry_type: 'cash_movement',
        sub_type: null, quantity_delta: '0.00000000', cash_delta: '100000.00000000',
        source_ledger_entry_id: 'entry-1',
      };
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }])
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce({
          event: { id: 'event-99', source_record_id: null },
          entries: [target, derivedLeg],
          allocations: [],
        })
        .mockResolvedValueOnce({ event: { id: 'event-100' } });

      await saveHoldingTransaction(
        'fund-1', 'asset-1', false,
        { date: '2026-02-01', type: 'Buy', value: '150000', shares: '150000' },
        'entry-1',
      );

      const patchCall = apiRequestMock.mock.calls.find(([url, init]) =>
        url === '/api/fund-ledger/events/event-99' && init?.method === 'PATCH');
      const body = JSON.parse(String(patchCall![1]?.body));
      expect(body.entries).toHaveLength(1);
      // The edited row itself is rebuilt from the form; the derived leg is gone.
      expect(body.entries[0].entry_type).toBe('buy');
    });

    it('keeps an opening balance and an FX transfer leg, which are rows in their own right', async () => {
      const target = {
        id: 'entry-1', business_event_id: 'event-99', position_id: 'pos-1',
        entry_type: 'paid_in', sub_type: 'capital_call', commitment_delta: '0.00000000',
        quantity_delta: '100000.00000000', cash_delta: '-100000.00000000', currency: 'USD',
        fx_rate: '1.00000000', price_per_unit: null, counterparty_position_id: null,
        data_status: 'verified', source_record_id: null, notes: null,
      };
      const opening = {
        ...target, id: 'entry-2', position_id: 'cash-pos', entry_type: 'cash_movement',
        sub_type: 'opening_balance', quantity_delta: '0.00000000', cash_delta: '5000.00000000',
      };
      const fxLeg = {
        ...opening, id: 'entry-3', sub_type: null, counterparty_position_id: 'cash-pos-idr',
      };
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }])
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce({
          event: { id: 'event-99', source_record_id: null },
          entries: [target, opening, fxLeg],
          allocations: [],
        })
        .mockResolvedValueOnce({ event: { id: 'event-100' } });

      await saveHoldingTransaction(
        'fund-1', 'asset-1', false,
        { date: '2026-02-01', type: 'Buy', value: '150000', shares: '150000' },
        'entry-1',
      );

      const patchCall = apiRequestMock.mock.calls.find(([url, init]) =>
        url === '/api/fund-ledger/events/event-99' && init?.method === 'PATCH');
      const body = JSON.parse(String(patchCall![1]?.body));
      expect(body.entries.map((e: { id?: string; entry_type: string; sub_type: string | null }) =>
        `${e.entry_type}:${e.sub_type ?? ''}`)).toEqual([
        'buy:',
        'cash_movement:opening_balance',
        'cash_movement:',
      ]);
    });

    it('resolves business_event_id for transaction edit (updateEvent)', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1' }]) // listPositions
        .mockResolvedValueOnce([{ id: 'entry-1', business_event_id: 'event-99' }]) // listEntries
        .mockResolvedValueOnce({
          event: { id: 'event-99', source_record_id: null },
          entries: [{ id: 'entry-1' }],
          allocations: [],
        }) // getEvent
        .mockResolvedValueOnce({ event: { id: 'event-100' } }); // updateEvent

      await saveHoldingTransaction(
        'fund-1',
        'asset-1',
        false,
        {
          date: '2026-02-01',
          type: 'Sell',
          value: '0.5',
          shares: '0.02',
        },
        'entry-1',
      );

      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events/event-99', {
        method: 'PATCH',
        body: expect.stringContaining('"cash_delta":"500000"'),
      });
    });

    it('preserves exact deltas, allocations, and sibling legs for metadata-only edits', async () => {
      const target = {
        id: 'entry-1', business_event_id: 'event-99', position_id: 'pos-1',
        entry_type: 'paid_in', sub_type: 'capital_call', commitment_delta: '123.45000000',
        quantity_delta: '0.00000000', cash_delta: '-1000000.12345678', currency: 'USD',
        fx_rate: '1.25000000', price_per_unit: null, counterparty_position_id: null,
        data_status: 'verified', source_record_id: 'source-entry', notes: 'Old note',
      };
      const sibling = {
        ...target, id: 'entry-2', position_id: 'cash-pos', entry_type: 'income',
        sub_type: 'paired_leg', commitment_delta: '0.00000000', cash_delta: '1000000.12345678',
        source_record_id: null,
      };
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-1', fund_id: 'target-fund' }])
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce({
          event: { id: 'event-99', source_record_id: 'source-event' },
          entries: [target, sibling],
          allocations: [
            { ledger_entry_id: 'entry-1', funding_source_id: 'fs-1', amount: '600000.12345678' },
            { ledger_entry_id: 'entry-1', funding_source_id: 'fs-2', amount: '400000.00000000' },
          ],
        })
        .mockResolvedValueOnce({ event: { id: 'event-new' } });

      await saveHoldingTransaction('fund-1', 'target-fund', true, {
        date: '2026-02-02',
        type: 'Buy',
        entryType: 'paid_in',
        value: '1',
        notes: 'Updated note',
        preserveEconomicFields: true,
      }, 'entry-1');

      const patchCall = apiRequestMock.mock.calls.find(([url, init]) =>
        url === '/api/fund-ledger/events/event-99' && init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String(patchCall![1]?.body));
      expect(body.source_record_id).toBe('source-event');
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0]).toMatchObject({
        entry_type: 'paid_in',
        commitment_delta: '123.45000000',
        quantity_delta: '0.00000000',
        cash_delta: '-1000000.12345678',
        notes: 'Updated note',
        allocations: [
          { funding_source_id: 'fs-1', amount: '600000.12345678' },
          { funding_source_id: 'fs-2', amount: '400000.00000000' },
        ],
      });
      expect(body.entries[1]).toMatchObject({
        position_id: 'cash-pos', entry_type: 'income', cash_delta: '1000000.12345678',
      });
    });

    it('pins natural key with explicit funding source, opening missing partition with exact key', async () => {
      apiRequestMock
        .mockResolvedValueOnce([]) // listPositions (0 found)
        .mockResolvedValueOnce({ id: 'pos-created' }) // openPosition
        .mockResolvedValueOnce({ event: { id: 'ev-new' } }); // postEvent

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-02-01',
        type: 'Buy',
        shares: '0.05',
        value: '1.0',
        fundingSourceId: 'fs-1',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?holderFundId=fund-1&assetId=asset-1&holderSourceOfFundId=fs-1',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/positions',
        {
          method: 'POST',
          body: JSON.stringify({
            holder_fund_id: 'fund-1',
            holder_investor_id: null,
            asset_id: 'asset-1',
            fund_id: null,
            holder_source_of_fund_id: 'fs-1',
            opened_at: '2026-02-01',
          }),
        },
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        3,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"funding_source_id":"fs-1"'),
        }),
      );
    });

    it('finds an existing asset position with omitted XOR fields instead of opening a duplicate', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-existing-asset', holder_fund_id: 'fund-1', asset_id: 'asset-1' }]) // listPositions
        .mockResolvedValueOnce({ event: { id: 'ev-new' } }); // postEvent

      await saveHoldingTransaction('fund-1', 'asset-1', false, {
        date: '2026-03-01',
        type: 'Buy',
        shares: '100',
        value: '1000',
      });

      // 1. Queries with holderFundId and assetId (inactive XOR fields omitted) and tri-state nulls for fundingSource
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?holderFundId=fund-1&assetId=asset-1&holderSourceOfFundId=null',
      );
      // 2. Directly posts event on existing position without calling openPosition
      expect(apiRequestMock).toHaveBeenCalledTimes(2);
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"position_id":"pos-existing-asset"'),
        }),
      );
    });

    it('throws descriptive error on ambiguous position match instead of picking first', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'pos-1' }, { id: 'pos-2' }]);

      await expect(
        saveHoldingTransaction('fund-1', 'asset-1', false, {
          date: '2026-02-01',
          type: 'Buy',
          shares: '0.05',
          value: '1.0',
        }),
      ).rejects.toThrow(/Ambiguous position match/);
    });

    it('saves FoF capital call transaction as paid_in without requiring shares', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-fof-1', holder_fund_id: 'fund-1', fund_id: 'target-fund-1' }]) // listPositions
        .mockResolvedValueOnce({ event: { id: 'ev-fof-1' } }); // postEvent

      await saveHoldingTransaction('fund-1', 'target-fund-1', true, {
        date: '2026-04-01',
        type: 'Buy',
        value: 1.5,
        notes: 'Capital call #1',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"entry_type":"paid_in"'),
        }),
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"cash_delta":"-1500000"'),
        }),
      );
    });

    it('saves FoF divestment/distribution without shares as distribution', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-fof-1', holder_fund_id: 'fund-1', fund_id: 'target-fund-1' }]) // listPositions
        .mockResolvedValueOnce({ event: { id: 'ev-fof-2' } }); // postEvent

      await saveHoldingTransaction('fund-1', 'target-fund-1', true, {
        date: '2026-08-01',
        type: 'Sell',
        value: 0.5,
        notes: 'Dividend/distribution',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"entry_type":"distribution"'),
        }),
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"cash_delta":"500000"'),
        }),
      );
    });

    it('passes holderInvestorId instead of holderFundId when saving a transaction on an investor-held position', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-inv-1', holder_investor_id: 'inv-1', asset_id: 'asset-1' }])
        .mockResolvedValueOnce({ event: { id: 'ev-inv-1' } });

      await saveHoldingTransaction('fund-ignored', 'asset-1', false, {
        date: '2026-05-01',
        type: 'Buy',
        value: '2000',
      }, undefined, 'inv-1');

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?holderInvestorId=inv-1&assetId=asset-1&holderSourceOfFundId=null',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/events',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"position_id":"pos-inv-1"'),
        }),
      );
    });

    it('opens missing position with holder_investor_id when investor holder is specified', async () => {
      apiRequestMock
        .mockResolvedValueOnce([]) // listPositions returns empty
        .mockResolvedValueOnce({ id: 'pos-inv-new' }) // openPosition
        .mockResolvedValueOnce({ event: { id: 'ev-inv-new' } }); // postEvent

      await saveHoldingTransaction('', 'asset-1', false, {
        date: '2026-05-01',
        type: 'Buy',
        value: '1000',
        holderInvestorId: 'inv-1',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?holderInvestorId=inv-1&assetId=asset-1&holderSourceOfFundId=null',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/positions',
        {
          method: 'POST',
          body: JSON.stringify({
            holder_fund_id: null,
            holder_investor_id: 'inv-1',
            asset_id: 'asset-1',
            fund_id: null,
            holder_source_of_fund_id: null,
            opened_at: '2026-05-01',
          }),
        },
      );
    });

    it('throws ambiguous position error with holderInvestorId when multiple investor-held positions match', async () => {
      apiRequestMock.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);

      await expect(
        saveHoldingTransaction('', 'asset-1', false, {
          date: '2026-05-01',
          type: 'Buy',
          value: '1000',
        }, undefined, 'inv-1'),
      ).rejects.toThrow('Ambiguous position match: found 2 matching positions for holderInvestorId=inv-1, assetId=asset-1, fundingSourceId=null');
    });

    it('passes holderInvestorId instead of holderFundId when deleting a transaction on an investor-held position', async () => {
      apiRequestMock
        .mockResolvedValueOnce([{ id: 'pos-inv-1' }])
        .mockResolvedValueOnce([{ id: 'txn-1', business_event_id: 'ev-inv-del' }])
        .mockResolvedValueOnce({ event: { id: 'ev-rev' } });

      await deleteHoldingTransaction('fund-ignored', 'asset-1', false, 'txn-1', {
        holderInvestorId: 'inv-1',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?holderInvestorId=inv-1&assetId=asset-1&holderSourceOfFundId=null',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/entries?positionIds=pos-inv-1',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        3,
        '/api/fund-ledger/events/ev-inv-del',
        {
          method: 'DELETE',
          body: JSON.stringify({ description: 'Transaction reversed' }),
        },
      );
    });
  });

  describe('listCommitmentEvents and Running Balances', () => {
    it('computes running balance independently per position', async () => {
      apiRequestMock.mockResolvedValueOnce({
        positions: [
          { id: 'pos-inv1', fund_id: 'f1', holder_investor_id: 'inv1' },
          { id: 'pos-inv2', fund_id: 'f1', holder_investor_id: 'inv2' },
        ],
        entries: [
          {
            id: 'e1',
            position_id: 'pos-inv1',
            entry_date: '2026-01-01',
            entry_type: 'commitment',
            commitment_delta: '10000000',
            currency: 'USD',
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'e2',
            position_id: 'pos-inv2',
            entry_date: '2026-01-01',
            entry_type: 'commitment',
            commitment_delta: '5000000',
            currency: 'USD',
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'e3',
            position_id: 'pos-inv1',
            entry_date: '2026-02-01',
            entry_type: 'commitment',
            commitment_delta: '2000000',
            currency: 'USD',
            created_at: '2026-02-01T00:00:00Z',
          },
        ],
      });

      const events = await listCommitmentEvents();
      expect(events).toHaveLength(3);

      const inv1Events = events.filter((e) => e.holding_entity_id === 'inv1');
      expect(inv1Events).toHaveLength(2);
      expect(inv1Events[0].runningBalance).toBe(10000000);
      expect(inv1Events[1].runningBalance).toBe(12000000);

      const inv2Events = events.filter((e) => e.holding_entity_id === 'inv2');
      expect(inv2Events).toHaveLength(1);
      expect(inv2Events[0].runningBalance).toBe(5000000); // independent from inv1!
    });

    it('updateCommitmentEvent on a transfer preserves both reciprocal legs with equal/opposite deltas', async () => {
      apiRequestMock
        .mockResolvedValueOnce({
          entries: [{ id: 'e-transfer-out', business_event_id: 'ev-transfer-1' }],
          positions: [],
        }) // getPortfolio
        .mockResolvedValueOnce({
          event: { id: 'ev-transfer-1', event_date: '2026-03-01', description: 'Transfer' },
          entries: [
            {
              id: 'e-transfer-out',
              position_id: 'pos-seller',
              counterparty_position_id: 'pos-buyer',
              entry_date: '2026-03-01',
              entry_type: 'commitment_transfer',
              sub_type: null,
              commitment_delta: '-1000000',
              currency: 'USD',
            },
            {
              id: 'e-transfer-in',
              position_id: 'pos-buyer',
              counterparty_position_id: 'pos-seller',
              entry_date: '2026-03-01',
              entry_type: 'commitment_transfer',
              sub_type: null,
              commitment_delta: '1000000',
              currency: 'USD',
            },
          ],
        }) // getEvent
        .mockResolvedValueOnce({ event: { id: 'ev-transfer-1-updated' } }); // updateEvent

      await updateCommitmentEvent('e-transfer-out', {
        effectiveDate: '2026-03-15',
        amount: 2500000,
        notes: 'Updated transfer amount',
      });

      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events/ev-transfer-1', {
        method: 'PATCH',
        body: JSON.stringify({
          event_date: '2026-03-15',
          description: 'Updated transfer amount',
          entries: [
            {
              position_id: 'pos-seller',
              counterparty_position_id: 'pos-buyer',
              entry_date: '2026-03-15',
              entry_type: 'commitment_transfer',
              sub_type: null,
              commitment_delta: '-2500000',
              quantity_delta: '0',
              cash_delta: '0',
              currency: 'USD',
              notes: 'Updated transfer amount',
            },
            {
              position_id: 'pos-buyer',
              counterparty_position_id: 'pos-seller',
              entry_date: '2026-03-15',
              entry_type: 'commitment_transfer',
              sub_type: null,
              commitment_delta: '2500000',
              quantity_delta: '0',
              cash_delta: '0',
              currency: 'USD',
              notes: 'Updated transfer amount',
            },
          ],
        }),
      });
    });

    it('createCommitmentEvent pins natural key including fundingSourceId and opens missing partition', async () => {
      apiRequestMock
        .mockResolvedValueOnce([]) // listPositions (0 found)
        .mockResolvedValueOnce({ id: 'pos-lp-1' }) // openPosition
        .mockResolvedValueOnce({ event: { id: 'ev-commit' } }); // postEvent

      await createCommitmentEvent({
        fundId: 'fund-1',
        holdingEntityId: 'inv-1',
        effectiveDate: '2026-01-15',
        eventType: 'initial_commitment',
        amount: 5000000,
        fundingSourceId: 'fs-1',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?fundId=fund-1&holderInvestorId=inv-1&holderSourceOfFundId=fs-1',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        2,
        '/api/fund-ledger/positions',
        {
          method: 'POST',
          body: JSON.stringify({
            holder_investor_id: 'inv-1',
            holder_fund_id: null,
            fund_id: 'fund-1',
            asset_id: null,
            holder_source_of_fund_id: 'fs-1',
            opened_at: '2026-01-15',
          }),
        },
      );
    });

    it('createCommitmentTransfer pins natural keys for both legs including distinct fundingSourceIds', async () => {
      apiRequestMock
        .mockResolvedValueOnce([]) // listPositions fromPos
        .mockResolvedValueOnce({ id: 'pos-from' }) // openPosition fromPos
        .mockResolvedValueOnce([]) // listPositions toPos
        .mockResolvedValueOnce({ id: 'pos-to' }) // openPosition toPos
        .mockResolvedValueOnce({ event: { id: 'ev-transfer' } }); // postEvent

      await createCommitmentTransfer({
        fundId: 'fund-1',
        fromHoldingEntityId: 'inv-1',
        toHoldingEntityId: 'inv-2',
        effectiveDate: '2026-02-01',
        amount: 1000000,
        fromFundingSourceId: 'fs-1',
        toFundingSourceId: 'fs-2',
      });

      expect(apiRequestMock).toHaveBeenNthCalledWith(
        1,
        '/api/fund-ledger/positions?fundId=fund-1&holderInvestorId=inv-1&holderSourceOfFundId=fs-1',
      );
      expect(apiRequestMock).toHaveBeenNthCalledWith(
        3,
        '/api/fund-ledger/positions?fundId=fund-1&holderInvestorId=inv-2&holderSourceOfFundId=fs-2',
      );
    });

    it('deleteCommitmentEvent reverses the shared business event', async () => {
      apiRequestMock
        .mockResolvedValueOnce({
          entries: [{ id: 'e-transfer-out', business_event_id: 'ev-transfer-1' }],
          positions: [],
        }) // getPortfolio
        .mockResolvedValueOnce({ success: true }); // reverseEvent

      await deleteCommitmentEvent('e-transfer-out');

      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/events/ev-transfer-1', {
        method: 'DELETE',
        body: JSON.stringify({ description: 'Commitment event reversed' }),
      });
    });
  });

  describe('AI Opinion', () => {
    it('triggerAiOpinion calls POST /api/fund-ledger/assets/:id/ai-opinion without body', async () => {
      apiRequestMock.mockResolvedValueOnce({ job_id: 'job-1' });
      const res = await triggerAiOpinion('asset-123');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/asset-123/ai-opinion', {
        method: 'POST',
      });
      expect(res).toEqual({ job_id: 'job-1' });
    });

    it('clearAiOpinion calls DELETE /api/fund-ledger/assets/:id/ai-opinion', async () => {
      apiRequestMock.mockResolvedValueOnce({ success: true });
      const res = await clearAiOpinion('asset-123');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/asset-123/ai-opinion', {
        method: 'DELETE',
      });
      expect(res).toEqual({ success: true });
    });

    it('getAiOpinion calls GET /api/fund-ledger/assets/:id/ai-opinion', async () => {
      apiRequestMock.mockResolvedValueOnce({ ai_opinion: { verdict: 'favorable' } });
      const res = await getAiOpinion('asset-123');
      expect(apiRequestMock).toHaveBeenCalledWith('/api/fund-ledger/assets/asset-123/ai-opinion');
      expect(res).toEqual({ ai_opinion: { verdict: 'favorable' } });
    });
  });

  describe('Regression: Double-unwrapping bug (does not evaluate second .data)', () => {
    it('getPortfolio returns the unwrapped read model with managed_funds intact', async () => {
      const unwrappedPayload = {
        managed_funds: [
          { id: 'f1', name: 'Fund Alpha', managed: true },
          { id: 'f2', name: 'Fund Beta', managed: true },
        ],
        funds: [],
        assets: [],
        positions: [],
        entries: [],
        funding_sources: [],
        investors: [],
      };
      // apiRequest returns the unwrapped data payload (no outer .data envelope)
      apiRequestMock.mockResolvedValueOnce(unwrappedPayload);

      const portfolio = await getPortfolio();
      // Verifies portfolio is NOT undefined, is not unwrapped twice, and managed_funds can be read
      expect(portfolio).toBeDefined();
      expect(portfolio.managed_funds).toHaveLength(2);
      expect(portfolio.managed_funds[0].name).toBe('Fund Alpha');
    });

    it('representative methods (list, create, update, delete, event, AI) return unwrapped response directly without accessing .data', async () => {
      // List
      apiRequestMock.mockResolvedValueOnce([{ id: 'f1' }]);
      const funds = await listFunds();
      expect(funds).toEqual([{ id: 'f1' }]);

      // Create
      apiRequestMock.mockResolvedValueOnce({ id: 'f1', name: 'Fund 1' });
      const createdFund = await createFund({ name: 'Fund 1' });
      expect(createdFund).toEqual({ id: 'f1', name: 'Fund 1' });

      // Update
      apiRequestMock.mockResolvedValueOnce({ id: 'f1', name: 'Fund Updated' });
      const updatedFund = await updateFund('f1', { name: 'Fund Updated' });
      expect(updatedFund).toEqual({ id: 'f1', name: 'Fund Updated' });

      // Delete (valuation)
      apiRequestMock.mockResolvedValueOnce({ success: true });
      const delVal = await deleteValuation('v1');
      expect(delVal).toEqual({ success: true });

      // Event (postEvent & getEvent)
      apiRequestMock.mockResolvedValueOnce({ event_id: 'ev-1' });
      const posted = await postEvent({ event_date: '2026-01-01', entries: [] });
      expect(posted).toEqual({ event_id: 'ev-1' });

      apiRequestMock.mockResolvedValueOnce({
        event: { id: 'ev-1' },
        entries: [],
      });
      const fetchedEvent = await getEvent('ev-1');
      expect(fetchedEvent).toEqual({ event: { id: 'ev-1' }, entries: [] });

      // AI Opinion
      apiRequestMock.mockResolvedValueOnce({ ai_opinion: { score: 95 } });
      const aiOpinion = await getAiOpinion('a1');
      expect(aiOpinion).toEqual({ ai_opinion: { score: 95 } });
    });
  });
});
