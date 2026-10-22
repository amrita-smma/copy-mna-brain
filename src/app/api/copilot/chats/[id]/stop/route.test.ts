import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createContainerMock, assertOwnedByMock, requestStopMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createContainerMock: vi.fn(),
  assertOwnedByMock: vi.fn(),
  requestStopMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import {
  CopilotChatForbiddenError,
  CopilotChatNotFoundError,
} from '@/lib/services/copilotChatsService';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const call = () =>
  POST(new Request(`http://localhost/api/copilot/chats/${CHAT_ID}/stop`, { method: 'POST' }), {
    params: Promise.resolve({ id: CHAT_ID }),
  });

describe('POST /api/copilot/chats/[id]/stop', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    assertOwnedByMock.mockReset().mockResolvedValue({ id: CHAT_ID });
    requestStopMock.mockReset().mockResolvedValue(true);
    createContainerMock.mockReset().mockReturnValue({
      copilotChatsService: { assertOwnedBy: assertOwnedByMock, requestStop: requestStopMock },
    });
  });

  it("flags the user's running turn to stop", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { stopped: true } });
    expect(assertOwnedByMock).toHaveBeenCalledWith(CHAT_ID, 'u1');
    expect(requestStopMock).toHaveBeenCalledWith(CHAT_ID);
  });

  it('reports stopped: false when no turn is running', async () => {
    requestStopMock.mockResolvedValue(false);

    await expect((await call()).json()).resolves.toEqual({ data: { stopped: false } });
  });

  it('rejects a signed-out request', async () => {
    authMock.mockResolvedValue(null);

    expect((await call()).status).toBe(401);
    expect(requestStopMock).not.toHaveBeenCalled();
  });

  it("refuses to stop someone else's chat", async () => {
    assertOwnedByMock.mockRejectedValue(new CopilotChatForbiddenError(CHAT_ID));

    expect((await call()).status).toBe(403);
    expect(requestStopMock).not.toHaveBeenCalled();
  });

  it('404s an unknown chat', async () => {
    assertOwnedByMock.mockRejectedValue(new CopilotChatNotFoundError(CHAT_ID));

    expect((await call()).status).toBe(404);
  });
});
