import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  getActiveWorkspaceIdOrThrowMock,
  getPendingAutomationMock,
  updatePendingAutomationMock,
  scanNowMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  getPendingAutomationMock: vi.fn(),
  updatePendingAutomationMock: vi.fn(),
  scanNowMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return {
    ...actual,
    getActiveWorkspaceId: getActiveWorkspaceIdMock,
    getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock,
  };
});

import { GET, PUT } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const WORKSPACE_ID = 'w1';
const OFF = { autoScan: false, autoDropPromote: false };

function makeRequest(body: unknown): never {
  return { json: async () => body } as never;
}

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
  createDbMock.mockReset().mockReturnValue({});
  getActiveWorkspaceIdMock.mockReset().mockResolvedValue(WORKSPACE_ID);
  getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue(WORKSPACE_ID);
  getPendingAutomationMock.mockReset().mockResolvedValue(OFF);
  updatePendingAutomationMock.mockReset().mockImplementation(async (_id, input) => input);
  scanNowMock.mockReset();
  createContainerMock.mockReset().mockReturnValue({
    workspaceService: {
      getPendingAutomation: getPendingAutomationMock,
      updatePendingAutomation: updatePendingAutomationMock,
    },
    pendingAutoScanService: { scanNow: scanNowMock },
  });
});

describe('GET /api/pending-automation', () => {
  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the active workspace toggles', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: OFF });
    expect(getPendingAutomationMock).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

describe('PUT /api/pending-automation', () => {
  it('saves the toggles and returns what was stored', async () => {
    const res = await PUT(makeRequest({ autoScan: true, autoDropPromote: true }));

    expect(res.status).toBe(200);
    expect(updatePendingAutomationMock).toHaveBeenCalledWith(WORKSPACE_ID, {
      autoScan: true,
      autoDropPromote: true,
    });
    expect(await res.json()).toEqual({ data: { autoScan: true, autoDropPromote: true } });
  });

  it('does not queue the companies already waiting when auto-scan is switched on', async () => {
    const res = await PUT(makeRequest({ autoScan: true, autoDropPromote: false }));

    expect(res.status).toBe(200);
    expect(scanNowMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed body without saving', async () => {
    const res = await PUT(makeRequest({ autoScan: 'yes' }));
    expect(res.status).toBe(400);
    expect(updatePendingAutomationMock).not.toHaveBeenCalled();
  });

  it('returns 403 without an active workspace', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    const res = await PUT(makeRequest(OFF));
    expect(res.status).toBe(403);
  });
});
