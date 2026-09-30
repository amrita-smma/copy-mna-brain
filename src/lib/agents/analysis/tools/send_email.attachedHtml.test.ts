import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const { findAll, sendComposedEmail, download, getActiveWorkspaceId } = vi.hoisted(() => ({
  findAll: vi.fn(),
  sendComposedEmail: vi.fn(),
  download: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));

vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId }));

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

vi.mock('@/lib/services/chatAttachmentService', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/services/chatAttachmentService')
  >('@/lib/services/chatAttachmentService');
  return {
    ...actual,
    ChatAttachmentService: class {
      download = download;
    },
  };
});

// The artifact builders hit the DB / render exceljs + pdf; only the schemas
// matter for these cases.
vi.mock('./emailArtifacts', async () => {
  const { z } = await import('zod');
  return {
    companyExcelSpecSchema: z.object({}).passthrough(),
    researchSummarySpecSchema: z.object({}).passthrough(),
    presentationSpecSchema: z.object({}).passthrough(),
    companyCardSpecSchema: z.object({}).passthrough(),
    buildCompanyExcelAttachment: vi.fn(),
    buildResearchSummaryAttachment: vi.fn(),
    buildPresentationAttachment: vi.fn(),
    buildCompanyCardAttachment: vi.fn(),
  };
});

import { sendEmailTool } from './send_email';

const PREFIX = 'chat-attachments/ws-1/';
const DECK = {
  key: `${PREFIX}deck.html`,
  fileName: 'deck.html',
  contentType: 'text/html',
};
const HTML =
  '<!doctype html><html><head><style>body{background:#fff}</style></head><body>' +
  '<h1>Q3 pipeline review</h1><p>Eleven targets advanced to L1 this quarter.</p>' +
  '<script>renderCharts();</script></body></html>';
/** A page whose content only exists once its JavaScript has run. */
const JS_ONLY_HTML =
  '<!doctype html><html><body><div id="root">' +
  '<div class="logo">B</div><div class="loader">Unpacking...</div></div>' +
  '<noscript>This page requires JavaScript to display.</noscript>' +
  '<script>mount(document.getElementById("root"));</script></body></html>';

const config = (configurable: Record<string, unknown>): RunnableConfig => ({
  configurable: { userEmail: 'ana@e.com', ...configurable },
});

function invoke(args: Record<string, unknown>, cfg?: RunnableConfig) {
  return sendEmailTool.invoke(args, cfg);
}

describe('send_email attached_html', () => {
  beforeEach(() => {
    findAll.mockReset();
    sendComposedEmail.mockReset();
    download.mockReset();
    getActiveWorkspaceId.mockReset();
    findAll.mockResolvedValue([{ id: 'u1', name: 'Ana', email: 'ana@e.com', role: null }]);
    sendComposedEmail.mockResolvedValue({ messageId: 'msg-1' });
    download.mockResolvedValue(Buffer.from(HTML, 'utf-8'));
    getActiveWorkspaceId.mockResolvedValue('ws-1');
  });

  it('sends the uploaded page reformatted for email, scripts and all removed', async () => {
    const result = await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: { file_name: 'deck.html' } },
      config({ attachments: [DECK] }),
    );

    expect(download).toHaveBeenCalledWith(DECK.key);
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    const sent = sendComposedEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ email: 'ana@e.com', subject: 'Q3', body: 'Attached page.' });
    expect(sent.documentHtml).toContain('Q3 pipeline review');
    expect(sent.documentHtml).not.toContain('<script');
    expect(sent.documentHtml).not.toContain('renderCharts');
    expect(result).toContain('deck.html');
    // The agent is told what the rewrite dropped, so it can pass that on.
    expect(result).toContain('1 script');
  });

  it('refuses a page that renders through JavaScript instead of mailing a blank sheet', async () => {
    download.mockResolvedValue(Buffer.from(JS_ONLY_HTML, 'utf-8'));

    const result = await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: {} },
      config({ attachments: [DECK] }),
    );

    expect(result).toContain('**Error:**');
    expect(result).toContain('builds its content with JavaScript');
    expect(result).toContain('deck.html');
    // What the recipient would have received, quoted back to the sender.
    expect(result).toContain('Unpacking');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('resolves the file from an earlier turn of the same chat', async () => {
    await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: {} },
      config({ attachments: [], priorAttachments: [DECK] }),
    );
    expect(download).toHaveBeenCalledWith(DECK.key);
  });

  it('leaves the rendered shell in place when no HTML is requested', async () => {
    await invoke({ subject: 'Hi', body: 'A note.' }, config({ attachments: [DECK] }));
    expect(download).not.toHaveBeenCalled();
    expect(sendComposedEmail.mock.calls[0][0].documentHtml).toBeUndefined();
  });

  it('errors without sending when no HTML file is attached', async () => {
    const result = await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: { file_name: 'deck.html' } },
      config({}),
    );
    expect(result).toContain('**Error:**');
    expect(result).toContain('no HTML file is attached');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('errors without sending when the named file is not attached', async () => {
    const result = await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: { file_name: 'other.html' } },
      config({ attachments: [DECK] }),
    );
    expect(result).toContain('**Error:**');
    expect(result).toContain('deck.html');
    expect(download).not.toHaveBeenCalled();
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('refuses an empty file rather than mailing a blank page', async () => {
    download.mockResolvedValue(Buffer.from('   \n', 'utf-8'));
    const result = await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: {} },
      config({ attachments: [DECK] }),
    );
    expect(result).toContain('**Error:**');
    expect(result).toContain('empty');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('refuses a file that would blow the SES message size limit', async () => {
    download.mockResolvedValue(Buffer.alloc(6_000_000, 'a'));
    const result = await invoke(
      { subject: 'Q3', body: 'Attached page.', attached_html: {} },
      config({ attachments: [DECK] }),
    );
    expect(result).toContain('**Error:**');
    expect(result).toContain('too large');
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });
});
