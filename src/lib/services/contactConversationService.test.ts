import { describe, it, expect, vi, beforeEach } from 'vitest';

const handler = vi.hoisted(() => ({ runContactRelationshipOverview: vi.fn() }));
vi.mock('@/lib/jobs/handlers/contactRelationshipOverview', () => handler);

import {
  ContactConversationService,
  InvalidOverviewRefreshSinceError,
} from './contactConversationService';
import { overviewInputHash } from '@/lib/crm/overviewInputHash';
import { ContactNotFoundError } from './crmContactEnrichmentService';
import type {
  ContactConversationRepository,
  ContactInteractionRepository,
  CorrespondentRepository,
} from '@/lib/repositories';
import type { JobDispatcher } from './jobDispatcher';

describe('ContactConversationService', () => {
  let contactConversationRepo: {
    listNotes: ReturnType<typeof vi.fn>;
    getRoleRollup: ReturnType<typeof vi.fn>;
    getNoteInputHash: ReturnType<typeof vi.fn>;
    getOverview: ReturnType<typeof vi.fn>;
    claimOverviewPending: ReturnType<typeof vi.fn>;
    claimOverviewsPending: ReturnType<typeof vi.fn>;
    setOverviewJobId: ReturnType<typeof vi.fn>;
    listOverviewRefreshCandidates: ReturnType<typeof vi.fn>;
    saveOverviewReady: ReturnType<typeof vi.fn>;
    markOverviewFailed: ReturnType<typeof vi.fn>;
  };
  let correspondentRepo: {
    findById: ReturnType<typeof vi.fn>;
  };
  let contactInteractionRepo: {
    workspaceHasSyncedData: ReturnType<typeof vi.fn>;
  };
  let jobDispatcher: {
    dispatch: ReturnType<typeof vi.fn>;
  };
  let service: ContactConversationService;

  beforeEach(() => {
    contactConversationRepo = {
      listNotes: vi.fn().mockResolvedValue({ notes: [], nextCursor: null }),
      getRoleRollup: vi.fn().mockResolvedValue({ roles: [], emailCount: 0, evidence: null }),
      getNoteInputHash: vi
        .fn()
        .mockResolvedValue({ noteCount: 0, latestEmailId: null, dealCompanyIds: [] }),
      getOverview: vi.fn().mockResolvedValue(null),
      claimOverviewPending: vi.fn().mockResolvedValue(true),
      claimOverviewsPending: vi.fn(async (_workspaceId: string, ids: string[]) => ids),
      setOverviewJobId: vi.fn().mockResolvedValue(undefined),
      listOverviewRefreshCandidates: vi.fn().mockResolvedValue([]),
      saveOverviewReady: vi.fn().mockResolvedValue(undefined),
      markOverviewFailed: vi.fn().mockResolvedValue(undefined),
    };
    correspondentRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'c1', name: 'Jane Banker' }),
    };
    contactInteractionRepo = {
      workspaceHasSyncedData: vi.fn().mockResolvedValue(true),
    };
    jobDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    };

    service = new ContactConversationService(
      contactConversationRepo as unknown as ContactConversationRepository,
      correspondentRepo as unknown as CorrespondentRepository,
      contactInteractionRepo as unknown as ContactInteractionRepository,
      jobDispatcher as unknown as JobDispatcher,
      'w1',
    );
  });

  describe('getConversation', () => {
    it('throws ContactNotFoundError if contact is not visible in the workspace', async () => {
      correspondentRepo.findById.mockResolvedValueOnce(undefined);
      await expect(service.getConversation('c1', 'u1')).rejects.toThrow(ContactNotFoundError);
    });

    it('marks overview stale when no text exists and notes exist', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 3,
        latestEmailId: 'e3',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce(null);

      const conv = await service.getConversation('c1', 'u1');
      expect(conv.overview.status).toBe('none');
      expect(conv.overview.text).toBeNull();
      expect(conv.overview.stale).toBe(true);
    });

    it('hides a stored overview once no note is left behind it', async () => {
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Mostly arranged office meetings.',
        input_hash: 'v2:2:e2',
        generated_at: '2026-10-01T00:00:00Z',
        role_summary: 'Advisor',
      });

      const conv = await service.getConversation('c1', 'u1');
      expect(conv.overview).toMatchObject({
        status: 'none',
        text: null,
        stale: false,
        dealNotes: [],
        roleSummary: null,
      });
    });

    it('marks overview stale when row input_hash differs from currentHash', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 5,
        latestEmailId: 'e5',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Old overview summary.',
        input_hash: 'v2:4:e4',
        generated_at: '2026-10-01T00:00:00Z',
      });

      const conv = await service.getConversation('c1', 'u1');
      expect(conv.overview.status).toBe('ready');
      expect(conv.overview.text).toBe('Old overview summary.');
      expect(conv.overview.stale).toBe(true);
    });

    it('marks overview fresh (stale=false) when input_hash matches currentHash', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 4,
        latestEmailId: 'e4',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Fresh overview summary.',
        input_hash: 'v2:4:e4',
        generated_at: '2026-10-01T00:00:00Z',
      });

      const conv = await service.getConversation('c1', 'u1');
      expect(conv.overview.status).toBe('ready');
      expect(conv.overview.stale).toBe(false);
    });

    it('returns full ContactConversation DTO with notes, roles, and hasSyncedData', async () => {
      const mockNotes = [
        {
          emailId: 'e1',
          sentAt: '2026-10-10T00:00:00Z',
          direction: 'inbound' as const,
          teamMembers: [{ userId: 'u1', name: 'Alice', sent: true }],
          summary: 'Summary 1',
          keyPoints: ['point 1'],
          nextStep: 'Action',
          nextStepStatus: 'action' as const,
          sentiment: 'positive' as const,
        },
      ];
      contactConversationRepo.listNotes.mockResolvedValueOnce({
        notes: mockNotes,
        nextCursor: 'cursor-123',
      });
      contactConversationRepo.getRoleRollup.mockResolvedValueOnce({
        roles: [{ label: 'funding', confidence: 'high', emailCount: 2 }],
        emailCount: 2,
        evidence: 'Role evidence sentence.',
      });

      const conv = await service.getConversation('c1', 'u1');
      expect(conv.contactId).toBe('c1');
      expect(conv.hasSyncedData).toBe(true);
      expect(conv.roles.roles.length).toBe(1);
      expect(conv.roles.evidence).toBe('Role evidence sentence.');
      expect(conv.notes).toEqual(mockNotes);
      expect(conv.nextCursor).toBe('cursor-123');
    });
  });

  describe('getConversation with CRM_EMAIL_NOTES_ENABLED off', () => {
    it('returns and reads no notes, but keeps roles and the overview', async () => {
      contactConversationRepo.getRoleRollup.mockResolvedValueOnce({
        roles: [{ label: 'funding', confidence: 'high', emailCount: 2 }],
        emailCount: 2,
        evidence: 'Role evidence sentence.',
      });
      const conv = await service.getConversation('c1', 'u1', { includeNotes: false, limit: 20 });
      expect(conv.notes).toEqual([]);
      expect(conv.nextCursor).toBeNull();
      expect(contactConversationRepo.listNotes).not.toHaveBeenCalled();
      expect(conv.roles.roles).toHaveLength(1);
    });

    it('passes the note filters, without includeNotes, to the repository when on', async () => {
      await service.getConversation('c1', 'u1', { includeNotes: true, limit: 20, cursor: 'k' });
      expect(contactConversationRepo.listNotes).toHaveBeenCalledWith('w1', 'c1', 'u1', {
        limit: 20,
        cursor: 'k',
      });
    });
  });

  describe('requestOverview', () => {
    it('throws ContactNotFoundError if contact is not visible', async () => {
      correspondentRepo.findById.mockResolvedValueOnce(undefined);
      await expect(service.requestOverview('c1')).rejects.toThrow(ContactNotFoundError);
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('does NOT dispatch when there are zero notes', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 0,
        latestEmailId: null,
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce(null);

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
      expect(res.status).toBe('none');
      expect(res.stale).toBe(false);
    });

    it('does NOT dispatch when status is already pending', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 3,
        latestEmailId: 'e3',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'pending',
        overview: 'Existing text',
        input_hash: 'v2:2:e2',
        generated_at: null,
        updated_at: new Date().toISOString(),
      });

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
      expect(res.status).toBe('pending');
      expect(res.text).toBe('Existing text');
    });

    it('re-dispatches when a pending row has been abandoned for over 5 minutes', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 3,
        latestEmailId: 'e3',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'pending',
        overview: 'Existing text',
        input_hash: 'v2:2:e2',
        generated_at: null,
        updated_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      });

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('pending');
      expect(res.text).toBe('Existing text');
    });

    it('does NOT dispatch when fresh and ready (not stale)', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 3,
        latestEmailId: 'e3',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Current overview',
        input_hash: 'v2:3:e3',
        generated_at: '2026-10-15T00:00:00Z',
      });

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
      expect(res.status).toBe('ready');
      expect(res.text).toBe('Current overview');
      expect(res.stale).toBe(false);
    });

    it('dispatches when none-with-notes (no row, noteCount > 0)', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 2,
        latestEmailId: 'e2',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce(null);

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'contact_relationship_overview',
          payload: { correspondentIds: ['c1'], workspaceId: 'w1' },
        }),
      );
      expect(contactConversationRepo.claimOverviewPending).toHaveBeenCalledWith('w1', 'c1');
      expect(contactConversationRepo.setOverviewJobId).toHaveBeenCalledWith('w1', ['c1'], 'job-1');
      expect(res.status).toBe('pending');
      expect(res.text).toBeNull();
    });

    it('dispatches when status is failed', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 2,
        latestEmailId: 'e2',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'failed',
        overview: 'Prior text kept',
        input_hash: 'v2:1:e1',
        generated_at: '2026-09-01T00:00:00Z',
      });

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(contactConversationRepo.claimOverviewPending).toHaveBeenCalledWith('w1', 'c1');
      expect(contactConversationRepo.setOverviewJobId).toHaveBeenCalledWith('w1', ['c1'], 'job-1');
      expect(res.status).toBe('pending');
      expect(res.text).toBe('Prior text kept');
    });

    it('dispatches when stale (ready but input_hash differs)', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 5,
        latestEmailId: 'e5',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Old text',
        input_hash: 'v2:4:e4',
        generated_at: '2026-10-01T00:00:00Z',
      });

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(contactConversationRepo.claimOverviewPending).toHaveBeenCalledWith('w1', 'c1');
      expect(contactConversationRepo.setOverviewJobId).toHaveBeenCalledWith('w1', ['c1'], 'job-1');
      expect(res.status).toBe('pending');
      expect(res.text).toBe('Old text');
    });

    it('does NOT dispatch when another worker claimed the overview first', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 2,
        latestEmailId: 'e2',
        dealCompanyIds: [],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce(null);
      contactConversationRepo.claimOverviewPending.mockResolvedValueOnce(false);

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
      expect(res.status).toBe('none');
    });

    it('dispatches when a deal was linked since the overview was written', async () => {
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce({
        noteCount: 3,
        latestEmailId: 'e3',
        dealCompanyIds: ['co-1'],
      });
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Text from before the link',
        input_hash: 'v2:3:e3',
        deal_notes: [],
        generated_at: '2026-10-15T00:00:00Z',
      });

      const res = await service.requestOverview('c1');
      expect(jobDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('pending');
      expect(res.stale).toBe(true);
    });
  });

  describe('getConversation overview', () => {
    it('returns the stored per-deal lines and role summary, fresh when the deal set matches', async () => {
      const hash = { noteCount: 3, latestEmailId: 'e3', dealCompanyIds: ['co-1'] };
      contactConversationRepo.getNoteInputHash.mockResolvedValueOnce(hash);
      contactConversationRepo.getOverview.mockResolvedValueOnce({
        status: 'ready',
        overview: 'Overview.',
        input_hash: overviewInputHash(hash),
        deal_notes: [{ companyId: 'co-1', note: 'Asked for the data room.' }, { companyId: 7 }],
        role_summary: 'Penny mostly negotiates facility terms.',
        generated_at: '2026-10-15T00:00:00Z',
      });

      const { overview } = await service.getConversation('c1', 'u1');
      expect(overview.stale).toBe(false);
      expect(overview.dealNotes).toEqual([{ companyId: 'co-1', note: 'Asked for the data room.' }]);
      // Shared, like the overview: every viewer gets the same sentence.
      expect(overview.roleSummary).toBe('Penny mostly negotiates facility terms.');
    });

    it('has no role summary before an overview exists', async () => {
      contactConversationRepo.getOverview.mockResolvedValueOnce(null);
      const { overview } = await service.getConversation('c1', 'u1');
      expect(overview.status).toBe('none');
      expect(overview.roleSummary).toBeNull();
    });
  });

  describe('refreshTouchedOverviews', () => {
    const NOW = Date.now();
    const ago = (min: number) => new Date(NOW - min * 60 * 1000).toISOString();
    const candidate = (over: Record<string, unknown>) => ({
      correspondentId: 'c',
      noteCount: 2,
      latestEmailId: 'e2',
      dealCompanyIds: [],
      status: 'ready',
      inputHash: 'v2:2:e2',
      hasText: true,
      updatedAt: ago(30),
      ...over,
    });

    beforeEach(() => {
      handler.runContactRelationshipOverview.mockReset();
    });

    it('claims only missing or stale overviews no live job holds, and runs them in one job', async () => {
      contactConversationRepo.listOverviewRefreshCandidates.mockResolvedValueOnce([
        candidate({ correspondentId: 'fresh' }),
        candidate({ correspondentId: 'stale', inputHash: 'v2:1:e1' }),
        candidate({ correspondentId: 'new-deal', dealCompanyIds: ['co-1'] }),
        candidate({ correspondentId: 'none', status: null, inputHash: null, hasText: false, updatedAt: null }),
        candidate({ correspondentId: 'pending-live', status: 'pending', inputHash: 'v2:1:e1', updatedAt: ago(1) }),
        candidate({ correspondentId: 'pending-dead', status: 'pending', inputHash: 'v2:1:e1', updatedAt: ago(10) }),
        candidate({ correspondentId: 'failed-recent', status: 'failed', updatedAt: ago(10) }),
        candidate({ correspondentId: 'failed-old', status: 'failed', updatedAt: ago(90) }),
      ]);

      const res = await service.refreshTouchedOverviews('2026-10-21T00:00:00Z');

      const claimed = ['stale', 'new-deal', 'none', 'pending-dead', 'failed-old'];
      expect(contactConversationRepo.listOverviewRefreshCandidates).toHaveBeenCalledWith(
        'w1',
        '2026-10-21T00:00:00.000Z',
      );
      expect(contactConversationRepo.claimOverviewsPending).toHaveBeenCalledWith('w1', claimed);
      expect(jobDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(jobDispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'contact_relationship_overview',
          payload: { correspondentIds: claimed, workspaceId: 'w1' },
        }),
      );
      expect(contactConversationRepo.setOverviewJobId).toHaveBeenCalledWith('w1', claimed, 'job-1');
      expect(res).toEqual({ candidates: 8, claimed: 5, jobId: 'job-1' });
    });

    it('claims at most 10, newest first, and skips a contact another worker claimed', async () => {
      const ids = Array.from({ length: 11 }, (_, i) => `c${i}`);
      contactConversationRepo.listOverviewRefreshCandidates.mockResolvedValueOnce(
        ids.map((id) => candidate({ correspondentId: id, inputHash: null })),
      );
      // Another worker holds c0; the claim returns the rest in any order.
      contactConversationRepo.claimOverviewsPending.mockResolvedValueOnce(ids.slice(1, 10).reverse());

      const res = await service.refreshTouchedOverviews('2026-10-21T00:00:00Z');

      expect(contactConversationRepo.claimOverviewsPending).toHaveBeenCalledWith('w1', ids.slice(0, 10));
      expect(contactConversationRepo.setOverviewJobId).toHaveBeenCalledWith('w1', ids.slice(1, 10), 'job-1');
      expect(res.claimed).toBe(9);
    });

    it('dispatches nothing when no overview is due', async () => {
      contactConversationRepo.listOverviewRefreshCandidates.mockResolvedValueOnce([
        candidate({ correspondentId: 'fresh' }),
      ]);
      await expect(service.refreshTouchedOverviews('2026-10-21T00:00:00Z')).resolves.toEqual({
        candidates: 1,
        claimed: 0,
        jobId: null,
      });
      expect(jobDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('rejects an unparseable since', async () => {
      await expect(service.refreshTouchedOverviews('yesterday')).rejects.toThrow(
        InvalidOverviewRefreshSinceError,
      );
      expect(contactConversationRepo.listOverviewRefreshCandidates).not.toHaveBeenCalled();
    });

    it("the job keeps going past one contact's failure and fails only when all do", async () => {
      contactConversationRepo.listOverviewRefreshCandidates.mockResolvedValue([
        candidate({ correspondentId: 'a', inputHash: null }),
        candidate({ correspondentId: 'b', inputHash: null }),
      ]);
      await service.refreshTouchedOverviews('2026-10-21T00:00:00Z');
      const { work } = jobDispatcher.dispatch.mock.calls[0][0];
      const ctx = { job: { id: 'job-1' }, db: {} };

      handler.runContactRelationshipOverview
        .mockRejectedValueOnce(new Error('LLM down'))
        .mockResolvedValueOnce({ overview: 'ok', dealNotes: [] });
      await expect(work(ctx)).resolves.toEqual({ ready: 1, failed: 1 });
      expect(handler.runContactRelationshipOverview).toHaveBeenCalledWith(
        { correspondentId: 'b', workspaceId: 'w1', jobId: 'job-1' },
        { db: {} },
      );

      handler.runContactRelationshipOverview.mockRejectedValue(new Error('LLM down'));
      await expect(work(ctx)).rejects.toThrow('All 2 overviews failed');
    });
  });
});
