import { NextRequest, NextResponse } from 'next/server';

// Reverse-proxies browser-side PostHog traffic (event capture, feature flags,
// session recording assets) through our own origin instead of posthog-js
// talking to PostHog's domain directly. Ad/tracker blockers commonly block
// requests by hostname (posthog.com, i.posthog.com), which silently drops
// analytics for a meaningful slice of users; same-origin traffic isn't
// caught by those hostname-based lists.
//
// Deliberately lives at `/ingest`, outside `src/app/api/` — it must stay
// reachable by unauthenticated visitors (e.g. the login page) and by
// posthog-js itself, which has no way to attach the `X-Api-Secret` header
// `src/proxy.ts` requires for `/api/*`. See `src/instrumentation-client.ts`,
// which points `api_host` at this route.
async function proxyToPostHog(request: NextRequest) {
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  if (!posthogHost || posthogHost === 'posthog_host') {
    return NextResponse.json({ error: 'PostHog is not configured' }, { status: 404 });
  }

  try {
    const targetPath = request.nextUrl.pathname.replace(/^\/ingest/, '');
    const targetUrl = `${posthogHost}${targetPath}${request.nextUrl.search}`;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    // Browser requests to same-origin `/ingest` include session cookies.
    // PostHog does not need them (or Authorization / our admin secret);
    // forwarding would leak credentials to a third party.
    headers.delete('cookie');
    headers.delete('authorization');
    headers.delete('x-api-secret');

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      // Node's fetch requires `duplex` to stream a request body through;
      // not yet part of the DOM `RequestInit` type this project's lib targets.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);

    const responseHeaders = new Headers(response.headers);
    // Fetched already-decoded by undici; forwarding the original
    // Content-Encoding/-Length would mismatch the body we're passing through.
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    return new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[posthog-ingest-proxy]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = proxyToPostHog;
export const POST = proxyToPostHog;
export const OPTIONS = proxyToPostHog;
