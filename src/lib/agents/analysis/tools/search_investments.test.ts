import { afterEach, describe, expect, it, vi } from 'vitest';

const findAllAssetsMock = vi.fn();
const findByFundIdsMock = vi.fn();
const findAllFundsMock = vi.fn();
const findAllInvestorsMock = vi.fn();
const findAllSourcesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

const sourceOfFundsEnabledMock = vi.fn(async () => true);

vi.mock('@/lib/flags', () => ({
  sourceOfFundsEnabled: () => sourceOfFundsEnabledMock(),
}));

vi.mock('@/lib/repositories', () => ({
  FundAssetRepository: vi.fn(function FundAssetRepository() {
    return { findAll: findAllAssetsMock, findByFundIds: findByFundIdsMock };
  }),
  FundRepository: vi.fn(function FundRepository() {
    return { findAll: findAllFundsMock };
  }),
  HoldingEntityRepository: vi.fn(function HoldingEntityRepository() {
    return { findAll: findAllInvestorsMock };
  }),
  FundSourceRepository: vi.fn(function FundSourceRepository() {
    return { findAll: findAllSourcesMock };
  }),
}));

import { searchInvestments } from './search_investments';

const ACME_ID = '11111111-1111-1111-1111-111111111111';

const asset = (over: Record<string, unknown> = {}) => ({
  id: ACME_ID,
  asset_name: 'Acme Holdings',
  legal_name: 'Acme Holdings Pte Ltd',
  status: 'active',
  sector: 'Software',
  invested_capital_amount: 5_000_000,
  fmv_amount: 8_000_000,
  gross_moic: 1.8,
  dpi: 0.2,
  gross_irr: 0.22,
  ...over,
});

const fund = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  name: 'Growth Fund II',
  vintage_year: 2021,
  status: 'investing',
  commitment_size_amount: 100_000_000,
  called_amount: 60_000_000,
  fmv_amount: 80_000_000,
  realized_amount: 10_000_000,
  dpi: 0.17,
  tvpi: 1.5,
  irr: 0.18,
  ...over,
});

const investor = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  name: 'Tanaka Family Office',
  entity_type: 'family_office',
  invested_amount: 20_000_000,
  realized_amount: 5_000_000,
  fmv_amount: 26_000_000,
  dpi: 0.25,
  moic: 1.55,
  irr: 0.14,
  ...over,
});

const source = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Evergreen Capital Pool',
  invested_amount: 40_000_000,
  realized_amount: 12_000_000,
  fmv_amount: 45_000_000,
  dpi: 0.3,
  moic: 1.42,
  irr: 0.11,
  ...over,
});

/** Default: an empty portfolio, so each test only seeds what it cares about. */
const seed = (over: {
  assets?: unknown[];
  funds?: unknown[];
  investors?: unknown[];
  sources?: unknown[];
  assetFundPairs?: unknown[];
} = {}) => {
  findAllAssetsMock.mockResolvedValue(over.assets ?? []);
  findAllFundsMock.mockResolvedValue(over.funds ?? []);
  findAllInvestorsMock.mockResolvedValue(over.investors ?? []);
  findAllSourcesMock.mockResolvedValue(over.sources ?? []);
  findByFundIdsMock.mockResolvedValue(over.assetFundPairs ?? []);
};

afterEach(() => {
  vi.clearAllMocks();
  sourceOfFundsEnabledMock.mockResolvedValue(true);
});

