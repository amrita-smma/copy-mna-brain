import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  createContainer: vi.fn(),
  copilotMemoryEnabled: vi.fn(),
  saveReviewed: vi.fn(),
  count: vi.fn(),
  userMemoryService: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));
vi.mock('@/lib/flags', () => ({ copilotMemoryEnabled: mocks.copilotMemoryEnabled }));

import { POST } from './route';
import { MAX_IMPORT_STATEMENTS } from '@/lib/memory/limits';

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/profile/memories/import/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.copilotMemoryEnabled.mockResolvedValue(true);
  mocks.saveReviewed.mockResolvedValue({ submitted: 2, added: 2, skipped: 0 });
  // Counted either side of the write: 5 before, 7 after.
  mocks.count.mockResolvedValueOnce(5).mockResolvedValue(7);
  mocks.userMemoryService.mockReturnValue({
    saveReviewed: mocks.saveReviewed,
    count: mocks.count,
  });
  mocks.createContainer.mockReturnValue({ userMemoryService: mocks.userMemoryService });
});

describe('POST /api/profile/memories/import/confirm', () => {
  it('stores exactly the statements the user approved', async () => {
    // The review step lets the user edit the wording, so this takes the body at
    // face value rather than re-deriving anything from the source.
    const res = await POST(
      post({ statements: ['Covers coal', 'Prefers tables'], origin: 'ChatGPT' }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: { submitted: 2, added: 2, skipped: 0, total: 7 },
    });
    expect(mocks.saveReviewed).toHaveBeenCalledWith({
      userId: 'user-1',
      statements: ['Covers coal', 'Prefers tables'],
      origin: 'ChatGPT',
    });
  });

  it('reports what actually landed, not what mem0 claimed', async () => {
    // mem0 swallows its own extraction failures and reports zero records, which
    // is indistinguishable from "all duplicates" unless the store is measured.
    // It can equally over-report; either way the count is the truth.
    mocks.saveReviewed.mockResolvedValue({ submitted: 2, added: 2, skipped: 0 });
    mocks.count.mockReset().mockResolvedValueOnce(5).mockResolvedValue(5);

    const res = await POST(post({ statements: ['Covers coal', 'Prefers tables'] }));

    await expect(res.json()).resolves.toEqual({
      data: { submitted: 2, added: 0, skipped: 2, total: 5 },
    });
  });

  it('takes the owner from the session, never from the body', async () => {
    await POST(post({ statements: ['a'], userId: 'someone-else' }));

    expect(mocks.saveReviewed.mock.calls[0][0].userId).toBe('user-1');
  });

  it('drops blank and non-string entries before saving', async () => {
    await POST(post({ statements: ['  Covers coal  ', '', '   ', 42, null] }));

    expect(mocks.saveReviewed.mock.calls[0][0].statements).toEqual(['Covers coal']);
  });

  it('400s when nothing survived the review', async () => {
    const res = await POST(post({ statements: ['', '   '] }));

    expect(res.status).toBe(400);
    expect(mocks.saveReviewed).not.toHaveBeenCalled();
  });

  it('400s when statements is not an array', async () => {
    expect((await POST(post({ statements: 'nope' }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect(mocks.saveReviewed).not.toHaveBeenCalled();
  });

  it('413s past the per-import cap', async () => {
    const many = Array.from({ length: MAX_IMPORT_STATEMENTS + 1 }, (_, i) => `fact ${i}`);

    expect((await POST(post({ statements: many }))).status).toBe(413);
    expect(mocks.saveReviewed).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await POST(post({ statements: ['a'] }))).status).toBe(401);
    expect(mocks.saveReviewed).not.toHaveBeenCalled();
  });

  it('403s when the memory feature is off', async () => {
    mocks.copilotMemoryEnabled.mockResolvedValue(false);

    expect((await POST(post({ statements: ['a'] }))).status).toBe(403);
    expect(mocks.saveReviewed).not.toHaveBeenCalled();
  });

  it('names a configuration failure instead of telling the user to retry', async () => {
    // Saving is the first point that needs Bedrock; a deployment with no AWS
    // credentials extracts fine and only fails here, and "try again" would
    // never come true.
    mocks.saveReviewed.mockRejectedValue(
      new Error('Could not load credentials from any providers'),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(post({ statements: ['a'] }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toContain('embedding service');
    expect(body.error).not.toContain('try again');
    spy.mockRestore();
  });

  it('still asks the user to retry a transient failure, without leaking the provider', async () => {
    mocks.saveReviewed.mockRejectedValue(new Error('boom at https://api.anthropic.com'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(post({ statements: ['a'] }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('try again');
    expect(JSON.stringify(body)).not.toContain('anthropic.com');
    spy.mockRestore();
  });
});
