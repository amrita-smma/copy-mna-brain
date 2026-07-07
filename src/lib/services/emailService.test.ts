import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmailService,
  buildResetUrl,
  renderForgotPasswordEmail,
  renderResearchSummaryEmail,
  renderTaskCompletedEmail,
  renderTaskWaitingApprovalEmail,
  renderTaskFailedEmail,
  renderTaskProgressEmail,
  renderTaskInsightEmail,
  renderCompanyAssignedEmail,
  renderDealResurfacedEmail,
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
