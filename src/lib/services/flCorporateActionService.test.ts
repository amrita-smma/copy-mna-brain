import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlCorporateActionService } from './flCorporateActionService';
import {
  EntityNotFoundError,
  CorporateActionValidationError,
  WorkspaceMismatchError,
} from './flErrors';

const WS = 'ws-1';
const ASSET = 'asset-1';

const m = vi.hoisted(() => ({
  createAction: vi.fn(),
  findActionById: vi.fn(),
  findActionsByAssetIds: vi.fn(),
  updateAction: vi.fn(),
  deleteAction: vi.fn(),
  findChangesByActionIds: vi.fn(),
  insertChanges: vi.fn(),
  deleteChangesByActionId: vi.fn(),
  findLatestByPositionIds: vi.fn(),
  findLatestByAssetIds: vi.fn(),
  positionFindByIds: vi.fn(),
  positionFindByAssetIds: vi.fn(),
  assetFindById: vi.fn(),
  fundFindByIds: vi.fn(),
  investorFindByIds: vi.fn(),
  findAllByPositionIds: vi.fn(),
  transaction: vi.fn(),
}));

class MockRoundRepo {
  createAction = m.createAction;
  findActionById = m.findActionById;
  findActionsByAssetIds = m.findActionsByAssetIds;
  updateAction = m.updateAction;
  deleteAction = m.deleteAction;
  findChangesByActionIds = m.findChangesByActionIds;
  insertChanges = m.insertChanges;
  deleteChangesByActionId = m.deleteChangesByActionId;
}
class MockPositionRepo {
  findByIds = m.positionFindByIds;
  findByAssetIds = m.positionFindByAssetIds;
}
class MockAssetRepo {
  findById = m.assetFindById;
}
class MockFundRepo {
  findByIds = m.fundFindByIds;
}
class MockInvestorRepo {
  findByIds = m.investorFindByIds;
}

/**
 * A repository that allows only the named reads. Any other method access is
 * recorded and throws, which is how we prove a round moves nothing else.
 */
function readOnlyRepo(name: string, reads: Record<string, unknown>, touches: string[]) {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop in reads) return reads[prop];
        if (prop === 'then') return undefined;
        touches.push(prop);
        return () => {
          throw new Error(`${name} repository method ${prop} must not be called`);
        };
      },
    },
  );
}

/**
 * The ledger is only ever read (to cross-check follow-ons). Invested capital,
 * realized proceeds and contributions all derive from ledger entries, and a
 * round never writes one.
 */
const ledgerTouches: string[] = [];
const ledgerRepo = readOnlyRepo('ledger', { findAllByPositionIds: m.findAllByPositionIds }, ledgerTouches);

/**
 * Valuations are only ever read (to pre-fill a stake from a quarterly mark).
 * Market value derives from marks, and a round never writes, edits or deletes one.
 */
const valuationTouches: string[] = [];
const valuationRepo = readOnlyRepo(
  'valuation',
  {
    findLatestByPositionIds: m.findLatestByPositionIds,
    findLatestByAssetIds: m.findLatestByAssetIds,
  },
  valuationTouches,
);

const tx = { __tx: true };

function makeService() {
  return new FlCorporateActionService(
    { transaction: m.transaction } as never,
    new MockRoundRepo() as never,
    valuationRepo as never,
    new MockPositionRepo() as never,
    new MockAssetRepo() as never,
    new MockFundRepo() as never,
    new MockInvestorRepo() as never,
    ledgerRepo as never,
  );
}

function position(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS,
    asset_id: ASSET,
    holder_fund_id: `fund-${id}`,
    holder_investor_id: null,
    status: 'open',
    opened_at: '2024-01-01',
    ...over,
  };
}

const roundRow = {
  id: 'round-1',
  workspace_id: WS,
  asset_id: ASSET,
  action_date: '2025-06-30',
  label: 'Series B',
  currency: 'CNY',
  pre_money: '150000000.00000000',
  round_size: '50000000.00000000',
  notes: null,
  created_by: null,
  updated_by: null,
  created_at: '2025-07-01T00:00:00Z',
  updated_at: '2025-07-01T00:00:00Z',
};

