import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmailService,
  buildResetUrl,
  renderForgotPasswordEmail,
  renderAccountInviteEmail,
  renderResearchSummaryEmail,
  renderTaskCompletedEmail,
  renderTaskWaitingApprovalEmail,
  renderTaskFailedEmail,
  renderTaskProgressEmail,
  renderTaskInsightEmail,
  renderCompanyAssignedEmail,
  renderEmailPdfIngestedEmail,
  renderDealResurfacedEmail,
  renderFeedbackSubmittedEmail,
  renderConsentRecordedEmail,
  renderVoteInvitationEmail,
  renderVoteSubmittedEmail,
  renderVoteRecapEmail,
  renderInsightRefreshedEmail,
} from './emailService';
import type { AttachmentSender, EmailSender } from './emailService';

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

describe('renderAccountInviteEmail', () => {
  it('greets the user by name, invites them to set a password, and includes the link', () => {
    const out = renderAccountInviteEmail({
      name: 'Jane Doe',
      resetUrl: 'https://app.example.com/reset-password?token=t',
      ttlMinutes: 60,
    });
    expect(out.subject).toMatch(/welcome/i);
    expect(out.html).toContain('Hi Jane Doe,');
    expect(out.html).toContain('https://app.example.com/reset-password?token=t');
    expect(out.text).toContain('https://app.example.com/reset-password?token=t');
    expect(out.text).toContain('set your password');
  });

  it('formats a whole-day TTL as days, not minutes', () => {
    const out = renderAccountInviteEmail({
      name: 'Jane',
      resetUrl: 'https://x.com/reset-password?token=t',
      ttlMinutes: 7 * 24 * 60,
    });
    expect(out.html).toContain('7 days');
    expect(out.text).toContain('7 days');
  });

  it('falls back to minutes when the TTL is not a whole number of days', () => {
    const out = renderAccountInviteEmail({
      name: 'Jane',
      resetUrl: 'https://x.com/reset-password?token=t',
      ttlMinutes: 45,
    });
    expect(out.text).toContain('45 minutes');
  });

  it('escapes HTML in the name and reset URL', () => {
    const out = renderAccountInviteEmail({
      name: '<script>alert(1)</script>',
      resetUrl: 'https://x.com/?token=<script>alert(1)</script>',
      ttlMinutes: 60,
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});

describe('EmailService.sendAccountInviteEmail', () => {
  let sender: EmailSender;
  let service: EmailService;

  beforeEach(() => {
    sender = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    service = new EmailService(sender);
  });

  it('throws when required fields are missing', async () => {
    await expect(
      service.sendAccountInviteEmail({ email: '', name: 'Jane', token: 't', appUrl: 'https://x.com' }),
    ).rejects.toThrow('email is required');
    await expect(
      service.sendAccountInviteEmail({ email: 'a@b.com', name: '', token: 't', appUrl: 'https://x.com' }),
    ).rejects.toThrow('name is required');
    await expect(
      service.sendAccountInviteEmail({ email: 'a@b.com', name: 'Jane', token: '', appUrl: 'https://x.com' }),
    ).rejects.toThrow('token is required');
    await expect(
      service.sendAccountInviteEmail({ email: 'a@b.com', name: 'Jane', token: 't', appUrl: '' }),
    ).rejects.toThrow('appUrl is required');
  });

  it('calls the sender with a built set-password link and returns its result', async () => {
    const result = await service.sendAccountInviteEmail({
      email: 'user@example.com',
      name: 'Jane Doe',
      token: 'tok-xyz',
      appUrl: 'https://app.example.com',
    });

    expect(result).toEqual({ messageId: 'msg-1' });
    const arg = vi.mocked(sender).mock.calls[0][0];
    expect(arg.to).toBe('user@example.com');
    expect(arg.subject).toMatch(/welcome/i);
    expect(arg.html).toContain('https://app.example.com/reset-password?token=tok-xyz');
  });

  it('defaults the TTL to 7 days when none is given', async () => {
    await service.sendAccountInviteEmail({
      email: 'user@example.com',
      name: 'Jane',
      token: 't',
      appUrl: 'https://app.example.com',
    });
    const arg = vi.mocked(sender).mock.calls[0][0];
    expect(arg.text).toContain('7 days');
  });
});

describe('renderResearchSummaryEmail', () => {
  it('produces a subject prefixed with the title and a preview block in HTML/text', () => {
    const out = renderResearchSummaryEmail({
      title: 'Acme Corp',
      summaryMarkdown: 'Strong margin profile. EBITDA up 30% YoY.',
    });
    expect(out.subject).toBe('Research summary: Acme Corp');
    expect(out.html).toContain('Acme Corp');
    expect(out.html).toContain('Strong margin profile');
    expect(out.text).toContain('Strong margin profile');
  });

  it('escapes HTML in the title and preview body', () => {
    const out = renderResearchSummaryEmail({
      title: '<script>alert(1)</script>',
      summaryMarkdown: '<img src=x onerror=alert(1)>',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img');
  });

  it('truncates a long summary into a short preview with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = renderResearchSummaryEmail({ title: 't', summaryMarkdown: long });
    expect(out.text).toContain('…');
  });
});

describe('EmailService.sendResearchSummaryEmail', () => {
  let attachmentSender: AttachmentSender;
  let service: EmailService;

  beforeEach(() => {
    attachmentSender = vi.fn().mockResolvedValue({ messageId: 'ses-pdf-1' });
    service = new EmailService(vi.fn(), attachmentSender);
  });

  it('throws when required fields are missing', async () => {
    await expect(
      service.sendResearchSummaryEmail({
        email: '',
        title: 't',
        summaryMarkdown: 's',
        pdfBuffer: Buffer.from('x'),
      }),
    ).rejects.toThrow('email is required');

    await expect(
      service.sendResearchSummaryEmail({
        email: 'a@b.com',
        title: '',
        summaryMarkdown: 's',
        pdfBuffer: Buffer.from('x'),
      }),
    ).rejects.toThrow('title is required');

    await expect(
      service.sendResearchSummaryEmail({
        email: 'a@b.com',
        title: 't',
        summaryMarkdown: '',
        pdfBuffer: Buffer.from('x'),
      }),
    ).rejects.toThrow('summaryMarkdown is required');

    await expect(
      service.sendResearchSummaryEmail({
        email: 'a@b.com',
        title: 't',
        summaryMarkdown: 's',
        pdfBuffer: Buffer.alloc(0),
      }),
    ).rejects.toThrow('pdfBuffer is required');
  });

  it('attaches the PDF and uses a slugified filename by default', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 fake');
    const result = await service.sendResearchSummaryEmail({
      email: 'user@example.com',
      title: 'Acme Corp Q1 review',
      summaryMarkdown: 'Findings...',
      pdfBuffer,
    });

    expect(result).toEqual({ messageId: 'ses-pdf-1' });
    expect(attachmentSender).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(attachmentSender).mock.calls[0][0];
    expect(arg.to).toBe('user@example.com');
    expect(arg.subject).toBe('Research summary: Acme Corp Q1 review');
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe('acme-corp-q1-review.pdf');
    expect(arg.attachments[0].content).toBe(pdfBuffer);
    expect(arg.attachments[0].contentType).toBe('application/pdf');
  });

  it('uses a custom subject and filename when provided', async () => {
    await service.sendResearchSummaryEmail({
      email: 'user@example.com',
      title: 'X',
      summaryMarkdown: 'Y',
      pdfBuffer: Buffer.from('z'),
      subject: 'Custom subject',
      filename: 'custom-name.pdf',
    });

    const arg = vi.mocked(attachmentSender).mock.calls[0][0];
    expect(arg.subject).toBe('Custom subject');
    expect(arg.attachments[0].filename).toBe('custom-name.pdf');
  });
});

describe('EmailService.sendCompanyExcelEmail', () => {
  let attachmentSender: AttachmentSender;
  let service: EmailService;

  beforeEach(() => {
    attachmentSender = vi.fn().mockResolvedValue({ messageId: 'ses-xlsx-1' });
    service = new EmailService(vi.fn(), attachmentSender);
  });

  it('throws when required fields are missing', async () => {
    await expect(
      service.sendCompanyExcelEmail({
        email: '',
        title: 't',
        companyCount: 1,
        excelBuffer: Buffer.from('x'),
      }),
    ).rejects.toThrow('email is required');

    await expect(
      service.sendCompanyExcelEmail({
        email: 'a@b.com',
        title: '',
        companyCount: 1,
        excelBuffer: Buffer.from('x'),
      }),
    ).rejects.toThrow('title is required');

    await expect(
      service.sendCompanyExcelEmail({
        email: 'a@b.com',
        title: 't',
        companyCount: 1,
        excelBuffer: Buffer.alloc(0),
      }),
    ).rejects.toThrow('excelBuffer is required');
  });

  it('attaches the .xlsx with the correct content type and a slugified filename', async () => {
    const excelBuffer = Buffer.from('PK fake xlsx');
    const result = await service.sendCompanyExcelEmail({
      email: 'user@example.com',
      title: 'Family-owned Japan targets',
      companyCount: 7,
      filterSummary: 'geography=Japan, ownership=family',
      excelBuffer,
    });

    expect(result).toEqual({ messageId: 'ses-xlsx-1' });
    const arg = vi.mocked(attachmentSender).mock.calls[0][0];
    expect(arg.to).toBe('user@example.com');
    expect(arg.subject).toBe('Company export: Family-owned Japan targets');
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe('family-owned-japan-targets.xlsx');
    expect(arg.attachments[0].content).toBe(excelBuffer);
    expect(arg.attachments[0].contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // Body carries the count + filter for a quick sanity check.
    expect(arg.html).toContain('7 companies included.');
    expect(arg.html).toContain('geography=Japan, ownership=family');
  });

  it('honours a custom subject and filename', async () => {
    await service.sendCompanyExcelEmail({
      email: 'user@example.com',
      title: 'X',
      companyCount: 1,
      excelBuffer: Buffer.from('z'),
      subject: 'Custom subject',
      filename: 'custom.xlsx',
    });
    const arg = vi.mocked(attachmentSender).mock.calls[0][0];
    expect(arg.subject).toBe('Custom subject');
    expect(arg.attachments[0].filename).toBe('custom.xlsx');
  });
});

describe('EmailService.sendComposedEmail', () => {
  let sender: EmailSender;
  let attachmentSender: AttachmentSender;
  let service: EmailService;

  beforeEach(() => {
    sender = vi.fn().mockResolvedValue({ messageId: 'ses-plain' });
    attachmentSender = vi.fn().mockResolvedValue({ messageId: 'ses-attach' });
    service = new EmailService(sender, attachmentSender);
  });

  it('throws when required fields are missing', async () => {
    await expect(
      service.sendComposedEmail({ email: '', subject: 's', body: 'b' }),
    ).rejects.toThrow('email is required');
    await expect(
      service.sendComposedEmail({ email: 'a@b.com', subject: '', body: 'b' }),
    ).rejects.toThrow('subject is required');
    await expect(
      service.sendComposedEmail({ email: 'a@b.com', subject: 's', body: '' }),
    ).rejects.toThrow('body is required');
  });

  it('uses the plain (non-attachment) path when there are no attachments', async () => {
    const result = await service.sendComposedEmail({
      email: 'user@example.com',
      subject: 'Heads up',
      body: 'A quick note.',
    });
    expect(result).toEqual({ messageId: 'ses-plain' });
    expect(attachmentSender).not.toHaveBeenCalled();
    const arg = vi.mocked(sender).mock.calls[0][0];
    expect(arg.to).toBe('user@example.com');
    expect(arg.subject).toBe('Heads up');
    expect(arg.html).toContain('A quick note.');
    // Branded on behalf of the app, not the user.
    expect(arg.from).toMatch(/Investment Brain/);
  });

  it('carries every attachment in one email via the attachment path', async () => {
    const pdf = Buffer.from('%PDF fake');
    const xlsx = Buffer.from('PK xlsx');
    const result = await service.sendComposedEmail({
      email: 'user@example.com',
      subject: 'Your summary + spreadsheet',
      body: 'Both attached.',
      attachments: [
        { filename: 'summary.pdf', content: pdf, contentType: 'application/pdf' },
        {
          filename: 'export.xlsx',
          content: xlsx,
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    });
    expect(result).toEqual({ messageId: 'ses-attach' });
    expect(sender).not.toHaveBeenCalled();
    const arg = vi.mocked(attachmentSender).mock.calls[0][0];
    expect(arg.attachments).toHaveLength(2);
    expect(arg.attachments.map((a) => a.filename)).toEqual([
      'summary.pdf',
      'export.xlsx',
    ]);
    expect(arg.from).toMatch(/Investment Brain/);
    expect(arg.html).toContain('Both attached.');
  });
});

// ── Notification renderers (MB-90) ───────────────────────────────────────────

describe('renderTaskCompletedEmail', () => {
  it('builds the ✅ Complete subject and includes the summary + View Results CTA', () => {
    const out = renderTaskCompletedEmail({
      taskName: 'Project Maple screening',
      taskUrl: 'https://app.example.com/ai-workforce/tasks/r1',
      summary: 'Found 5 strong candidates.',
    });
    expect(out.subject).toBe('✅ Project Maple screening — Complete');
    expect(out.html).toContain('Found 5 strong candidates.');
    expect(out.html).toContain('https://app.example.com/ai-workforce/tasks/r1');
    expect(out.html).toContain('View Results');
    expect(out.html).toContain('Successfully completed');
    expect(out.text).toContain('Project Maple screening — Complete');
  });

  it('renders SUMMARY and RESULTS tables and the finished-at line', () => {
    const out = renderTaskCompletedEmail({
      taskName: 'Project Maple Screening',
      taskUrl: 'https://app.example.com/ai-workforce/tasks/r1',
      finishedAtLabel: 'Finished at 2:42 PM on April 28, 2026',
      summaryRows: [
        { label: 'Task', value: 'Screening 5 inbound targets' },
        { label: 'Duration', value: '27 minutes' },
      ],
      resultRows: [
        { label: 'Companies screened', value: '5' },
        { label: 'Pass L0 (Financial)', value: '4 (80%)', highlight: true },
      ],
    });
    expect(out.html).toContain('Finished at 2:42 PM on April 28, 2026');
    expect(out.html).toContain('Summary');
    expect(out.html).toContain('Screening 5 inbound targets');
    expect(out.html).toContain('Results');
    expect(out.html).toContain('Pass L0 (Financial)');
    expect(out.html).toContain('4 (80%)');
    expect(out.text).toContain('Companies screened: 5');
  });

  it('hides the free-text summary when structured result rows exist', () => {
    const out = renderTaskCompletedEmail({
      taskName: 'X',
      summary: 'free text that should be hidden',
      resultRows: [{ label: 'Companies screened', value: '5' }],
    });
    expect(out.html).not.toContain('free text that should be hidden');
  });

  it('omits everything optional when only a name is given', () => {
    const out = renderTaskCompletedEmail({ taskName: 'X' });
    expect(out.subject).toBe('✅ X — Complete');
    expect(out.text).not.toContain('undefined');
    expect(out.html).not.toContain('Summary');
  });
});

describe('renderTaskWaitingApprovalEmail', () => {
  it('builds the ⏳ Needs Your Approval subject around the action', () => {
    const out = renderTaskWaitingApprovalEmail({
      action: 'Promote NovaSpec Materials to L2',
      taskName: 'Project Maple screening',
    });
    expect(out.subject).toBe('⏳ Promote NovaSpec Materials to L2 — Needs Your Approval');
    expect(out.html).toContain('Project Maple screening');
  });

  it('renders the proposal card, change preview, and CTA when structured fields are given', () => {
    const out = renderTaskWaitingApprovalEmail({
      action: 'Promote NovaSpec Materials to L1',
      taskName: 'Project Maple screening',
      taskUrl: 'https://app.example.com/ai-workforce/tasks/r1',
      company: 'NovaSpec Materials',
      proposedAction: 'Move to stage L1',
      reason: 'Passes all L1 criteria; ready for partner discussion',
      changeField: 'Pipeline Stage',
      beforeValue: 'L0',
      afterValue: 'L1',
    });
    expect(out.html).toContain("What's being proposed");
    expect(out.html).toContain('NovaSpec Materials');
    expect(out.html).toContain('Move to stage L1');
    expect(out.html).toContain('Change preview');
    expect(out.html).toContain('Pipeline Stage');
    // CTA button is present because a taskUrl was supplied.
    expect(out.html).toContain('View Approval');
    expect(out.html).toContain('https://app.example.com/ai-workforce/tasks/r1');
    expect(out.text).toContain('Pipeline Stage: L0 → L1');
  });

  it('omits the CTA button when no taskUrl is given', () => {
    const out = renderTaskWaitingApprovalEmail({ action: 'Approve X' });
    expect(out.html).not.toContain('View Approval');
  });
});

describe('renderTaskFailedEmail', () => {
  it('uses Failed verb for agent failures', () => {
    const out = renderTaskFailedEmail({ taskName: 'Project Maple screening', reason: 'boom' });
    expect(out.subject).toBe('❌ Project Maple screening — Failed');
    expect(out.html).toContain('boom');
  });

  it('uses Canceled verb when cancelled is true', () => {
    const out = renderTaskFailedEmail({ taskName: 'Project Maple screening', cancelled: true });
    expect(out.subject).toBe('❌ Project Maple screening — Canceled');
    expect(out.text).toContain('canceled');
  });
});

describe('renderTaskProgressEmail', () => {
  it('puts the headline in the subject', () => {
    const out = renderTaskProgressEmail({
      taskName: 'Project Maple screening',
      headline: '47 companies scanned',
      progress: '47 companies scanned, 12 pass L0, 5 pass L1, continuing...',
    });
    expect(out.subject).toBe('⏳ Project Maple screening — 47 companies scanned');
    expect(out.html).toContain('12 pass L0');
  });

  it('defaults the headline to Progress Update', () => {
    const out = renderTaskProgressEmail({ taskName: 'X', progress: 'p' });
    expect(out.subject).toBe('⏳ X — Progress Update');
  });
});

describe('renderTaskInsightEmail', () => {
  it('builds the passes-criteria subject with confidence in the body', () => {
    const out = renderTaskInsightEmail({
      companyName: 'NovaSpec Materials',
      level: 'L1',
      confidencePct: 94,
    });
    expect(out.subject).toBe('✅ NovaSpec Materials — Passes L1 Criteria');
    expect(out.html).toContain('94% confidence');
  });

  it('rounds and omits confidence when absent', () => {
    const out = renderTaskInsightEmail({ companyName: 'X', level: 'L2' });
    expect(out.subject).toBe('✅ X — Passes L2 Criteria');
    expect(out.html).not.toContain('confidence');
  });
});

describe('renderInsightRefreshedEmail', () => {
  it('includes the escaped name, the version number and the CTA href', () => {
    const out = renderInsightRefreshedEmail({
      insightName: '<script>alert("xss")</script> Market Report',
      versionNo: 4,
      insightUrl: 'https://app.example.com/w/slug/insight/123',
    });
    expect(out.subject).toBe('"<script>alert("xss")</script> Market Report" was refreshed');
    expect(out.html).not.toContain('<script>alert("xss")</script>');
    expect(out.html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; Market Report');
    expect(out.html).toContain('version 4');
    expect(out.html).toContain('href="https://app.example.com/w/slug/insight/123"');
    expect(out.html).toContain('Open insight');
    expect(out.text).toContain('Market Report');
    expect(out.text).toContain('version 4');
    expect(out.text).toContain('Open insight: https://app.example.com/w/slug/insight/123');
  });

  it('omits CTA button when insightUrl is not provided', () => {
    const out = renderInsightRefreshedEmail({
      insightName: 'Market Report',
      versionNo: 2,
    });
    expect(out.html).not.toContain('Open insight');
    expect(out.text).not.toContain('Open insight:');
  });
});

describe('renderCompanyAssignedEmail', () => {
  it('addresses the recipient by name and names the assigned company', () => {
    const out = renderCompanyAssignedEmail({
      recipientName: 'Jane Doe',
      companyName: 'Acme Corp',
    });
    expect(out.subject).toBe('📌 Acme Corp — Assigned to you for verification');
    expect(out.html).toContain('Hey, Jane Doe,');
    expect(out.html).toContain('Acme Corp');
    expect(out.html).toContain('redirect it to the correct PIC');
    expect(out.text).toContain(
      'Hey, Jane Doe, you have been assigned this company Acme Corp because you are one of the email recipients from this bank.',
    );
  });

  it('names the banker source when provided', () => {
    const out = renderCompanyAssignedEmail({
      recipientName: 'Jane',
      companyName: 'Acme Corp',
      bankerSource: 'Goldman Sachs',
    });
    expect(out.html).toContain('this bank (Goldman Sachs)');
    expect(out.text).toContain('this bank (Goldman Sachs)');
  });

  it('renders a review CTA only when a company URL is provided', () => {
    const withUrl = renderCompanyAssignedEmail({
      recipientName: 'Jane',
      companyName: 'Acme Corp',
      companyUrl: 'https://app.example.com/pipeline/company-1',
    });
    expect(withUrl.html).toContain('https://app.example.com/pipeline/company-1');
    expect(withUrl.text).toContain('Review the company: https://app.example.com/pipeline/company-1');

    const withoutUrl = renderCompanyAssignedEmail({
      recipientName: 'Jane',
      companyName: 'Acme Corp',
    });
    expect(withoutUrl.html).not.toContain('Review Company');
  });

  it('escapes HTML in user-supplied values', () => {
    const out = renderCompanyAssignedEmail({
      recipientName: '<b>Jane</b>',
      companyName: 'Acme <script>alert(1)</script>',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;b&gt;Jane&lt;/b&gt;');
  });
});

describe('renderEmailPdfIngestedEmail', () => {
  const base = {
    email: 'jane@corp.com',
    fileName: 'Project Atlas - Teaser.pdf',
    workspaceName: 'MNA',
  };

  it('names the file and the workspace it landed in', () => {
    const out = renderEmailPdfIngestedEmail(base);
    expect(out.subject).toBe('📄 Project Atlas - Teaser.pdf added to MNA');
    expect(out.html).toContain('Project Atlas - Teaser.pdf');
    expect(out.html).toContain('<strong>MNA</strong>');
    expect(out.text).toContain(
      'A PDF attached to your email was scanned and added to MNA in Investment Brain.',
    );
    expect(out.text).toContain('Workspace: MNA');
  });

  it('greets the custodian by name only when one is known', () => {
    expect(renderEmailPdfIngestedEmail({ ...base, recipientName: 'Jane' }).html).toContain(
      'Hey, Jane,',
    );
    expect(renderEmailPdfIngestedEmail(base).html).not.toContain('Hey,');
  });

  it('renders the source email headers when the pipeline supplies them', () => {
    const out = renderEmailPdfIngestedEmail({
      ...base,
      emailSender: 'Jane Doe <jane@bank.com>',
      emailSubject: 'Project Atlas — teaser attached',
      emailReceivedLabel: '28 Sep 2026, 14:32 UTC',
    });
    expect(out.text).toContain('From: Jane Doe <jane@bank.com>');
    expect(out.text).toContain('Email subject: Project Atlas — teaser attached');
    expect(out.text).toContain('Received: 28 Sep 2026, 14:32 UTC');
  });

  it('falls back to the banker source when no sender header is available', () => {
    const out = renderEmailPdfIngestedEmail({ ...base, bankerSource: 'Goldman Sachs' });
    expect(out.text).toContain('From: Goldman Sachs');
  });

  it('prefers the sender header over the banker source', () => {
    const out = renderEmailPdfIngestedEmail({
      ...base,
      bankerSource: 'Goldman Sachs',
      emailSender: 'Jane Doe <jane@bank.com>',
    });
    expect(out.text).toContain('From: Jane Doe <jane@bank.com>');
    expect(out.text).not.toContain('Goldman Sachs');
  });

  it('lists optional metadata rows only when populated', () => {
    const full = renderEmailPdfIngestedEmail({
      ...base,
      fileTypeLabel: 'Prospectus',
      fileSizeLabel: '1.4 MB',
      fileDateLabel: '2026-09-01',
      matchedCompanies: ['Acme Corp', 'Beta Ltd'],
      tags: ['teaser', 'energy'],
      additionalWorkspaces: ['Ventures'],
    });
    expect(full.text).toContain('Document type: Prospectus');
    expect(full.text).toContain('Size: 1.4 MB');
    expect(full.text).toContain('Document date: 2026-09-01');
    expect(full.text).toContain('Companies: Acme Corp, Beta Ltd');
    expect(full.text).toContain('Tags: teaser, energy');
    expect(full.text).toContain('Also added to: Ventures');

    const sparse = renderEmailPdfIngestedEmail(base);
    expect(sparse.text).not.toContain('Document type:');
    expect(sparse.text).not.toContain('Companies:');
    expect(sparse.text).not.toContain('Also added to:');
  });

  it('reports the review status', () => {
    expect(renderEmailPdfIngestedEmail(base).text).toContain('Status: Processed');
    const review = renderEmailPdfIngestedEmail({ ...base, awaitingReview: true });
    expect(review.text).toContain('Status: Awaiting your review');
    expect(review.html).toContain('needs a human review');
  });

  it('renders a view CTA only when a file URL is provided', () => {
    const withUrl = renderEmailPdfIngestedEmail({
      ...base,
      fileUrl: 'https://app.example.com/w/mna/smart-files',
    });
    expect(withUrl.html).toContain('https://app.example.com/w/mna/smart-files');
    expect(withUrl.text).toContain(
      'View the document: https://app.example.com/w/mna/smart-files',
    );
    expect(renderEmailPdfIngestedEmail(base).text).not.toContain('View the document:');
  });

  it('escapes HTML in user-supplied values', () => {
    const out = renderEmailPdfIngestedEmail({
      ...base,
      fileName: '<script>alert(1)</script>.pdf',
      emailSubject: '<img src=x onerror=1>',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<img src=x');
  });
});

describe('EmailService notification methods', () => {
  it('sendTaskCompletedEmail delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);
    await svc.sendTaskCompletedEmail({ email: 'u@e.com', taskName: 'T' });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'u@e.com',
      subject: '✅ T — Complete',
    });
  });

  it('sendTaskWaitingApprovalEmail throws without an action', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendTaskWaitingApprovalEmail({ email: 'u@e.com', action: '' }),
    ).rejects.toThrow(/action is required/);
  });

  it('sendEmailPdfIngestedEmail delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);
    await svc.sendEmailPdfIngestedEmail({
      email: 'jane@corp.com',
      fileName: 'Teaser.pdf',
      workspaceName: 'MNA',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'jane@corp.com',
      subject: '📄 Teaser.pdf added to MNA',
    });
  });

  it('sendEmailPdfIngestedEmail throws without a fileName or workspaceName', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendEmailPdfIngestedEmail({ email: 'u@e.com', fileName: '', workspaceName: 'MNA' }),
    ).rejects.toThrow(/fileName is required/);
    await expect(
      svc.sendEmailPdfIngestedEmail({ email: 'u@e.com', fileName: 'a.pdf', workspaceName: '' }),
    ).rejects.toThrow(/workspaceName is required/);
  });

  it('sendCompanyAssignedEmail delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);
    await svc.sendCompanyAssignedEmail({
      email: 'jane@corp.com',
      recipientName: 'Jane',
      companyName: 'Acme Corp',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'jane@corp.com',
      subject: '📌 Acme Corp — Assigned to you for verification',
    });
  });

  it('sendCompanyAssignedEmail throws without a recipient name or company name', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendCompanyAssignedEmail({ email: 'u@e.com', recipientName: '', companyName: 'Acme' }),
    ).rejects.toThrow(/recipientName is required/);
    await expect(
      svc.sendCompanyAssignedEmail({ email: 'u@e.com', recipientName: 'Jane', companyName: '' }),
    ).rejects.toThrow(/companyName is required/);
  });

  it('sendInsightRefreshedEmail delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm-refreshed' });
    const svc = new EmailService(sender as EmailSender);
    const result = await svc.sendInsightRefreshedEmail({
      email: 'owner@example.com',
      insightName: 'Market Overview',
      versionNo: 5,
      insightUrl: 'https://app.example.com/insight/1',
    });
    expect(result).toEqual({ messageId: 'm-refreshed' });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'owner@example.com',
      subject: '"Market Overview" was refreshed',
    });
  });

  it('sendInsightRefreshedEmail throws without email or insightName', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendInsightRefreshedEmail({
        email: '',
        insightName: 'Market Overview',
        versionNo: 1,
      }),
    ).rejects.toThrow(/email is required/);
    await expect(
      svc.sendInsightRefreshedEmail({
        email: 'owner@example.com',
        insightName: '',
        versionNo: 1,
      }),
    ).rejects.toThrow(/insightName is required/);
  });
});

