import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, findProcessingMock } = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  findProcessingMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));

import { GET } from './route';

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  findProcessingMock.mockReset().mockResolvedValue([]);
  createContainerMock.mockReset().mockReturnValue({
    companyService: { findProcessingAiOpinions: findProcessingMock },
  });
});

describe('GET /api/companies/ai-opinions', () => {
  it('returns the compact set of companies with an AI Opinion run in flight', async () => {
    const rows = [{ id: 'c1', ai_opinion_status: 'processing' }];
    findProcessingMock.mockResolvedValue(rows);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');
    expect(await res.json()).toEqual({ data: rows });
  });

  it('returns 500 when the service throws', async () => {
    findProcessingMock.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await GET();
    expect(res.status).toBe(500);
  });
});
