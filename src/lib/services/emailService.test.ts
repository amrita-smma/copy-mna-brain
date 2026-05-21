import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmailService,
  buildResetUrl,
  renderForgotPasswordEmail,
} from './emailService';
import type { EmailSender } from './emailService';

describe('buildResetUrl', () => {
  it('appends the token as a URL-encoded query param', () => {
    const url = buildResetUrl('abc123', 'https://app.example.com');
    expect(url).toBe('https://app.example.com/reset-password?token=abc123');
  });

  it('strips trailing slashes from the base URL', () => {
    const url = buildResetUrl('t', 'https://app.example.com/');
    expect(url).toBe('https://app.example.com/reset-password?token=t');
  });

  it('encodes special characters in the token', () => {
    const url = buildResetUrl('a/b+c=d', 'https://x.com');
    expect(url).toContain('token=a%2Fb%2Bc%3Dd');
  });
});

describe('renderForgotPasswordEmail', () => {
  it('produces subject, html, and text', () => {
    const out = renderForgotPasswordEmail({
      resetUrl: 'https://app.example.com/reset-password?token=t',
      ttlMinutes: 60,
    });
    expect(out.subject).toMatch(/reset/i);
    expect(out.html).toContain('https://app.example.com/reset-password?token=t');
    expect(out.text).toContain('https://app.example.com/reset-password?token=t');
    expect(out.text).toContain('60 minutes');
  });

  it('escapes HTML in the reset URL to prevent injection', () => {
    const out = renderForgotPasswordEmail({
      // Pathological token containing characters that buildResetUrl would
      // normally encode, but render the URL anyway to verify escaping.
      resetUrl: 'https://x.com/?token=<script>alert(1)</script>',
      ttlMinutes: 30,
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});

describe('EmailService.sendForgotPasswordEmail', () => {
  let sender: EmailSender;
  let service: EmailService;

  beforeEach(() => {
    sender = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    service = new EmailService(sender);
  });

  it('throws when email is missing', async () => {
    await expect(
      service.sendForgotPasswordEmail({
        email: '',
        token: 't',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('email is required');
  });

  it('throws when token is missing', async () => {
    await expect(
      service.sendForgotPasswordEmail({
        email: 'a@b.com',
        token: '',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('token is required');
  });

  it('throws when appUrl is missing', async () => {
    await expect(
      service.sendForgotPasswordEmail({
        email: 'a@b.com',
        token: 't',
        appUrl: '',
      }),
    ).rejects.toThrow('appUrl is required');
  });

  it('calls the sender with a built reset link and returns its result', async () => {
    const result = await service.sendForgotPasswordEmail({
      email: 'user@example.com',
      token: 'tok-xyz',
      appUrl: 'https://app.example.com',
      ttlMinutes: 45,
    });

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(sender).toHaveBeenCalledTimes(1);

    const arg = vi.mocked(sender).mock.calls[0][0];
    expect(arg.to).toBe('user@example.com');
    expect(arg.subject).toMatch(/reset/i);
    expect(arg.html).toContain(
      'https://app.example.com/reset-password?token=tok-xyz',
    );
    expect(arg.text).toContain('45 minutes');
  });

  it('uses the provided appUrl (sourced from the request origin) to build the reset link', async () => {
    await service.sendForgotPasswordEmail({
      email: 'user@example.com',
      token: 'plain',
      appUrl: 'https://preview-123.vercel.app',
    });
    const arg = vi.mocked(sender).mock.calls[0][0];
    expect(arg.html).toContain(
      'https://preview-123.vercel.app/reset-password?token=plain',
    );
  });

  it('propagates errors from the sender', async () => {
    sender = vi.fn().mockRejectedValue(new Error('SES boom'));
    service = new EmailService(sender);
    await expect(
      service.sendForgotPasswordEmail({
        email: 'a@b.com',
        token: 't',
        appUrl: 'https://x.com',
      }),
    ).rejects.toThrow('SES boom');
  });
});
