import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbMock, getActiveWorkspaceIdMock, reprocessMock } =
  vi.hoisted(() => ({
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    reprocessMock: vi.fn(),
  }));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
}));
vi.mock('@/lib/services/container', () => ({
  createContainer: () => ({
    fileService: { reprocess: reprocessMock },
  }),
}));

import { POST } from './route';
import { NextRequest } from 'next/server';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/smart-files/file-1/reprocess', {
    method: 'POST',
  });
}

describe('POST /api/smart-files/[id]/reprocess', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    reprocessMock.mockReset();
  });

  it('returns 400 when file id is missing', async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: '' }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'File ID is required',
    });
    expect(reprocessMock).not.toHaveBeenCalled();
  });

  it('returns HTTP 202 when reprocess dispatches an async background job with jobId', async () => {
    reprocessMock.mockResolvedValueOnce({
      id: 'file-1',
      file_name: 'fund_report.xlsx',
      file_type: 'fund_updates',
      processing_status: 'processing',
      jobId: 'job-reprocess-123',
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'file-1' }) });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'file-1',
      jobId: 'job-reprocess-123',
      processing_status: 'processing',
    });
    expect(reprocessMock).toHaveBeenCalledWith('file-1');
  });

  it('returns HTTP 200 when reprocess extracts synchronously without jobId', async () => {
    reprocessMock.mockResolvedValueOnce({
      id: 'file-1',
      file_name: 'notes.pdf',
      file_type: 'other',
      processing_status: 'completed',
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'file-1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: 'file-1',
      processing_status: 'completed',
    });
    expect(reprocessMock).toHaveBeenCalledWith('file-1');
  });

  it('returns HTTP 500 when fileService.reprocess throws', async () => {
    reprocessMock.mockRejectedValueOnce(new Error('File not found in S3'));

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'file-1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('File not found in S3');
  });
});