describe('renderDealResurfacedEmail', () => {
  it('builds subject, html, and text with the deal context rows', () => {
    const out = renderDealResurfacedEmail({
      companyName: 'Acme Corp',
      stage: 'L1',
      droppedAtLabel: 'April 3, 2026',
      dropReason: 'bad timing',
      companyUrl: 'https://app.example.com/pipeline',
    });
    expect(out.subject).toBe('Deal resurfaced: Acme Corp is back in the pipeline');
    expect(out.html).toContain('Acme Corp is back in the pipeline');
    expect(out.html).toContain('L1');
    expect(out.html).toContain('April 3, 2026');
    expect(out.html).toContain('bad timing');
    expect(out.html).toContain('https://app.example.com/pipeline');
    expect(out.text).toContain('Drop reason: bad timing');
    expect(out.text).toContain('Review the deal: https://app.example.com/pipeline');
  });

  it('omits context rows that are absent', () => {
    const out = renderDealResurfacedEmail({ companyName: 'X' });
    expect(out.html).not.toContain('Drop reason');
    expect(out.html).not.toContain('Dropped on');
    expect(out.text).not.toContain('Drop reason');
  });

  it('escapes HTML in user-supplied fields', () => {
    const out = renderDealResurfacedEmail({
      companyName: '<script>alert(1)</script>',
      dropReason: '<img src=x>',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<img src=x>');
  });
});

describe('EmailService.sendDealResurfacedEmail', () => {
  it('delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);
    await svc.sendDealResurfacedEmail({ email: 'u@e.com', companyName: 'Acme' });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'u@e.com',
      subject: 'Deal resurfaced: Acme is back in the pipeline',
    });
  });

  it('throws without an email or companyName', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendDealResurfacedEmail({ email: '', companyName: 'Acme' }),
    ).rejects.toThrow(/email is required/);
    await expect(
      svc.sendDealResurfacedEmail({ email: 'u@e.com', companyName: '' }),
    ).rejects.toThrow(/companyName is required/);
  });
});

