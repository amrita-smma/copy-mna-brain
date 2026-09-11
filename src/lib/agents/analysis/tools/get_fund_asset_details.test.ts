import { beforeEach, describe, expect, it, vi } from 'vitest';

const findByIdMock = vi.fn();
const findByWorkspaceIdMock = vi.fn();
const findValuationsMock = vi.fn();
const findPositionsMock = vi.fn();
const findFundsMock = vi.fn();
const findInvestorsMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/repositories', () => ({
  FlAssetRepository: vi.fn(function FlAssetRepository() {
    return { findById: findByIdMock, findByWorkspaceId: findByWorkspaceIdMock };
  }),
  FlValuationRepository: vi.fn(function FlValuationRepository() {
    return { findSeriesByTarget: findValuationsMock };
  }),
  FlPositionRepository: vi.fn(function FlPositionRepository() {
    return { findByAssetIds: findPositionsMock };
  }),
  FlFundRepository: vi.fn(function FlFundRepository() {
    return { findByIds: findFundsMock, findByWorkspaceId: findFundsMock };
  }),
  FlInvestorRepository: vi.fn(function FlInvestorRepository() {
    return { findByIds: findInvestorsMock, findByWorkspaceId: findInvestorsMock };
  }),
}));

import { getFundAssetDetails } from './get_fund_asset_details';

beforeEach(() => {
  findByIdMock.mockReset();
  findByWorkspaceIdMock.mockReset();
  findValuationsMock.mockReset();
  findPositionsMock.mockReset();
  findFundsMock.mockReset();
  findInvestorsMock.mockReset();
});

const asset = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  workspace_id: 'ws-1',
  name: 'Acme Holdco',
  legal_name: 'Acme Holdco Ltd',
  asset_kind: 'direct_investment',
  sector: 'Software',
  sub_sector: 'SaaS',
  country: 'US',
  description: 'Series B lead.',
  instrument_terms: {
    stakePct: 12.5,
    keyRights: 'Board seat',
    aiOpinion: {
      verdict: 'hold',
      summary: 'Fairly valued SaaS asset.',
      status: 'completed',
      confidence: 'medium',
      data_gaps: null,
      updated_at: '2026-08-01T00:00:00Z',
    },
  },
  ...over,
});

const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const MISSING_ID = '22222222-2222-2222-2222-222222222222';

