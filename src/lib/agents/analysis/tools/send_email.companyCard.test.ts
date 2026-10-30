import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const {
  findAll,
  sendComposedEmail,
  buildCompanyExcelAttachment,
  buildResearchSummaryAttachment,
  buildPresentationAttachment,
  buildCompanyCardAttachment,
} = vi.hoisted(() => ({
  findAll: vi.fn(),
  sendComposedEmail: vi.fn(),
  buildCompanyExcelAttachment: vi.fn(),
  buildResearchSummaryAttachment: vi.fn(),
  buildPresentationAttachment: vi.fn(),
  buildCompanyCardAttachment: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));

// These tests cover the platform (SES) send; the Gmail-draft routing has its own file.
vi.mock('./gmailDraft', () => ({
  GMAIL_DRAFT_MAX_RECIPIENTS: 25,
  resolveEmailRoute: vi.fn(async () => ({ kind: 'platform' })),
  saveGmailDraft: vi.fn(),
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
    researchSummarySpecSchema: z
      .object({ title: z.string(), sections: z.array(z.any()).min(1) })
      .passthrough(),
    presentationSpecSchema: z.object({ title: z.string(), brief: z.string() }).passthrough(),
    companyCardSpecSchema: z
      .object({ company_names: z.array(z.string()).min(1) })
      .passthrough(),
    buildCompanyExcelAttachment,
    buildResearchSummaryAttachment,
    buildPresentationAttachment,
    buildCompanyCardAttachment,
  };
});

import { sendEmailTool } from './send_email';

function invoke(args: Record<string, unknown>, config?: RunnableConfig) {
  return sendEmailTool.invoke(args, config);
}

const PLATFORM_USERS = [{ id: 'u1', name: 'Ana', email: 'ana@e.com', role: null }];

const CARD_ATTACHMENT = {
  filename: 'acme-company-card.pptx',
  content: Buffer.from('pptx'),
  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const CONFIG: RunnableConfig = { configurable: { userEmail: 'ana@e.com' } };

describe('send_email company_card', () => {
  beforeEach(() => {
    findAll.mockReset().mockResolvedValue(PLATFORM_USERS);
    sendComposedEmail.mockReset().mockResolvedValue({ messageId: 'msg-1' });
    buildCompanyCardAttachment.mockReset().mockResolvedValue({
      attachment: CARD_ATTACHMENT,
      title: 'Acme — Company Card',
      companyTitles: ['Acme'],
      slideCount: 2,
      notes: [],
    });
    buildPresentationAttachment.mockReset();
    buildCompanyExcelAttachment.mockReset();
    buildResearchSummaryAttachment.mockReset();
  });

  it('attaches the rendered card deck and reports the companies and slide count', async () => {
    const result = await invoke(
      { subject: 's', body: 'b', company_card: { company_names: ['Acme'] } },
      CONFIG,
    );

    expect(buildCompanyCardAttachment).toHaveBeenCalledWith({ company_names: ['Acme'] });
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@e.com', attachments: [CARD_ATTACHMENT] }),
    );
    expect(String(result)).toContain('company card (PPTX: Acme — 2 slides)');
  });

  it('does not build a card deck when company_card is omitted', async () => {
    await invoke({ subject: 's', body: 'b' }, CONFIG);
    expect(buildCompanyCardAttachment).not.toHaveBeenCalled();
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [] }),
    );
  });

  it('still sends the email, with a note, when no company resolves', async () => {
    buildCompanyCardAttachment.mockResolvedValue(null);

    const result = await invoke(
      { subject: 's', body: 'b', company_card: { company_names: ['Ghost'] } },
      CONFIG,
    );

    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [] }),
    );
    expect(String(result)).toContain('None of the requested companies could be resolved');
  });

  it('surfaces per-company resolution notes from the builder', async () => {
    buildCompanyCardAttachment.mockResolvedValue({
      attachment: CARD_ATTACHMENT,
      title: 'Company cards',
      companyTitles: ['Acme'],
      slideCount: 1,
      notes: ['Could not resolve company for the Company Card deck: Ghost.'],
    });

    const result = await invoke(
      { subject: 's', body: 'b', company_card: { company_names: ['Acme', 'Ghost'] } },
      CONFIG,
    );

    expect(String(result)).toContain('company card (PPTX: Acme — 1 slide)');
    expect(String(result)).toContain('Could not resolve company for the Company Card deck: Ghost.');
  });

  it('refuses before rendering when earlier attachments used up the size budget', async () => {
    buildCompanyExcelAttachment.mockResolvedValue({
      attachment: {
        filename: 'huge.xlsx',
        content: Buffer.alloc(5_450_000),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      title: 'Huge',
      companyCount: 900,
      filterSummary: 'all',
      notes: [],
    });

    const result = await invoke(
      {
        subject: 's',
        body: 'b',
        company_excel: {},
        company_card: { company_names: ['Acme'] },
      },
      CONFIG,
    );

    expect(String(result)).toMatch(/^\*\*Error:\*\*/);
    expect(buildCompanyCardAttachment).not.toHaveBeenCalled();
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('sends a card deck and a spreadsheet in ONE email when both are requested', async () => {
    const xlsx = {
      filename: 'export.xlsx',
      content: Buffer.from('xlsx'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    buildCompanyExcelAttachment.mockResolvedValue({
      attachment: xlsx,
      title: 'Export',
      companyCount: 3,
      filterSummary: 'stage=L1',
      notes: [],
    });

    await invoke(
      {
        subject: 's',
        body: 'b',
        company_card: { company_names: ['Acme'] },
        company_excel: { stage: 'L1' },
      },
      CONFIG,
    );

    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [xlsx, CARD_ATTACHMENT] }),
    );
  });
});
