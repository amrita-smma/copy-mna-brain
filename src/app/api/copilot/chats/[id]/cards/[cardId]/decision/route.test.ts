import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, getActiveWorkspaceIdOrThrowMock, createContainerMock, decideMock } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    getActiveWorkspaceIdOrThrowMock: vi.fn(),
    createContainerMock: vi.fn(),
    decideMock: vi.fn(),
  }),
);

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return { ...actual, getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock };
});
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from '@/lib/services/copilotChatsService';
import { CardDecisionConflictError, InvalidCardDecisionError } from '@/lib/services/copilotChatCardService';

const CHAT_ID = '11111111-1111-4111-8111-111111111111';
const body = { toolName: 'offer_options', status: 'accepted', resolutionText: 'Option A', data: { picked: ['A'] } };

function call(json: unknown, chatId = CHAT_ID, cardId = 'card-1') {
  const req = {
    json: async () => {
      if (json instanceof Error) throw json;
      return json;
    },
  };
  return POST(req as never, { params: Promise.resolve({ id: chatId, cardId }) });
}

describe('POST /api/copilot/chats/[id]/cards/[cardId]/decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    getActiveWorkspaceIdOrThrowMock.mockResolvedValue('ws-1');
    createContainerMock.mockReturnValue({ copilotChatCardService: { decide: decideMock } });
  });

  it("records the caller's decision and returns the one that stands", async () => {
    const result = { decision: { status: 'accepted', resolutionText: 'Option A' }, alreadyDecided: false };
    decideMock.mockResolvedValue(result);

    const res = await call(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: result });
    expect(decideMock).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: CHAT_ID,
      cardId: 'card-1',
      toolName: 'offer_options',
      status: 'accepted',
      resolutionText: 'Option A',
      data: { picked: ['A'] },
    });
  });

  it('401s without a session and 404s a chat id that is not a uuid', async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await call(body)).status).toBe(401);
    expect((await call(body, 'nope')).status).toBe(404);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('400s a body that is not JSON or not a valid decision', async () => {
    expect((await call(new Error('bad json'))).status).toBe(400);
    decideMock.mockRejectedValueOnce(new InvalidCardDecisionError('status must be accepted'));
    const res = await call({ ...body, status: 'maybe' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'status must be accepted' });
  });

  it("maps a refused decision to 409, a missing chat to 404, another user's to 403, no workspace to 403 and anything else to 500", async () => {
    decideMock.mockRejectedValueOnce(new CardDecisionConflictError('card-1'));
    expect((await call(body)).status).toBe(409);
    decideMock.mockRejectedValueOnce(new CopilotChatNotFoundError(CHAT_ID));
    expect((await call(body)).status).toBe(404);
    decideMock.mockRejectedValueOnce(new CopilotChatForbiddenError(CHAT_ID));
    expect((await call(body)).status).toBe(403);
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    expect((await call(body)).status).toBe(403);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    decideMock.mockRejectedValueOnce(new Error('boom'));
    expect((await call(body)).status).toBe(500);
    spy.mockRestore();
  });
});