describe('getFundAssetDetails', () => {
  it('requires fund_asset_id or asset_name', async () => {
    const result = (await getFundAssetDetails.invoke({})) as string;
    expect(result).toMatch(/fund_asset_id or asset_name/);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('returns details when looked up by fund_asset_id', async () => {
    findByIdMock.mockResolvedValueOnce(asset());
    findValuationsMock.mockResolvedValueOnce([
      {
        as_of_date: '2026-06-30',
        market_value: '8000000.00',
        currency: 'USD',
        price_per_unit: '80.00',
        valuation_method: 'comparables',
      },
    ]);
    findPositionsMock.mockResolvedValueOnce([{ holder_fund_id: 'f1' }]);
    findFundsMock.mockResolvedValueOnce([{ id: 'f1', name: 'Growth Fund II' }]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: ASSET_ID })) as string;

    expect(findByIdMock).toHaveBeenCalledWith('ws-1', ASSET_ID);
    expect(result).toContain(`Fund Asset ID (UUID):** ${ASSET_ID}`);
    expect(result).toContain('Acme Holdco');
    expect(result).toContain('Growth Fund II');
    expect(result).toContain('Series B lead.');
    expect(result).toContain('Board seat');
    expect(result).toContain('2026-06-30');
    expect(result).toContain('**Verdict:** hold');
  });

  it('returns not-found for an unknown fund_asset_id', async () => {
    findByIdMock.mockResolvedValueOnce(undefined);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: MISSING_ID })) as string;

    expect(result).toContain(`No fund asset found for fund_asset_id "${MISSING_ID}"`);
  });

  it('treats a non-UUID fund_asset_id as an asset_name search (avoids Postgres UUID errors)', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([asset()]);
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: 'Acme' })) as string;

    expect(findByIdMock).not.toHaveBeenCalled();
    expect(findByWorkspaceIdMock).toHaveBeenCalled();
    expect(result).toContain('Acme Holdco');
  });

  it('looks up by asset name when id is omitted', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([
      asset(),
      asset({
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Other Co',
        legal_name: 'Other Co LLC',
      }),
    ]);
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'acme' })) as string;

    expect(findByIdMock).not.toHaveBeenCalled();
    expect(findByWorkspaceIdMock).toHaveBeenCalled();
    expect(result).toContain('Acme Holdco');
    expect(result).toContain('(unassigned)');
    expect(result).toContain('No valuation history on record');
  });

  it('asks to disambiguate when multiple name matches exist', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([
      asset({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Acme One' }),
      asset({
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        name: 'Acme Two',
        legal_name: 'Acme Two LLC',
      }),
    ]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acme' })) as string;

    expect(result).toContain('Multiple holdings match');
    expect(result).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(findValuationsMock).not.toHaveBeenCalled();
  });

  it('resolves a name that only matches once legal suffixes are ignored', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([
      asset({ name: 'Acme Holdco Pte Ltd', legal_name: 'Acme Holdco Private Limited' }),
    ]);
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acme Holdco' })) as string;

    expect(result).toContain('Acme Holdco Pte Ltd');
  });

  it('resolves a misspelled name', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([asset()]);
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acne Holdco' })) as string;

    expect(result).toContain('Acme Holdco');
  });

  it('picks the decisive winner instead of asking to disambiguate a far weaker match', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([
      asset({ name: 'Acme Holdco', legal_name: null }),
      asset({
        id: '44444444-4444-4444-4444-444444444444',
        name: 'Acme Holdings',
        legal_name: null,
      }),
    ]);
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acme Holdco' })) as string;

    expect(result).not.toContain('Multiple holdings match');
    expect(result).toContain(`Fund Asset ID (UUID):** ${ASSET_ID}`);
  });

  it('returns not-found when the name matches nothing, pointing at search_investments', async () => {
    findByWorkspaceIdMock.mockResolvedValueOnce([asset()]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'zzzz' })) as string;

    expect(result).toContain('No fund asset found matching "zzzz"');
    expect(result).toContain('search_investments');
  });

  it('lists an investor as holder and displays (group name) when investor has a parent', async () => {
    findByIdMock.mockResolvedValueOnce(asset());
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([
      { holder_investor_id: 'inv-1', holder_fund_id: null },
    ]);
    findInvestorsMock
      .mockResolvedValueOnce([
        { id: 'inv-1', name: 'Startech Early Stage SPV', parent_investor_id: 'inv-group' },
      ])
      .mockResolvedValueOnce([
        { id: 'inv-group', name: 'Startech Group', parent_investor_id: null },
      ]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: ASSET_ID })) as string;

    expect(result).toContain('Holders:** Startech Early Stage SPV (Startech Group)');
    expect(findInvestorsMock).toHaveBeenCalledTimes(2);
    expect(findInvestorsMock).toHaveBeenNthCalledWith(1, 'ws-1', ['inv-1']);
    expect(findInvestorsMock).toHaveBeenNthCalledWith(2, 'ws-1', ['inv-group']);
  });

  it('batches investor lookup into a single call for N positions without per-position queries', async () => {
    findByIdMock.mockResolvedValueOnce(asset());
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([
      { holder_investor_id: 'inv-1', holder_fund_id: null },
      { holder_investor_id: 'inv-2', holder_fund_id: null },
      { holder_investor_id: 'inv-3', holder_fund_id: null },
    ]);
    findInvestorsMock.mockResolvedValueOnce([
      { id: 'inv-1', name: 'Alpha Investor', parent_investor_id: null },
      { id: 'inv-2', name: 'Beta Investor', parent_investor_id: null },
      { id: 'inv-3', name: 'Gamma Investor', parent_investor_id: null },
    ]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: ASSET_ID })) as string;

    expect(result).toContain('Holders:** Alpha Investor, Beta Investor, Gamma Investor');
    expect(findInvestorsMock).toHaveBeenCalledTimes(1);
    expect(findInvestorsMock).toHaveBeenCalledWith('ws-1', ['inv-1', 'inv-2', 'inv-3']);
  });

  it('lists both fund and investor holders together', async () => {
    findByIdMock.mockResolvedValueOnce(asset());
    findValuationsMock.mockResolvedValueOnce([]);
    findPositionsMock.mockResolvedValueOnce([
      { holder_fund_id: 'f1', holder_investor_id: null },
      { holder_investor_id: 'inv-1', holder_fund_id: null },
    ]);
    findFundsMock.mockResolvedValueOnce([{ id: 'f1', name: 'Growth Fund II' }]);
    findInvestorsMock.mockResolvedValueOnce([
      { id: 'inv-1', name: 'Tanaka Family Office', parent_investor_id: null },
    ]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: ASSET_ID })) as string;

    expect(result).toContain('Holders:** Growth Fund II, Tanaka Family Office');
  });
});
