import { afterEach, describe, expect, it, vi } from 'vitest';

const searchForAgentMock = vi.fn();
const findLatestByCompaniesMock = vi.fn();
const findByNameFuzzyMock = vi.fn();
const getConnectedCompaniesMock = vi.fn();
const getGraphDataMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return {
      searchForAgent: searchForAgentMock,
      findByNameFuzzy: findByNameFuzzyMock,
    };
  },
  CompanyFinancialRepository: function CompanyFinancialRepository() {
    return { findLatestByCompanies: findLatestByCompaniesMock };
  },
}));

vi.mock('@/lib/services/container', () => ({
  createContainer: () => ({
    companyGraphService: {
      getConnectedCompanies: getConnectedCompaniesMock,
      getGraphData: getGraphDataMock,
    },
  }),
}));

import { queryCompanies } from './query_companies';
import { parseCompanyMentions } from '@/lib/navigation/companyMentions';

afterEach(() => vi.clearAllMocks());

describe('queryCompanies', () => {
  it('returns a "no companies found" message when the repo returns nothing', async () => {
    searchForAgentMock.mockResolvedValue([]);

    const result = (await queryCompanies.invoke({ segment: 'Tech' })) as string;

    expect(result).toBe('No companies found matching your criteria.');
    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ segment: 'Tech', limit: 20 }),
    );
  });

  it('renders a markdown table with latest financials joined per company', async () => {
    searchForAgentMock.mockResolvedValue([
      { id: 'c1', target: 'Acme', project_name: 'Project Alpha', segment: 'Tech', geography: 'US', watchlist_status: 'Active' },
      { id: 'c2', target: 'Beta', project_name: null, segment: 'Health', geography: 'JP', watchlist_status: null },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([
      { company_id: 'c1', revenue_usd_mn: 12.345, ebitda_usd_mn: 3.5, ev_usd_mn: 100 },
    ]);

    const result = (await queryCompanies.invoke({ search_term: 'a' })) as string;

    expect(result).toContain('Query Results (2 companies)');
    expect(result).toContain('Acme');
    expect(result).toContain('Project Alpha');
    expect(result).toContain('ID | Target | Project | Segment');
    expect(result).toContain('$12.3');
    expect(result).toContain('Beta');
    expect(result).toContain('| - |'); // missing financials render as '-'
  });

  // The ids are the handoff channel to send_email's company_excel /
  // company_card — without them in the visible table the agent has nothing to
  // pass along, and the export re-derives (and can disagree with) the cohort.
  it('prints each company id and tells the model what to do with them', async () => {
    searchForAgentMock.mockResolvedValue([
      { id: 'c1', target: 'Acme' },
      { id: 'c2', target: 'Beta' },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([]);

    const result = (await queryCompanies.invoke({})) as string;

    expect(result).toContain('| c1 | Acme');
    expect(result).toContain('| c2 | Beta');
    expect(result).toContain('company_ids');
  });

  // The table has names but no ids, so the chat UI has nothing to build an
  // "Open <company>" link from without this manifest.
  it('appends an id-to-name manifest for the chat UI, covering target and project name', async () => {
    searchForAgentMock.mockResolvedValue([
      { id: 'c1', target: 'Acme', project_name: 'Project Alpha' },
      { id: 'c2', target: 'Beta', project_name: null },
    ]);
    findLatestByCompaniesMock.mockResolvedValue([]);

    const result = (await queryCompanies.invoke({ search_term: 'a' })) as string;

    expect(parseCompanyMentions(result)).toEqual([
      { id: 'c1', name: 'Acme' },
      { id: 'c1', name: 'Project Alpha' },
      { id: 'c2', name: 'Beta' },
    ]);
  });

  it('omits the manifest when no companies matched', async () => {
    searchForAgentMock.mockResolvedValue([]);

    const result = (await queryCompanies.invoke({ search_term: 'zzz' })) as string;

    expect(parseCompanyMentions(result)).toEqual([]);
  });

  it('forwards the stage filter to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ stage: 'L2' });

    const passed = searchForAgentMock.mock.calls[0][0];
    expect(passed.stage).toBe('L2');
    expect(passed.stageIn).toBeUndefined();
  });

  it('defaults the cohort to the L0–L5 funnel when no stage is specified', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ segment: 'Tech' });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stageIn: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
      }),
    );
    expect(searchForAgentMock.mock.calls[0][0].stage).toBeUndefined();
  });

  it('forwards the name filter to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ name: 'Acme' });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', limit: 20 }),
    );
  });

  it('forwards ownership, company_focus, source and status filters to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({
      ownership: 'family office',
      company_focus: 'SaaS',
      source: 'inbound',
      status: 'active',
    });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownership: 'family office',
        companyFocus: 'SaaS',
        source: 'inbound',
        status: 'active',
        limit: 20,
      }),
    );
  });

  it('forwards max_ebitda alongside min_ebitda to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ min_ebitda: 5, max_ebitda: 50 });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ minEbitda: 5, maxEbitda: 50, limit: 20 }),
    );
  });

  it('forwards created_after and created_before date filters to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({
      created_after: '2026-01-01',
      created_before: '2026-06-30',
    });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAfter: '2026-01-01',
        createdBefore: '2026-06-30',
        limit: 20,
      }),
    );
  });

  it('forwards the newly exposed column filters to the repository', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({
      entry_id: 42,
      website: 'acme.com',
      workflow_status: 'NDA signed',
      advisor: 'Goldman',
      is_live: true,
      has_nbo_date: true,
      ai_opinion_status: 'completed',
      last_activity_after: '2026-01-01',
      matched_track_id: 'track-1',
      alias: 'Old Acme',
    });

    expect(searchForAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: 42,
        website: 'acme.com',
        workflowStatus: 'NDA signed',
        advisor: 'Goldman',
        isLive: true,
        hasNboDate: true,
        aiOpinionStatus: 'completed',
        lastActivityAfter: '2026-01-01',
        matchedTrackId: 'track-1',
        alias: 'Old Acme',
      }),
    );
  });

  it('scopes to company_ids and skips the L0–L5 stage default when given', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ company_ids: ['c1', 'c2'] });

    const passed = searchForAgentMock.mock.calls[0][0];
    expect(passed.ids).toEqual(['c1', 'c2']);
    expect(passed.stageIn).toBeUndefined();
  });

  it('searches every stage when include_pre_pipeline is set', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ include_pre_pipeline: true });

    expect(searchForAgentMock.mock.calls[0][0].stageIn).toContain('market_screening');
  });

  it('forwards stage_in as-is instead of applying the default cohort', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ stage_in: ['L3', 'L4'] });

    expect(searchForAgentMock.mock.calls[0][0].stageIn).toEqual(['L3', 'L4']);
  });

  it('never touches the graph when no relationship filter is given', async () => {
    searchForAgentMock.mockResolvedValue([]);

    await queryCompanies.invoke({ segment: 'Tech' });

    expect(getConnectedCompaniesMock).not.toHaveBeenCalled();
    expect(getGraphDataMock).not.toHaveBeenCalled();
  });

  it('narrows the cohort to the graph neighbours of connected_to', async () => {
    findByNameFuzzyMock.mockResolvedValue({ id: 'anchor', target: 'Acme' });
    getConnectedCompaniesMock.mockResolvedValue([
      { company: { id: 'n1', name: 'Beta' }, type: 'SELLS_TO', direction: 'outgoing' },
    ]);
    searchForAgentMock.mockResolvedValue([{ id: 'n1', target: 'Beta' }]);
    findLatestByCompaniesMock.mockResolvedValue([]);

    const result = (await queryCompanies.invoke({ connected_to: 'Acme' })) as string;

    expect(searchForAgentMock.mock.calls[0][0].ids).toEqual(['n1']);
    expect(result).toContain('directly connected to Acme');
  });

  it('errors when connected_to cannot be resolved', async () => {
    findByNameFuzzyMock.mockResolvedValue(null);

    const result = (await queryCompanies.invoke({ connected_to: 'Ghost' })) as string;

    expect(result).toContain('**Error:**');
    expect(result).toContain('Ghost');
    expect(searchForAgentMock).not.toHaveBeenCalled();
  });

  it('appends a Relationships column with one graph read for the whole page', async () => {
    searchForAgentMock.mockResolvedValue([{ id: 'c1', target: 'Acme' }]);
    findLatestByCompaniesMock.mockResolvedValue([]);
    getGraphDataMock.mockResolvedValue({
      nodes: [
        { id: 'c1', name: 'Acme' },
        { id: 'c2', name: 'Beta' },
      ],
      links: [{ source: 'c1', target: 'c2', label: 'SELLS_TO' }],
    });

    const result = (await queryCompanies.invoke({ include_relationships: true })) as string;

    expect(result).toContain('Relationships');
    expect(result).toContain('Acme --SELLS_TO--> Beta');
    expect(getGraphDataMock).toHaveBeenCalledTimes(1);
  });

  it('returns a formatted error when the search call throws', async () => {
    searchForAgentMock.mockRejectedValue(new Error('boom'));

    const result = (await queryCompanies.invoke({})) as string;

    expect(result).toContain('**Error:** boom');
  });
});
