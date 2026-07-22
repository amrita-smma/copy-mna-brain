import { describe, it, expect, vi } from 'vitest';
import { processFundUpdateContent, buildLlmFundUpdateResult } from './index';
import * as fundUpdatesLib from '@/lib/fund_updates';
import * as llmExtractor from './llmExtractor';
import type { ParsedAsset } from '@/lib/fund_updates';

// Mock dependencies
vi.mock('@/lib/fund_updates', async () => {
  const actual = await vi.importActual<any>('@/lib/fund_updates');
  return {
    ...actual,
    tryDeterministicFundUpdateParse: vi.fn(),
  };
});

vi.mock('./llmExtractor', () => ({
  extractFundUpdateProposal: vi.fn(),
}));

describe('buildLlmFundUpdateResult', () => {
  it('returns a skeleton when assets are empty or null', () => {
    const result = buildLlmFundUpdateResult(null);
    expect(result.file_type).toBe('fund_updates');
    expect(result.parser).toBe('llm_fallback');
    expect(result.fund_update_proposal).toBeUndefined(); // Should not have a proposal
  });

  it('merges with baseResult and builds a full proposal when assets exist', () => {
    const mockAssets: ParsedAsset[] = [
      {
        code: 'asset1',
        name: 'Asset 1',
        assetType: 'direct_investment',
        txns: [{ date: '2023-01-01', type: 'contribution', valueAmount: 100 } as any],
        valuations: [],
      } as any
    ];

    const baseResult = {
      file_type: 'fund_updates' as const,
      summary: 'Base summary from general agent',
      tags: ['General Tag'],
      key_points: [],
      action_items: [],
      companies_detected: [],
      company_notes: [],
      file_date: null,
      suggested_track_ids: [],
      matched_companies: [],
    };

    const result = buildLlmFundUpdateResult(mockAssets, baseResult);
    expect(result.summary).toBe('Base summary from general agent');
    expect(result.tags).toContain('General Tag');
    expect(result.fund_update_proposal?.stats.asset_count).toBe(1);
    expect(result.fund_update_proposal?.stats.direct_count).toBe(1);
    expect(result.fund_update_proposal?.stats.transaction_count).toBe(1);
  });
});

describe('processFundUpdateContent', () => {
  it('returns deterministic result if tryDeterministicFundUpdateParse succeeds', async () => {
    const mockDeterministic = { file_type: 'fund_updates', parser: 'test_parser' };
    vi.mocked(fundUpdatesLib.tryDeterministicFundUpdateParse).mockResolvedValue(mockDeterministic as any);

    const result = await processFundUpdateContent('raw text', Buffer.from(''), 'application/pdf');
    expect(result).toBe(mockDeterministic);
  });

  it('falls back to LLM extractor if fingerprint misses', async () => {
    vi.mocked(fundUpdatesLib.tryDeterministicFundUpdateParse).mockResolvedValue(null);
    vi.mocked(llmExtractor.extractFundUpdateProposal).mockResolvedValue({
      assets: [{ name: 'Extracted Asset', txns: [], valuations: [] } as any]
    });

    const result = await processFundUpdateContent('raw text', Buffer.from(''), 'application/pdf');
    
    expect(llmExtractor.extractFundUpdateProposal).toHaveBeenCalled();
    expect(result.parser).toBe('llm_fallback');
    expect(result.fund_update_proposal?.assets[0].name).toBe('Extracted Asset');
  });
});
