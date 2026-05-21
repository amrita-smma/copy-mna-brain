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
});
