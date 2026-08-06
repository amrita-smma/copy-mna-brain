import { afterEach, describe, expect, it, vi } from 'vitest';

const findByIdMock = vi.fn();
const findAllMock = vi.fn();
const findValuationsMock = vi.fn();
const findTxnsMock = vi.fn();
const findFundsMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/repositories', () => ({
  FundAssetRepository: vi.fn(function FundAssetRepository() {
    return { findById: findByIdMock, findAll: findAllMock };
  }),
  FundAssetValuationRepository: vi.fn(function FundAssetValuationRepository() {
    return { findByFundAssetId: findValuationsMock };
  }),
  FundAssetTransactionRepository: vi.fn(function FundAssetTransactionRepository() {
    return { findByFundAssetId: findTxnsMock };
  }),
  FundRepository: vi.fn(function FundRepository() {
    return { findAll: findFundsMock };
  }),
}));

import { getFundAssetDetails } from './get_fund_asset_details';

afterEach(() => vi.clearAllMocks());

const asset = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  asset_name: 'Acme Holdco',
  legal_name: 'Acme Holdco Ltd',
  asset_type: 'direct_investment',
  sector: 'Software',
  sub_sector: 'SaaS',
  status: 'active',
  country: 'US',
  stake_pct: 12.5,
  invested_capital_amount: 5_000_000,
  commitment_amount: 6_000_000,
  net_distribution_amount: 1_000_000,
  fmv_amount: 8_000_000,
  gross_moic: 1.8,
  dpi: 0.2,
  gross_irr: 0.22,
  entry_date: '2022-01-15',
  maturity_date: null,
  investment_currency: 'USD',
  report_currency: 'USD',
  key_rights: 'Board seat',
  investment_description: 'Series B lead.',
  share_count: 1000,
  current_price_per_share: 80,
  ai_opinion_verdict: 'hold',
  ai_opinion_summary: 'Fairly valued SaaS asset.',
  ai_opinion_status: 'completed',
  ai_opinion_confidence: 'medium',
  ai_opinion_data_gaps: null,
  ai_opinion_updated_at: '2026-08-01T00:00:00Z',
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
        market_value_amount: 8_000_000,
        currency: 'USD',
        gross_moic: 1.8,
        dpi: 0.2,
        gross_xirr: 0.22,
      },
    ]);
    findTxnsMock.mockResolvedValueOnce([{ fund_id: 'f1' }]);
    findFundsMock.mockResolvedValueOnce([{ id: 'f1', name: 'Growth Fund II' }]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: ASSET_ID })) as string;

    expect(findByIdMock).toHaveBeenCalledWith(ASSET_ID);
    expect(result).toContain(`Fund Asset ID (UUID):** ${ASSET_ID}`);
    expect(result).toContain('Acme Holdco');
    expect(result).toContain('Growth Fund II');
    expect(result).toContain('Series B lead.');
    expect(result).toContain('Board seat');
    expect(result).toContain('2026-06-30');
    expect(result).toContain('**Verdict:** hold');
    expect(result).toContain('Unfunded commitment');
  });

  it('returns not-found for an unknown fund_asset_id', async () => {
    findByIdMock.mockResolvedValueOnce(undefined);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: MISSING_ID })) as string;

    expect(result).toContain(`No fund asset found for fund_asset_id "${MISSING_ID}"`);
  });

  it('treats a non-UUID fund_asset_id as an asset_name search (avoids Postgres UUID errors)', async () => {
    findAllMock.mockResolvedValueOnce([asset()]);
    findValuationsMock.mockResolvedValueOnce([]);
    findTxnsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ fund_asset_id: 'Acme' })) as string;

    expect(findByIdMock).not.toHaveBeenCalled();
    expect(findAllMock).toHaveBeenCalled();
    expect(result).toContain('Acme Holdco');
  });

  it('looks up by asset name when id is omitted', async () => {
    findAllMock.mockResolvedValueOnce([
      asset(),
      asset({
        id: '33333333-3333-3333-3333-333333333333',
        asset_name: 'Other Co',
        legal_name: 'Other Co LLC',
      }),
    ]);
    findValuationsMock.mockResolvedValueOnce([]);
    findTxnsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'acme' })) as string;

    expect(findByIdMock).not.toHaveBeenCalled();
    expect(findAllMock).toHaveBeenCalled();
    expect(result).toContain('Acme Holdco');
    expect(result).toContain('(unassigned)');
    expect(result).toContain('No valuation history on record');
  });

  it('asks to disambiguate when multiple name matches exist', async () => {
    findAllMock.mockResolvedValueOnce([
      asset({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', asset_name: 'Acme One' }),
      asset({
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        asset_name: 'Acme Two',
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
    findAllMock.mockResolvedValueOnce([
      asset({ asset_name: 'Acme Holdco Pte Ltd', legal_name: 'Acme Holdco Private Limited' }),
    ]);
    findValuationsMock.mockResolvedValueOnce([]);
    findTxnsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acme Holdco' })) as string;

    expect(result).toContain('Acme Holdco Pte Ltd');
  });

  it('resolves a misspelled name', async () => {
    findAllMock.mockResolvedValueOnce([asset()]);
    findValuationsMock.mockResolvedValueOnce([]);
    findTxnsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acne Holdco' })) as string;

    expect(result).toContain('Acme Holdco');
  });

  it('picks the decisive winner instead of asking to disambiguate a far weaker match', async () => {
    findAllMock.mockResolvedValueOnce([
      asset({ asset_name: 'Acme Holdco', legal_name: null }),
      asset({
        id: '44444444-4444-4444-4444-444444444444',
        asset_name: 'Acme Holdings',
        legal_name: null,
      }),
    ]);
    findValuationsMock.mockResolvedValueOnce([]);
    findTxnsMock.mockResolvedValueOnce([]);
    findFundsMock.mockResolvedValueOnce([]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'Acme Holdco' })) as string;

    expect(result).not.toContain('Multiple holdings match');
    expect(result).toContain(`Fund Asset ID (UUID):** ${ASSET_ID}`);
  });

  it('returns not-found when the name matches nothing, pointing at search_investments', async () => {
    findAllMock.mockResolvedValueOnce([asset()]);

    const result = (await getFundAssetDetails.invoke({ asset_name: 'zzzz' })) as string;

    expect(result).toContain('No fund asset found matching "zzzz"');
    expect(result).toContain('search_investments');
  });
});
