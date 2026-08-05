import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  getActiveWorkspaceIdOrThrowMock,
  createContainerMock,
  submitMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  createContainerMock: vi.fn(),
  submitMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace')>('@/lib/workspace');
  return {
    ...actual,
    getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock,
  };
});
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const USER_ID = 'user-1';

function makeRequest(body: unknown): never {
  return { json: async () => body } as never;
}

describe('POST /api/feedback', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue('workspace-1');
    submitMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({ feedbackService: { submit: submitMock } });
  });

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ title: 'Dark mode', message: 'Please add dark mode' }));
    expect(res.status).toBe(401);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body is not valid JSON', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST({
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid JSON/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 403 when there is no active workspace', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());

    const res = await POST(makeRequest({ title: 'Dark mode', message: 'Please add dark mode' }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/No active workspace/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 when title is missing or blank', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({ title: '   ', message: 'Please add dark mode' }));
    expect(res.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 when message is missing or blank', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({ title: 'Dark mode', message: '   ' }));
    expect(res.status).toBe(400);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('returns 400 when title exceeds the 200-character cap', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({ title: 'x'.repeat(201), message: 'Please add dark mode' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/200/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('accepts a title at exactly the 200-character cap', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitMock.mockResolvedValueOnce({ id: 'f1' });
    const res = await POST(makeRequest({ title: 'x'.repeat(200), message: 'Please add dark mode' }));
    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'x'.repeat(200) }),
    );
  });

  it('accepts a title that exceeds 200 chars only because of newlines, after normalization', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitMock.mockResolvedValueOnce({ id: 'f1' });
    // 50 + 120 newlines + 50 → raw length 220, normalized to "xxx… yyy…" (101 chars).
    const res = await POST(
      makeRequest({
        title: `${'x'.repeat(50)}${'\n'.repeat(120)}${'y'.repeat(50)}`,
        message: 'Please add dark mode',
      }),
    );
    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: `${'x'.repeat(50)} ${'y'.repeat(50)}` }),
    );
  });

  it('returns 400 when message exceeds the 5000-character cap', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(makeRequest({ title: 'Dark mode', message: 'x'.repeat(5001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/5000/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('accepts a message at exactly the 5000-character cap', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitMock.mockResolvedValueOnce({ id: 'f1' });
    const res = await POST(makeRequest({ title: 'Dark mode', message: 'x'.repeat(5000) }));
    expect(res.status).toBe(200);
  });

  it('submits the trimmed title and message for the authenticated user + active workspace', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitMock.mockResolvedValueOnce({
      id: 'f1',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });

    const res = await POST(
      makeRequest({ title: '  Dark mode  ', message: '  Please add dark mode  ' }),
    );

    expect(res.status).toBe(200);
    expect(createContainerMock).toHaveBeenCalledWith({}, 'workspace-1');
    expect(submitMock).toHaveBeenCalledWith({
      userId: USER_ID,
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
    const body = await res.json();
    expect(body).toEqual({
      data: { id: 'f1', title: 'Dark mode', message: 'Please add dark mode' },
    });
  });

  it('returns 500 when the service throws', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    submitMock.mockRejectedValueOnce(new Error('db down'));

    const res = await POST(makeRequest({ title: 'Dark mode', message: 'Please add dark mode' }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('db down');
  });
});
