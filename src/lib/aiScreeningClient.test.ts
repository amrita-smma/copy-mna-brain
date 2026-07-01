import { describe, it, expect } from 'vitest';
import { toAIScreeningCompany } from './aiScreeningClient';
import { buildTrackScreeningGroups, type TrackLike } from '@/lib/tracks/matchTracks';
import type { PipelineCompany } from '@/views/Pipeline';

const baseCompany = (overrides: Partial<PipelineCompany> = {}): PipelineCompany =>
  ({
    id: 'co-1',
    matched_track_ids: [],
    ...overrides,
  } as PipelineCompany);

describe('toAIScreeningCompany', () => {
  it('copies matched_track_ids through onto the returned object when present', () => {
    const company = baseCompany({ matched_track_ids: ['semi', 'renew'] });
    expect(toAIScreeningCompany(company).matched_track_ids).toEqual(['semi', 'renew']);
  });

  it('defaults matched_track_ids to [] when absent', () => {
    const company = baseCompany({ matched_track_ids: undefined as never });
    expect(toAIScreeningCompany(company).matched_track_ids).toEqual([]);
  });

  it('preserves the company id', () => {
    expect(toAIScreeningCompany(baseCompany({ id: 'abc' })).id).toBe('abc');
  });
});

describe('toAIScreeningCompany + buildTrackScreeningGroups integration', () => {
  const TRACKS: TrackLike[] = [
    { id: 'semi', title: 'Semiconductor', content: 'CMP, photoresist', pic: 'Alice' },
    { id: 'renew', title: 'Renewables', content: 'Solar, battery', pic: 'Bob' },
  ];
  const CRITERIA = [
    { id: 'c1', investment_thesis_id: 'semi' },
    { id: 'c2', investment_thesis_id: 'renew' },
  ];

  it('yields non-empty screening groups for a company with matched_track_ids + matching criteria', () => {
    const input = toAIScreeningCompany(baseCompany({ matched_track_ids: ['semi', 'renew'] }));
    expect(buildTrackScreeningGroups(input, TRACKS, CRITERIA)).toEqual([
      { trackId: 'semi', criteriaIds: ['c1'] },
      { trackId: 'renew', criteriaIds: ['c2'] },
    ]);
  });

  it('yields empty groups when no track is matched (so the screening error would fire)', () => {
    const input = toAIScreeningCompany(baseCompany({ matched_track_ids: [] }));
    expect(buildTrackScreeningGroups(input, TRACKS, CRITERIA)).toEqual([]);
  });
});
