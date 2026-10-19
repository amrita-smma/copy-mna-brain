import { describe, it, expect } from 'vitest';
import {
  suggestTrackIds,
  resolveTrackIds,
  persistedTrackIds,
  buildTrackScreeningGroups,
  trackDisplayName,
  matchedTrackPics,
  dealLeadField,
  dealLeadLabel,
  effectiveDealLead,
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

describe('persistedTrackIds', () => {
  it('returns the persisted matched_track_ids', () => {
    const company: MatchableCompany = { matched_track_ids: ['renew'] };
    expect(persistedTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('drops persisted ids for tracks that no longer exist', () => {
    const company: MatchableCompany = { matched_track_ids: ['renew', 'deleted'] };
    expect(persistedTrackIds(company, TRACKS)).toEqual(['renew']);
  });

  it('never falls back to the keyword heuristic when nothing is persisted', () => {
    // Same input that resolveTrackIds would auto-suggest "semi" for — but the
    // persisted-only view stays empty, so saving Pipeline Settings cannot
    // retroactively fill the Matched Tracks column.
    const company: MatchableCompany = {
      segment: 'Photoresist solvents',
      matched_track_ids: [],
    };
    expect(persistedTrackIds(company, TRACKS)).toEqual([]);
    expect(resolveTrackIds(company, TRACKS)).toEqual(['semi']);
  });

  it('returns [] when matched_track_ids is absent (no heuristic)', () => {
    const company: MatchableCompany = { segment: 'Renewable Energy — Hydropower' };
    expect(persistedTrackIds(company, TRACKS)).toEqual([]);
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

  it('never expands auto-suggested tracks: screening runs only on persisted matches', () => {
    // "Photoresist solvents" would auto-suggest "semi" via resolveTrackIds, but
    // screening must not run against keyword-suggested tracks — only explicitly
    // matched ones.
    const company: MatchableCompany = { segment: 'Photoresist solvents' };
    expect(buildTrackScreeningGroups(company, TRACKS, CRITERIA)).toEqual([]);
  });

  it('returns [] when no track is persisted', () => {
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

type LeadCompany = Parameters<typeof effectiveDealLead>[0];

const leadCompany = (overrides: Partial<LeadCompany> = {}): LeadCompany => ({
  deal_sponsor_name: null,
  deal_captain_name: null,
  ...overrides,
});

describe('dealLeadField', () => {
  it('returns deal_sponsor for L0–L2', () => {
    expect(dealLeadField('L0')).toBe('deal_sponsor');
    expect(dealLeadField('L1')).toBe('deal_sponsor');
    expect(dealLeadField('L2')).toBe('deal_sponsor');
  });

  it('returns deal_captain for L3 and above', () => {
    expect(dealLeadField('L3')).toBe('deal_captain');
    expect(dealLeadField('L4')).toBe('deal_captain');
    expect(dealLeadField('L5')).toBe('deal_captain');
  });

  it('returns deal_sponsor for pre-pipeline and unknown stages', () => {
    expect(dealLeadField('market_screening')).toBe('deal_sponsor');
    expect(dealLeadField('unreviewed')).toBe('deal_sponsor');
    expect(dealLeadField('discovered')).toBe('deal_sponsor');
    expect(dealLeadField(null)).toBe('deal_sponsor');
    expect(dealLeadField(undefined)).toBe('deal_sponsor');
  });
});

describe('dealLeadLabel', () => {
  it('labels L0–L2 and pre-pipeline stages as Deal Sponsor', () => {
    expect(dealLeadLabel('L2')).toBe('Deal Sponsor');
    expect(dealLeadLabel('market_screening')).toBe('Deal Sponsor');
  });

  it('labels L3+ as Deal Captain', () => {
    expect(dealLeadLabel('L3')).toBe('Deal Captain');
  });
});

describe('effectiveDealLead', () => {
  it('returns the stored sponsor name at sponsor stages', () => {
    expect(effectiveDealLead(leadCompany({ deal_sponsor_name: 'Alice' }), 'L1', TRACKS)).toBe('Alice');
  });

  it('returns the stored captain name at captain stages', () => {
    expect(
      effectiveDealLead(
        leadCompany({ deal_sponsor_name: 'Alice', deal_captain_name: 'Bob' }),
        'L3',
        TRACKS,
      ),
    ).toBe('Bob');
  });

  it('defaults the captain to the sponsor when no captain is set', () => {
    expect(effectiveDealLead(leadCompany({ deal_sponsor_name: 'Alice' }), 'L3', TRACKS)).toBe('Alice');
  });

  it('does not borrow the captain value at sponsor stages', () => {
    expect(effectiveDealLead(leadCompany({ deal_captain_name: 'Bob' }), 'L1', TRACKS)).toBeNull();
  });

  it('falls back to matched track PICs when no lead is stored', () => {
    expect(
      effectiveDealLead(leadCompany({ matched_track_ids: ['semi'] }), 'L3', TRACKS),
    ).toBe('Alice');
  });

  it('returns null when neither a lead nor a track PIC exists', () => {
    expect(effectiveDealLead(leadCompany(), 'L3', TRACKS)).toBeNull();
  });
});

describe('dealLeadField — workspace stage order', () => {
  it('treats a stage the workspace added after L3 as a Captain stage', () => {
    const captainStages = ['L3', 'L4', 'stg-postclose', 'L5'];
    expect(dealLeadField('stg-postclose', captainStages)).toBe('deal_captain');
    expect(dealLeadLabel('stg-postclose', captainStages)).toBe('Deal Captain');
  });

  it('treats a stage added before L3 as a Sponsor stage', () => {
    expect(dealLeadField('stg-expert-calls', ['L3', 'L4', 'L5'])).toBe('deal_sponsor');
  });

  it('defaults the captain fallback to the sponsor at an added Captain stage', () => {
    const company = { deal_sponsor_name: 'Sam Sponsor', deal_captain_name: null };
    expect(effectiveDealLead(company, 'stg-postclose', [], ['L3', 'stg-postclose'])).toBe(
      'Sam Sponsor',
    );
  });
});
