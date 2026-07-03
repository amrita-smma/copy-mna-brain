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
});
