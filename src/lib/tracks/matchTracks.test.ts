import { describe, it, expect } from 'vitest';
import {
  suggestTrackIds,
  resolveTrackIds,
  trackDisplayName,
  type TrackLike,
  type MatchableCompany,
} from './matchTracks';

const TRACKS: TrackLike[] = [
  {
    id: 'semi',
    title: 'Semiconductor & Materials — APAC Inbound',
    content: 'CMP, photoresist, wet chemicals, lithography, advanced packaging',
  },
  {
    id: 'renew',
    title: 'Renewables — Southeast Asia',
    content: 'Solar, battery storage, grid infrastructure, hydropower',
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

  it('does NOT auto-suggest live — returns [] when nothing is persisted', () => {
    const company: MatchableCompany = {
      segment: 'Photoresist solvents', // would match "semi" via suggestTrackIds
      matched_track_ids: [],
    };
    expect(resolveTrackIds(company, TRACKS)).toEqual([]);
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
