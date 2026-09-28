import { describe, expect, it, vi } from 'vitest';
import { runSendEmail } from './sendEmail';
import type { SendEmailPayload } from './sendEmail';
import { EmailService } from '@/lib/services/emailService';

function makeService(): EmailService {
  const svc = new EmailService(vi.fn().mockResolvedValue({ messageId: 'msg-1' }));
  vi.spyOn(svc, 'sendForgotPasswordEmail');
  return svc;
}

describe('runSendEmail', () => {
  it('throws when payload is missing `to`', async () => {
    await expect(
      runSendEmail({
        kind: 'forgot_password',
        to: '',
        token: 't',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('`to` is required');
  });

  it('throws when forgot_password payload is missing `token`', async () => {
    await expect(
      runSendEmail({
        kind: 'forgot_password',
        to: 'a@b.com',
        token: '',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('`token` is required');
  });

  it('throws when forgot_password payload is missing `appUrl`', async () => {
    await expect(
      runSendEmail({
        kind: 'forgot_password',
        to: 'a@b.com',
        token: 't',
        appUrl: '',
      }),
    ).rejects.toThrow('`appUrl` is required');
  });

  it('delegates forgot_password to EmailService.sendForgotPasswordEmail', async () => {
    const emailService = makeService();
    const payload: SendEmailPayload = {
      kind: 'forgot_password',
      to: 'user@example.com',
      token: 'tok-1',
      ttlMinutes: 30,
      appUrl: 'https://app.example.com',
    };

    const result = await runSendEmail(payload, { emailService });

    expect(emailService.sendForgotPasswordEmail).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: 'tok-1',
      appUrl: 'https://app.example.com',
      ttlMinutes: 30,
    });
    expect(result).toEqual({
      kind: 'forgot_password',
      to: 'user@example.com',
      messageId: 'msg-1',
    });
  });

  it('returns the SES message id from the email service', async () => {
    const fakeService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'ses-abc' }),
    );
    const result = await runSendEmail(
      {
        kind: 'forgot_password',
        to: 'a@b.com',
        token: 'x',
        appUrl: 'https://x.com',
      },
      { emailService: fakeService },
    );
    expect(result.messageId).toBe('ses-abc');
  });

  it('lets EmailService errors propagate (so the runner marks the job failed)', async () => {
    const errorService = new EmailService(
      vi.fn().mockRejectedValue(new Error('SES rate limit')),
    );
    await expect(
      runSendEmail(
        {
          kind: 'forgot_password',
          to: 'a@b.com',
          token: 't',
          appUrl: 'https://x.com',
        },
        { emailService: errorService },
      ),
    ).rejects.toThrow('SES rate limit');
  });

  it('throws when account_invite payload is missing `name`', async () => {
    await expect(
      runSendEmail({
        kind: 'account_invite',
        to: 'a@b.com',
        name: '',
        token: 't',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('`name` is required');
  });

  it('throws when account_invite payload is missing `token`', async () => {
    await expect(
      runSendEmail({
        kind: 'account_invite',
        to: 'a@b.com',
        name: 'Jane',
        token: '',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('`token` is required');
  });

  it('throws when account_invite payload is missing `appUrl`', async () => {
    await expect(
      runSendEmail({
        kind: 'account_invite',
        to: 'a@b.com',
        name: 'Jane',
        token: 't',
        appUrl: '',
      }),
    ).rejects.toThrow('`appUrl` is required');
  });

  it('delegates account_invite to EmailService.sendAccountInviteEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'msg-invite' }),
    );
    const spy = vi.spyOn(emailService, 'sendAccountInviteEmail');
    const payload: SendEmailPayload = {
      kind: 'account_invite',
      to: 'new@example.com',
      name: 'Jane Doe',
      token: 'tok-1',
      appUrl: 'https://app.example.com',
      ttlMinutes: 10080,
    };

    const result = await runSendEmail(payload, { emailService });

    expect(spy).toHaveBeenCalledWith({
      email: 'new@example.com',
      name: 'Jane Doe',
      token: 'tok-1',
      appUrl: 'https://app.example.com',
      ttlMinutes: 10080,
    });
    expect(result).toEqual({
      kind: 'account_invite',
      to: 'new@example.com',
      messageId: 'msg-invite',
    });
  });

  it('delegates task_completed to EmailService.sendTaskCompletedEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm1' }),
    );
    const spy = vi.spyOn(emailService, 'sendTaskCompletedEmail');
    const payload: SendEmailPayload = {
      kind: 'task_completed',
      to: 'u@e.com',
      taskName: 'Project Maple',
      taskUrl: 'https://x/t',
      summary: 'done',
    };
    const result = await runSendEmail(payload, { emailService });
    expect(spy).toHaveBeenCalledWith({
      email: 'u@e.com',
      taskName: 'Project Maple',
      taskUrl: 'https://x/t',
      summary: 'done',
    });
    expect(result).toEqual({ kind: 'task_completed', to: 'u@e.com', messageId: 'm1' });
  });

  it('delegates task_waiting_approval to EmailService', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm2' }),
    );
    const spy = vi.spyOn(emailService, 'sendTaskWaitingApprovalEmail');
    await runSendEmail(
      {
        kind: 'task_waiting_approval',
        to: 'u@e.com',
        action: 'Promote X to L1',
        company: 'X',
        proposedAction: 'Move to stage L1',
        reason: 'passes',
        changeField: 'Pipeline Stage',
        beforeValue: 'L0',
        afterValue: 'L1',
      },
      { emailService },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'u@e.com',
        action: 'Promote X to L1',
        company: 'X',
        beforeValue: 'L0',
        afterValue: 'L1',
      }),
    );
  });

  it('delegates task_failed with the cancelled flag', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm3' }),
    );
    const spy = vi.spyOn(emailService, 'sendTaskFailedEmail');
    await runSendEmail(
      { kind: 'task_failed', to: 'u@e.com', taskName: 'T', cancelled: true },
      { emailService },
    );
    expect(spy).toHaveBeenCalledWith({
      email: 'u@e.com',
      taskName: 'T',
      reason: undefined,
      cancelled: true,
      taskUrl: undefined,
    });
  });

  it('delegates task_progress and task_insight', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm4' }),
    );
    const progress = vi.spyOn(emailService, 'sendTaskProgressEmail');
    const insight = vi.spyOn(emailService, 'sendTaskInsightEmail');

    await runSendEmail(
      { kind: 'task_progress', to: 'u@e.com', taskName: 'T', progress: '47 scanned' },
      { emailService },
    );
    await runSendEmail(
      { kind: 'task_insight', to: 'u@e.com', companyName: 'NovaSpec', level: 'L1', confidencePct: 94 },
      { emailService },
    );

    expect(progress).toHaveBeenCalledOnce();
    expect(insight).toHaveBeenCalledWith({
      email: 'u@e.com',
      companyName: 'NovaSpec',
      level: 'L1',
      detail: undefined,
      confidencePct: 94,
      taskUrl: undefined,
    });
  });

  it('delegates company_assigned to EmailService.sendCompanyAssignedEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm5' }),
    );
    const spy = vi.spyOn(emailService, 'sendCompanyAssignedEmail');

    const result = await runSendEmail(
      {
        kind: 'company_assigned',
        to: 'jane@corp.com',
        recipientName: 'Jane',
        companyName: 'Acme Corp',
        bankerSource: 'Goldman Sachs',
        companyUrl: 'https://app.example.com/pipeline/company-1',
      },
      { emailService },
    );

    expect(spy).toHaveBeenCalledWith({
      email: 'jane@corp.com',
      recipientName: 'Jane',
      companyName: 'Acme Corp',
      bankerSource: 'Goldman Sachs',
      companyUrl: 'https://app.example.com/pipeline/company-1',
    });
    expect(result).toEqual({ kind: 'company_assigned', to: 'jane@corp.com', messageId: 'm5' });
  });

  it('throws when company_assigned payload is missing recipientName or companyName', async () => {
    await expect(
      runSendEmail({
        kind: 'company_assigned',
        to: 'jane@corp.com',
        recipientName: '',
        companyName: 'Acme Corp',
      }),
    ).rejects.toThrow('`recipientName` is required');
    await expect(
      runSendEmail({
        kind: 'company_assigned',
        to: 'jane@corp.com',
        recipientName: 'Jane',
        companyName: '',
      }),
    ).rejects.toThrow('`companyName` is required');
  });

  it('delegates deal_resurfaced to EmailService.sendDealResurfacedEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm5' }),
    );
    const spy = vi.spyOn(emailService, 'sendDealResurfacedEmail');
    const result = await runSendEmail(
      {
        kind: 'deal_resurfaced',
        to: 'pic@fund.com',
        companyName: 'Acme Corp',
        stage: 'L1',
        droppedAtLabel: 'April 3, 2026',
        dropReason: 'bad timing',
        companyUrl: 'https://x/pipeline',
      },
      { emailService },
    );
    expect(spy).toHaveBeenCalledWith({
      email: 'pic@fund.com',
      companyName: 'Acme Corp',
      stage: 'L1',
      droppedAtLabel: 'April 3, 2026',
      dropReason: 'bad timing',
      companyUrl: 'https://x/pipeline',
    });
    expect(result).toEqual({ kind: 'deal_resurfaced', to: 'pic@fund.com', messageId: 'm5' });
  });

  it('throws when deal_resurfaced payload is missing companyName', async () => {
    await expect(
      runSendEmail({ kind: 'deal_resurfaced', to: 'a@b.com', companyName: '' }),
    ).rejects.toThrow('`companyName` is required');
  });

  it('delegates vote_submitted to EmailService.sendVoteSubmittedEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm6' }),
    );
    const spy = vi.spyOn(emailService, 'sendVoteSubmittedEmail');
    const result = await runSendEmail(
      {
        kind: 'vote_submitted',
        to: 'cp@example.com',
        recipientName: 'CP Tei',
        companyName: 'Project Highway',
        choiceLabel: 'HARD YES',
        deadlineLabel: 'tomorrow',
        voteUrl: 'https://x/vote',
      },
      { emailService },
    );
    expect(spy).toHaveBeenCalledWith({
      email: 'cp@example.com',
      recipientName: 'CP Tei',
      companyName: 'Project Highway',
      choiceLabel: 'HARD YES',
      deadlineLabel: 'tomorrow',
      voteUrl: 'https://x/vote',
    });
    expect(result).toEqual({
      kind: 'vote_submitted',
      to: 'cp@example.com',
      messageId: 'm6',
    });
  });

  it('throws when vote_submitted payload is missing companyName', async () => {
    await expect(
      runSendEmail({
        kind: 'vote_submitted',
        to: 'a@b.com',
        recipientName: 'A',
        companyName: '',
        choiceLabel: 'YES',
        deadlineLabel: 'tomorrow',
        voteUrl: 'https://x/vote',
      }),
    ).rejects.toThrow('`companyName` is required');
  });

  it('delegates vote_recap to EmailService.sendVoteRecapEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm7' }),
    );
    const spy = vi.spyOn(emailService, 'sendVoteRecapEmail');
    const result = await runSendEmail(
      {
        kind: 'vote_recap',
        to: 'nico@example.com',
        companyName: 'Project Highway',
        headline: '4–0 FOR',
        outcomeLabel: '4 Proceed',
        closedReason: 'all_submitted',
        ballots: [{ voterName: 'CP Tei', choiceLabel: 'YES' }],
        voteUrl: 'https://x/vote',
      },
      { emailService },
    );
    expect(spy).toHaveBeenCalledWith({
      email: 'nico@example.com',
      companyName: 'Project Highway',
      headline: '4–0 FOR',
      outcomeLabel: '4 Proceed',
      closedReason: 'all_submitted',
      ballots: [{ voterName: 'CP Tei', choiceLabel: 'YES' }],
      voteUrl: 'https://x/vote',
    });
    expect(result).toEqual({
      kind: 'vote_recap',
      to: 'nico@example.com',
      messageId: 'm7',
    });
  });

  it('defaults vote_recap ballots to an empty list when the payload omits them', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm8' }),
    );
    const spy = vi.spyOn(emailService, 'sendVoteRecapEmail');
    await runSendEmail(
      {
        kind: 'vote_recap',
        to: 'nico@example.com',
        companyName: 'Project Highway',
        headline: '0–0 SPLIT',
        outcomeLabel: 'Split',
        closedReason: 'deadline',
        voteUrl: 'https://x/vote',
      } as never,
      { emailService },
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ ballots: [] }));
  });

  it('delegates insight_refreshed to EmailService.sendInsightRefreshedEmail', async () => {
    const emailService = new EmailService(
      vi.fn().mockResolvedValue({ messageId: 'm-insight' }),
    );
    const spy = vi.spyOn(emailService, 'sendInsightRefreshedEmail');
    const payload: SendEmailPayload = {
      kind: 'insight_refreshed',
      to: 'owner@example.com',
      insightName: 'Japan Target Analysis',
      versionNo: 2,
      insightUrl: 'https://app.example.com/w/togan/insight/i1',
    };

    const result = await runSendEmail(payload, { emailService });

    expect(spy).toHaveBeenCalledWith({
      email: 'owner@example.com',
      insightName: 'Japan Target Analysis',
      versionNo: 2,
      insightUrl: 'https://app.example.com/w/togan/insight/i1',
    });
    expect(result).toEqual({
      kind: 'insight_refreshed',
      to: 'owner@example.com',
      messageId: 'm-insight',
    });
  });
});
