import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUploadSignedUrl: vi.fn(),
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  generateChatAttachmentKey: vi.fn(),
  chatAttachmentPrefix: vi.fn(),
  filesUpload: vi.fn(),
  filesDelete: vi.fn(),
  toFile: vi.fn(),
  extractTextFromFile: vi.fn(),
}));

vi.mock('@/lib/s3', () => ({
  getUploadSignedUrl: mocks.getUploadSignedUrl,
  deleteFile: mocks.deleteFile,
  downloadFile: mocks.downloadFile,
  generateChatAttachmentKey: mocks.generateChatAttachmentKey,
  chatAttachmentPrefix: mocks.chatAttachmentPrefix,
}));

vi.mock('@/lib/fileExtractor', () => ({
  extractTextFromFile: mocks.extractTextFromFile,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = { files: { upload: mocks.filesUpload, delete: mocks.filesDelete } };
  }
  return { default: Anthropic, toFile: mocks.toFile };
});

import {
  ChatAttachmentService,
  ChatAttachmentForbiddenError,
  isChatAttachmentRef,
} from './chatAttachmentService';
import { CHAT_INLINE_DOCUMENT_MAX_CHARS } from '@/lib/insights/templateAttachment';

const WORKSPACE = 'ws-1';
const CHAT = { largeHtml: 'outline' } as const;
const WORKFORCE = { largeHtml: 'full' } as const;
const PREFIX = `chat-attachments/${WORKSPACE}/`;

function makeService() {
  return new ChatAttachmentService(WORKSPACE, 'test-key');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatAttachmentPrefix.mockImplementation((ws: string) => `chat-attachments/${ws}/`);
  mocks.generateChatAttachmentKey.mockReturnValue(`${PREFIX}uuid_123_file.pdf`);
  mocks.getUploadSignedUrl.mockResolvedValue('https://s3/presigned-put');
  mocks.downloadFile.mockResolvedValue(Buffer.from('pdf-bytes'));
  mocks.toFile.mockResolvedValue({ name: 'file.pdf' });
  mocks.filesUpload.mockResolvedValue({ id: 'file_abc' });
  mocks.filesDelete.mockResolvedValue(undefined);
  mocks.extractTextFromFile.mockResolvedValue('extracted text');
});

describe('ChatAttachmentService.createUploadTarget', () => {
  it('mints a workspace-scoped key and presigned URL', async () => {
    const target = await makeService().createUploadTarget('file.pdf', 'application/pdf');
    expect(mocks.generateChatAttachmentKey).toHaveBeenCalledWith(WORKSPACE, 'file.pdf');
    expect(mocks.getUploadSignedUrl).toHaveBeenCalledWith(`${PREFIX}uuid_123_file.pdf`, 'application/pdf');
    expect(target).toEqual({ uploadUrl: 'https://s3/presigned-put', key: `${PREFIX}uuid_123_file.pdf` });
  });
});

