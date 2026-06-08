import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  deleteFile: vi.fn(),
  toFile: vi.fn(),
  stream: vi.fn(),
  getAllCompanyReferences: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = { files: { upload: mocks.upload, delete: mocks.deleteFile } };
  }
  return { default: Anthropic, toFile: mocks.toFile };
});

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class {},
}));

vi.mock('langchain', () => ({
  createAgent: vi.fn(() => ({ stream: mocks.stream })),
}));

vi.mock('@/lib/fuzzySearch', () => ({
  getAllCompanyReferences: mocks.getAllCompanyReferences,
}));

import { processFileContent } from './index';

const FILES_API_BETA = 'files-api-2025-04-14';

// A minimal agent reply containing the JSON contract block the parser expects.
const JSON_BLOCK =
  '```json\n' +
  JSON.stringify({
    file_type: 'other',
    summary: 's',
    companies_detected: [],
    company_notes: [],
  }) +
  '\n```';

/** Build a one-shot async stream that mimics `agent.stream(...)`. */
function streamReturning(content: string) {
  return (async function* () {
    yield { messages: [{ content }] };
  })();
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mocks.getAllCompanyReferences.mockResolvedValue([]);
  mocks.toFile.mockResolvedValue('FILE');
  mocks.deleteFile.mockResolvedValue(undefined);
  mocks.stream.mockImplementation(() => Promise.resolve(streamReturning(JSON_BLOCK)));
});

afterEach(() => vi.clearAllMocks());

describe('processFileContent (Files API for PDFs)', () => {
  it('uploads the whole PDF once by id and deletes it immediately after processing', async () => {
    mocks.upload.mockResolvedValueOnce({ id: 'file_a' });

    await processFileContent('raw text', Buffer.from('pdf'), 'application/pdf', '');

    // The whole buffer is uploaded once — no chunking — and deleted afterwards.
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'FILE', betas: [FILES_API_BETA] }),
    );
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).toHaveBeenCalledWith('file_a', { betas: [FILES_API_BETA] });

    // The message references the uploaded file by id — never base64 data.
    const firstMessage = mocks.stream.mock.calls[0][0].messages[0];
    const fileBlock = firstMessage.content.find((b: { type: string }) => b.type === 'file');
    expect(fileBlock).toEqual({ type: 'file', fileId: 'file_a' });
    expect(JSON.stringify(firstMessage.content)).not.toContain('source_type');
  });

  it('deletes the uploaded file even when the agent stream throws', async () => {
    mocks.upload.mockResolvedValueOnce({ id: 'file_a' });
    mocks.stream.mockRejectedValueOnce(new Error('boom'));

    await expect(
      processFileContent('raw text', Buffer.from('pdf'), 'application/pdf', ''),
    ).rejects.toThrow('boom');

    expect(mocks.deleteFile).toHaveBeenCalledWith('file_a', { betas: [FILES_API_BETA] });
  });

  it('does not touch the Files API for non-PDF content', async () => {
    await processFileContent('raw text', Buffer.from('x'), 'text/plain', '');

    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });
});
