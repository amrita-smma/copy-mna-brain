import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fundMark, companyMark } = vi.hoisted(() => ({
  fundMark: vi.fn(),
  companyMark: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  FundAssetRepository: class {
    markAiOpinionFailedIfProcessing = fundMark;
  },
  CompanyRepository: class {
    markAiOpinionFailedIfProcessing = companyMark;
  },
}));

import { failAiOpinionIfStillProcessing } from './clearAiOpinionOnFailure';

describe('failAiOpinionIfStillProcessing', () => {
  beforeEach(() => {
    fundMark.mockReset();
    companyMark.mockReset();
  });

  it('no-ops on missing or non-object trigger_meta', async () => {
    await failAiOpinionIfStillProcessing({} as never, 'ws-1', null, 'fund_ai_opinion');
    await failAiOpinionIfStillProcessing({} as never, 'ws-1', 'x', 'ai_opinion');
    expect(fundMark).not.toHaveBeenCalled();
    expect(companyMark).not.toHaveBeenCalled();
  });

  it('no-ops for non-opinion agent names even when trigger_meta has ids', async () => {
    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { company_id: 'c-1', fund_asset_id: 'a-1' },
      'company_card',
    );
    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { company_id: 'c-1' },
      undefined,
    );
    expect(fundMark).not.toHaveBeenCalled();
    expect(companyMark).not.toHaveBeenCalled();
  });

  it('marks a processing fund asset as failed via the atomic conditional update', async () => {
    fundMark.mockResolvedValueOnce(undefined);
    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { fund_asset_id: 'asset-1' },
      'fund_ai_opinion',
    );
    expect(fundMark).toHaveBeenCalledWith('asset-1');
  });

  it('marks a processing company as failed via the atomic conditional update', async () => {
    companyMark.mockResolvedValueOnce(undefined);
    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { company_id: 'c-1' },
      'ai_opinion',
    );
    expect(companyMark).toHaveBeenCalledWith('c-1');
  });

  it('swallows repository errors so queue failure handling still completes', async () => {
    fundMark.mockRejectedValueOnce(new Error('db down'));
    await expect(
      failAiOpinionIfStillProcessing(
        {} as never,
        'ws-1',
        { fund_asset_id: 'asset-1' },
        'fund_ai_opinion',
      ),
    ).resolves.toBeUndefined();
  });
});
