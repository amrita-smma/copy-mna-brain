/**
 * Track ↔ company matching.
 *
 * A "Track" is an `investment_thesis` row (`title` = name, `content` = thesis).
 * Companies may be *manually* matched to tracks (`matched_track_ids`); when that
 * list is empty we fall back to an *auto-suggested* match derived from keyword
 * overlap between the track thesis and the company's descriptive fields.
 */

export interface TrackLike {
  id: string;
  title: string | null;
  content: string | null;
  /** Person in charge of the track (investment_thesis.pic). */
  pic?: string | null;
}

export interface MatchableCompany {
  segment?: string | null;
  geography?: string | null;
  target?: string | null;
  project_name?: string | null;
  thesis_content?: string | null;
  matched_track_ids?: string[] | null;
}

// Common words that carry no sector signal — excluded from track keywords.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'our', 'are',
  'all', 'any', 'within', 'across', 'their', 'they', 'will', 'has', 'have',
  'companies', 'company', 'target', 'targets', 'sector', 'sectors', 'focus',
  'investment', 'thesis', 'deal', 'deals', 'market', 'markets',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));

/** Lowercased blob of a company's descriptive fields, for substring matching. */
function companyHaystack(company: MatchableCompany): string {
  return [
    company.segment,
    company.geography,
    company.target,
    company.project_name,
    company.thesis_content,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Distinct keywords describing a track (from its name + thesis). */
function trackKeywords(track: TrackLike): string[] {
  const tokens = tokenize(`${track.title ?? ''} ${track.content ?? ''}`);
  return [...new Set(tokens)];
}

/**
 * Auto-suggested track ids for a company: a track is suggested when any of its
 * keywords appears in the company's descriptive text. Order follows `tracks`.
 */
export function suggestTrackIds(
  company: MatchableCompany,
  tracks: TrackLike[],
): string[] {
  const haystack = companyHaystack(company);
  if (!haystack.trim()) return [];
  return tracks
    .filter((track) =>
      trackKeywords(track).some((kw) => haystack.includes(kw)),
    )
    .map((track) => track.id);
}

/**
 * Resolved track ids to display for a company (drives both the "Matched Tracks"
 * pills and the pipeline Track filter):
 *
 * 1. The persisted `matched_track_ids` assigned by the agent when the company
 *    entered L0 (filtered to tracks that still exist), if any.
 * 2. Otherwise fall back to keyword-based {@link suggestTrackIds}, so a company
 *    that was never assigned still surfaces under its thesis-relevant tracks
 *    instead of disappearing from the filter.
 */
export function resolveTrackIds(
  company: MatchableCompany,
  tracks: TrackLike[],
): string[] {
  const known = new Set(tracks.map((t) => t.id));
  const manual = (company.matched_track_ids ?? []).filter((id) => known.has(id));
  if (manual.length > 0) return manual;
  return suggestTrackIds(company, tracks);
}

/**
 * Track ids actually *persisted* on the company (assigned by the agent when it
 * entered L0, or set manually), filtered to tracks that still exist. Unlike
 * {@link resolveTrackIds} this never falls back to the live keyword heuristic —
 * so it reflects only what was committed at L0 entry and does NOT change when
 * the track list is edited/saved. Use this for the "Matched Tracks" display
 * (pills) so saving Track Settings can't retroactively "fill in" matches.
 */
export function persistedTrackIds(
  company: MatchableCompany,
  tracks: TrackLike[],
): string[] {
  const known = new Set(tracks.map((t) => t.id));
  return (company.matched_track_ids ?? []).filter((id) => known.has(id));
}

/** A screening criterion as far as track matching cares: its owning Track. */
export interface CriterionLike {
  id: string;
  investment_thesis_id?: string | null;
}

/** One per-track AI-screening group: the track and the criteria to run for it. */
export interface TrackScreeningGroup {
  trackId: string;
  criteriaIds: string[];
}

/**
 * Expand a company into per-track screening groups: one group per *persisted*
 * matched track (see {@link persistedTrackIds}), each carrying the criteria that
 * belong to that track (`criterias.investment_thesis_id`). Tracks with no
 * criteria are skipped — they would screen nothing — so the number of groups is
 * the number of *screenable* matched tracks.
 *
 * This deliberately uses {@link persistedTrackIds} (not {@link resolveTrackIds}):
 * AI screening only runs against tracks a company is explicitly matched to, and
 * never against the keyword-based auto-suggestion fallback.
 */
export function buildTrackScreeningGroups(
  company: MatchableCompany,
  tracks: TrackLike[],
  criteria: CriterionLike[],
): TrackScreeningGroup[] {
  const matchedIds = persistedTrackIds(company, tracks);
  return matchedIds
    .map((trackId) => ({
      trackId,
      criteriaIds: criteria
        .filter((c) => c.investment_thesis_id === trackId)
        .map((c) => c.id),
    }))
    .filter((g) => g.criteriaIds.length > 0);
}

/**
 * Distinct, non-empty PIC names of the tracks a company is matched to. Drives
 * the pipeline "Deal Sponsor" (L0–L2) / "Deal Captain" (L3+) columns, which
 * both surface the matched Track's PIC.
 */
export function matchedTrackPics(
  company: MatchableCompany,
  tracks: TrackLike[],
): string[] {
  const ids = resolveTrackIds(company, tracks);
  const pics = ids
    .map((id) => tracks.find((t) => t.id === id)?.pic?.trim())
    .filter((p): p is string => !!p);
  return [...new Set(pics)];
}

export type DealLeadField = 'deal_sponsor' | 'deal_captain';

/**
 * Which per-company column backs the Deal Sponsor/Captain at a given stage:
 * "deal_captain" at L3+, "deal_sponsor" everywhere else (L0–L2 and the
 * pre-pipeline stages: market_screening, unreviewed, discovered).
 */
export function dealLeadField(stage: string | null | undefined): DealLeadField {
  return stage === 'L3' || stage === 'L4' || stage === 'L5'
    ? 'deal_captain'
    : 'deal_sponsor';
}

/** Column label for the Deal Sponsor/Captain at a given stage. */
export function dealLeadLabel(stage: string | null | undefined): string {
  return dealLeadField(stage) === 'deal_sponsor' ? 'Deal Sponsor' : 'Deal Captain';
}

/**
 * Effective Deal Sponsor/Captain for display: the per-company override when
 * set, else the matched Track's PIC(s). Returns null when neither is present.
 * At Captain stages (L3+) the Deal Captain defaults to the Deal Sponsor when
 * no captain has been set yet, so the lead carries over on promotion.
 */
export function effectiveDealLead(
  company: MatchableCompany & {
    deal_sponsor?: string | null;
    deal_captain?: string | null;
  },
  stage: string | null | undefined,
  tracks: TrackLike[],
): string | null {
  const stored = company[dealLeadField(stage)]?.trim();
  if (stored) return stored;
  if (dealLeadField(stage) === 'deal_captain') {
    const sponsor = company.deal_sponsor?.trim();
    if (sponsor) return sponsor;
  }
  const pics = matchedTrackPics(company, tracks);
  return pics.length > 0 ? pics.join(', ') : null;
}

/** Short display label for a track pill (name truncated at the first em/en dash). */
export function trackDisplayName(track: TrackLike): string {
  const name = (track.title ?? '').trim();
  if (!name) return 'Untitled track';
  return name.split(/[–—]/)[0].trim() || name;
}