const baseInput = {
  asset_id: ASSET,
  action_date: '2025-06-30',
  label: 'Series B',
  currency: 'CNY',
  pre_money: '150000000',
  round_size: '50000000',
  participants: [
    { position_id: 'pA', pct_before: '12', follow_on_amount: '5000000' },
    { position_id: 'pB', pct_before: '4' },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  ledgerTouches.length = 0;
  valuationTouches.length = 0;
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  m.assetFindById.mockResolvedValue({ id: ASSET, name: 'Co', asset_kind: 'equity' });
  m.positionFindByIds.mockImplementation(async (_ws: string, ids: string[]) =>
    ids.map((id) => position(id)),
  );
  m.createAction.mockResolvedValue(roundRow);
  m.updateAction.mockResolvedValue(roundRow);
  m.insertChanges.mockImplementation(async (rows: Array<Record<string, unknown>>) =>
    rows.map((r, i) => ({ ...r, id: `part-${i + 1}` })),
  );
  m.findActionsByAssetIds.mockResolvedValue([roundRow]);
  m.findChangesByActionIds.mockResolvedValue([]);
  m.fundFindByIds.mockImplementation(async (_ws: string, ids: string[]) =>
    ids.map((id) => ({ id, name: `Name of ${id}` })),
  );
  m.investorFindByIds.mockResolvedValue([]);
  m.findAllByPositionIds.mockResolvedValue([
    { position_id: 'pA', entry_type: 'buy', entry_date: '2025-07-10' },
  ]);
});

describe('FlCorporateActionService.record', () => {
  it("records each position's stake before and after, inside a transaction", async () => {
    const { action: round, warnings } = await makeService().record(WS, baseInput);

    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.insertChanges).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          corporate_action_id: 'round-1',
          position_id: 'pA',
          pct_before: '12.00000000',
          follow_on_amount: '5000000.00000000',
          // (12% × 150M + 5M) / 200M = 11.5%
          pct_after: '11.50000000',
          pct_override: null,
        }),
        // 4% × 150/200 = 3%
        expect.objectContaining({ position_id: 'pB', pct_after: '3.00000000' }),
      ],
      tx,
    );
    expect(warnings).toEqual([]);
    expect(round.post_money).toBe('200000000.00000000');
  });

  it('touches neither the ledger nor valuations, so invested, realized and market value are unchanged', async () => {
    await makeService().record(WS, baseInput);

    expect(ledgerTouches).toEqual([]);
    expect(valuationTouches).toEqual([]);
  });

  it('shows an implied value for reference without saving it', async () => {
    m.insertChanges.mockImplementation(async (rows: Array<Record<string, unknown>>) =>
      rows.map((r, i) => ({ ...r, id: `part-${i + 1}` })),
    );

    const { action: round } = await makeService().record(WS, baseInput);

    const pA = round.changes.find((p) => p.position_id === 'pA');
    expect(pA?.implied_value).toBe('23000000.00000000');
    expect(valuationTouches).toEqual([]);
  });

  it('records a manual stake override and its remark', async () => {
    await makeService().record(WS, {
      ...baseInput,
      participants: [
        { position_id: 'pB', pct_before: '4', pct_override: '3.5', override_remark: 'Anti-dilution' },
      ],
    });

    expect(m.insertChanges.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ pct_after: '3.00000000', pct_override: '3.50000000', override_remark: 'Anti-dilution' }),
    );
  });

  it('warns, without blocking, when a follow-on has no investment entry near the round date', async () => {
    m.findAllByPositionIds.mockResolvedValue([]);

    const { warnings } = await makeService().record(WS, baseInput);

    expect(m.insertChanges).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Name of fund-pA');
  });

  it("names the holder with its English name in the follow-on warning when it has one", async () => {
    m.findAllByPositionIds.mockResolvedValue([]);
    m.fundFindByIds.mockResolvedValue([{ id: 'fund-pA', name: '瑞来', english_name: 'Ruilai Fund' }]);

    const { warnings } = await makeService().record(WS, baseInput);

    expect(warnings[0]).toMatch(/^瑞来 \(Ruilai Fund\) put follow-on money/);
  });

  it('rejects a non-company asset before writing anything', async () => {
    m.assetFindById.mockResolvedValue({ id: ASSET, name: 'Loan', asset_kind: 'loan' });

    await expect(makeService().record(WS, baseInput)).rejects.toBeInstanceOf(CorporateActionValidationError);
    expect(m.createAction).not.toHaveBeenCalled();
  });

  it('rejects a fund-of-funds stake stored as an equity asset', async () => {
    m.assetFindById.mockResolvedValue({
      id: ASSET,
      name: 'Partnership',
      asset_kind: 'equity',
      instrument_terms: { investmentTypeLabel: 'Fund of Funds' },
    });

    await expect(makeService().record(WS, baseInput)).rejects.toBeInstanceOf(CorporateActionValidationError);
    expect(m.createAction).not.toHaveBeenCalled();
  });

  it('rejects a position that does not hold this company', async () => {
    m.positionFindByIds.mockImplementation(async (_ws: string, ids: string[]) =>
      ids.map((id) => position(id, id === 'pB' ? { asset_id: 'other-asset' } : {})),
    );

    await expect(makeService().record(WS, baseInput)).rejects.toBeInstanceOf(WorkspaceMismatchError);
    expect(m.createAction).not.toHaveBeenCalled();
  });

  it('rejects a closed position', async () => {
    m.positionFindByIds.mockImplementation(async (_ws: string, ids: string[]) =>
      ids.map((id) => position(id, { status: 'closed' })),
    );

    await expect(makeService().record(WS, baseInput)).rejects.toBeInstanceOf(CorporateActionValidationError);
  });

  it('rejects follow-on amounts larger than the round', async () => {
    await expect(
      makeService().record(WS, {
        ...baseInput,
        participants: [{ position_id: 'pA', pct_before: '12', follow_on_amount: '60000000' }],
      }),
    ).rejects.toThrow(/more than the round size/);
    expect(m.createAction).not.toHaveBeenCalled();
  });

  it('does not care whether a position already has a mark on the round date', async () => {
    m.findLatestByPositionIds.mockResolvedValue([{ id: 'manual-mark', position_id: 'pA', as_of_date: '2025-06-30' }]);

    await makeService().record(WS, baseInput);

    expect(m.insertChanges).toHaveBeenCalledTimes(1);
    expect(valuationTouches).toEqual([]);
  });

  it('rejects a malformed round date', async () => {
    await expect(
      makeService().record(WS, { ...baseInput, action_date: '30/06/2025' }),
    ).rejects.toBeInstanceOf(CorporateActionValidationError);
  });
});

