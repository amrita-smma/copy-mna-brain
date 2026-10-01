import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, createContainerMock, uploadDocumentMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  uploadDocumentMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceIdOrThrow: vi.fn(async () => 'ws-1'),
  NoActiveWorkspaceError: class NoActiveWorkspaceError extends Error {},
}));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import {
  InsightPayloadTooLargeError,
  InsightValidationError,
} from '@/lib/services/insightService';

const HTML = '<!DOCTYPE html><html><body><p>Q3 — review</p></body></html>';

function postForm(fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return POST(new NextRequest('http://localhost/api/insights/upload', { method: 'POST', body: form }));
}

describe('POST /api/insights/upload', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    uploadDocumentMock.mockReset().mockResolvedValue({ id: 'i1' });
    createContainerMock.mockReset().mockReturnValue({
      insightService: { uploadDocument: uploadDocumentMock },
    });
  });

  it("hands the file's name and UTF-8 text, the form fields and the user to the service", async () => {
    const res = await postForm({
      file: new File([HTML], 'Q3 review.html', { type: 'text/html' }),
      name: 'Board pack',
      description: 'For the board',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: 'i1' } });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'ws-1');
    expect(uploadDocumentMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      fileName: 'Q3 review.html',
      html: HTML,
      name: 'Board pack',
      description: 'For the board',
      userId: 'u1',
    });
  });

  it('passes a missing name and description as null, for the service to fill in', async () => {
    await postForm({ file: new File([HTML], 'a.html') });

    expect(uploadDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: null, description: null }),
    );
  });

  it('returns 400 when the form has no file', async () => {
    const res = await postForm({ name: 'No file', file: 'not a file' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: file' });
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a body that is not multipart', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/insights/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html: HTML }),
      }),
    );

    expect(res.status).toBe(400);
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a validation error as 400', new InsightValidationError('The file is empty.'), 400],
    ['an over-cap file as 413', new InsightPayloadTooLargeError('The file is 5 MB; insights are limited to 4 MB.'), 413],
  ])("maps %s with the service's message", async (_label, error, status) => {
    uploadDocumentMock.mockRejectedValue(error);

    const res = await postForm({ file: new File([HTML], 'a.html') });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: error.message });
  });

  it('returns a generic 500 for an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    uploadDocumentMock.mockRejectedValue(new Error('db down'));

    const res = await postForm({ file: new File([HTML], 'a.html') });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
