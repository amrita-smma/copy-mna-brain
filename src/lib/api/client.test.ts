import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { signOutMock, isEmbeddedMock, postToLauncherMock } = vi.hoisted(() => ({
  signOutMock: vi.fn(),
  isEmbeddedMock: vi.fn(() => false),
  postToLauncherMock: vi.fn(),
}));

vi.mock('next-auth/react', () => ({ signOut: signOutMock }));
vi.mock('@/lib/iframe', () => ({
  isEmbedded: isEmbeddedMock,
  postToLauncher: postToLauncherMock,
}));

import { apiRequest, buildWorkspaceHeaders, getWorkspaceSlugFromUrl } from './client';

function stubLocation(pathname: string, origin = 'http://localhost:3000') {
  vi.stubGlobal('window', { location: { pathname, origin } });
}

describe('getWorkspaceSlugFromUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when window is undefined (server-side)', () => {
    vi.stubGlobal('window', undefined);
    expect(getWorkspaceSlugFromUrl()).toBeNull();
  });

  it('extracts the slug from a /w/<slug>/... pathname', () => {
    stubLocation('/w/togan-vcc/pipeline');
    expect(getWorkspaceSlugFromUrl()).toBe('togan-vcc');
  });

  it('extracts the slug when the pathname is just /w/<slug>', () => {
    stubLocation('/w/togan-vcc');
    expect(getWorkspaceSlugFromUrl()).toBe('togan-vcc');
  });

  it('returns null for a flat (non-/w/) pathname', () => {
    stubLocation('/master-data');
    expect(getWorkspaceSlugFromUrl()).toBeNull();
  });
});

describe('buildWorkspaceHeaders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches X-Workspace-Slug for a same-origin relative URL', () => {
    stubLocation('/w/togan-vcc/pipeline');
    expect(buildWorkspaceHeaders('/api/companies')).toEqual({
      'X-Workspace-Slug': 'togan-vcc',
    });
  });

  it('preserves existing headers alongside the workspace header', () => {
    stubLocation('/w/togan-vcc/pipeline');
    expect(buildWorkspaceHeaders('/api/companies', { Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
      'X-Workspace-Slug': 'togan-vcc',
    });
  });

  it('does not attach a header for a cross-origin URL (e.g. an S3 presigned upload)', () => {
    stubLocation('/w/togan-vcc/pipeline');
    expect(buildWorkspaceHeaders('https://bucket.s3.amazonaws.com/upload?sig=abc')).toEqual({});
  });

  it('does not attach a header when there is no slug in the URL', () => {
    stubLocation('/master-data');
    expect(buildWorkspaceHeaders('/api/companies')).toEqual({});
  });
});

describe('apiRequest', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('includes the workspace header in the outgoing fetch call', async () => {
    stubLocation('/w/aeliana-vcc/master-data');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );

    await apiRequest('/api/companies');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['X-Workspace-Slug']).toBe('aeliana-vcc');
  });

  it('does not force a JSON content-type when the body is FormData', async () => {
    stubLocation('/w/aeliana-vcc/master-data');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );

    const formData = new FormData();
    formData.append('file', 'content');
    await apiRequest('/api/upload', { method: 'POST', body: formData });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('sets a JSON content-type for a normal (non-FormData) request', async () => {
    stubLocation('/w/aeliana-vcc/master-data');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );

    await apiRequest('/api/companies');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('unwraps the { data } envelope', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );

    await expect(apiRequest('/api/x')).resolves.toEqual({ ok: true });
  });

  it('resolves to null when data is explicitly null (not the envelope)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: null }), { status: 200 }),
    );

    await expect(apiRequest('/api/x')).resolves.toBeNull();
  });

  it('passes a raw response (no data key) through unchanged', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 }),
    );

    await expect(apiRequest('/api/x')).resolves.toEqual({ ok: true, count: 2 });
  });

  it('passes a raw array response through unchanged', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify([1, 2, 3]), { status: 200 }),
    );

    await expect(apiRequest('/api/x')).resolves.toEqual([1, 2, 3]);
  });
});

describe('apiRequest 401 handling', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    signOutMock.mockReset();
    postToLauncherMock.mockReset();
    isEmbeddedMock.mockReset();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('signs out to /login on 401 when running standalone (not embedded)', async () => {
    stubLocation('/w/aeliana-vcc/master-data');
    isEmbeddedMock.mockReturnValue(false);

    await expect(apiRequest('/api/companies')).rejects.toThrow('Unauthorized');

    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/login' });
    expect(postToLauncherMock).not.toHaveBeenCalled();
  });

  it('notifies the launcher (auth-expired) on 401 when embedded, without signing out', async () => {
    stubLocation('/w/aeliana-vcc/master-data');
    isEmbeddedMock.mockReturnValue(true);

    await expect(apiRequest('/api/companies')).rejects.toThrow('Unauthorized');

    expect(postToLauncherMock).toHaveBeenCalledWith({ type: 'auth-expired' });
    expect(signOutMock).not.toHaveBeenCalled();
  });
});
