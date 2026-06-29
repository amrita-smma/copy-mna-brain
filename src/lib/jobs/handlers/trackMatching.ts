import {
  extractMessageText,
  getStatelessAgentGraph,
  HumanMessage,
} from '@/lib/agents/analysis';
import { CompanyRepository, InvestmentThesisRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { suggestTrackIds, type TrackLike } from '@/lib/tracks/matchTracks';

export const TRACK_MATCHING_TIMEOUT_SECONDS = 120;

export interface TrackMatchingPayload {
  companyId: string;
}

export interface TrackMatchingResult {
  companyId: string;
  matchedTrackIds: string[];
  /** Whether the LLM agent decided the match, or the keyword heuristic fallback. */
  via: 'agent' | 'heuristic';
}

/** Pull the text of the final AI message from an agent invoke result. */
function lastAiText(messages: unknown[]): string {
  const aiMessages = (messages as Array<{
    _getType?: () => string;
    constructor?: { name: string };
  }>).filter(
    (m) => m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage',
  );
  return extractMessageText(aiMessages[aiMessages.length - 1] as never);
}

/**
 * Parse a `{ "trackIds": [...] }` (or bare array) of ids from the agent reply.
 *
 * Returns `null` when no parseable id list could be found (e.g. the agent
 * replied with prose). This is distinct from an empty array `[]`, which means
 * the agent explicitly decided no tracks fit. The caller uses `null` to fall
 * back to the keyword heuristic, so a company never ends up silently unmatched
 * just because the reply wasn't valid JSON.
 */
function parseTrackIds(text: string): string[] | null {
  try {
    const objMatch = text.match(/\{[\s\S]*"trackIds"[\s\S]*\}/);
    if (objMatch) {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed.trackIds)) return parsed.trackIds.map(String);
    }
    const arrMatch = text.match(/\[[\s\S]*?\]/);
    if (arrMatch) {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return parsed.map(String);
    }
  } catch {
    /* fall through to caller's heuristic fallback */
  }
  return null;
}

function buildPrompt(
  company: { target: string | null; segment: string | null; geography: string | null; project_name: string | null; thesis_content: string | null },
  tracks: TrackLike[],
): string {
  const tracksBlock = tracks
    .map((t) => `- id: ${t.id}\n  name: ${t.title ?? ''}\n  thesis: ${t.content ?? ''}`)
    .join('\n');
  return `You are an M&A analyst. Decide which investment theses ("Tracks") the company below fits.

## Company
- Name: ${company.target ?? '—'}
- Project: ${company.project_name ?? '—'}
- Sector / segment: ${company.segment ?? '—'}
- Geography: ${company.geography ?? '—'}
- Notes: ${company.thesis_content ?? '—'}

## Tracks
${tracksBlock || '(none)'}

## Instructions
- Return ONLY the tracks whose thesis genuinely fits this company's sector, geography, and profile.
- Do NOT force a match — return an empty list if none fit.
- Respond with strict JSON and nothing else: {"trackIds": ["<id>", ...]}`;
}

/**
 * Match a company against the investment theses ("Tracks") and persist the
 * result on `companies.matched_track_ids`. Runs when a company enters L0.
 *
 * Uses the analysis agent (LLM) to decide; falls back to the keyword heuristic
 * when the agent is unavailable or returns an unparseable reply, so matching is
 * always assigned exactly once at L0 entry.
 */
export async function runTrackMatching(
  payload: TrackMatchingPayload,
  deps: { db: DbClient },
): Promise<TrackMatchingResult> {
  const companyRepo = new CompanyRepository(deps.db);
  const thesisRepo = new InvestmentThesisRepository(deps.db);

  const company = await companyRepo.findById(payload.companyId);
  const tracks = await thesisRepo.findAll();

  if (tracks.length === 0) {
    await companyRepo.update(company.id, { matched_track_ids: [] });
    return { companyId: company.id, matchedTrackIds: [], via: 'heuristic' };
  }

  const known = new Set(tracks.map((t) => t.id));
  let matchedIds: string[] | null = null;
  let via: 'agent' | 'heuristic' = 'heuristic';

  const agent = await getStatelessAgentGraph();
  if (agent) {
    try {
      const result = await agent.invoke({
        messages: [new HumanMessage(buildPrompt(company, tracks))],
      });
      const parsed = parseTrackIds(lastAiText(result.messages));
      // Only trust the agent when it returned a parseable id list (even an
      // empty one — that's a deliberate "no fit"). An unparseable reply leaves
      // `matchedIds` null so we fall through to the keyword heuristic below.
      if (parsed !== null) {
        matchedIds = parsed.filter((id) => known.has(id));
        via = 'agent';
      } else {
        console.warn('[trackMatching] agent reply unparseable, using heuristic');
      }
    } catch (err) {
      console.error('[trackMatching] agent matching failed, using heuristic:', err);
    }
  }

  if (matchedIds === null) {
    matchedIds = suggestTrackIds(company, tracks);
    via = 'heuristic';
  }

  await companyRepo.update(company.id, { matched_track_ids: matchedIds });
  return { companyId: company.id, matchedTrackIds: matchedIds, via };
}
