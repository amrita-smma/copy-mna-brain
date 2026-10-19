import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findByNameFuzzyMock = vi.fn();
const findByIdOrNullMock = vi.fn();
const findByCompanyFinancialsMock = vi.fn();
const findByCompanyScreeningMock = vi.fn();
const findByDealIdMock = vi.fn();
const countByDealIdMock = vi.fn();
const listCompletedSessionsByCompanyIdsMock = vi.fn();
const listBallotsBySessionIdsMock = vi.fn();
const findAllThesesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return {
      findByNameFuzzy: findByNameFuzzyMock,
      findByIdOrNull: findByIdOrNullMock,
    };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findByCompany: findByCompanyFinancialsMock };
  },
  CompanyScreeningDerivedRepository: function CompanyScreeningDerivedRepository() {
    return { findByCompany: findByCompanyScreeningMock };
  },
  DealNoteRepository: function DealNoteRepository() {
    return { findByDealId: findByDealIdMock, countByDealId: countByDealIdMock };
  },
  InvestmentThesisRepository: function InvestmentThesisRepository() {
    return { findAll: findAllThesesMock };
  },
  CompanyVoteRepository: function CompanyVoteRepository() {
    return {
      listCompletedSessionsByCompanyIds: listCompletedSessionsByCompanyIdsMock,
      listBallotsBySessionIds: listBallotsBySessionIdsMock,
    };
  },
}));

vi.mock('./stageLabels', () => ({
  loadStageLabeler: vi.fn(async () => (stage: string | null | undefined) =>
    stage === 'stg-post' ? 'L6 · Post-Close' : (stage ?? null),
  ),
}));

import { getCompanyDetails } from './get_company_details';
import { parseCompanyMentions } from '@/lib/navigation/companyMentions';

