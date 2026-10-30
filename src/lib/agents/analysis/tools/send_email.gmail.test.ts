import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const { findAll, sendComposedEmail, isConfigured, getStatus, createDraft, enabled, buildResearchSummaryAttachment } =
  vi.hoisted(() => ({
    findAll: vi.fn(),
    sendComposedEmail: vi.fn(),
    isConfigured: vi.fn(),
    getStatus: vi.fn(),
    createDraft: vi.fn(),
    enabled: vi.fn(),
    buildResearchSummaryAttachment: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/flags', () => ({ gmailEnabled: () => enabled() }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({ gmailService: { isConfigured, getStatus, createDraft } })),
}));
vi.mock('@/lib/repositories', () => ({
  UserRepository: class {
    findAll = findAll;
  },
}));
vi.mock('@/lib/services/emailService', () => ({
  EmailService: class {
    sendComposedEmail = sendComposedEmail;
  },
}));
vi.mock('./emailArtifacts', async () => {
  const { z } = await import('zod');
  return {
    companyExcelSpecSchema: z.object({}).passthrough(),
    researchSummarySpecSchema: z.object({ title: z.string(), sections: z.array(z.any()).min(1) }).passthrough(),
    presentationSpecSchema: z.object({ title: z.string(), brief: z.string() }).passthrough(),
    companyCardSpecSchema: z.object({ company_names: z.array(z.string()).min(1) }).passthrough(),
    buildCompanyExcelAttachment: vi.fn(),
    buildResearchSummaryAttachment,
    ResearchSummaryTooLargeError: class extends Error {},
    buildPresentationAttachment: vi.fn(),
    buildCompanyCardAttachment: vi.fn(),
  };
});

import { sendEmailTool } from './send_email';
import { GmailApiError } from '@/lib/gmail';
import { GmailNotConnectedError, GmailScopeMissingError } from '@/lib/services/gmailService';

const CHAT: RunnableConfig = {
  configurable: { userId: 'u1', botId: 'copilot', userEmail: 'me@corp.com', agentRole: 'chat' },
};
const WORKFORCE: RunnableConfig = { configurable: { agentRole: 'workforce', userEmail: 'me@corp.com' } };

const invoke = async (args: Record<string, unknown>, config: RunnableConfig = CHAT) =>
  String(await sendEmailTool.invoke(args, config));

const connected = { connected: true, canDraft: true, googleEmail: 'me@gmail.com', connectedAt: 'x' };
const args = { to: ['banker@bank.com'], subject: 'Intro call', body: 'Hi,\nCan we talk <Tuesday>?' };