describe('searchInvestments', () => {
  it('asks for a query when none is given', async () => {
    const result = (await searchInvestments.invoke({ query: '  ' })) as string;

    expect(result).toContain('Please provide a `query`');
    expect(findAllAssetsMock).not.toHaveBeenCalled();
  });

  it('finds a holding by a partial name and returns its fund_asset_id and fund', async () => {
    seed({
      assets: [asset()],
      funds: [fund()],
      assetFundPairs: [{ fundId: 'f1', asset: asset() }],
    });

    const result = (await searchInvestments.invoke({ query: 'acme' })) as string;

    expect(result).toContain('Holdings / fund assets (1)');
    expect(result).toContain('Acme Holdings');
    expect(result).toContain(ACME_ID);
    expect(result).toContain('Growth Fund II');
    expect(result).toContain('get_fund_asset_details');
  });

  it('matches a holding through its legal suffix and a typo', async () => {
    seed({ assets: [asset({ asset_name: 'Acme Holdings Pte Ltd' })] });

    const exact = (await searchInvestments.invoke({ query: 'Acme Holdings' })) as string;
    expect(exact).toContain('Acme Holdings');

    const typo = (await searchInvestments.invoke({ query: 'acne holdings' })) as string;
    expect(typo).toContain('Acme Holdings');
  });

  it('searches funds, investors, and capital sources in the same call', async () => {
    seed({ funds: [fund({ name: 'Meridian Fund' })] });
    expect((await searchInvestments.invoke({ query: 'meridian' })) as string).toContain(
      'Funds (1)',
    );

    seed({ investors: [investor()] });
    expect((await searchInvestments.invoke({ query: 'tanaka' })) as string).toContain(
      'Investors / LPs (1)',
    );

    seed({ sources: [source()] });
    expect((await searchInvestments.invoke({ query: 'evergreen' })) as string).toContain(
      'Sources of capital (1)',
    );
  });

  it('reports every entity type that matches one name and names the best match', async () => {
    seed({
      assets: [asset({ asset_name: 'Meridian Holdco' })],
      funds: [fund({ name: 'Meridian' })],
      investors: [investor({ name: 'Meridian Family Office' })],
    });

    const result = (await searchInvestments.invoke({ query: 'meridian' })) as string;

    expect(result).toContain('Portfolio matches for "meridian" (3)');
    expect(result).toContain('Holdings / fund assets (1)');
    expect(result).toContain('Funds (1)');
    expect(result).toContain('Investors / LPs (1)');
    // The fund is named exactly "Meridian", so it outranks the partial matches.
    expect(result).toContain('Best match: **Meridian** (fund, exact)');
    expect(result).toContain('genuinely ambiguous');
  });

  it('restricts the search to the requested types', async () => {
    seed({ funds: [fund({ name: 'Acme Fund' })] });

    const result = (await searchInvestments.invoke({
      query: 'acme',
      types: ['fund'],
    })) as string;

    expect(result).toContain('Funds (1)');
    expect(findAllAssetsMock).not.toHaveBeenCalled();
    expect(findAllInvestorsMock).not.toHaveBeenCalled();
    expect(findAllSourcesMock).not.toHaveBeenCalled();
  });

  it('caps hits per type at the requested limit', async () => {
    seed({
      investors: [
        investor({ id: 'i1', name: 'Acme Capital One' }),
        investor({ id: 'i2', name: 'Acme Capital Two' }),
        investor({ id: 'i3', name: 'Acme Capital Three' }),
      ],
    });

    const result = (await searchInvestments.invoke({ query: 'acme capital', limit: 2 })) as string;

    expect(result).toContain('Investors / LPs (2)');
  });

  it('maps assets to funds with ONE batched query, not one per asset', async () => {
    seed({
      assets: [
        asset({ id: ACME_ID, asset_name: 'Acme One' }),
        asset({ id: 'a2', asset_name: 'Acme Two' }),
      ],
      funds: [fund()],
      assetFundPairs: [
        { fundId: 'f1', asset: { id: ACME_ID } },
        { fundId: 'f1', asset: { id: 'a2' } },
      ],
    });

    await searchInvestments.invoke({ query: 'acme' });

    expect(findByFundIdsMock).toHaveBeenCalledTimes(1);
    expect(findByFundIdsMock).toHaveBeenCalledWith(['f1']);
  });

  it('labels an asset with no fund transactions as unassigned', async () => {
    seed({ assets: [asset()], funds: [fund()], assetFundPairs: [] });

    const result = (await searchInvestments.invoke({ query: 'acme' })) as string;

    expect(result).toContain('(unassigned)');
  });

  it('omits capital sources when the source-of-funds flag is off', async () => {
    sourceOfFundsEnabledMock.mockResolvedValue(false);
    seed({ funds: [fund({ name: 'Evergreen Fund' })], sources: [source()] });

    const result = (await searchInvestments.invoke({ query: 'evergreen' })) as string;

    expect(findAllSourcesMock).not.toHaveBeenCalled();
    expect(result).not.toContain('Sources of capital');
    expect(result).toContain('Funds (1)');
  });

  it('tells the agent where to look next when nothing matches', async () => {
    seed({ assets: [asset()], funds: [fund()], investors: [investor()], sources: [source()] });

    const result = (await searchInvestments.invoke({ query: 'zzz industries' })) as string;

    expect(result).toContain('No fund, holding, investor, or capital source');
    expect(result).toContain('valyu_search');
  });

  it('returns the error string when a repository throws', async () => {
    seed({});
    findAllAssetsMock.mockRejectedValueOnce(new Error('db down'));

    const result = (await searchInvestments.invoke({ query: 'acme' })) as string;

    expect(result).toBe('**Error:** db down');
  });
});
