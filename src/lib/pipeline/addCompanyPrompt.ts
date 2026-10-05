/**
 * The default prompt the Pipeline "Add Company → Ask AI" option puts in the
 * Copilot composer. The user appends the company's details and sends it.
 *
 * Pure and dependency-free so the view can build it from the tracks it has
 * already loaded.
 */

/** The subset of a track (investment thesis) the prompt reads. */
export interface AddCompanyPromptTrack {
  title: string | null;
  is_active?: boolean | null;
}

/**
 * Names the workspace's active theses after the financials line, so the AI
 * knows which screen the figures feed. With no active thesis the clause is
 * dropped rather than naming a screen that doesn't exist.
 */
function thesisClause(tracks: readonly AddCompanyPromptTrack[]): string {
  const titles = tracks
    .filter((t) => t.is_active)
    .map((t) => (t.title ?? '').trim())
    .filter((t) => t.length > 0);
  if (titles.length === 0) return '';
  return ` — these feed this workspace’s active thesis screen (${titles.join('; ')})`;
}

export function buildAddCompanyPrompt(tracks: readonly AddCompanyPromptTrack[]): string {
  return `Add a new company to the pipeline. I’ll provide details below — ask me only for whatever’s missing from the required list.

Required (must have all 4):
- Company name
- Segment (broad category, e.g. “Semiconductor” — not a niche)
- HQ country (single country, English — not a region or multiple countries)
- What the company does (1-2 lines)

Strongly recommended (flag if I skip these, don’t block on them):
- Website
- Ownership (e.g. family office / PE-backed / public)
- Source (inbound / outbound)
- Most recent fiscal year revenue, EBITDA, EV (USD mn)${thesisClause(tracks)}

Optional:
- Comments, remarks, thesis notes, watchlist ID/status

What’s the company name?
`;
}
