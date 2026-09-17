import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

describe('GET/POST /ingest/[...path]', () => {
  const originalHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NEXT_PUBLIC_POSTHOG_HOST = originalHost;
  });

  it('forwards the request to NEXT_PUBLIC_POSTHOG_HOST with the /ingest prefix stripped', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    fetchMock.mockResolvedValue(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));

    const { GET } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/decide/?v=3', { method: 'GET' });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchMock.mock.calls[0];
    expect(targetUrl).toBe('https://us.i.posthog.com/decide/?v=3');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('streams the request body through for POST requests', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const { POST } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/e/', {
      method: 'POST',
      body: JSON.stringify({ event: 'test' }),
      headers: { 'content-type': 'application/json' },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [targetUrl, init] = fetchMock.mock.calls[0];
    expect(targetUrl).toBe('https://us.i.posthog.com/e/');
    expect(init.method).toBe('POST');
    expect(init.body).toBeDefined();
    expect(init.duplex).toBe('half');
  });

  it('does not forward cookie, authorization, or x-api-secret headers upstream', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const { GET } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/decide/', {
      method: 'GET',
      headers: {
        cookie: 'authjs.session-token=secret',
        authorization: 'Bearer leaked',
        'x-api-secret': 'admin-secret',
        'content-type': 'application/json',
      },
    });

    await GET(request);

    const [, init] = fetchMock.mock.calls[0];
    const forwarded = init.headers as Headers;
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('authorization')).toBeNull();
    expect(forwarded.get('x-api-secret')).toBeNull();
    expect(forwarded.get('content-type')).toBe('application/json');
  });

  it('returns 404 without calling fetch when PostHog is not configured', async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;

    const { GET } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/decide/', { method: 'GET' });

    const response = await GET(request);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the upstream fetch throws', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    fetchMock.mockRejectedValue(new Error('network down'));

    const { GET } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/decide/', { method: 'GET' });

    const response = await GET(request);

    expect(response.status).toBe(500);
  });
});