describe('FlCorporateActionService.update', () => {
  beforeEach(() => {
    m.findActionById.mockResolvedValue(roundRow);
  });

  it("replaces the round's changes and leaves ledger and valuations alone", async () => {
    await makeService().update(WS, 'round-1', { ...baseInput, pre_money: '100000000' });

    expect(m.deleteChangesByActionId).toHaveBeenCalledWith('round-1', tx);
    expect(m.updateAction).toHaveBeenCalledWith(
      WS,
      'round-1',
      expect.objectContaining({ pre_money: '100000000' }),
      tx,
    );
    expect(m.insertChanges).toHaveBeenCalledTimes(1);
    expect(ledgerTouches).toEqual([]);
    expect(valuationTouches).toEqual([]);
  });

  it('throws when the round does not exist', async () => {
    m.findActionById.mockResolvedValue(undefined);

    await expect(makeService().update(WS, 'missing', baseInput)).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});

describe('FlCorporateActionService.delete', () => {
  it('deletes the round and nothing else', async () => {
    m.findActionById.mockResolvedValue(roundRow);

    await makeService().delete(WS, 'round-1');

    expect(m.deleteAction).toHaveBeenCalledWith(WS, 'round-1', tx);
    expect(ledgerTouches).toEqual([]);
    expect(valuationTouches).toEqual([]);
  });

  it('throws when the round does not exist', async () => {
    m.findActionById.mockResolvedValue(undefined);

    await expect(makeService().delete(WS, 'missing')).rejects.toBeInstanceOf(EntityNotFoundError);
    expect(m.deleteAction).not.toHaveBeenCalled();
  });
});

describe('FlCorporateActionService.getContext', () => {
  it("pre-fills each open position's stake from its latest mark and skips closed positions", async () => {
    m.positionFindByAssetIds.mockResolvedValue([
      position('pA'),
      position('pB'),
      position('pC', { status: 'closed' }),
    ]);
    m.findActionsByAssetIds.mockResolvedValue([]);
    m.findLatestByAssetIds.mockResolvedValue([]);
    m.findLatestByPositionIds.mockResolvedValue([
      {
        id: 'v1',
        position_id: 'pA',
        as_of_date: '2025-03-31',
        notes: 'Q1 | source_meta: {"shareholding_pct":12}',
      },
    ]);

    const ctx = await makeService().getContext(WS, ASSET);

    expect(ctx.positions.map((p) => p.position_id)).toEqual(['pA', 'pB']);
    expect(ctx.positions[0]).toEqual(
      expect.objectContaining({
        holder_kind: 'fund',
        holder_name: 'Name of fund-pA',
        current_pct: '12.00000000',
        current_pct_as_of: '2025-03-31',
      }),
    );
    expect(ctx.positions[1].current_pct).toBeNull();
    expect(m.findLatestByPositionIds).toHaveBeenCalledWith(WS, ['pA', 'pB'], null, undefined);
  });

  it('falls back to the asset mark when the company has a single holder', async () => {
    m.positionFindByAssetIds.mockResolvedValue([position('pA')]);
    m.findActionsByAssetIds.mockResolvedValue([]);
    m.findLatestByPositionIds.mockResolvedValue([]);
    m.findLatestByAssetIds.mockResolvedValue([
      { id: 'va', asset_id: ASSET, as_of_date: '2024-12-31', notes: 'source_meta: {"shareholding_pct":7.25}' },
    ]);

    const ctx = await makeService().getContext(WS, ASSET);

    expect(ctx.positions[0].current_pct).toBe('7.25000000');
  });

  it('flags a round whose starting stake no longer matches the round before it', async () => {
    const r1 = { ...roundRow, id: 'r1', action_date: '2025-01-31', created_at: '2025-02-01T00:00:00Z' };
    const r2 = { ...roundRow, id: 'r2', action_date: '2025-06-30', created_at: '2025-07-01T00:00:00Z' };
    m.positionFindByAssetIds.mockResolvedValue([position('pA')]);
    m.findActionsByAssetIds.mockResolvedValue([r1, r2]);
    m.findLatestByPositionIds.mockResolvedValue([]);
    m.findLatestByAssetIds.mockResolvedValue([]);
    m.findChangesByActionIds.mockResolvedValue([
      { id: 'a', corporate_action_id: 'r1', position_id: 'pA', pct_before: '12', follow_on_amount: '0', pct_after: '9', pct_override: null },
      // r2 was entered when r1 left pA at 10%; r1 has since been edited to 9%.
      { id: 'b', corporate_action_id: 'r2', position_id: 'pA', pct_before: '10', follow_on_amount: '0', pct_after: '7.5', pct_override: null },
    ]);

    const ctx = await makeService().getContext(WS, ASSET);

    expect(ctx.actions.map((r) => [r.id, r.stale])).toEqual([
      ['r1', false],
      ['r2', true],
    ]);
    // Implied value is re-derived from the stored stake: 7.5% of 200M post-money.
    expect(ctx.actions[1].changes[0].implied_value).toBe('15000000.00000000');
  });

  it("returns each holder's English name alongside its name, only when it differs", async () => {
    m.positionFindByAssetIds.mockResolvedValue([
      position('pA'),
      position('pB'),
      position('pC', { holder_fund_id: null, holder_investor_id: 'inv-1' }),
    ]);
    m.fundFindByIds.mockResolvedValue([
      { id: 'fund-pA', name: '瑞来', english_name: 'Ruilai Fund' },
      { id: 'fund-pB', name: 'Apex Ventures I', english_name: 'apex ventures i' },
    ]);
    m.investorFindByIds.mockResolvedValue([{ id: 'inv-1', name: '李雷', english_name: null }]);
    m.findActionsByAssetIds.mockResolvedValue([roundRow]);
    m.findLatestByPositionIds.mockResolvedValue([]);
    m.findLatestByAssetIds.mockResolvedValue([]);
    m.findChangesByActionIds.mockResolvedValue([
      { id: 'a', corporate_action_id: 'round-1', position_id: 'pA', pct_before: '12', follow_on_amount: '0', pct_after: '9', pct_override: null },
    ]);

    const ctx = await makeService().getContext(WS, ASSET);

    expect(ctx.positions.map((p) => [p.holder_name, p.holder_english_name])).toEqual([
      ['瑞来', 'Ruilai Fund'],
      ['Apex Ventures I', null],
      ['李雷', null],
    ]);
    expect(ctx.actions[0].changes[0]).toEqual(
      expect.objectContaining({ holder_name: '瑞来', holder_english_name: 'Ruilai Fund' }),
    );
  });

  it('throws when the asset does not exist', async () => {
    m.assetFindById.mockResolvedValue(undefined);

    await expect(makeService().getContext(WS, 'missing')).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});

describe('FlCorporateActionService — other corporate action types', () => {
  it('records an opening stake with no terms, from 0% to the stake entered, without reading the ledger', async () => {
    m.createAction.mockImplementation(async (row: Record<string, unknown>) => ({
      ...roundRow,
      ...row,
      id: 'open-1',
    }));
    m.insertChanges.mockImplementation(async (rows: Array<Record<string, unknown>>) =>
      rows.map((r, i) => ({ ...r, id: `part-${i + 1}` })),
    );
    m.findActionsByAssetIds.mockResolvedValue([]);

    const { action: round, warnings } = await makeService().record(WS, {
      asset_id: ASSET,
      action_type: 'opening_stake',
      action_date: '2024-01-01',
      participants: [{ position_id: 'pA', pct_after: '6' }],
    });

    expect(m.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'opening_stake',
        currency: null,
        pre_money: null,
        round_size: null,
      }),
      tx,
    );
    expect(m.insertChanges.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        position_id: 'pA',
        pct_before: '0.00000000',
        follow_on_amount: '0.00000000',
        pct_after: '6.00000000',
        pct_override: null,
      }),
    ]);
    expect(warnings).toEqual([]);
    expect(m.findAllByPositionIds).not.toHaveBeenCalled();
    expect(round.action_type).toBe('opening_stake');
    expect(round.post_money).toBeNull();
    expect(round.changes[0].implied_value).toBeNull();
    expect(ledgerTouches).toEqual([]);
    expect(valuationTouches).toEqual([]);
  });

  it('records another corporate action with the stakes as entered', async () => {
    await makeService().record(WS, {
      asset_id: ASSET,
      action_type: 'other',
      action_date: '2025-08-01',
      label: 'Share transfer',
      participants: [{ position_id: 'pA', pct_before: '6', pct_after: '5.5' }],
    });

    expect(m.insertChanges.mock.calls[0][0]).toEqual([
      expect.objectContaining({ pct_before: '6.00000000', pct_after: '5.50000000' }),
    ]);
    expect(valuationTouches).toEqual([]);
  });

  it('rejects an unknown action type before writing anything', async () => {
    await expect(
      makeService().record(WS, { ...baseInput, action_type: 'merger' as never }),
    ).rejects.toBeInstanceOf(CorporateActionValidationError);
    expect(m.createAction).not.toHaveBeenCalled();
  });

  it("keeps an action's type on update and ignores funding-round terms for it", async () => {
    m.findActionById.mockResolvedValue({ ...roundRow, action_type: 'opening_stake', currency: null, pre_money: null, round_size: null });

    await makeService().update(WS, 'round-1', {
      action_date: '2024-01-01',
      pre_money: '999',
      round_size: '1',
      participants: [{ position_id: 'pA', pct_after: '7' }],
    });

    expect(m.updateAction).toHaveBeenCalledWith(
      WS,
      'round-1',
      expect.objectContaining({ currency: null, pre_money: null, round_size: null }),
      tx,
    );
    expect(m.insertChanges.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ pct_before: '0.00000000', pct_after: '7.00000000' }),
    );
  });
});

