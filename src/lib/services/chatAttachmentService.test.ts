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
} from './chatAttachmentService';

const WORKSPACE = 'ws-1';
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
    const out = await makeService().prepareForMessage([]);
    expect(out).toEqual({ blocks: [], fileIds: [] });
    expect(mocks.filesUpload).not.toHaveBeenCalled();
  });

  it('uploads PDFs and images to the Files API as file blocks', async () => {
    mocks.filesUpload
      .mockResolvedValueOnce({ id: 'file_1' })
      .mockResolvedValueOnce({ id: 'file_2' });
    const out = await makeService().prepareForMessage([
      { key: `${PREFIX}a.pdf`, fileName: 'a.pdf', contentType: 'application/pdf' },
      { key: `${PREFIX}b.png`, fileName: 'b.png', contentType: 'image/png' },
    ]);
    expect(mocks.filesUpload).toHaveBeenCalledTimes(2);
    expect(mocks.extractTextFromFile).not.toHaveBeenCalled();
    expect(out).toEqual({
      blocks: [
        { type: 'file', fileId: 'file_1' },
        { type: 'file', fileId: 'file_2' },
      ],
      fileIds: ['file_1', 'file_2'],
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
    ]);
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
    ]);
    expect(out.blocks[0]).toEqual({
      type: 'text',
      text: 'Attached file "bad.docx":\n\n[Unable to read this file: corrupt]',
    });
  });

  it('rejects a foreign key before downloading anything', async () => {
    await expect(
      makeService().prepareForMessage([
        { key: 'meeting-notes/x.pdf', fileName: 'x.pdf', contentType: 'application/pdf' },
      ]),
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
      ]),
    ).rejects.toThrow('boom');
    expect(mocks.filesDelete).toHaveBeenCalledWith('file_1', { betas: ['files-api-2025-04-14'] });
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
