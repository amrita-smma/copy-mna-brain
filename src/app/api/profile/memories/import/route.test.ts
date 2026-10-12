import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  createContainer: vi.fn(),
  copilotMemoryEnabled: vi.fn(),
  count: vi.fn(),
  available: vi.fn(),
  enabledForUser: vi.fn(),
  extractForReview: vi.fn(),
  userMemoryService: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services', () => ({ createContainer: mocks.createContainer }));
vi.mock('@/lib/flags', () => ({ copilotMemoryEnabled: mocks.copilotMemoryEnabled }));
vi.mock('@/lib/langfuse', () => ({ flushLangfuse: vi.fn() }));

import { POST } from './route';
import { MAX_IMPORT_CHARS } from '@/lib/memory/limits';

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/profile/memories/import', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.copilotMemoryEnabled.mockResolvedValue(true);
  mocks.available.mockReturnValue(true);
  mocks.enabledForUser.mockResolvedValue(true);
  mocks.extractForReview.mockResolvedValue({
    statements: ['Covers Indonesian coal'],
    summary: 'Found 1.',
  });
  mocks.userMemoryService.mockReturnValue({
    count: mocks.count,
    available: mocks.available,
    enabledForUser: mocks.enabledForUser,
    extractForReview: mocks.extractForReview,
  });
  mocks.createContainer.mockReturnValue({ userMemoryService: mocks.userMemoryService });
});

describe('POST /api/profile/memories/import', () => {
  it('returns proposals for review and stores nothing', async () => {
    const res = await POST(post({ text: 'I cover Indonesian coal.', origin: 'ChatGPT' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: {
        statements: ['Covers Indonesian coal'],
        summary: 'Found 1.',
        origin: 'ChatGPT',
      },
    });
    expect(mocks.extractForReview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', text: 'I cover Indonesian coal.' }),
    );
  });

  it('takes the owner from the session, never from the request body', async () => {
    await POST(post({ text: 'notes', userId: 'someone-else' }));

    expect(mocks.extractForReview.mock.calls[0][0].userId).toBe('user-1');
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await POST(post({ text: 'notes' }))).status).toBe(401);
    expect(mocks.extractForReview).not.toHaveBeenCalled();
  });

  it('403s when the memory feature is off', async () => {
    mocks.copilotMemoryEnabled.mockResolvedValue(false);

    expect((await POST(post({ text: 'notes' }))).status).toBe(403);
    expect(mocks.extractForReview).not.toHaveBeenCalled();
  });

  it('503s when the deployment has no model to extract with', async () => {
    mocks.available.mockReturnValue(false);

    expect((await POST(post({ text: 'notes' }))).status).toBe(503);
    expect(mocks.extractForReview).not.toHaveBeenCalled();
  });

  it('409s with an actionable message when the user switched memory off', async () => {
    mocks.enabledForUser.mockResolvedValue(false);

    const res = await POST(post({ text: 'notes' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Remember me across conversations');
    expect(mocks.extractForReview).not.toHaveBeenCalled();
  });

  it('400s on an empty paste', async () => {
    expect((await POST(post({ text: '   ' }))).status).toBe(400);
    expect(mocks.extractForReview).not.toHaveBeenCalled();
  });

  it('413s on a source past the size cap, before spending a model call', async () => {
    const res = await POST(post({ text: 'x'.repeat(MAX_IMPORT_CHARS + 1) }));

    expect(res.status).toBe(413);
    expect(mocks.extractForReview).not.toHaveBeenCalled();
  });

  it('reports provider overload as busy rather than as a broken deployment', async () => {
    mocks.extractForReview.mockRejectedValue(
      new Error('anthropic 529 at https://api.anthropic.com/v1/messages'),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(post({ text: 'notes' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain('anthropic.com');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('names a configuration failure rather than telling the user to retry', async () => {
    mocks.extractForReview.mockRejectedValue(new Error('Could not load credentials'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(post({ text: 'notes' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toContain('embedding service');
    spy.mockRestore();
  });

  it('500s generically on an unrecognised failure, without echoing the provider', async () => {
    mocks.extractForReview.mockRejectedValue(new Error('odd at https://api.anthropic.com'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(post({ text: 'notes' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('try again');
    expect(JSON.stringify(body)).not.toContain('anthropic.com');
    spy.mockRestore();
  });
});