describe('FlCorporateActionService.getContext — ownership history', () => {
  it("takes each position's current stake from its latest ownership event over a quarterly mark", async () => {
    const open = {
      ...roundRow,
      id: 'open',
      action_type: 'opening_stake',
      action_date: '2024-01-01',
      currency: null,
      pre_money: null,
      round_size: null,
      created_at: '2024-01-02T00:00:00Z',
    };
    const series = { ...roundRow, id: 'series-b', action_date: '2025-06-30' };
    m.positionFindByAssetIds.mockResolvedValue([position('pA'), position('pB')]);
    m.findActionsByAssetIds.mockResolvedValue([open, series]);
    m.findLatestByAssetIds.mockResolvedValue([]);
    m.findLatestByPositionIds.mockResolvedValue([
      // A quarterly mark says 20%, but pA has ownership history, which wins.
      { id: 'v1', position_id: 'pA', as_of_date: '2025-09-30', notes: 'source_meta: {"shareholding_pct":20}' },
      { id: 'v2', position_id: 'pB', as_of_date: '2025-09-30', notes: 'source_meta: {"shareholding_pct":4}' },
    ]);
    m.findChangesByActionIds.mockResolvedValue([
      { id: 'a', corporate_action_id: 'open', position_id: 'pA', pct_before: '0', follow_on_amount: '0', pct_after: '12', pct_override: null },
      { id: 'b', corporate_action_id: 'series-b', position_id: 'pA', pct_before: '12', follow_on_amount: '5000000', pct_after: '11.5', pct_override: null },
    ]);

    const ctx = await makeService().getContext(WS, ASSET);

    expect(ctx.positions[0]).toEqual(
      expect.objectContaining({
        position_id: 'pA',
        current_pct: '11.50000000',
        current_pct_as_of: '2025-06-30',
        current_pct_source: 'ownership',
        current_pct_event_id: 'series-b',
      }),
    );
    // No ownership history yet: falls back to the quarterly mark.
    expect(ctx.positions[1]).toEqual(
      expect.objectContaining({ position_id: 'pB', current_pct: '4.00000000', current_pct_source: 'valuation' }),
    );
    expect(ctx.actions.map((r) => [r.id, r.action_type, r.stale])).toEqual([
      ['open', 'opening_stake', false],
      ['series-b', 'funding_round', false],
    ]);
  });
});
