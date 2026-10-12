import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listCompletedSessionsByCompanyIdsMock = vi.fn();
const listBallotsBySessionIdsMock = vi.fn();

vi.mock('@/lib/repositories', () => ({
  CompanyVoteRepository: function CompanyVoteRepository() {
    return {
      listCompletedSessionsByCompanyIds: listCompletedSessionsByCompanyIdsMock,
      listBallotsBySessionIds: listBallotsBySessionIdsMock,
    };
  },
}));

import {
  loadVoteSummaries,
  voteCountsLine,
  voteSummaryCell,
} from './voteSummaries';

beforeEach(() => {
  listCompletedSessionsByCompanyIdsMock.mockReset();
  listCompletedSessionsByCompanyIdsMock.mockResolvedValue([]);
  listBallotsBySessionIdsMock.mockReset();
  listBallotsBySessionIdsMock.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe('loadVoteSummaries', () => {
  it('returns an empty map without hitting the DB when the id list is empty', async () => {
    const summaries = await loadVoteSummaries({} as never, 'ws-1', []);

    expect(summaries.size).toBe(0);
    expect(listCompletedSessionsByCompanyIdsMock).not.toHaveBeenCalled();
  });

  it('hides a completed round in which no ballot was cast at all', async () => {
    listCompletedSessionsByCompanyIdsMock.mockResolvedValue([
      { id: 'vs-1', company_id: 'c-1', ai_vote_choice: null, concluded_at: '2026-10-01T10:00:00Z' },
    ]);
    listBallotsBySessionIdsMock.mockResolvedValue([
      { vote_session_id: 'vs-1', choice: null },
    ]);

    const summaries = await loadVoteSummaries({} as never, 'ws-1', ['c-1']);

    // A 0–0 "SPLIT" would mislead more than it informs — show nothing instead.
    expect(summaries.has('c-1')).toBe(false);
  });

  it('skips the ballot read when no company has a completed round', async () => {
    const summaries = await loadVoteSummaries({} as never, 'ws-1', ['c-1']);

    expect(summaries.size).toBe(0);
    expect(listBallotsBySessionIdsMock).not.toHaveBeenCalled();
  });

  it('tallies the latest round per company including the AI seat, in two batched reads', async () => {
    listCompletedSessionsByCompanyIdsMock.mockResolvedValue([
      // c-1 has two rounds, newest conclusion first (repo ordering contract).
      { id: 'vs-2', company_id: 'c-1', ai_vote_choice: 'yes', concluded_at: '2026-10-01T10:00:00Z' },
      { id: 'vs-1', company_id: 'c-1', ai_vote_choice: 'no', concluded_at: '2026-08-01T10:00:00Z' },
      { id: 'vs-3', company_id: 'c-2', ai_vote_choice: null, concluded_at: '2026-09-15T10:00:00Z' },
    ]);
    listBallotsBySessionIdsMock.mockResolvedValue([
      { vote_session_id: 'vs-2', choice: 'hard_yes' },
      { vote_session_id: 'vs-2', choice: 'no' },
      { vote_session_id: 'vs-3', choice: 'hard_no' },
    ]);

    const summaries = await loadVoteSummaries({} as never, 'ws-1', ['c-1', 'c-2']);

    // Only the latest round's ballots are read — vs-1 stays untouched.
    expect(listBallotsBySessionIdsMock).toHaveBeenCalledWith(['vs-2', 'vs-3']);
    expect(listCompletedSessionsByCompanyIdsMock).toHaveBeenCalledTimes(1);
    expect(listBallotsBySessionIdsMock).toHaveBeenCalledTimes(1);

    const c1 = summaries.get('c-1');
    // hard_yes + ai yes = 2 FOR, no = 1 AGAINST.
    expect(c1?.tally.headline).toBe('2–1 FOR');
    expect(c1?.completedRounds).toBe(2);
    expect(c1?.concludedAt).toBe('2026-10-01T10:00:00Z');

    const c2 = summaries.get('c-2');
    // A null AI choice is ignored, never invented.
    expect(c2?.tally.headline).toBe('1–0 AGAINST');
    expect(c2?.tally.castCount).toBe(1);
    expect(c2?.completedRounds).toBe(1);
  });
});

describe('voteSummaryCell', () => {
  it('renders a dash for a company with no completed round', () => {
    expect(voteSummaryCell(undefined)).toBe('-');
  });

  it('renders the headline, flagging a unanimous round', async () => {
    listCompletedSessionsByCompanyIdsMock.mockResolvedValue([
      { id: 'vs-1', company_id: 'c-1', ai_vote_choice: 'yes', concluded_at: null },
    ]);
    listBallotsBySessionIdsMock.mockResolvedValue([
      { vote_session_id: 'vs-1', choice: 'hard_yes' },
    ]);

    const summaries = await loadVoteSummaries({} as never, 'ws-1', ['c-1']);

    expect(voteSummaryCell(summaries.get('c-1'))).toBe('2–0 FOR (unanimous)');
  });
});

describe('voteCountsLine', () => {
  it('lists only the choices that received ballots, labelled', async () => {
    listCompletedSessionsByCompanyIdsMock.mockResolvedValue([
      { id: 'vs-1', company_id: 'c-1', ai_vote_choice: 'inconclusive', concluded_at: null },
    ]);
    listBallotsBySessionIdsMock.mockResolvedValue([
      { vote_session_id: 'vs-1', choice: 'hard_yes' },
      { vote_session_id: 'vs-1', choice: 'yes' },
      { vote_session_id: 'vs-1', choice: 'yes' },
      { vote_session_id: 'vs-1', choice: 'no' },
    ]);

    const summaries = await loadVoteSummaries({} as never, 'ws-1', ['c-1']);

    expect(voteCountsLine(summaries.get('c-1')!)).toBe(
      'HARD YES 1 · YES 2 · NO 1 · INCONCLUSIVE 1',
    );
  });
});
