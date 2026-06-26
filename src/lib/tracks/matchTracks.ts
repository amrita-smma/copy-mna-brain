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
 * Resolved track ids to display for a company: the persisted `matched_track_ids`
 * (filtered to tracks that still exist). Matching is assigned by the agent when a
 * company enters L0 — the UI never recomputes suggestions live, so pills stay
 * stable when theses change. Use {@link suggestTrackIds} for the agent fallback.
 */
export function resolveTrackIds(
  company: MatchableCompany,
  tracks: TrackLike[],
): string[] {
  const manual = company.matched_track_ids;
  if (!manual || manual.length === 0) return [];
  const known = new Set(tracks.map((t) => t.id));
  return manual.filter((id) => known.has(id));
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
 * "deal_sponsor" at L0–L2, "deal_captain" at L3+.
 */
export function dealLeadField(stage: string | null | undefined): DealLeadField {
  return stage === 'L0' || stage === 'L1' || stage === 'L2'
    ? 'deal_sponsor'
    : 'deal_captain';
}

/** Column label for the Deal Sponsor/Captain at a given stage. */
export function dealLeadLabel(stage: string | null | undefined): string {
  return dealLeadField(stage) === 'deal_sponsor' ? 'Deal Sponsor' : 'Deal Captain';
}

/**
 * Effective Deal Sponsor/Captain for display: the per-company override when
 * set, else the matched Track's PIC(s). Returns null when neither is present.
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
  const pics = matchedTrackPics(company, tracks);
  return pics.length > 0 ? pics.join(', ') : null;
}

/** Short display label for a track pill (name truncated at the first em/en dash). */
export function trackDisplayName(track: TrackLike): string {
  const name = (track.title ?? '').trim();
  if (!name) return 'Untitled track';
  return name.split(/[–—]/)[0].trim() || name;
}
