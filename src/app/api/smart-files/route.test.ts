import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, createDbMock, getActiveWorkspaceIdMock, processUploadMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    processUploadMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
}));
vi.mock('@/lib/services/container', () => ({
  createContainer: () => ({
    fileService: { processUpload: processUploadMock },
  }),
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/smart-files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/smart-files', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    processUploadMock.mockReset();
  });

  it('returns 400 when key or fileName is missing', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    const res = await POST(makeRequest({ key: 'uploads/f1' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'key and fileName are required',
    });
    expect(processUploadMock).not.toHaveBeenCalled();
  });

  it('returns HTTP 202 when processUpload dispatches an async background job with jobId', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    processUploadMock.mockResolvedValueOnce({
      id: 'file-1',
      file_name: 'fund_report.xlsx',
      file_type: 'fund_updates',
      processing_status: 'processing',
      jobId: 'job-123',
      signed_url: 'https://signed-url',
    });

    const res = await POST(
      makeRequest({
        key: 'uploads/fund_report.xlsx',
        fileName: 'fund_report.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_type_override: 'fund_updates',
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'file-1',
      jobId: 'job-123',
      processing_status: 'processing',
    });
    expect(processUploadMock).toHaveBeenCalledWith(
      'uploads/fund_report.xlsx',
      'fund_report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      'fund_updates',
      false,
      undefined,
      undefined,
      'user-1',
      undefined,
    );
  });

  it('forwards the pipeline email_context to processUpload', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    processUploadMock.mockResolvedValueOnce({ id: 'file-9' });

    await POST(
      makeRequest({
        key: 'uploads/teaser.pdf',
        fileName: 'teaser.pdf',
        contentType: 'application/pdf',
        email_context: {
          senderName: '  John Banker  ',
          senderEmail: 'john@bank.com',
          subject: 'Project Atlas',
          receivedAt: '2026-09-28T14:32:00.000Z',
          unexpected: 'dropped',
        },
      }),
    );

    expect(processUploadMock.mock.calls[0][9]).toEqual({
      senderName: 'John Banker',
      senderEmail: 'john@bank.com',
      subject: 'Project Atlas',
      receivedAt: '2026-09-28T14:32:00.000Z',
    });
  });

  it('passes no email_context when the pipeline omits it or sends only blanks', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    processUploadMock.mockResolvedValue({ id: 'file-9' });

    await POST(
      makeRequest({ key: 'uploads/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' }),
    );
    expect(processUploadMock.mock.calls[0][9]).toBeUndefined();

    await POST(
      makeRequest({
        key: 'uploads/b.pdf',
        fileName: 'b.pdf',
        contentType: 'application/pdf',
        email_context: { subject: '   ', senderEmail: null },
      }),
    );
    expect(processUploadMock.mock.calls[1][9]).toBeUndefined();
  });

  it('returns HTTP 200 when processUpload extracts synchronously without jobId', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    processUploadMock.mockResolvedValueOnce({
      id: 'file-2',
      file_name: 'notes.pdf',
      file_type: 'other',
      processing_status: 'completed',
      signed_url: 'https://signed-url',
    });

    const res = await POST(
      makeRequest({
        key: 'uploads/notes.pdf',
        fileName: 'notes.pdf',
        contentType: 'application/pdf',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'file-2',
      processing_status: 'completed',
    });
  });

  it('returns HTTP 500 when fileService.processUpload throws', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    processUploadMock.mockRejectedValueOnce(new Error('S3 upload failed'));

    const res = await POST(
      makeRequest({
        key: 'uploads/notes.pdf',
        fileName: 'notes.pdf',
        contentType: 'application/pdf',
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('S3 upload failed');
  });
});
