import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchArticleContent, fetchWithRedirectGuard, CONTENT_MAX_BYTES } from './rssContent';

const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dnsMocks.lookup }));

describe('fetchArticleContent', () => {
  it('returns the extracted plain text of the article body', async () => {
    const extract = vi.fn().mockResolvedValue({
      content:
        "<p>Acme <b>raised</b> $40m in a round led by Beta Capital, with participation from Gamma Ventures and Delta Partners. The financing will fund international expansion and product development over the next eighteen months. Acme's chief executive said the round values the company at $250m post-money.</p>",
    });

    const out = await fetchArticleContent('https://example.com/a', { extract });

    expect(out).toEqual({
      kind: 'ok',
      text:
        "Acme raised $40m in a round led by Beta Capital, with participation from Gamma Ventures and Delta Partners. The financing will fund international expansion and product development over the next eighteen months. Acme's chief executive said the round values the company at $250m post-money.",
    });
  });

  it('reports a failure when the extractor finds no article', async () => {
    const extract = vi.fn().mockResolvedValue(null);
    expect(await fetchArticleContent('https://example.com/a', { extract })).toEqual({
      kind: 'failed',
      reason: 'no article extracted',
    });
  });

  it('reports a failure when the extracted body is too short to be useful', async () => {
    const extract = vi.fn().mockResolvedValue({ content: '<p>Subscribe to read.</p>' });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out).toEqual({ kind: 'failed', reason: 'content too short' });
  });

  // This is the falsifier for MIN_USEFUL_LENGTH: the extracted text below is 43
  // characters — comfortably past a naive/low floor but nowhere near the real
  // 200-char floor. If MIN_USEFUL_LENGTH is ever lowered back into the 30-200
  // range, this test starts failing. Do not delete it as "redundant" with the
  // 18-char "too short" case above — that case doesn't exercise the threshold,
  // this one does.
  it('rejects a paywall stub that clears a naive short-length floor but not the real one', async () => {
    const extract = vi.fn().mockResolvedValue({
      content: '<p>Subscribe to continue reading this article.</p>',
    });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out).toEqual({ kind: 'failed', reason: 'content too short' });
  });

  it('caps very long bodies so one article cannot bloat a row', async () => {
    const extract = vi.fn().mockResolvedValue({ content: '<p>' + 'x'.repeat(500_000) + '</p>' });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.text.length).toBe(CONTENT_MAX_BYTES);
  });

  it('converts a thrown error into a failure reason rather than propagating', async () => {
    const extract = vi.fn().mockRejectedValue(new Error('403 Forbidden'));
    expect(await fetchArticleContent('https://example.com/a', { extract })).toEqual({
      kind: 'failed',
      reason: '403 Forbidden',
    });
  });

  it('rejects a non-http URL without calling the extractor', async () => {
    const extract = vi.fn();
    const out = await fetchArticleContent('javascript:alert(1)', { extract });
    expect(out).toEqual({ kind: 'failed', reason: 'unsupported url scheme' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('rejects an empty URL', async () => {
    const extract = vi.fn();
    expect(await fetchArticleContent('', { extract })).toEqual({
      kind: 'failed',
      reason: 'unsupported url scheme',
    });
  });

  it('collapses runaway whitespace in the extracted text', async () => {
    const extract = vi.fn().mockResolvedValue({
      content:
        '<p>Line one with additional context about the deal timeline and structure so this paragraph carries real content on its own.</p>\n\n\n\n<p>Line two with plenty of words to clear the length floor here, including details about deal size, key parties involved, and the expected closing timeline for this transaction.</p>',
    });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.text).not.toMatch(/\n{3,}/);
  });
});

/**
 * `fetchWithRedirectGuard` is the SSRF-hardened `Fetcher` `fetchArticleContent`
 * wires into the article extractor. These tests exercise it directly with an
 * injected `fetchImpl` — no real network or DNS lookup ever happens; `node:dns/promises`
 * is mocked at the top of this file so any non-literal-IP hostname resolves to
 * whatever `dnsMocks.lookup` is set to return.
 */
describe('fetchWithRedirectGuard', () => {
  beforeEach(() => {
    dnsMocks.lookup.mockReset();
    // Default: every hostname resolves to a public address, so tests that
    // don't care about DNS still exercise the real resolution branch.
    dnsMocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  function redirectResponse(location: string) {
    return new Response(null, { status: 302, headers: { location } });
  }

  it('refuses a redirect to the EC2/VPC metadata IP', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://169.254.169.254/latest/meta-data'));

    await expect(
      fetchWithRedirectGuard('https://example.com/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a non-http(s) scheme', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('javascript:alert(1)'));

    await expect(
      fetchWithRedirectGuard('https://example.com/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/unsupported url scheme/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect chain longer than the hop cap', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      const n = Number(new URL(url).pathname.split('/').pop());
      return Promise.resolve(redirectResponse(`https://example.com/hop/${n + 1}`));
    });

    await expect(
      fetchWithRedirectGuard('https://example.com/hop/0', 1000, fetchImpl as never),
    ).rejects.toThrow(/too many redirects/);
    // 1 initial request + at most 5 followed redirects, never unbounded.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('follows an ordinary same-origin redirect to a public host and returns the final response', async () => {
    const finalResponse = new Response('<html><body>ok</body></html>', { status: 200 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://example.com/canonical-article'))
      .mockResolvedValueOnce(finalResponse);

    const response = await fetchWithRedirectGuard(
      'https://example.com/article',
      1000,
      fetchImpl as never,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://example.com/canonical-article',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects a hostname it cannot resolve rather than letting it through', async () => {
    dnsMocks.lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const fetchImpl = vi.fn();

    await expect(
      fetchWithRedirectGuard('https://nonexistent.example/', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * IPv6 bypass regression tests. The WHATWG `URL` parser normalizes an
   * IPv4-mapped IPv6 literal's dotted-quad tail into hex
   * (`::ffff:169.254.169.254` -> `[::ffff:a9fe:a9fe]`) — these redirect to
   * the *unnormalized* dotted form so `new URL(location, currentUrl)`
   * inside `fetchWithRedirectGuard` performs that normalization for real,
   * exercising the exact host string `assertAllowedUrl` has to classify.
   */
  it('refuses a redirect to an IPv4-mapped IPv6 metadata address, dotted spelling', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://[::ffff:169.254.169.254]/'));

    await expect(
      fetchWithRedirectGuard('https://example.com/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to an IPv4-mapped IPv6 metadata address, hex spelling', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://[::ffff:a9fe:a9fe]/'));

    await expect(
      fetchWithRedirectGuard('https://example.com/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to the IPv6 loopback literal [::1]', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse('http://[::1]/'));

    await expect(
      fetchWithRedirectGuard('https://example.com/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to an IPv6 link-local literal [fe80::1]', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirectResponse('http://[fe80::1]/'));

    await expect(
      fetchWithRedirectGuard('https://example.com/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a hostname whose DNS lookup resolves to an IPv4-mapped metadata address', async () => {
    dnsMocks.lookup.mockResolvedValueOnce([{ address: '::ffff:169.254.169.254', family: 6 }]);
    const fetchImpl = vi.fn();

    await expect(
      fetchWithRedirectGuard('https://news.example/article', 1000, fetchImpl as never),
    ).rejects.toThrow(/blocked host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a redirect to a genuine public IPv6 host rather than blocking the legitimate IPv6 internet', async () => {
    const finalResponse = new Response('<html><body>ok</body></html>', { status: 200 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://[2606:4700:4700::1111]/'))
      .mockResolvedValueOnce(finalResponse);

    const response = await fetchWithRedirectGuard(
      'https://example.com/article',
      1000,
      fetchImpl as never,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://[2606:4700:4700::1111]/',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});
