import { describe, it, expect } from 'vitest';
import {
  suggestTrackIds,
  resolveTrackIds,
  buildTrackScreeningGroups,
  trackDisplayName,
  matchedTrackPics,
  type TrackLike,
  type MatchableCompany,
} from './matchTracks';

const TRACKS: TrackLike[] = [
  {
    id: 'semi',
    title: 'Semiconductor & Materials — APAC Inbound',
    content: 'CMP, photoresist, wet chemicals, lithography, advanced packaging',
    pic: 'Alice',
  },
  {
    id: 'renew',
    title: 'Renewables — Southeast Asia',
    content: 'Solar, battery storage, grid infrastructure, hydropower',
    pic: 'Bob',
  },
];

describe('suggestTrackIds', () => {
  it('matches a track whose thesis keyword appears in the company text', () => {
    const company: MatchableCompany = {
      segment: 'Photoresist — ArF & KrF',
      geography: 'South Korea',
    };
    expect(suggestTrackIds(company, TRACKS)).toEqual(['semi']);
  });

  it('matches via the track name keywords too', () => {
    const company: MatchableCompany = { segment: 'Renewable Energy — Hydropower' };
    expect(suggestTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('can suggest multiple tracks', () => {
    const company: MatchableCompany = {
      segment: 'Semiconductor packaging and solar battery systems',
    };
    expect(suggestTrackIds(company, TRACKS)).toEqual(['semi', 'renew']);
  });

  it('returns [] when nothing matches', () => {
    const company: MatchableCompany = { segment: 'Telecom billing software services' };
    expect(suggestTrackIds(company, TRACKS)).toEqual([]);
  });

  it('returns [] when the company has no descriptive text', () => {
    expect(suggestTrackIds({}, TRACKS)).toEqual([]);
  });
});

describe('resolveTrackIds', () => {
  it('returns the persisted matched_track_ids', () => {
    const company: MatchableCompany = { matched_track_ids: ['renew'] };
    expect(resolveTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('drops persisted ids for tracks that no longer exist', () => {
    const company: MatchableCompany = { matched_track_ids: ['renew', 'deleted'] };
    expect(resolveTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('falls back to auto-suggested tracks when nothing is persisted', () => {
    const company: MatchableCompany = {
      segment: 'Photoresist solvents', // matches "semi" via suggestTrackIds
      matched_track_ids: [],
    };
    expect(resolveTrackIds(company, TRACKS)).toEqual(['semi']);
  });

  it('falls back to auto-suggested tracks when matched_track_ids is absent', () => {
    const company: MatchableCompany = { segment: 'Renewable Energy — Hydropower' };
    expect(resolveTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('prefers persisted matches over suggestions and does not mix them in', () => {
    const company: MatchableCompany = {
      segment: 'Photoresist solvents', // would suggest "semi"
      matched_track_ids: ['renew'], // but a manual match exists
    };
    expect(resolveTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('returns [] when nothing is persisted and nothing matches', () => {
    const company: MatchableCompany = {
      segment: 'Telecom billing software services',
      matched_track_ids: [],
    };
    expect(resolveTrackIds(company, TRACKS)).toEqual([]);
  });
});

describe('buildTrackScreeningGroups', () => {
  const CRITERIA = [
    { id: 'c1', investment_thesis_id: 'semi' },
    { id: 'c2', investment_thesis_id: 'semi' },
    { id: 'c3', investment_thesis_id: 'renew' },
  ];

  it('returns one group per matched track, carrying each track criteria', () => {
    const company: MatchableCompany = { matched_track_ids: ['semi', 'renew'] };
    expect(buildTrackScreeningGroups(company, TRACKS, CRITERIA)).toEqual([
      { trackId: 'semi', criteriaIds: ['c1', 'c2'] },
      { trackId: 'renew', criteriaIds: ['c3'] },
    ]);
  });

  it('skips matched tracks that have no criteria', () => {
    const criteria = [{ id: 'c1', investment_thesis_id: 'semi' }]; // renew has none
    const company: MatchableCompany = { matched_track_ids: ['semi', 'renew'] };
    expect(buildTrackScreeningGroups(company, TRACKS, criteria)).toEqual([
      { trackId: 'semi', criteriaIds: ['c1'] },
    ]);
  });

  it('expands auto-suggested tracks when nothing is manually matched', () => {
    const company: MatchableCompany = { segment: 'Photoresist solvents' }; // suggests semi
    expect(buildTrackScreeningGroups(company, TRACKS, CRITERIA)).toEqual([
      { trackId: 'semi', criteriaIds: ['c1', 'c2'] },
    ]);
  });

  it('returns [] when no track is matched', () => {
    const company: MatchableCompany = { segment: 'Telecom billing software' };
    expect(buildTrackScreeningGroups(company, TRACKS, CRITERIA)).toEqual([]);
  });
});

describe('matchedTrackPics', () => {
  it('returns the PIC of the single matched track', () => {
    const company: MatchableCompany = { matched_track_ids: ['semi'] };
    expect(matchedTrackPics(company, TRACKS)).toEqual(['Alice']);
  });

  it('returns distinct PICs across multiple matched tracks', () => {
    const company: MatchableCompany = { matched_track_ids: ['semi', 'renew'] };
    expect(matchedTrackPics(company, TRACKS)).toEqual(['Alice', 'Bob']);
  });

  it('dedupes when two matched tracks share a PIC', () => {
    const tracks: TrackLike[] = [
      { id: 'a', title: 'A', content: null, pic: 'Alice' },
      { id: 'b', title: 'B', content: null, pic: 'Alice' },
    ];
    const company: MatchableCompany = { matched_track_ids: ['a', 'b'] };
    expect(matchedTrackPics(company, tracks)).toEqual(['Alice']);
  });

  it('skips tracks with an empty or missing PIC', () => {
    const tracks: TrackLike[] = [
      { id: 'a', title: 'A', content: null, pic: '  ' },
      { id: 'b', title: 'B', content: null, pic: null },
      { id: 'c', title: 'C', content: null, pic: 'Carol' },
    ];
    const company: MatchableCompany = { matched_track_ids: ['a', 'b', 'c'] };
    expect(matchedTrackPics(company, tracks)).toEqual(['Carol']);
  });

  it('returns [] when the company has no matched tracks', () => {
    expect(matchedTrackPics({ matched_track_ids: [] }, TRACKS)).toEqual([]);
  });
});

describe('trackDisplayName', () => {
  it('truncates at the first dash', () => {
    expect(trackDisplayName(TRACKS[0])).toBe('Semiconductor & Materials');
  });

  it('falls back for an empty name', () => {
    expect(trackDisplayName({ id: 'x', title: '', content: null })).toBe('Untitled track');
  });
});
