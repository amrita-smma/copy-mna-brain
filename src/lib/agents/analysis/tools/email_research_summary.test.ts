import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const { sendResearchSummaryEmail, generateResearchSummaryPdf } = vi.hoisted(() => ({
  sendResearchSummaryEmail: vi.fn(),
  generateResearchSummaryPdf: vi.fn(),
}));

vi.mock('@/lib/services/emailService', () => {
  class MockEmailService {
    sendResearchSummaryEmail = sendResearchSummaryEmail;
  }
  return { EmailService: MockEmailService };
});

vi.mock('@/lib/pdfSummary', () => ({ generateResearchSummaryPdf }));

import { emailResearchSummary } from './email_research_summary';

const MINIMUM_ARGS = {
  title: 'Acme Corp research summary',
  sections: [
    { kind: 'paragraph', text: 'Strong margin profile. Recommendation: proceed.' },
  ],
};

function invokeWith(
  args: Record<string, unknown>,
  config: RunnableConfig | undefined,
): Promise<unknown> {
  // langchain tool().invoke signature: invoke(input, options) where options
  // carries configurable. The tool reads `configurable.userEmail` at runtime.
  return emailResearchSummary.invoke(args, config);
}

describe('email_research_summary', () => {
  beforeEach(() => {
    sendResearchSummaryEmail.mockReset();
    generateResearchSummaryPdf.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('refuses to send when no userEmail is in the runtime config', async () => {
    const result = await invokeWith(MINIMUM_ARGS, { configurable: {} });
    expect(String(result)).toMatch(/No signed-in user email is available/);
    expect(generateResearchSummaryPdf).not.toHaveBeenCalled();
    expect(sendResearchSummaryEmail).not.toHaveBeenCalled();
  });

  it('refuses to send when userEmail in config is malformed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await invokeWith(MINIMUM_ARGS, {
      configurable: { userEmail: 'not-an-email' },
    });
    expect(String(result)).toMatch(/malformed/);
    expect(generateResearchSummaryPdf).not.toHaveBeenCalled();
    expect(sendResearchSummaryEmail).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects an empty sections array (zod schema enforces min length)', async () => {
    await expect(
      invokeWith(
        { title: 'x', sections: [] },
        { configurable: { userEmail: 'user@example.com' } },
      ),
    ).rejects.toThrow(/sections|at least/i);
  });

  it('renders the PDF and emails it to the email pulled from config', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake');
    generateResearchSummaryPdf.mockResolvedValueOnce(fakePdf);
    sendResearchSummaryEmail.mockResolvedValueOnce({ messageId: 'ses-1' });

    const result = await invokeWith(
      {
        title: 'Acme summary',
        sections: [
          { kind: 'heading', text: 'Snapshot' },
          {
            kind: 'kpi_cards',
            cards: [{ label: 'Revenue', value: '$112M' }],
          },
        ],
      },
      { configurable: { userEmail: 'pulled@example.com', thread_id: 'chat-1' } },
    );

    expect(generateResearchSummaryPdf).toHaveBeenCalledTimes(1);
    const renderArg = generateResearchSummaryPdf.mock.calls[0][0];
    expect(renderArg.title).toBe('Acme summary');
    expect(renderArg.subtitle).toMatch(/pulled@example\.com/);
    expect(renderArg.sections).toHaveLength(2);

    expect(sendResearchSummaryEmail).toHaveBeenCalledWith({
      email: 'pulled@example.com',
      title: 'Acme summary',
      summaryMarkdown: expect.any(String),
      pdfBuffer: fakePdf,
      subject: undefined,
    });
    expect(String(result)).toMatch(/Emailed the research summary PDF to your inbox/);
  });

  it('does NOT accept a recipient_email argument (recipient is config-only)', async () => {
    generateResearchSummaryPdf.mockResolvedValueOnce(Buffer.from('pdf'));
    sendResearchSummaryEmail.mockResolvedValueOnce({ messageId: 'm' });

    await invokeWith(
      // The LLM cannot override the recipient via the args — even if it tries
      // to pass one, the tool ignores it and uses configurable.userEmail.
      { ...MINIMUM_ARGS, recipient_email: 'attacker@example.com' },
      { configurable: { userEmail: 'real@example.com' } },
    );

    expect(sendResearchSummaryEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'real@example.com' }),
    );
  });

  it('forwards an optional subject override to the email service', async () => {
    generateResearchSummaryPdf.mockResolvedValueOnce(Buffer.from('pdf'));
    sendResearchSummaryEmail.mockResolvedValueOnce({ messageId: 'm-2' });

    await invokeWith(
      { ...MINIMUM_ARGS, subject: 'Custom subject' },
      { configurable: { userEmail: 'user@example.com' } },
    );

    expect(sendResearchSummaryEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Custom subject' }),
    );
  });

  it('maps references with explicit null defaults for missing link/date', async () => {
    generateResearchSummaryPdf.mockResolvedValueOnce(Buffer.from('pdf'));
    sendResearchSummaryEmail.mockResolvedValueOnce({ messageId: 'm-3' });

    await invokeWith(
      {
        ...MINIMUM_ARGS,
        references: [
          { name: 'Q1 memo', link: 'https://example.com', date: '2025-03-01' },
          { name: 'Industry report' },
        ],
      },
      { configurable: { userEmail: 'user@example.com' } },
    );

    const renderArg = generateResearchSummaryPdf.mock.calls[0][0];
    expect(renderArg.references).toEqual([
      { name: 'Q1 memo', link: 'https://example.com', date: '2025-03-01' },
      { name: 'Industry report', link: null, date: null },
    ]);
  });

  it('returns an **Error:** string when the email service throws', async () => {
    generateResearchSummaryPdf.mockResolvedValueOnce(Buffer.from('pdf'));
    sendResearchSummaryEmail.mockRejectedValueOnce(new Error('SES rate limit'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await invokeWith(MINIMUM_ARGS, {
      configurable: { userEmail: 'user@example.com' },
    });

    expect(String(result)).toMatch(/\*\*Error:\*\* Could not send email — SES rate limit/);
    errSpy.mockRestore();
  });
});
