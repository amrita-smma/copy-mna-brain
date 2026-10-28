import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createDbMock, createContainerMock, getActiveWorkspaceIdMock, listCompanyTasksMock } = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  listCompanyTasksMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));

import { GET } from './route';

beforeEach(() => {
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
  listCompanyTasksMock.mockReset().mockResolvedValue([]);
  createContainerMock.mockReset().mockReturnValue({
    aiScreeningService: { listCompanyTasks: listCompanyTasksMock },
  });
});

describe('GET /api/ai-screening/tasks', () => {
  it("returns the workspace's screening tasks in the data envelope", async () => {
    const tasks = [{ runId: 'r1', status: 'pending', companyId: 'c1' }];
    listCompanyTasksMock.mockResolvedValue(tasks);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(createContainerMock).toHaveBeenCalledWith({}, 'w1');
    expect(await res.json()).toEqual({ data: tasks });
  });

  it('returns 500 when the service throws', async () => {
    listCompanyTasksMock.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
