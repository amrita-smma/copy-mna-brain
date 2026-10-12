import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  improvePrompt: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/chat/improvePrompt', () => ({ improvePrompt: mocks.improvePrompt }));

import { POST } from './route';
// Deliberately not mocked: the attribution assertion below needs the real store.
import { getLangfuseUserId } from '@/lib/langfuseUser';

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/chat/improve-prompt', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.improvePrompt.mockResolvedValue('A sharper prompt');
});

describe('POST /api/chat/improve-prompt', () => {
  it('returns the improved prompt', async () => {
    const res = await POST(post({ prompt: 'make slides' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { improved: 'A sharper prompt' } });
    expect(mocks.improvePrompt).toHaveBeenCalledWith('make slides');
  });

  it('runs the rewrite under the signed-in user so its Langfuse trace is attributed', async () => {
    // `improvePrompt` takes no user parameter — the id reaches Langfuse through
    // the ambient store that `withLangfuseCallbacks` reads inside it.
    let userDuringRewrite: string | undefined;
    mocks.improvePrompt.mockImplementation(async () => {
      userDuringRewrite = getLangfuseUserId();
      return 'A sharper prompt';
    });

    await POST(post({ prompt: 'make slides' }));

    expect(userDuringRewrite).toBe('user-1');
    expect(getLangfuseUserId()).toBeUndefined();
  });

  it('rejects an unauthenticated request without calling the model', async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await POST(post({ prompt: 'make slides' }));

    expect(res.status).toBe(401);
    expect(mocks.improvePrompt).not.toHaveBeenCalled();
  });

  it('rejects a blank prompt without calling the model', async () => {
    const res = await POST(post({ prompt: '   ' }));

    expect(res.status).toBe(400);
    expect(mocks.improvePrompt).not.toHaveBeenCalled();
  });
});
