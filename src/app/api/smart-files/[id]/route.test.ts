import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { createDbMock, getActiveWorkspaceIdMock, createContainerMock, getStatusMock } = vi.hoisted(
  () => ({
    createDbMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    createContainerMock: vi.fn(),
    getStatusMock: vi.fn(),
  }),
);

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

describe('GET /api/smart-files/[id]', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ sentinel: 'db' });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getStatusMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({ fileService: { getStatus: getStatusMock } });
  });

  it('returns the file status', async () => {
    const status = {
      id: 'file-1',
      file_name: 'Q3 update.pdf',
      file_type: 'fund_updates',
      processing_status: 'awaiting_review',
    };
    getStatusMock.mockResolvedValueOnce(status);
    const res = await GET(new NextRequest('http://localhost/api/smart-files/file-1'), {
      params: Promise.resolve({ id: 'file-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: status });
    expect(createContainerMock).toHaveBeenCalledWith({ sentinel: 'db' }, 'ws-1');
  });

  it('returns 404 when the file is not in the workspace', async () => {
    getStatusMock.mockRejectedValueOnce(new Error('File file-9 not found'));
    const res = await GET(new NextRequest('http://localhost/api/smart-files/file-9'), {
      params: Promise.resolve({ id: 'file-9' }),
    });
    expect(res.status).toBe(404);
  });
});