describe('renderFeedbackSubmittedEmail', () => {
  it('builds subject, html, and text with submitter, workspace, title, and message', () => {
    const out = renderFeedbackSubmittedEmail({
      submitterName: 'Jane Doe',
      submitterEmail: 'jane@sqe.co.id',
      workspaceName: 'SQE Capital',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
    expect(out.subject).toBe('SQE Capital - New Feedback from Jane Doe Received');
    expect(out.html).toContain('Jane Doe');
    expect(out.html).toContain('jane@sqe.co.id');
    expect(out.html).toContain('SQE Capital');
    expect(out.html).toContain('Dark mode');
    expect(out.html).toContain('Please add dark mode');
    expect(out.text).toContain('Please add dark mode');
  });

  it('includes a clickable Jira ticket link and CTA when present, without duplicating in text', () => {
    const out = renderFeedbackSubmittedEmail({
      submitterName: 'Jane Doe',
      submitterEmail: 'jane@sqe.co.id',
      workspaceName: 'SQE Capital',
      title: 'Dark mode',
      message: 'Please add dark mode',
      jiraIssueKey: 'MB-999',
      jiraIssueUrl: 'https://smma-sqe.atlassian.net/browse/MB-999',
    });
    expect(out.subject).toBe('SQE Capital - New Feedback from Jane Doe Received');
    expect(out.html).toContain('MB-999');
    expect(out.html).toContain('href="https://smma-sqe.atlassian.net/browse/MB-999"');
    expect(out.text).toContain('Jira ticket: https://smma-sqe.atlassian.net/browse/MB-999');
    expect(out.text.match(/Jira ticket:/g)).toHaveLength(1);
  });

  it('strips CR/LF from the submitter name in the subject to prevent header injection', () => {
    const out = renderFeedbackSubmittedEmail({
      submitterName: 'Evil\r\nBcc: attacker@evil.com',
      submitterEmail: 'jane@sqe.co.id',
      workspaceName: 'SQE Capital',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
    expect(out.subject).toBe('SQE Capital - New Feedback from Evil Bcc: attacker@evil.com Received');
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it('escapes HTML in the title and message', () => {
    const out = renderFeedbackSubmittedEmail({
      submitterName: 'Jane Doe',
      submitterEmail: 'jane@sqe.co.id',
      workspaceName: 'SQE Capital',
      title: '<img src=x>',
      message: '<script>alert(1)</script>',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).not.toContain('<img src=x>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});

describe('EmailService.sendFeedbackSubmittedEmail', () => {
  it('delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);
    await svc.sendFeedbackSubmittedEmail({
      email: 'nico.alimin@smma.id',
      submitterName: 'Jane Doe',
      submitterEmail: 'jane@sqe.co.id',
      workspaceName: 'SQE Capital',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'nico.alimin@smma.id',
      subject: 'SQE Capital - New Feedback from Jane Doe Received',
    });
  });

  it('throws without an email, title, or message', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendFeedbackSubmittedEmail({
        email: '',
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@sqe.co.id',
        workspaceName: 'SQE Capital',
        title: 'Dark mode',
        message: 'x',
      }),
    ).rejects.toThrow(/email is required/);
    await expect(
      svc.sendFeedbackSubmittedEmail({
        email: 'nico.alimin@smma.id',
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@sqe.co.id',
        workspaceName: 'SQE Capital',
        title: '',
        message: 'x',
      }),
    ).rejects.toThrow(/title is required/);
    await expect(
      svc.sendFeedbackSubmittedEmail({
        email: 'nico.alimin@smma.id',
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@sqe.co.id',
        workspaceName: 'SQE Capital',
        title: 'Dark mode',
        message: '',
      }),
    ).rejects.toThrow(/message is required/);
  });
});

describe('renderConsentRecordedEmail', () => {
  it('builds subject, html, and text with user, policy version, and timestamp', () => {
    const out = renderConsentRecordedEmail({
      userName: 'Jane Doe',
      userEmail: 'jane@sqe.co.id',
      policyVersion: 'v1',
      consentedAtLabel: 'August 27, 2026, 2:42 PM',
    });
    expect(out.subject).toBe('Jane Doe accepted the Sync consent screen');
    expect(out.html).toContain('Jane Doe');
    expect(out.html).toContain('jane@sqe.co.id');
    expect(out.html).toContain('v1');
    expect(out.html).toContain('August 27, 2026, 2:42 PM');
    expect(out.text).toContain('Jane Doe accepted the Sync consent screen');
  });

  it('falls back to "Unknown user" in the subject when the name is blank', () => {
    const out = renderConsentRecordedEmail({
      userName: '   ',
      userEmail: 'jane@sqe.co.id',
      policyVersion: 'v1',
      consentedAtLabel: 'August 27, 2026, 2:42 PM',
    });
    expect(out.subject).toBe('Unknown user accepted the Sync consent screen');
  });

  it('strips CR/LF from the user name in the subject to prevent header injection', () => {
    const out = renderConsentRecordedEmail({
      userName: 'Evil\r\nBcc: attacker@evil.com',
      userEmail: 'jane@sqe.co.id',
      policyVersion: 'v1',
      consentedAtLabel: 'August 27, 2026, 2:42 PM',
    });
    expect(out.subject).toBe('Evil Bcc: attacker@evil.com accepted the Sync consent screen');
    expect(out.subject).not.toMatch(/[\r\n]/);
  });
});

describe('EmailService.sendConsentRecordedEmail', () => {
  it('delegates to the sender with the rendered email', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);
    await svc.sendConsentRecordedEmail({
      email: 'nico.alimin@smma.id',
      userName: 'Jane Doe',
      userEmail: 'jane@sqe.co.id',
      policyVersion: 'v1',
      consentedAtLabel: 'August 27, 2026, 2:42 PM',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'nico.alimin@smma.id',
      subject: 'Jane Doe accepted the Sync consent screen',
    });
  });

  it('throws without an email or userEmail', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(
      svc.sendConsentRecordedEmail({
        email: '',
        userName: 'Jane Doe',
        userEmail: 'jane@sqe.co.id',
        policyVersion: 'v1',
        consentedAtLabel: 'August 27, 2026, 2:42 PM',
      }),
    ).rejects.toThrow(/email is required/);
    await expect(
      svc.sendConsentRecordedEmail({
        email: 'nico.alimin@smma.id',
        userName: 'Jane Doe',
        userEmail: '',
        policyVersion: 'v1',
        consentedAtLabel: 'August 27, 2026, 2:42 PM',
      }),
    ).rejects.toThrow(/userEmail is required/);
  });
});

describe('renderVoteInvitationEmail', () => {
  const input = {
    recipientName: 'CP Tei',
    companyName: 'Project Highway',
    initiatorName: 'Nico',
    deadlineLabel: '5:00 PM UTC on September 5, 2026',
    voteUrl: 'https://app.example.com/w/mna/companies/c-1?tab=voting',
  };

  it('names the company in the subject', () => {
    expect(renderVoteInvitationEmail(input).subject).toBe(
      "You're a voter on Project Highway",
    );
  });

  it('states the deadline and initiator in both bodies', () => {
    const { html, text } = renderVoteInvitationEmail(input);
    for (const body of [html, text]) {
      expect(body).toContain('Project Highway');
      expect(body).toContain('5:00 PM UTC on September 5, 2026');
      expect(body).toContain('Nico');
    }
  });

  it('spells out the draft / submit / auto-submit rules', () => {
    const { html, text } = renderVoteInvitationEmail(input);
    expect(html).toContain('INCONCLUSIVE');
    expect(text).toContain('INCONCLUSIVE');
    expect(text).toContain('vote is final');
  });

  it('deep-links to the voting tab', () => {
    const { html, text } = renderVoteInvitationEmail(input);
    expect(html).toContain('tab=voting');
    expect(text).toContain(input.voteUrl);
  });

  it('links the company card in the app when a URL is supplied', () => {
    const withCard = {
      ...input,
      companyCardUrl: 'https://app.example.com/w/mna/companies/c-1?tab=overview',
    };
    const { html, text } = renderVoteInvitationEmail(withCard);

    expect(html).toContain('tab=overview');
    expect(html).toContain('view the company card');
    expect(text).toContain(withCard.companyCardUrl);
  });

  it('omits the card link when no URL is supplied', () => {
    const { html } = renderVoteInvitationEmail(input);
    expect(html).not.toContain('tab=overview');
  });

  it('promises the attachment only when there actually is one', () => {
    const withAttachment = renderVoteInvitationEmail(input, { hasAttachment: true });
    const without = renderVoteInvitationEmail(input, { hasAttachment: false });

    expect(withAttachment.text).toContain('attached to this email');
    expect(without.text).not.toContain('attached to this email');
    expect(without.html).toContain('Open the company card in the app');
  });
});

describe('EmailService.sendVoteInvitationEmail', () => {
  const input = {
    email: 'cp@example.com',
    recipientName: 'CP Tei',
    companyName: 'Project Highway',
    initiatorName: 'Nico',
    deadlineLabel: 'tomorrow',
    voteUrl: 'https://app.example.com/vote',
  };

  it('attaches the company card as a .pptx when one is supplied', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const attachmentSender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender, attachmentSender as AttachmentSender);

    await svc.sendVoteInvitationEmail({
      ...input,
      companyCardPptx: Buffer.from('deck'),
    });

    expect(sender).not.toHaveBeenCalled();
    expect(attachmentSender).toHaveBeenCalledTimes(1);
    const call = vi.mocked(attachmentSender).mock.calls[0][0];
    expect(call.attachments[0]).toMatchObject({
      filename: 'project-highway-company-card.pptx',
      contentType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
  });

  it('does not promise an attachment on the plain fallback path', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender, vi.fn() as AttachmentSender);

    await svc.sendVoteInvitationEmail({
      ...input,
      companyCardUrl: 'https://app.example.com/card',
    });

    const call = vi.mocked(sender).mock.calls[0][0];
    expect(call.text).not.toContain('attached to this email');
    expect(call.html).toContain('Open the company card in the app');
    expect(call.html).toContain('https://app.example.com/card');
  });

  it('falls back to a plain email when the deck could not be built', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const attachmentSender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender, attachmentSender as AttachmentSender);

    await svc.sendVoteInvitationEmail(input);

    expect(attachmentSender).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('throws without an email, companyName or voteUrl', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    await expect(svc.sendVoteInvitationEmail({ ...input, email: '' })).rejects.toThrow(
      /email is required/,
    );
    await expect(
      svc.sendVoteInvitationEmail({ ...input, companyName: '' }),
    ).rejects.toThrow(/companyName is required/);
    await expect(svc.sendVoteInvitationEmail({ ...input, voteUrl: '' })).rejects.toThrow(
      /voteUrl is required/,
    );
  });
});

describe('renderVoteSubmittedEmail', () => {
  const input = {
    recipientName: 'CP Tei',
    companyName: 'Project Highway',
    choiceLabel: 'HARD YES',
    deadlineLabel: 'tomorrow',
    voteUrl: 'https://app.example.com/vote',
  };

  it('confirms the submission in the subject', () => {
    expect(renderVoteSubmittedEmail(input).subject).toBe(
      'Your vote has been submitted for Project Highway',
    );
  });

  it('echoes back the recorded choice', () => {
    const { html, text } = renderVoteSubmittedEmail(input);
    expect(html).toContain('HARD YES');
    expect(text).toContain('HARD YES');
  });

  it('explains that the ballot is now locked', () => {
    expect(renderVoteSubmittedEmail(input).html).toContain('longer be edited');
  });
});

describe('EmailService.sendVoteSubmittedEmail', () => {
  it('delegates to the plain sender', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);

    await svc.sendVoteSubmittedEmail({
      email: 'cp@example.com',
      recipientName: 'CP Tei',
      companyName: 'Project Highway',
      choiceLabel: 'YES',
      deadlineLabel: 'tomorrow',
      voteUrl: 'https://app.example.com/vote',
    });

    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'cp@example.com',
      subject: 'Your vote has been submitted for Project Highway',
    });
  });
});

