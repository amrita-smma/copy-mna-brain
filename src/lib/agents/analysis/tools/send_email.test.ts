import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const {
  findAll,
  sendComposedEmail,
  buildCompanyExcelAttachment,
  buildResearchSummaryAttachment,
  buildPresentationAttachment,
} = vi.hoisted(() => ({
  findAll: vi.fn(),
  sendComposedEmail: vi.fn(),
  buildCompanyExcelAttachment: vi.fn(),
  buildResearchSummaryAttachment: vi.fn(),
  buildPresentationAttachment: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));

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

// Mock the artifact builders (real ones hit the DB / render exceljs + pdf).
// Provide lightweight zod schemas so the tool's argsSchema still constructs.
vi.mock('./emailArtifacts', async () => {
  const { z } = await import('zod');
  return {
    companyExcelSpecSchema: z.object({}).passthrough(),
    researchSummarySpecSchema: z
      .object({ title: z.string(), sections: z.array(z.any()).min(1) })
      .passthrough(),
    presentationSpecSchema: z
      .object({ title: z.string(), brief: z.string() })
      .passthrough(),
    buildCompanyExcelAttachment,
    buildResearchSummaryAttachment,
    buildPresentationAttachment,
  };
});

import { sendEmailTool } from './send_email';

function invoke(args: Record<string, unknown>, config?: RunnableConfig) {
  return sendEmailTool.invoke(args, config);
}

const PLATFORM_USERS = [
  { id: 'u1', name: 'Ana', email: 'ana@e.com', role: null },
  { id: 'u2', name: 'Bo', email: 'BO@e.com', role: null },
  { id: 'u3', name: 'No Email', email: null, role: null },
];

const XLSX_ATTACHMENT = {
  filename: 'export.xlsx',
  content: Buffer.from('xlsx'),
  contentType:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const PDF_ATTACHMENT = {
  filename: 'summary.pdf',
  content: Buffer.from('pdf'),
  contentType: 'application/pdf',
};

describe('send_email', () => {
  beforeEach(() => {
    findAll.mockReset();
    sendComposedEmail.mockReset();
    buildCompanyExcelAttachment.mockReset();
    buildResearchSummaryAttachment.mockReset();
    findAll.mockResolvedValue(PLATFORM_USERS);
    sendComposedEmail.mockResolvedValue({ messageId: 'msg-1' });
    buildCompanyExcelAttachment.mockResolvedValue({
      attachment: XLSX_ATTACHMENT,
      title: 'Export',
      companyCount: 3,
      filterSummary: 'stage=L1',
    });
    buildResearchSummaryAttachment.mockResolvedValue({
      attachment: PDF_ATTACHMENT,
      title: 'Summary',
    });
  });

  it('requires a non-blank subject and body (whitespace is trimmed)', async () => {
    expect(String(await invoke({ to: ['ana@e.com'], subject: '   ', body: 'hi' }))).toMatch(
      /subject is required/i,
    );
    expect(String(await invoke({ to: ['ana@e.com'], subject: 's', body: '   ' }))).toMatch(
      /body is required/i,
    );
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('rejects malformed addresses without sending', async () => {
    const result = await invoke({ to: ['not-an-email'], subject: 's', body: 'b' });
    expect(String(result)).toMatch(/malformed/i);
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('sends a body-only email to whitelisted users (case-insensitive), no attachments', async () => {
    const result = await invoke({
      to: ['ana@e.com', 'bo@e.com'],
      subject: 'Hello team',
      body: 'Heads up on the deal.',
    });
    expect(sendComposedEmail).toHaveBeenCalledTimes(2);
    expect(sendComposedEmail).toHaveBeenCalledWith({
      email: 'ana@e.com',
      subject: 'Hello team',
      body: 'Heads up on the deal.',
      attachments: [],
    });
    // Matched against the stored address ("BO@e.com"), not the lowercased input.
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'BO@e.com' }),
    );
    expect(String(result)).toMatch(/Sent to 2 platform user/i);
  });

  it('skips addresses that are not registered platform users', async () => {
    const result = await invoke({
      to: ['ana@e.com', 'stranger@external.com'],
      subject: 's',
      body: 'b',
    });
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@e.com' }),
    );
    expect(String(result)).toMatch(/Sent to 1 platform user/i);
    expect(String(result)).toMatch(/stranger@external\.com/);
  });

  it('errors (sends nothing) when no recipient is on the platform', async () => {
    const result = await invoke({
      to: ['stranger@external.com'],
      subject: 's',
      body: 'b',
    });
    expect(sendComposedEmail).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/^\*\*Error:\*\*/);
    expect(String(result)).toMatch(/registered platform users/i);
  });

  it('de-duplicates repeated recipients', async () => {
    await invoke({
      to: ['ana@e.com', 'ANA@e.com', 'ana@e.com'],
      subject: 's',
      body: 'b',
    });
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
  });

  it('defaults to the signed-in user when `to` is omitted', async () => {
    const result = await invoke(
      { subject: 's', body: 'b' },
      { configurable: { userEmail: 'ana@e.com' } },
    );
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@e.com' }),
    );
    expect(String(result)).toMatch(/Sent to 1 platform user/i);
  });

  it('errors when `to` is omitted and no signed-in user is on the runtime', async () => {
    const result = await invoke({ subject: 's', body: 'b' }, { configurable: {} });
    expect(String(result)).toMatch(/no signed-in user email/i);
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('reports per-recipient send failures without throwing', async () => {
    sendComposedEmail.mockRejectedValueOnce(new Error('SES down'));
    const result = await invoke({
      to: ['ana@e.com', 'bo@e.com'],
      subject: 's',
      body: 'b',
    });
    expect(String(result)).toMatch(/Sent to 1 platform user/i);
    expect(String(result)).toMatch(/Failed to send to: ana@e.com/);
  });

  it('attaches a research-summary PDF built from the spec', async () => {
    const result = await invoke({
      to: ['ana@e.com'],
      subject: 's',
      body: 'b',
      research_summary: { title: 'Summary', sections: [{ kind: 'paragraph', text: 'x' }] },
    });
    expect(buildResearchSummaryAttachment).toHaveBeenCalledTimes(1);
    // Single recipient → their email is passed as the "prepared for" label.
    expect(buildResearchSummaryAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Summary' }),
      'ana@e.com',
    );
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [PDF_ATTACHMENT] }),
    );
    expect(String(result)).toMatch(/research summary/i);
  });

  it('attaches a company Excel export built from the filters', async () => {
    const result = await invoke({
      to: ['ana@e.com'],
      subject: 's',
      body: 'b',
      company_excel: { stage: 'L1' },
    });
    expect(buildCompanyExcelAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L1' }),
    );
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [XLSX_ATTACHMENT] }),
    );
    expect(String(result)).toMatch(/company Excel \(3 companies\)/i);
  });

  it('notes (but still sends) when the Excel filter matches no companies', async () => {
    buildCompanyExcelAttachment.mockResolvedValueOnce(null);
    const result = await invoke({
      to: ['ana@e.com'],
      subject: 's',
      body: 'b',
      company_excel: { stage: 'L5' },
    });
    // Email still goes out (body only, no attachment).
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [] }),
    );
    expect(String(result)).toMatch(/No companies matched the Excel filter/i);
  });

  it('delivers body + PDF + Excel together in ONE email per recipient', async () => {
    await invoke({
      to: ['ana@e.com'],
      subject: 's',
      body: 'b',
      research_summary: { title: 'Summary', sections: [{ kind: 'paragraph', text: 'x' }] },
      company_excel: { stage: 'L1' },
    });
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    const arg = sendComposedEmail.mock.calls[0][0];
    // Research PDF first, then the Excel — both in the same send.
    expect(arg.attachments).toEqual([PDF_ATTACHMENT, XLSX_ATTACHMENT]);
  });
});