describe('send_email → Gmail draft', () => {
  beforeEach(() => {
    for (const m of [findAll, sendComposedEmail, isConfigured, getStatus, createDraft, enabled, buildResearchSummaryAttachment]) {
      m.mockReset();
    }
    enabled.mockResolvedValue(true);
    isConfigured.mockReturnValue(true);
    getStatus.mockResolvedValue(connected);
    createDraft.mockResolvedValue({ draftId: 'r1', messageId: 'm1', threadId: 't1', googleEmail: 'me@gmail.com' });
    findAll.mockResolvedValue([{ id: 'u1', name: 'Me', email: 'me@corp.com' }]);
    sendComposedEmail.mockResolvedValue({ messageId: 'ses-1' });
  });

  it('saves a draft instead of sending when the user has connected Gmail, and says nothing was sent', async () => {
    const out = await invoke(args);

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(sendComposedEmail).not.toHaveBeenCalled();
    expect(out).toContain('Saved as a DRAFT');
    expect(out).toContain('nothing was sent');
    expect(out).toContain('me@gmail.com');
    expect(out).toContain('https://mail.google.com/mail/u/me%40gmail.com/#drafts');
    expect(out).toContain('do not say the email was sent');
  });

  it('drafts for the chatting user only, with the user from the turn config', async () => {
    await invoke(args);
    expect(getStatus).toHaveBeenCalledWith('u1');
    expect(createDraft.mock.calls[0]![0]).toBe('u1');
  });

  it('can address any email address, not only platform users', async () => {
    await invoke({ ...args, to: ['Banker@Bank.com', 'cfo@target.co.id'] });
    expect(createDraft.mock.calls[0]![1].to).toEqual(['banker@bank.com', 'cfo@target.co.id']);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('writes a plain draft body: escaped HTML, no Investment Brain shell', async () => {
    await invoke(args);
    const draft = createDraft.mock.calls[0]![1];
    expect(draft.subject).toBe('Intro call');
    expect(draft.text).toBe('Hi,\nCan we talk <Tuesday>?');
    expect(draft.html).toContain('Can we talk &lt;Tuesday&gt;?');
    expect(draft.html).toContain('<br />');
    expect(draft.html).not.toContain('<Tuesday>');
    expect(draft.html).not.toMatch(/Investment Brain|Sent on behalf/);
  });

  it('addresses the signed-in user when no recipient is given, falling back to the Gmail address', async () => {
    await invoke({ subject: 's', body: 'b' });
    expect(createDraft.mock.calls[0]![1].to).toEqual(['me@corp.com']);

    createDraft.mockClear();
    await invoke({ subject: 's', body: 'b' }, { configurable: { userId: 'u1', botId: 'copilot' } });
    expect(createDraft.mock.calls[0]![1].to).toEqual(['me@gmail.com']);
  });

  it('attaches generated files to the draft and names them in the result', async () => {
    const attachment = { filename: 'summary.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' };
    buildResearchSummaryAttachment.mockResolvedValue({ attachment, title: 'Summary' });

    const out = await invoke({
      ...args,
      research_summary: { title: 'Summary', sections: [{ type: 'paragraph', text: 'x' }] },
    });

    expect(createDraft.mock.calls[0]![1].attachments).toEqual([attachment]);
    expect(out).toContain('with research summary (PDF)');
  });

  it('refuses a recipient that could smuggle in another address or header, without touching Gmail', async () => {
    for (const bad of ['a@b.com,evil@x.com', 'a@b.com\r\nBcc: evil@x.com', 'Ana <a@b.com>', 'nope']) {
      expect(await invoke({ ...args, to: [bad] }), bad).toMatch(/malformed/i);
    }
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('caps the recipients on one draft', async () => {
    const to = Array.from({ length: 26 }, (_, i) => `p${i}@x.com`);
    expect(await invoke({ ...args, to })).toMatch(/at most 25 recipients/);
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('send_email → platform send', () => {
  beforeEach(() => {
    for (const m of [findAll, sendComposedEmail, isConfigured, getStatus, createDraft, enabled]) m.mockReset();
    enabled.mockResolvedValue(true);
    isConfigured.mockReturnValue(true);
    getStatus.mockResolvedValue(connected);
    findAll.mockResolvedValue([
      { id: 'u1', name: 'Me', email: 'me@corp.com' },
      { id: 'u2', name: 'Ana', email: 'ana@corp.com' },
    ]);
    sendComposedEmail.mockResolvedValue({ messageId: 'ses-1' });
  });

  it('sends for real, to platform users only, when the user asks to send on behalf of Brain', async () => {
    const out = await invoke({ ...args, to: ['ana@corp.com', 'banker@bank.com'], send_as_brain: true });

    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(sendComposedEmail.mock.calls[0]![0].email).toBe('ana@corp.com');
    expect(out).toContain('Sent to 1 platform user(s)');
    expect(out).toContain('Skipped 1 address(es) not on the platform: banker@bank.com');
    expect(createDraft).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('sends via the platform when the user has not connected Gmail', async () => {
    getStatus.mockResolvedValue({ connected: false, canDraft: false, googleEmail: null, connectedAt: null });
    const out = await invoke({ ...args, to: ['ana@corp.com'] });
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(out).toContain('Sent to 1 platform user(s)');
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('sends via the platform when Gmail is off for the workspace or not set up on this deployment', async () => {
    enabled.mockResolvedValue(false);
    await invoke({ ...args, to: ['ana@corp.com'] });
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(getStatus).not.toHaveBeenCalled();

    enabled.mockResolvedValue(true);
    isConfigured.mockReturnValue(false);
    await invoke({ ...args, to: ['ana@corp.com'] });
    expect(sendComposedEmail).toHaveBeenCalledTimes(2);
    expect(getStatus).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('never drafts when the turn is marked workforce, even if a user id were present', async () => {
    await invoke(
      { ...args, to: ['ana@corp.com'] },
      { configurable: { userId: 'u1', agentRole: 'workforce', userEmail: 'me@corp.com' } },
    );
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(createDraft).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('never drafts in a Workforce run, which has no chatting user — and does not even consult Gmail', async () => {
    await invoke({ ...args, to: ['ana@corp.com'] }, WORKFORCE);
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(getStatus).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('send_email → Gmail problems', () => {
  it('says nothing was sent when something fails before the draft is saved', async () => {
    enabled.mockResolvedValue(true);
    isConfigured.mockReturnValue(true);
    getStatus.mockResolvedValue(connected);
    buildResearchSummaryAttachment.mockRejectedValue(new Error('pdf renderer down'));
    const out = await invoke({ ...args, research_summary: { title: 'S', sections: [{ type: 'paragraph', text: 'x' }] } });
    expect(out).toContain('Nothing was sent. Could not save the Gmail draft — pdf renderer down');
    expect(createDraft).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    for (const m of [findAll, sendComposedEmail, isConfigured, getStatus, createDraft, enabled]) m.mockReset();
    enabled.mockResolvedValue(true);
    isConfigured.mockReturnValue(true);
    getStatus.mockResolvedValue(connected);
    findAll.mockResolvedValue([]);
  });

  it('asks the user to reconnect when their connection predates draft permission, and sends nothing', async () => {
    getStatus.mockResolvedValue({ ...connected, canDraft: false });
    const out = await invoke(args);
    expect(out).toContain('Nothing was sent or saved');
    expect(out).toContain('Reconnect');
    expect(out).toContain('Only if the user asks');
    expect(createDraft).not.toHaveBeenCalled();
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('does not quietly fall back to sending when the connection has expired', async () => {
    createDraft.mockRejectedValue(new GmailNotConnectedError('expired'));
    const out = await invoke(args);
    expect(out).toMatch(/^\*\*Error:\*\*/);
    expect(out).toContain('expired or was revoked');
    expect(out).toContain('Only if the user asks');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('says to reconnect when Google reports the permission missing at draft time', async () => {
    createDraft.mockRejectedValue(new GmailScopeMissingError('gmail.compose'));
    expect(await invoke(args)).toContain('Reconnect');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('turns Gmail API failures into messages, never a throw', async () => {
    createDraft.mockRejectedValueOnce(new GmailApiError(429, 'slow', 9));
    expect(await invoke(args)).toContain('rate limiting requests. Try again in 9s');

    createDraft.mockRejectedValueOnce(new GmailApiError(403, 'Request had insufficient authentication scopes.'));
    expect(await invoke(args)).toContain('Gmail refused to create the draft');

    createDraft.mockRejectedValueOnce(new GmailApiError(503, 'backend error'));
    expect(await invoke(args)).toContain('Could not save the Gmail draft: backend error');

    createDraft.mockRejectedValueOnce(new Error('kaput'));
    expect(await invoke(args)).toContain('Could not save the Gmail draft: kaput');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });
});
