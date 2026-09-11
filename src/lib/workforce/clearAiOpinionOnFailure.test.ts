import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findAssetById, updateAsset, companyMark } = vi.hoisted(() => ({
  findAssetById: vi.fn(),
  updateAsset: vi.fn(),
  companyMark: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  FlAssetRepository: class {
    findById = findAssetById;
    update = updateAsset;
  },
  CompanyRepository: class {
    markAiOpinionFailedIfProcessing = companyMark;
  },
}));

import { failAiOpinionIfStillProcessing } from './clearAiOpinionOnFailure';

describe('failAiOpinionIfStillProcessing', () => {
  beforeEach(() => {
    findAssetById.mockReset();
    updateAsset.mockReset();
    companyMark.mockReset();
  });

  it('no-ops on missing or non-object trigger_meta', async () => {
    await failAiOpinionIfStillProcessing({} as never, 'ws-1', null, 'fund_ai_opinion');
    await failAiOpinionIfStillProcessing({} as never, 'ws-1', 'x', 'ai_opinion');
    expect(findAssetById).not.toHaveBeenCalled();
    expect(companyMark).not.toHaveBeenCalled();
  });

  it('no-ops for non-opinion agent names even when trigger_meta has ids', async () => {
    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { company_id: 'c-1', asset_id: 'a-1' },
      'company_card',
    );
    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { company_id: 'c-1' },
      undefined,
    );
    expect(findAssetById).not.toHaveBeenCalled();
    expect(companyMark).not.toHaveBeenCalled();
  });

  it('marks a processing fund asset as failed in fl_assets.instrument_terms', async () => {
    findAssetById.mockResolvedValueOnce({
      id: 'asset-1',
      instrument_terms: {
        aiOpinion: {
          status: 'processing',
        },
      },
    });
    updateAsset.mockResolvedValueOnce({ id: 'asset-1' });

    await failAiOpinionIfStillProcessing(
      {} as never,
      'ws-1',
      { asset_id: 'asset-1' },
      'fund_ai_opinion',
    );
    expect(findAssetById).toHaveBeenCalledWith('ws-1', 'asset-1');
    expect(updateAsset).toHaveBeenCalledWith('ws-1', 'asset-1', {
      instrument_terms: {
        aiOpinion: {
          status: 'failed',
        },
      },
    });
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
    findAssetById.mockRejectedValueOnce(new Error('db down'));
    await expect(
      failAiOpinionIfStillProcessing(
        {} as never,
        'ws-1',
        { asset_id: 'asset-1' },
        'fund_ai_opinion',
      ),
    ).resolves.toBeUndefined();
  });
});