describe('renderVoteRecapEmail', () => {
  const input = {
    companyName: 'Project Highway',
    headline: '4–0 FOR',
    outcomeLabel: '4 Proceed',
    closedReason: 'all_submitted' as const,
    ballots: [
      { voterName: 'CP Tei', choiceLabel: 'YES', rationale: 'Support signing the NDA.' },
      { voterName: 'Jien Lit', choiceLabel: 'YES' },
    ],
    voteUrl: 'https://app.example.com/vote',
  };

  it('puts the company and headline in the subject', () => {
    expect(renderVoteRecapEmail(input).subject).toBe(
      'Voting closed: Project Highway — 4–0 FOR',
    );
  });

  it('lists every voter with their choice and rationale', () => {
    const { html, text } = renderVoteRecapEmail(input);
    for (const body of [html, text]) {
      expect(body).toContain('CP Tei');
      expect(body).toContain('Support signing the NDA.');
      expect(body).toContain('Jien Lit');
    }
  });

  it('says the round closed early when everyone submitted', () => {
    expect(renderVoteRecapEmail(input).text).toContain('closed early');
  });

  it('explains the auto-submit rule when the deadline closed it', () => {
    const { text } = renderVoteRecapEmail({ ...input, closedReason: 'deadline' });
    expect(text).toContain('deadline passed');
    expect(text).toContain('INCONCLUSIVE');
  });

  it('handles a round where nobody voted', () => {
    const { html, text } = renderVoteRecapEmail({ ...input, ballots: [] });
    expect(html).toContain('No ballots were cast');
    expect(text).toContain('(no ballots were cast)');
  });

  it('escapes voter-authored rationale so the recap cannot inject markup', () => {
    const { html } = renderVoteRecapEmail({
      ...input,
      ballots: [
        {
          voterName: 'CP Tei',
          choiceLabel: 'YES',
          rationale: '<img src=x onerror=alert(1)>',
        },
      ],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('EmailService.sendVoteRecapEmail', () => {
  it('delegates to the plain sender', async () => {
    const sender = vi.fn().mockResolvedValue({ messageId: 'm' });
    const svc = new EmailService(sender as EmailSender);

    await svc.sendVoteRecapEmail({
      email: 'nico@example.com',
      companyName: 'Project Highway',
      headline: '4–0 FOR',
      outcomeLabel: '4 Proceed',
      closedReason: 'deadline',
      ballots: [],
      voteUrl: 'https://app.example.com/vote',
    });

    expect(vi.mocked(sender).mock.calls[0][0]).toMatchObject({
      to: 'nico@example.com',
    });
  });

  it('throws without an email or companyName', async () => {
    const svc = new EmailService(vi.fn() as EmailSender);
    const base = {
      email: 'nico@example.com',
      companyName: 'Project Highway',
      headline: '4–0 FOR',
      outcomeLabel: '4 Proceed',
      closedReason: 'deadline' as const,
      ballots: [],
      voteUrl: 'https://app.example.com/vote',
    };
    await expect(svc.sendVoteRecapEmail({ ...base, email: '' })).rejects.toThrow(
      /email is required/,
    );
    await expect(svc.sendVoteRecapEmail({ ...base, companyName: '' })).rejects.toThrow(
      /companyName is required/,
    );
  });
});
