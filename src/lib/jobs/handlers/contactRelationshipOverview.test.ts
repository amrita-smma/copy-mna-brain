import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeStructuredOutput: vi.fn(),
  saveOverviewReady: vi.fn(),
  markOverviewFailed: vi.fn(),
  appendLog: vi.fn(),
  listNotesForSystem: vi.fn(),
  getRoleRollup: vi.fn(),
  getNoteInputHash: vi.fn(),
  findByIdCorrespondent: vi.fn(),
  findByIdEmployer: vi.fn(),
  getInteractionSummaries: vi.fn(),
  listContactDeals: vi.fn(),
  listDealEvidenceEmails: vi.fn(),
}));

vi.mock('@/lib/agents/fund_update_processing/structuredOutput', () => ({
  invokeStructuredOutput: mocks.invokeStructuredOutput,
}));

vi.mock('@/lib/repositories', () => ({
  ContactConversationRepository: class {
    listNotesForSystem = mocks.listNotesForSystem;
    getRoleRollupForSystem = mocks.getRoleRollup;
    getNoteInputHash = mocks.getNoteInputHash;
    listDealEvidenceEmails = mocks.listDealEvidenceEmails;
    saveOverviewReady = mocks.saveOverviewReady;
    markOverviewFailed = mocks.markOverviewFailed;
  },
  CorrespondentRepository: class {
    findById = mocks.findByIdCorrespondent;
  },
  EmployerRepository: class {
    findById = mocks.findByIdEmployer;
  },
  JobRepository: class {
    appendLog = mocks.appendLog;
  },
}));

vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn().mockReturnValue({
    contactInsightsService: {
      getInteractionSummaries: mocks.getInteractionSummaries,
    },
    dealContactService: {
      listContactDeals: mocks.listContactDeals,
    },
  }),
}));

import { runContactRelationshipOverview } from './contactRelationshipOverview';
import { overviewInputHash } from '@/lib/crm/overviewInputHash';