// Most cases are not about notes; default them to a company with none so each
// test only states the data it actually exercises.
beforeEach(() => {
  findByDealIdMock.mockReset();
  findByDealIdMock.mockResolvedValue([]);
  countByDealIdMock.mockReset();
  countByDealIdMock.mockResolvedValue(0);
  listCompletedSessionsByCompanyIdsMock.mockReset();
  listCompletedSessionsByCompanyIdsMock.mockResolvedValue([]);
  listBallotsBySessionIdsMock.mockReset();
  listBallotsBySessionIdsMock.mockResolvedValue([]);
  findAllThesesMock.mockReset();
  findAllThesesMock.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe('getCompanyDetails', () => {
  it('returns a "not found" message when the company is missing', async () => {
    findByNameFuzzyMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Ghost' })) as string;

    expect(result).toContain('No company found matching "Ghost"');
  });

  it('titles a codename-only company by its project name', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: 'c1',
      target: null,
      project_name: 'Project Sunrise',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({
      company_name: 'Project Sunrise',
    })) as string;

    expect(result).toContain('## Company Details: [Project Sunrise]');
    expect(result).not.toContain('## Company Details: Unknown');
  });

  it('titles a company carrying both names with the target and the codename', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: 'c1',
      target: 'Acme Corp',
      project_name: 'Project Sunrise',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('## Company Details: Acme Corp [Project Sunrise]');
  });

  it('prints the company context with a note on how to weigh it', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: 'c1',
      target: 'Acme',
      context: '## Background\nFounder wants out; plant rebuilt in 2024.',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('### Context');
    expect(result).toContain('Founder wants out; plant rebuilt in 2024.');
    expect(result).toContain('first-hand internal knowledge');
  });

  it('lists matched tracks by title and id, dropping ids of deleted tracks', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: 'c1',
      target: 'Acme',
      matched_track_ids: ['t-semis', 't-gone'],
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);
    findAllThesesMock.mockResolvedValue([
      { id: 't-semis', title: 'Semiconductors' },
      { id: 't-health', title: 'Healthcare' },
    ]);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('- **Matched Tracks:** Semiconductors (id: t-semis)');
    expect(result).not.toContain('t-gone');
    expect(result).not.toContain('Healthcare');
  });

  it('reports no matched tracks without reading the track list', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme', matched_track_ids: [] });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('- **Matched Tracks:** None');
    expect(findAllThesesMock).not.toHaveBeenCalled();
  });

  it('omits the Context section when the company has none', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme', context: '   ' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).not.toContain('### Context');
  });

  it('prints the deal notes newest first, dated and stage-labelled', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);
    countByDealIdMock.mockResolvedValue(2);
    findByDealIdMock.mockResolvedValue([
      {
        id: 'n2',
        content: 'Management call: founder open to a majority sale.',
        stage: 'stg-post',
        created_at: '2026-03-04T09:15:00.000Z',
      },
      {
        id: 'n1',
        content: 'Teaser received from the banker.',
        stage: 'L1',
        created_at: '2026-01-02T11:00:00.000Z',
      },
    ]);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    // Bounded read: only the slice that can be printed is pulled off the table.
    expect(findByDealIdMock).toHaveBeenCalledWith('c1', 15);
    expect(countByDealIdMock).toHaveBeenCalledWith('c1');
    expect(result).toContain('### Notes (2)');
    expect(result).toContain('first-hand internal knowledge');
    expect(result).toContain('**2026-03-04 · L6 · Post-Close**');
    expect(result).toContain('Management call: founder open to a majority sale.');
    expect(result).toContain('**2026-01-02 · L1**');
    expect(result).toContain('Teaser received from the banker.');
    // The repository already orders newest first — the reply must not reshuffle it.
    expect(result.indexOf('Management call')).toBeLessThan(result.indexOf('Teaser received'));
    expect(result).not.toContain('not shown');
  });

  it('omits the Notes section when the company has none', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).not.toContain('### Notes');
  });

  it('caps a long note history and says how many it left out', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);
    countByDealIdMock.mockResolvedValue(18);
    // The repository is asked for 15 and returns 15; the other 3 never load.
    findByDealIdMock.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => ({
        id: `n${i}`,
        content: `Note ${i}`,
        stage: 'L1',
        created_at: '2026-01-02T11:00:00.000Z',
      })),
    );

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('### Notes (18)');
    // The cap is enforced at the query, not by filtering rows after the fact.
    expect(findByDealIdMock).toHaveBeenCalledWith('c1', 15);
    expect(result).toContain('Note 0');
    expect(result).toContain('Note 14');
    expect(result).toContain('3 older notes not shown.');
  });

  it('stops at the character budget when several notes are long', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);
    countByDealIdMock.mockResolvedValue(5);
    findByDealIdMock.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`,
        content: `note-${i} ${'x'.repeat(2_000)}`,
        stage: 'L1',
        created_at: null,
      })),
    );

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('### Notes (5)');
    // Each body clips to 1.5k, so three fit under the 6k section budget and the
    // fourth would not — the rest are reported rather than printed.
    expect(result).toContain('note-0');
    expect(result).toContain('note-2');
    expect(result).not.toContain('note-3');
    expect(result).toContain('2 older notes not shown.');
    // A note saved before created_at defaulted still gets a heading.
    expect(result).toContain('**Undated · L1**');
  });

  it('clips a single enormous note instead of printing the whole transcript', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);
    countByDealIdMock.mockResolvedValue(1);
    findByDealIdMock.mockResolvedValue([
      { id: 'n1', content: `call transcript ${'x'.repeat(20_000)}`, stage: 'L1', created_at: null },
    ]);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('call transcript');
    expect(result).toContain('…');
    // The one note prints, and the reply stays nowhere near the raw 20k body.
    expect(result).not.toContain('not shown');
    expect(result.length).toBeLessThan(6_000);
  });

  it('tells the model the reply carries the notes timeline', async () => {
    expect(getCompanyDetails.description).toContain('Notes');
    expect(getCompanyDetails.description).toContain(
      'Only the most recent notes are printed when a company has many',
    );
  });

  it('rejects whitespace-only input without hitting the repository', async () => {
    const result = (await getCompanyDetails.invoke({ company_name: '   ' })) as string;

    expect(result).toContain('Please provide a company_id, or a company target name');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
    expect(findByIdOrNullMock).not.toHaveBeenCalled();
  });

  it('rejects a call with neither company_id nor company_name', async () => {
    const result = (await getCompanyDetails.invoke({})) as string;

    expect(result).toContain('Please provide a company_id, or a company target name');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
    expect(findByIdOrNullMock).not.toHaveBeenCalled();
  });

  it('looks the company up by id exactly, never by name, when company_id is given', async () => {
    findByIdOrNullMock.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      target: '杭州华友新材料',
      pipeline_stage: 'L1',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({
      company_id: '11111111-2222-3333-4444-555555555555',
      // A name is supplied too — the id must still win, since the name is what
      // resolves to a near-identically named sibling record.
      company_name: '杭州华友',
    })) as string;

    expect(findByIdOrNullMock).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
    expect(result).toContain('## Company Details: 杭州华友新材料');
  });

  it('reports a company_id that resolves to nothing without falling back to the name', async () => {
    findByIdOrNullMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({
      company_id: '11111111-2222-3333-4444-555555555555',
      company_name: 'Acme',
    })) as string;

    expect(result).toContain('No company found for company_id "11111111-2222-3333-4444-555555555555"');
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed company_id rather than querying with it', async () => {
    const result = (await getCompanyDetails.invoke({ company_id: 'not-a-uuid' })) as string;

    expect(result).toContain('is not a valid UUID');
    expect(findByIdOrNullMock).not.toHaveBeenCalled();
    expect(findByNameFuzzyMock).not.toHaveBeenCalled();
  });

  it('tells the model to prefer company_id over the fuzzy name match', async () => {
    expect(getCompanyDetails.description).toContain('PREFER company_id whenever you have one');
    expect(getCompanyDetails.description).toContain(
      'Never re-resolve by name a company whose id you already have',
    );
  });

  it('resolves a company looked up by its project name', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      target: 'Acme',
      project_name: 'Project Alpha',
      entry_id: 7,
      pipeline_stage: 'L1',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Alpha' })) as string;

    expect(findByNameFuzzyMock).toHaveBeenCalledWith('Alpha');
    expect(result).toContain('## Company Details: Acme');
    expect(result).toContain('**Project Name:** Project Alpha');
  });

  // Feeds the chat UI's "Open <company>" chip — see `companyMentions`.
  it('appends an id-to-name manifest covering target and project name', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: 'c-acme',
      target: 'Acme',
      project_name: 'Project Alpha',
    });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(parseCompanyMentions(result)).toEqual([
      { id: 'c-acme', name: 'Acme' },
      { id: 'c-acme', name: 'Project Alpha' },
    ]);
  });

  it('renders financials, screening, and basic info for a real company', async () => {
    findByNameFuzzyMock.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      target: 'Acme',
      project_name: 'Project Alpha',
      entry_id: 7,
      segment: 'Tech',
      geography: 'US',
      pipeline_stage: 'L1',
      comments: 'Promising',
    });
    findByCompanyFinancialsMock.mockResolvedValue([
      { fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: 20, ebitda_margin: 0.2, ev_usd_mn: 500, ev_ebitda: 25, revenue_cagr_vs_prior: null },
      { fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 30, ebitda_margin: 0.25, ev_usd_mn: 600, ev_ebitda: 20, revenue_cagr_vs_prior: 0.2 },
    ]);
    findByCompanyScreeningMock.mockResolvedValue({
      l1_screening_result: 'pass',
      l1_rationale: 'Strong fit',
    });

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('## Company Details: Acme');
    expect(result).toContain('**Company ID (UUID):** 11111111-1111-1111-1111-111111111111');
    expect(result).toContain('**Project Name:** Project Alpha');
    expect(result).toContain('**Pipeline Stage:** L1');
    expect(result).toContain('### Revenue (USD Millions)');
    expect(result).toContain('### L1 Screening');
    expect(result).toContain('**Result:** pass');
    expect(result).toContain('Strong fit');
    expect(result).toContain('Promising');
  });

  it("names the pipeline stage by the workspace's code and name, not its key", async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c-1', target: 'Acme', pipeline_stage: 'stg-post' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('**Pipeline Stage:** L6 · Post-Close');
    expect(result).not.toContain('stg-post');
  });

  it('omits the Vote Results section when the company has no completed round', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c-1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).not.toContain('### Vote Results');
    // Only completed rounds are ever requested — an open round's live tally
    // and a cancelled round's drafts must stay out of the agent's view.
    expect(listCompletedSessionsByCompanyIdsMock).toHaveBeenCalledWith(['c-1']);
  });

  it("prints the latest completed round's tally with the neutrality guardrail", async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'c-1', target: 'Acme' });
    findByCompanyFinancialsMock.mockResolvedValue([]);
    findByCompanyScreeningMock.mockResolvedValue(null);
    listCompletedSessionsByCompanyIdsMock.mockResolvedValue([
      { id: 'vs-2', company_id: 'c-1', ai_vote_choice: 'yes', concluded_at: '2026-10-01T10:00:00Z' },
      { id: 'vs-1', company_id: 'c-1', ai_vote_choice: 'no', concluded_at: '2026-08-01T10:00:00Z' },
    ]);
    listBallotsBySessionIdsMock.mockResolvedValue([
      { vote_session_id: 'vs-2', choice: 'hard_yes' },
      { vote_session_id: 'vs-2', choice: 'yes' },
      { vote_session_id: 'vs-2', choice: 'no' },
    ]);

    const result = (await getCompanyDetails.invoke({ company_name: 'Acme' })) as string;

    expect(result).toContain('### Vote Results');
    // 3 FOR (hard_yes + yes + AI's yes) vs 1 AGAINST.
    expect(result).toContain('**Outcome:** 3–1 FOR — 3 Proceed');
    expect(result).toContain('**Ballots cast:** 4 (HARD YES 1 · YES 2 · NO 1)');
    expect(result).toContain('**Concluded:** 2026-10-01');
    expect(result).toContain('_1 earlier completed round not shown._');
    expect(result).toContain('do NOT let it sway your own analysis');
  });
});