describe('ChatAttachmentService.delete', () => {
  it('deletes a key that belongs to the workspace', async () => {
    await makeService().delete(`${PREFIX}mine.pdf`);
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${PREFIX}mine.pdf`);
  });

  it('rejects a key from another workspace without hitting S3', async () => {
    await expect(makeService().delete('chat-attachments/other-ws/x.pdf')).rejects.toBeInstanceOf(
      ChatAttachmentForbiddenError,
    );
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('rejects a key from an unrelated prefix (e.g. meeting-notes)', async () => {
    await expect(makeService().delete('meeting-notes/x.pdf')).rejects.toBeInstanceOf(
      ChatAttachmentForbiddenError,
    );
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });
});

describe('ChatAttachmentService.prepareForMessage', () => {
  it('returns empty result without calling Anthropic when there are no attachments', async () => {
    const out = await makeService().prepareForMessage([], CHAT);
    expect(out).toEqual({ blocks: [], fileIds: [], outlinedHtml: [] });
    expect(mocks.filesUpload).not.toHaveBeenCalled();
  });

  it('uploads PDFs to the Files API as file blocks and base64 encodes images', async () => {
    mocks.filesUpload
      .mockResolvedValueOnce({ id: 'file_1' });
    const out = await makeService().prepareForMessage([
      { key: `${PREFIX}a.pdf`, fileName: 'a.pdf', contentType: 'application/pdf' },
      { key: `${PREFIX}b.png`, fileName: 'b.png', contentType: 'image/png' },
    ], CHAT);
    expect(mocks.filesUpload).toHaveBeenCalledTimes(1);
    expect(mocks.extractTextFromFile).not.toHaveBeenCalled();
    expect(out).toEqual({
      blocks: [
        { type: 'file', fileId: 'file_1' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,cGRmLWJ5dGVz' } },
      ],
      fileIds: ['file_1'],
      outlinedHtml: [],
    });
  });

  it('text-extracts non-native files (e.g. pptx) and inlines them as text blocks', async () => {
    mocks.extractTextFromFile.mockResolvedValue('slide one\nslide two');
    const out = await makeService().prepareForMessage([
      {
        key: `${PREFIX}deck.pptx`,
        fileName: 'deck.pptx',
        contentType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    ], CHAT);
    expect(mocks.filesUpload).not.toHaveBeenCalled();
    expect(mocks.extractTextFromFile).toHaveBeenCalledTimes(1);
    expect(out.fileIds).toEqual([]);
    expect(out.blocks).toEqual([
      { type: 'text', text: 'Attached file "deck.pptx":\n\nslide one\nslide two' },
    ]);
  });

  it('inlines an error note rather than throwing when extraction fails', async () => {
    mocks.extractTextFromFile.mockRejectedValue(new Error('corrupt'));
    const out = await makeService().prepareForMessage([
      { key: `${PREFIX}bad.docx`, fileName: 'bad.docx', contentType: 'application/msword' },
    ], CHAT);
    expect(out.blocks[0]).toEqual({
      type: 'text',
      text: 'Attached file "bad.docx":\n\n[Unable to read this file: corrupt]',
    });
  });

  it('rejects a foreign key before downloading anything', async () => {
    await expect(
      makeService().prepareForMessage([
        { key: 'meeting-notes/x.pdf', fileName: 'x.pdf', contentType: 'application/pdf' },
      ], CHAT),
    ).rejects.toBeInstanceOf(ChatAttachmentForbiddenError);
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it('rolls back already-uploaded files when a later upload fails', async () => {
    mocks.filesUpload
      .mockResolvedValueOnce({ id: 'file_1' })
      .mockRejectedValueOnce(new Error('boom'));
    await expect(
      makeService().prepareForMessage([
        { key: `${PREFIX}a.pdf`, fileName: 'a.pdf', contentType: 'application/pdf' },
        { key: `${PREFIX}b.pdf`, fileName: 'b.pdf', contentType: 'application/pdf' },
      ], CHAT),
    ).rejects.toThrow('boom');
    expect(mocks.filesDelete).toHaveBeenCalledWith('file_1', { betas: ['files-api-2025-04-14'] });
  });
});

describe('ChatAttachmentService.prepareForMessage — large HTML', () => {
  const bigHtml = `<html><body><section data-section="summary"><h2>Summary</h2><p>${'Sample text. '.repeat(2_000)}</p></section></body></html>`;
  const htmlRef = { key: `${PREFIX}brief.html`, fileName: 'brief.html', contentType: 'text/html' };

  beforeEach(() => {
    mocks.extractTextFromFile.mockResolvedValue(bigHtml);
  });

  it('in outline mode, sends an HTML file over the chat cap as an outline plus the handoff rule', async () => {
    expect(bigHtml.length).toBeGreaterThan(CHAT_INLINE_DOCUMENT_MAX_CHARS);

    const out = await makeService().prepareForMessage([htmlRef], CHAT);

    expect(out.outlinedHtml).toEqual(['brief.html']);
    expect(out.blocks).toHaveLength(1);
    const text = (out.blocks[0] as { text: string }).text;
    expect(text.startsWith('Attached file "brief.html":\n\n')).toBe(true);
    expect(text).toContain('propose_workforce_handoff');
    expect(text).toContain('[section: summary]');
    expect(text).not.toContain(bigHtml);
    expect(text.length).toBeLessThan(CHAT_INLINE_DOCUMENT_MAX_CHARS);
  });

  it('routes by content type too, e.g. text/html with a charset and no .html extension', async () => {
    const out = await makeService().prepareForMessage(
      [{ key: `${PREFIX}page`, fileName: 'page', contentType: 'text/html; charset=utf-8' }],
      CHAT,
    );

    expect(out.outlinedHtml).toEqual(['page']);
  });

  it('in full mode (the Workforce), sends the whole HTML file', async () => {
    const out = await makeService().prepareForMessage([htmlRef], WORKFORCE);

    expect(out.outlinedHtml).toEqual([]);
    expect(out.blocks).toEqual([{ type: 'text', text: `Attached file "brief.html":\n\n${bigHtml}` }]);
  });

  it('inlines an HTML file at or under the chat cap in full, in outline mode', async () => {
    const small = `<p>${'x'.repeat(CHAT_INLINE_DOCUMENT_MAX_CHARS - 7)}</p>`;
    expect(small.length).toBe(CHAT_INLINE_DOCUMENT_MAX_CHARS);
    mocks.extractTextFromFile.mockResolvedValue(small);

    const out = await makeService().prepareForMessage([htmlRef], CHAT);

    expect(out.outlinedHtml).toEqual([]);
    expect(out.blocks).toEqual([{ type: 'text', text: `Attached file "brief.html":\n\n${small}` }]);
  });

  it('leaves a large non-HTML text file unchanged in outline mode', async () => {
    const csv = 'a,b\n'.repeat(10_000);
    mocks.extractTextFromFile.mockResolvedValue(csv);

    const out = await makeService().prepareForMessage(
      [{ key: `${PREFIX}data.csv`, fileName: 'data.csv', contentType: 'text/csv' }],
      CHAT,
    );

    expect(out.outlinedHtml).toEqual([]);
    expect(out.blocks).toEqual([{ type: 'text', text: `Attached file "data.csv":\n\n${csv}` }]);
  });
});

describe('ChatAttachmentService.ownedRefs', () => {
  it('keeps well-formed refs under this workspace and drops everything else without throwing', () => {
    const mine = { key: `${PREFIX}a.pdf`, fileName: 'a.pdf', contentType: 'application/pdf' };
    const refs = makeService().ownedRefs([
      mine,
      { key: 'chat-attachments/other-ws/b.pdf', fileName: 'b.pdf', contentType: 'application/pdf' },
      { key: 'meeting-notes/c.pdf', fileName: 'c.pdf', contentType: 'application/pdf' },
      { key: `${PREFIX}d.pdf`, fileName: 'd.pdf' },
      'not-a-ref',
      null,
      { ...mine, extra: 'dropped field' },
    ]);

    expect(refs).toEqual([mine, mine]);
  });

  it('returns [] for anything that is not an array', () => {
    expect(makeService().ownedRefs(undefined)).toEqual([]);
    expect(makeService().ownedRefs({ key: 'x' })).toEqual([]);
  });
});

describe('ChatAttachmentService.deleteFromAnthropic', () => {
  it('does nothing when given no ids', async () => {
    await makeService().deleteFromAnthropic([]);
    expect(mocks.filesDelete).not.toHaveBeenCalled();
  });

  it('deletes every id and swallows individual failures', async () => {
    mocks.filesDelete
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce(undefined);
    await expect(makeService().deleteFromAnthropic(['file_1', 'file_2'])).resolves.toBeUndefined();
    expect(mocks.filesDelete).toHaveBeenCalledTimes(2);
  });
});

describe('isChatAttachmentRef', () => {
  it('accepts valid ChatAttachmentRef', () => {
    expect(
      isChatAttachmentRef({ key: 'a/b', fileName: 'file.pdf', contentType: 'application/pdf' }),
    ).toBe(true);
  });

  it('rejects invalid shapes', () => {
    expect(isChatAttachmentRef(null)).toBe(false);
    expect(isChatAttachmentRef(undefined)).toBe(false);
    expect(isChatAttachmentRef('string')).toBe(false);
    expect(isChatAttachmentRef({})).toBe(false);
    expect(isChatAttachmentRef({ key: 'a/b', fileName: 'file.pdf' })).toBe(false);
    expect(isChatAttachmentRef({ key: 123, fileName: 'file.pdf', contentType: 'text/plain' })).toBe(false);
  });
});

