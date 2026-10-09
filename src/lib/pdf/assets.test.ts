import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadImage,
  loadImages,
  loadLocalLogo,
  isFetchableUrl,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_DOCUMENT,
  IMAGE_TIMEOUT_MS,
} from './assets';

const fetchMock = vi.fn();

function body(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

function response(opts: {
  status?: number;
  ok?: boolean;
  contentType?: string | null;
  contentLength?: string | null;
  location?: string | null;
  bytes?: Buffer;
}) {
  const headers = new Map<string, string>();
  if (opts.contentType != null) headers.set('content-type', opts.contentType);
  if (opts.contentLength != null) headers.set('content-length', opts.contentLength);
  if (opts.location != null) headers.set('location', opts.location);
  const bytes = opts.bytes ?? Buffer.from('png-bytes');
  const status = opts.status ?? 200;
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: body(bytes),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('isFetchableUrl', () => {
  it('accepts ordinary public http and https urls', () => {
    expect(isFetchableUrl('https://cdn.example.com/logo.png')).toBe(true);
    expect(isFetchableUrl('http://example.com/a.png')).toBe(true);
    expect(isFetchableUrl('https://8.8.8.8/a.png')).toBe(true);
  });

  it('rejects non-http schemes', () => {
    for (const url of ['data:image/png;base64,AA', 'file:///etc/passwd', 'ftp://x/a.png']) {
      expect(isFetchableUrl(url)).toBe(false);
    }
  });

  it('rejects loopback and link-local addresses, including cloud metadata', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', 'localhost']) {
      expect(isFetchableUrl(`https://${host}/a.png`)).toBe(false);
    }
  });

  it('rejects private and carrier-grade-NAT ranges', () => {
    for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1']) {
      expect(isFetchableUrl(`https://${host}/a.png`)).toBe(false);
    }
  });

  it('allows public addresses that merely look adjacent to private ones', () => {
    for (const host of ['172.32.0.1', '172.15.0.1', '192.167.1.1', '100.63.0.1', '11.0.0.1']) {
      expect(isFetchableUrl(`https://${host}/a.png`)).toBe(true);
    }
  });

  it('rejects IPv6 loopback, unique-local and IPv4-mapped private addresses', () => {
    for (const host of ['[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
      expect(isFetchableUrl(`https://${host}/a.png`)).toBe(false);
    }
  });

  it('rejects internal-sounding hostname suffixes', () => {
    for (const host of ['db.internal', 'printer.local', 'router.home.arpa']) {
      expect(isFetchableUrl(`https://${host}/a.png`)).toBe(false);
    }
  });

  it('rejects a malformed url instead of throwing', () => {
    expect(isFetchableUrl('not a url')).toBe(false);
  });
});

