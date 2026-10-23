import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getConversationMock, getConversationForWorkforceMock, createContainerMock } = vi.hoisted(() => ({
  getConversationMock: vi.fn(),
  getConversationForWorkforceMock: vi.fn(),
  createContainerMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({ db: true })) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn().mockResolvedValue('w1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import { MAX_EMAIL_NOTES, readContactEmails } from './read_contact_emails';

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    contactId: 'corr-1',
    hasSyncedData: true,
    roles: {
      roles: [{ label: 'advisory', confidence: 'high', emailCount: 3 }],
      emailCount: 3,
      evidence: 'Runs the sell-side process for the vendor.',
    },
    overview: { status: 'none', text: null, generatedAt: null, stale: false, roleSummary: null },
    notes: [
      {
        emailId: 'e2',
        sentAt: '2026-10-12T03:00:00.000Z',
        direction: 'inbound',
        teamMembers: [],
        summary: 'Jane, who heads the bank’s ASEAN TMT coverage, sent the teaser.',
        keyPoints: ['Teaser attached'],
        nextStep: 'Sign the NDA',
        nextStepStatus: 'action',
        sentiment: 'neutral',
      },
      {
        emailId: 'e1',
        sentAt: '2026-10-01T03:00:00.000Z',
        direction: 'outbound',
        teamMembers: [],
        summary: 'We asked for the teaser.',
        keyPoints: [],
        nextStep: null,
        nextStepStatus: 'none',
        sentiment: 'neutral',
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

beforeEach(() => {
  getConversationMock.mockReset().mockResolvedValue(conversation());
  createContainerMock
    .mockReset()
    .mockReturnValue({
      contactConversationService: {
        getConversation: getConversationMock,
        getConversationForWorkforce: getConversationForWorkforceMock,
      },
    });
  getConversationForWorkforceMock.mockReset().mockResolvedValue(conversation());
});

describe('readContactEmails tool', () => {
  it('reads one bounded page of the contact’s notes and roles in this workspace', async () => {
    await readContactEmails.invoke({ correspondent_id: 'corr-1' });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(getConversationMock).toHaveBeenCalledTimes(1);
    // No triggering user in the config: notes are private, so none are readable.
    expect(getConversationMock).toHaveBeenCalledWith('corr-1', '', { limit: MAX_EMAIL_NOTES });
  });

  it('lists roles and dated notes newest first, with the side and how to cite them', async () => {
    const out = (await readContactEmails.invoke({ correspondent_id: 'corr-1' })) as string;
    expect(out).toContain('## Email evidence — 2 most recent note(s)');
    expect(out).toContain('- advisory (high confidence, 3 email(s))');
    expect(out).toContain('Evidence: Runs the sell-side process for the vendor.');
    expect(out.indexOf('2026-10-12 · from their side')).toBeLessThan(out.indexOf('2026-10-01 · from us'));
    expect(out).toContain('Key points: Teaser attached');
    expect(out).toContain('Next step: Sign the NDA');
    expect(out).toContain('Attribute a fact to this contact only when the note says it about them');
    expect(out).toContain('"email 2026-10-12 from their side"');
  });

  it('says when older notes were left out', async () => {
    getConversationMock.mockResolvedValue(conversation({ nextCursor: 'c' }));
    const out = (await readContactEmails.invoke({ correspondent_id: 'corr-1' })) as string;
    expect(out).toContain(`older notes exist; these are the newest ${MAX_EMAIL_NOTES}`);
  });

  it('reads the full context in a Workforce run, whose trace redacts this output', async () => {
    await readContactEmails.invoke(
      { correspondent_id: 'corr-1' },
      { configurable: { agentRole: 'workforce', triggered_by_user_id: 'u-clicker' } },
    );
    expect(getConversationForWorkforceMock).toHaveBeenCalledWith('corr-1', { limit: MAX_EMAIL_NOTES });
    expect(getConversationMock).not.toHaveBeenCalled();
  });

  it('leads with the last relationship overview when there is one', async () => {
    getConversationMock.mockResolvedValue(
      conversation({
        overview: {
          status: 'ready',
          text: 'Jane runs ASEAN TMT coverage.',
          generatedAt: '2026-10-20T00:00:00Z',
          stale: false,
          roleSummary: 'Jane mostly brings sell-side mandates in TMT.',
        },
      }),
    );
    const out = (await readContactEmails.invoke({ correspondent_id: 'corr-1' })) as string;
    expect(out.startsWith('### Relationship overview (the last AI summary of their emails, 2026-10-20)')).toBe(true);
    expect(out).toContain('Jane runs ASEAN TMT coverage.');
    expect(out).toContain('Across their emails: Jane mostly brings sell-side mandates in TMT.');
    expect(out).toContain('never quote or paraphrase them in narrate_step');
  });

  it('falls back to the record and the web when there are no notes', async () => {
    getConversationMock.mockResolvedValue(conversation({ notes: [] }));
    expect(await readContactEmails.invoke({ correspondent_id: 'corr-1' })).toContain(
      'Rely on the record and the web.',
    );
    getConversationMock.mockResolvedValue(conversation({ notes: [], hasSyncedData: false }));
    expect(await readContactEmails.invoke({ correspondent_id: 'corr-1' })).toContain(
      'no synced email',
    );
  });

  it('reports an unknown contact and other errors instead of throwing', async () => {
    getConversationMock.mockRejectedValueOnce(new ContactNotFoundError('corr-x'));
    expect(await readContactEmails.invoke({ correspondent_id: 'corr-x' })).toBe(
      '**Error:** no CRM contact corr-x in this workspace.',
    );
    getConversationMock.mockRejectedValueOnce(new Error('db down'));
    expect(await readContactEmails.invoke({ correspondent_id: 'corr-1' })).toBe('**Error:** db down');
  });
});
