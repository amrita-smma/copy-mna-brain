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

  it('strips hop-by-hop headers so undici does not reject the upstream request', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const { POST } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/e/', {
      method: 'POST',
      body: JSON.stringify({ event: 'test' }),
      headers: {
        'content-type': 'application/json',
        'content-length': '17',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        trailer: 'Expires',
        upgrade: 'websocket',
        'proxy-connection': 'keep-alive',
      },
    });
    // Next.js sets this on a streamed body; undici throws
    // `InvalidArgumentError: invalid transfer-encoding header` if it is forwarded.
    request.headers.set('transfer-encoding', 'chunked');

    await POST(request);

    const [, init] = fetchMock.mock.calls[0];
    const forwarded = init.headers as Headers;
    expect(forwarded.get('transfer-encoding')).toBeNull();
    expect(forwarded.get('content-length')).toBeNull();
    expect(forwarded.get('connection')).toBeNull();
    expect(forwarded.get('keep-alive')).toBeNull();
    expect(forwarded.get('te')).toBeNull();
    expect(forwarded.get('trailer')).toBeNull();
    expect(forwarded.get('upgrade')).toBeNull();
    expect(forwarded.get('proxy-connection')).toBeNull();
    expect(forwarded.get('content-type')).toBe('application/json');
  });

  it('strips the extra field names a Connection header lists as connection-options', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const { GET } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/decide/', {
      method: 'GET',
      headers: {
        // An upstream CDN/proxy can name its own per-connection fields here;
        // RFC 9110 §7.6.1 makes those hop-by-hop too.
        connection: 'keep-alive, X-Edge-Hop, close',
        'x-edge-hop': 'edge-1',
        'content-type': 'application/json',
      },
    });

    await GET(request);

    const [, init] = fetchMock.mock.calls[0];
    const forwarded = init.headers as Headers;
    expect(forwarded.get('x-edge-hop')).toBeNull();
    expect(forwarded.get('connection')).toBeNull();
    expect(forwarded.get('content-type')).toBe('application/json');
  });

  it('strips hop-by-hop headers from the upstream response', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
    const upstream = new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    upstream.headers.set('transfer-encoding', 'chunked');
    upstream.headers.set('connection', 'keep-alive, X-Upstream-Hop');
    upstream.headers.set('x-upstream-hop', 'posthog-edge');
    fetchMock.mockResolvedValue(upstream);

    const { GET } = await import('./route');
    const request = new NextRequest('https://app.example.com/ingest/decide/', { method: 'GET' });

    const response = await GET(request);

    expect(response.headers.get('transfer-encoding')).toBeNull();
    expect(response.headers.get('connection')).toBeNull();
    expect(response.headers.get('x-upstream-hop')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/plain');
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