describe('loadImage', () => {
  it('returns the body for an allowed content type', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/png' }));
    const out = await loadImage('https://cdn.example.com/logo.png');
    expect(out?.toString()).toBe('png-bytes');
  });

  it('accepts a jpeg served with charset parameters on the content type', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/jpeg; charset=binary' }));
    await expect(loadImage('https://cdn.example.com/l.jpg')).resolves.toBeInstanceOf(Buffer);
  });

  it('falls back to the url extension when the CDN sends octet-stream', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'application/octet-stream' }));
    await expect(loadImage('https://cdn.example.com/l.png?v=2')).resolves.toBeInstanceOf(Buffer);
  });

  it('returns undefined for a type react-pdf cannot decode', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/svg+xml' }));
    await expect(loadImage('https://cdn.example.com/logo.svg')).resolves.toBeUndefined();
  });

  it('returns undefined for a non-2xx response', async () => {
    fetchMock.mockResolvedValue(response({ status: 404, contentType: 'image/png' }));
    await expect(loadImage('https://cdn.example.com/missing.png')).resolves.toBeUndefined();
  });

  it('returns undefined when the declared length exceeds the cap', async () => {
    fetchMock.mockResolvedValue(
      response({ contentType: 'image/png', contentLength: String(MAX_IMAGE_BYTES + 1) }),
    );
    await expect(loadImage('https://cdn.example.com/huge.png')).resolves.toBeUndefined();
  });

  it('abandons a body that exceeds the cap even with no content-length', async () => {
    fetchMock.mockResolvedValue(
      response({ contentType: 'image/png', bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
    );
    await expect(loadImage('https://cdn.example.com/huge.png')).resolves.toBeUndefined();
  });

  it('returns undefined for an empty body', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/png', bytes: Buffer.alloc(0) }));
    await expect(loadImage('https://cdn.example.com/empty.png')).resolves.toBeUndefined();
  });

  it('returns undefined when the transport rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(loadImage('https://cdn.example.com/logo.png')).resolves.toBeUndefined();
  });

  it('issues no request at all for a blocked address', async () => {
    await expect(loadImage('https://169.254.169.254/latest/meta-data')).resolves.toBeUndefined();
    await expect(loadImage('file:///etc/passwd')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an abort signal so a hung host cannot stall the render', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/png' }));
    await loadImage('https://cdn.example.com/logo.png');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(IMAGE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  describe('redirects', () => {
    it('follows a redirect to another public host', async () => {
      fetchMock
        .mockResolvedValueOnce(response({ status: 302, location: 'https://other.example.com/l.png' }))
        .mockResolvedValueOnce(response({ contentType: 'image/png' }));
      await expect(loadImage('https://cdn.example.com/l.png')).resolves.toBeInstanceOf(Buffer);
      expect(fetchMock.mock.calls[1][0]).toBe('https://other.example.com/l.png');
    });

    it('resolves a relative Location against the current url', async () => {
      fetchMock
        .mockResolvedValueOnce(response({ status: 301, location: '/real/l.png' }))
        .mockResolvedValueOnce(response({ contentType: 'image/png' }));
      await loadImage('https://cdn.example.com/a/l.png');
      expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.com/real/l.png');
    });

    it('refuses a redirect into the server\'s own network — the SSRF case', async () => {
      fetchMock.mockResolvedValueOnce(
        response({ status: 302, location: 'http://169.254.169.254/latest/meta-data' }),
      );
      await expect(loadImage('https://cdn.example.com/l.png')).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never follows the redirect chain forever', async () => {
      fetchMock.mockResolvedValue(
        response({ status: 302, location: 'https://cdn.example.com/again.png' }),
      );
      await expect(loadImage('https://cdn.example.com/l.png')).resolves.toBeUndefined();
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it('gives up on a redirect with no Location header', async () => {
      fetchMock.mockResolvedValueOnce(response({ status: 302 }));
      await expect(loadImage('https://cdn.example.com/l.png')).resolves.toBeUndefined();
    });
  });
});

describe('loadImages', () => {
  it('returns an empty cache without hitting the network when there are no urls', async () => {
    const cache = await loadImages([null, undefined, '']);
    expect(cache.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches each distinct url exactly once', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/png' }));
    const cache = await loadImages([
      'https://a.example/1.png',
      'https://a.example/1.png',
      'https://a.example/2.png',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it('records undefined for a failed url so its block renders without the image', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ contentType: 'image/png' }))
      .mockRejectedValueOnce(new Error('boom'));
    const cache = await loadImages(['https://a.example/ok.png', 'https://a.example/bad.png']);
    expect(cache.get('https://a.example/ok.png')).toBeInstanceOf(Buffer);
    expect(cache.get('https://a.example/bad.png')).toBeUndefined();
    expect(cache.has('https://a.example/bad.png')).toBe(true);
  });

  it('stops at the per-document ceiling instead of fanning out without limit', async () => {
    fetchMock.mockResolvedValue(response({ contentType: 'image/png' }));
    const many = Array.from({ length: MAX_IMAGES_PER_DOCUMENT + 40 }, (_, i) =>
      `https://a.example/${i}.png`,
    );
    const cache = await loadImages(many);
    expect(cache.size).toBe(MAX_IMAGES_PER_DOCUMENT);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_IMAGES_PER_DOCUMENT);
  });

  it('keeps only a handful of requests in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return response({ contentType: 'image/png' });
    });
    await loadImages(Array.from({ length: 24 }, (_, i) => `https://a.example/${i}.png`));
    expect(peak).toBeLessThanOrEqual(6);
  });
});

describe('loadLocalLogo', () => {
  it('reads the bundled app logo', () => {
    const logo = loadLocalLogo();
    expect(logo).toBeInstanceOf(Buffer);
    expect(logo!.subarray(1, 4).toString()).toBe('PNG');
  });
});
