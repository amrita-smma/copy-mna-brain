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
];

const PPTX_ATTACHMENT = {
  filename: 'deck.pptx',
  content: Buffer.from('pptx'),
  contentType:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

describe('send_email presentation (inline like excel/pdf)', () => {
  beforeEach(() => {
    findAll.mockReset();
    sendComposedEmail.mockReset();
    buildPresentationAttachment.mockReset();
    findAll.mockResolvedValue(PLATFORM_USERS);
    sendComposedEmail.mockResolvedValue({ messageId: 'msg-1' });
    buildPresentationAttachment.mockResolvedValue({
      attachment: PPTX_ATTACHMENT,
      title: 'Deck',
      notes: [],
    });
  });

  it('allows presentation from Copilot chat', async () => {
    const result = await invoke(
      {
        subject: 's',
        body: 'b',
        presentation: { title: 'T', brief: 'make a deck' },
      },
      { configurable: { userEmail: 'ana@e.com', agentRole: 'chat' } },
    );
    expect(String(result)).toMatch(/Sent to/);
    expect(buildPresentationAttachment).toHaveBeenCalled();
    expect(sendComposedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ana@e.com',
        attachments: [PPTX_ATTACHMENT],
      }),
    );
  });

  it('allows presentation when agentRole is missing', async () => {
    const result = await invoke(
      {
        subject: 's',
        body: 'b',
        presentation: { title: 'T', brief: 'make a deck' },
      },
      { configurable: { userEmail: 'ana@e.com' } },
    );
    expect(String(result)).toMatch(/Sent to/);
    expect(buildPresentationAttachment).toHaveBeenCalled();
  });

  it('allows presentation from workforce', async () => {
    const result = await invoke(
      {
        subject: 's',
        body: 'b',
        presentation: { title: 'T', brief: 'make a deck' },
      },
      { configurable: { userEmail: 'ana@e.com', agentRole: 'workforce' } },
    );
    expect(String(result)).toMatch(/Sent to/);
    expect(buildPresentationAttachment).toHaveBeenCalled();
  });
});
