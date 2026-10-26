import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  getActiveWorkspaceIdOrThrowMock,
  createContainerMock,
  submitMock,
  scoreMock,
  afterMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  createContainerMock: vi.fn(),
  submitMock: vi.fn(),
  scoreMock: vi.fn(),
  afterMock: vi.fn(),
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: afterMock };
});
vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return { ...actual, getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock };
});
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/langfuseScore', () => ({ sendLangfuseScore: vi.fn() }));

import { PUT } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from '@/lib/services/copilotChatsService';
import {
  InvalidResponseFeedbackError,
  ResponseFeedbackTurnNotFoundError,
} from '@/lib/services/copilotResponseFeedbackService';

const CHAT_ID = '11111111-1111-4111-8111-111111111111';
const QUESTION_ID = '22222222-2222-4222-8222-222222222222';

function call(body: unknown, chatId = CHAT_ID) {
  return PUT({ json: async () => body } as never, { params: Promise.resolve({ id: chatId }) });
}

describe('PUT /api/copilot/chats/[id]/feedback', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue('workspace-1');
    submitMock.mockReset();
    scoreMock.mockReset();
    afterMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      copilotResponseFeedbackService: { submit: submitMock, scoreInLangfuse: scoreMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValue(null);
    expect((await call({ messageId: QUESTION_ID, rating: 1 })).status).toBe(401);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 when messageId is not a uuid', async () => {
    expect((await call({ messageId: 'msg-1', rating: 1 })).status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a chat id that is not a uuid', async () => {
    expect((await call({ messageId: QUESTION_ID, rating: 1 }, 'nope')).status).toBe(404);
  });

  it("saves the caller's vote, returns it, and scores the trace after the response", async () => {
    const row = { id: 'f1', rating: -1, reasons: ['shallow'], comment: 'thin' };
    submitMock.mockResolvedValue(row);

    const res = await call({ messageId: QUESTION_ID, rating: -1, reasons: ['shallow'], comment: 'thin' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { rating: -1, reasons: ['shallow'], comment: 'thin' } });
    expect(submitMock).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: CHAT_ID,
      messageId: QUESTION_ID,
      rating: -1,
      reasons: ['shallow'],
      comment: 'thin',
    });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'workspace-1');
    // Not awaited in the request: handed to after().
    expect(scoreMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0][0]();
    expect(scoreMock).toHaveBeenCalledWith(row);
  });

  it.each([
    [new InvalidResponseFeedbackError('rating must be 1, -1 or null'), 400],
    [new CopilotChatNotFoundError(CHAT_ID), 404],
    [new ResponseFeedbackTurnNotFoundError(QUESTION_ID), 404],
    [new CopilotChatForbiddenError(CHAT_ID), 403],
  ])('maps %s to %i', async (err, status) => {
    submitMock.mockRejectedValue(err);
    expect((await call({ messageId: QUESTION_ID, rating: 1 })).status).toBe(status);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('returns 403 when no workspace is active', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValue(new NoActiveWorkspaceError());
    expect((await call({ messageId: QUESTION_ID, rating: 1 })).status).toBe(403);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 500 on an unexpected error', async () => {
    submitMock.mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await call({ messageId: QUESTION_ID, rating: 1 })).status).toBe(500);
    error.mockRestore();
  });
});