describe('runContactRelationshipOverview', () => {
  const payload = {
    correspondentId: 'c1',
    workspaceId: 'w1',
    jobId: 'job-123',
  };
  const deps = {
    db: {} as never,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByIdCorrespondent.mockResolvedValue({
      id: 'c1',
      name: 'John Doe',
      employer_id: 'emp-1',
      title: 'Partner',
    });
    mocks.findByIdEmployer.mockResolvedValue({
      id: 'emp-1',
      name: 'Acme Advisory',
    });
    mocks.listNotesForSystem.mockResolvedValue({
      notes: [
        {
          emailId: 'e1',
          sentAt: '2026-10-15T00:00:00Z',
          direction: 'inbound',
          teamMembers: [{ userId: 'u1', name: 'Alice Smith' }],
          summary: 'Call regarding debt financing options',
          keyPoints: [],
          nextStep: 'Follow up next week',
          nextStepStatus: 'action',
          sentiment: 'positive',
        },
      ],
      nextCursor: null,
    });
    mocks.getRoleRollup.mockResolvedValue({
      roles: [{ label: 'lending', confidence: 'high', emailCount: 3 }],
      emailCount: 3,
      evidence: 'Handled loan syndication proposals.',
    });
    mocks.getNoteInputHash.mockResolvedValue({
      noteCount: 1,
      latestEmailId: 'e1',
      dealCompanyIds: [],
    });
    mocks.listDealEvidenceEmails.mockResolvedValue([]);
    mocks.getInteractionSummaries.mockResolvedValue(
      new Map([
        [
          'c1',
          {
            correspondentId: 'c1',
            totalEmailsFromUs: 5,
            totalEmailsFromThem: 4,
            teamMemberCount: 2,
            lastContactAt: '2026-10-15T00:00:00Z',
            team: [],
            hasSyncedData: true,
          },
        ],
      ]),
    );
    mocks.listContactDeals.mockResolvedValue({
      deals: [
        {
          companyId: 'co-1',
          companyName: 'Project Apollo',
          role: 'source',
          stage: 'L2',
          stageLabel: 'L2 · Diligence',
          isDropped: false,
          linkedAt: '2026-10-01',
        },
        {
          companyId: 'co-2',
          companyName: 'Nusantara Lending',
          role: 'involved',
          stage: 'L1',
          stageLabel: 'L1 · Preliminary Review',
          isDropped: true,
          linkedAt: '2026-08-01',
        },
      ],
      suggestions: [],
    });
  });

  it('generates relationship overview, saves text + input hash, and appends success log', async () => {
    mocks.invokeStructuredOutput.mockResolvedValueOnce({
      overview:
        'John Doe has been in close discussions with our team regarding Project Apollo and debt structuring. Best next move: Finalize term sheet review.',
      dealNotes: [],
      roleSummary: ' John mostly brings co-investment and debt structuring questions. ',
    });

    const result = await runContactRelationshipOverview(payload, deps);

    expect(result.overview).toContain('Best next move:');
    // The overview is shared: it reads every note (system read).
    expect(mocks.listNotesForSystem).toHaveBeenCalledWith('w1', 'c1', { limit: 30 });
    // The same call asks for the role summary, by the contact's name.
    const { prompt, systemPrompt } = mocks.invokeStructuredOutput.mock.calls[0][0];
    expect(prompt).toContain("role in investment across these emails");
    expect(systemPrompt).toContain('never by a guessed gender');
    expect(mocks.saveOverviewReady).toHaveBeenCalledWith('w1', 'c1', {
      text: expect.stringContaining('Best next move:'),
      // The hash covers the deals the lines were written for.
      inputHash: overviewInputHash({
        noteCount: 1,
        latestEmailId: 'e1',
        dealCompanyIds: ['co-1', 'co-2'],
      }),
      dealNotes: [],
      roleSummary: 'John mostly brings co-investment and debt structuring questions.',
    });
    expect(mocks.appendLog).toHaveBeenCalledWith('job-123', {
      message: 'Contact relationship overview generated successfully',
      metadata: { correspondentId: 'c1', dealNotes: 0 },
    });
    expect(mocks.markOverviewFailed).not.toHaveBeenCalled();
  });

  it('on LLM failure marks overview failed, logs error, and preserves previous text in DB', async () => {
    mocks.invokeStructuredOutput.mockRejectedValueOnce(new Error('LLM rate limit reached'));

    await expect(runContactRelationshipOverview(payload, deps)).rejects.toThrow(
      'LLM rate limit reached',
    );

    expect(mocks.markOverviewFailed).toHaveBeenCalledWith('w1', 'c1');
    expect(mocks.appendLog).toHaveBeenCalledWith('job-123', {
      message: 'LLM rate limit reached',
      metadata: { error: true, correspondentId: 'c1' },
    });
    expect(mocks.saveOverviewReady).not.toHaveBeenCalled();
  });

  it('tags notes with the deals they are evidence for and maps deal lines back to companies', async () => {
    mocks.listDealEvidenceEmails.mockResolvedValue([
      { companyId: 'co-2', emailId: 'e1' },
      { companyId: 'co-unlinked', emailId: 'e1' },
    ]);
    mocks.invokeStructuredOutput.mockResolvedValueOnce({
      overview: 'John passed on Nusantara. Best next move: revisit after licensing.',
      dealNotes: [
        { ref: 'D1', note: null },
        { ref: ' D2 ', note: ' Declined over regulatory exposure. ' },
        { ref: 'D2', note: 'A duplicate the model repeated.' },
        { ref: 'D9', note: 'A ref that was never listed.' },
      ],
    });

    const result = await runContactRelationshipOverview(payload, deps);

    expect(mocks.listDealEvidenceEmails).toHaveBeenCalledWith('w1', 'c1', ['co-1', 'co-2']);
    const { prompt, maxTokens } = mocks.invokeStructuredOutput.mock.calls[0][0];
    expect(prompt).toContain('- D1: Project Apollo (brought, current stage: L2 · Diligence)');
    expect(prompt).toContain('- D2: Nusantara Lending (involved, current stage: L1 · Preliminary Review, dropped)');
    expect(prompt).toContain('[inbound] [D2] (team: Alice Smith)');
    expect(maxTokens).toBe(1500 + 2 * 120);
    expect(result.dealNotes).toEqual([
      { companyId: 'co-2', note: 'Declined over regulatory exposure.' },
    ]);
    expect(mocks.saveOverviewReady).toHaveBeenCalledWith(
      'w1',
      'c1',
      expect.objectContaining({
        dealNotes: [{ companyId: 'co-2', note: 'Declined over regulatory exposure.' }],
      }),
    );
  });

  it('accepts no deal lines for a contact with no linked deals, and asks for none', async () => {
    mocks.listContactDeals.mockResolvedValue({ deals: [], suggestions: [] });
    mocks.invokeStructuredOutput.mockResolvedValueOnce({
      overview: 'John covers lending. Best next move: send the teaser.',
      dealNotes: [],
    });

    const result = await runContactRelationshipOverview(payload, deps);

    const { prompt } = mocks.invokeStructuredOutput.mock.calls[0][0];
    expect(prompt).toContain('No linked deals recorded.');
    expect(prompt).not.toContain('for every linked deal ref');
    expect(result.dealNotes).toEqual([]);
    expect(mocks.saveOverviewReady).toHaveBeenCalledWith(
      'w1',
      'c1',
      expect.objectContaining({ inputHash: '1:e1', dealNotes: [] }),
    );
  });

  it('saves no role summary when the model returns a blank one', async () => {
    mocks.invokeStructuredOutput.mockResolvedValueOnce({
      overview: 'John covers lending. Best next move: send the teaser.',
      dealNotes: [],
      roleSummary: '   ',
    });

    const result = await runContactRelationshipOverview(payload, deps);

    expect(result.roleSummary).toBeNull();
    expect(mocks.saveOverviewReady).toHaveBeenCalledWith(
      'w1',
      'c1',
      expect.objectContaining({ roleSummary: null }),
    );
  });

  it('parses a model answer that omits dealNotes and roleSummary', async () => {
    const { overviewOutputSchema } = await import('./contactRelationshipOverview');
    expect(overviewOutputSchema.parse({ overview: 'x' })).toEqual({
      overview: 'x',
      dealNotes: [],
      roleSummary: null,
    });
  });
});
