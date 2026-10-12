import { CompanyVoteRepository } from "@/lib/repositories";
import type { DbClient } from "@/lib/repositories";
import {
  VOTE_CHOICES,
  VOTE_CHOICE_LABELS,
  tallyVotes,
  type VoteChoice,
  type VoteTally,
} from "@/lib/voting/tally";

/**
 * Shared vote exposure for the company-fetching tools (`query_companies`,
 * `get_company_details`).
 *
 * Only **completed** Investment Committee rounds are ever summarised here — an
 * active round's live tally is the initiator's private view and a cancelled
 * round was never published, so neither may reach the agent. The repository
 * read enforces that; this module just tallies what it returns.
 */

export interface CompanyVoteSummary {
  /** Final tally of the latest completed round (humans + the AI's seat). */
  tally: VoteTally;
  /** ISO instant the latest completed round concluded at. */
  concludedAt: string | null;
  /** How many completed rounds the company has in total. */
  completedRounds: number;
}

/**
 * The guardrail both tools print next to vote results. The vote is the deal
 * team's recorded judgment — surfacing it must not become a shortcut that
 * steers the agent's own conclusions.
 */
export const VOTE_NEUTRALITY_NOTE =
  "_Vote shows the deal team's latest **completed** voting round (open and cancelled rounds are never shown). It records the team's judgment — report it when relevant, but do NOT let it sway your own analysis, screening, or AI opinion: reach your conclusions from the underlying data alone._";

/**
 * Latest completed vote round per company, in two batched queries regardless
 * of how many companies are passed — never one lookup per row.
 */
export async function loadVoteSummaries(
  db: DbClient,
  workspaceId: string,
  companyIds: string[],
): Promise<Map<string, CompanyVoteSummary>> {
  const summaries = new Map<string, CompanyVoteSummary>();
  if (companyIds.length === 0) return summaries;

  const voteRepo = new CompanyVoteRepository(db, workspaceId);
  const sessions = await voteRepo.listCompletedSessionsByCompanyIds(companyIds);
  if (sessions.length === 0) return summaries;

  // Rows arrive ordered (company, newest conclusion first), so the first row
  // seen per company is its latest round; later rows only bump the count.
  const latestByCompany = new Map<string, (typeof sessions)[number]>();
  const roundsByCompany = new Map<string, number>();
  for (const session of sessions) {
    if (!latestByCompany.has(session.company_id)) {
      latestByCompany.set(session.company_id, session);
    }
    roundsByCompany.set(
      session.company_id,
      (roundsByCompany.get(session.company_id) ?? 0) + 1,
    );
  }

  const ballots = await voteRepo.listBallotsBySessionIds(
    Array.from(latestByCompany.values()).map((s) => s.id),
  );
  const choicesBySession = new Map<string, Array<VoteChoice | null>>();
  for (const ballot of ballots) {
    const list = choicesBySession.get(ballot.vote_session_id) ?? [];
    list.push((ballot.choice as VoteChoice | null) ?? null);
    choicesBySession.set(ballot.vote_session_id, list);
  }

  for (const [companyId, session] of latestByCompany) {
    // The AI Opinion holds one seat; its vote was snapshotted on the session
    // when the round closed (see `aiVerdictToVoteChoice`).
    const tally = tallyVotes([
      ...(choicesBySession.get(session.id) ?? []),
      session.ai_vote_choice as VoteChoice | null,
    ]);
    // A completed round with zero cast ballots (bad close path, partial data)
    // would render a misleading 0–0 SPLIT — show nothing instead.
    if (tally.castCount === 0) continue;
    summaries.set(companyId, {
      tally,
      concludedAt: session.concluded_at ?? null,
      completedRounds: roundsByCompany.get(companyId) ?? 1,
    });
  }
  return summaries;
}

/** Compact table cell, e.g. `3–1 FOR (unanimous)` → fits one markdown column. */
export function voteSummaryCell(summary: CompanyVoteSummary | undefined): string {
  if (!summary) return "-";
  return summary.tally.unanimous
    ? `${summary.tally.headline} (unanimous)`
    : summary.tally.headline;
}

/** Per-choice breakdown of the cast ballots, e.g. `HARD YES 1 · YES 2 · NO 1`. */
export function voteCountsLine(summary: CompanyVoteSummary): string {
  return VOTE_CHOICES.filter((choice) => summary.tally.counts[choice] > 0)
    .map((choice) => `${VOTE_CHOICE_LABELS[choice]} ${summary.tally.counts[choice]}`)
    .join(" · ");
}
