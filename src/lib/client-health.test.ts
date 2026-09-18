import { describe, it, expect, vi } from 'vitest';
import {
  PROBE_PATH,
  REPORTED_FLAG,
  REPORT_PATH,
  hasReported,
  markReported,
  probeIngest,
} from './client-health';

describe('probeIngest', () => {
  it('reports reachable when the request completes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(probeIngest(fetchImpl as unknown as typeof fetch)).resolves.toBe('reachable');
  });

  it('reports blocked when the request is rejected at the network layer', async () => {
    // This is what ERR_BLOCKED_BY_CLIENT looks like to fetch.
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeIngest(fetchImpl as unknown as typeof fetch)).resolves.toBe('blocked');
  });

  it('reports reachable for an HTTP error — the request still left the browser', async () => {
    // A 404/500 means our own proxy is misconfigured, not that a blocker ate
    // it. Calling that "blocked" would send us chasing the wrong cause.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    await expect(probeIngest(fetchImpl as unknown as typeof fetch)).resolves.toBe('reachable');
  });

  it('probes a real PostHog asset path so filter rules actually apply', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await probeIngest(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(
      PROBE_PATH,
      expect.objectContaining({ method: 'HEAD' }),
    );
    expect(PROBE_PATH).toBe('/ingest/static/array.js');
  });

  it('accepts an explicit path override', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await probeIngest(fetchImpl as unknown as typeof fetch, '/ingest/e/');

    expect(fetchImpl).toHaveBeenCalledWith('/ingest/e/', expect.anything());
  });
});

describe('REPORT_PATH', () => {
  it('avoids every word the filter lists this measures would block', () => {
    for (const word of ['analytics', 'tracking', 'telemetry', 'posthog']) {
      expect(REPORT_PATH).not.toContain(word);
    }
  });
});

describe('hasReported / markReported', () => {
  function makeStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      getItem: vi.fn((k: string) => data[k] ?? null),
      setItem: vi.fn((k: string, v: string) => {
        data[k] = v;
      }),
    };
  }

  it('is false before anything is recorded', () => {
    expect(hasReported(makeStorage())).toBe(false);
  });

  it('is true after markReported', () => {
    const storage = makeStorage();
    markReported(storage);
    expect(storage.setItem).toHaveBeenCalledWith(REPORTED_FLAG, '1');
    expect(hasReported(storage)).toBe(true);
  });

  it('treats unavailable storage as not-yet-reported', () => {
    // A duplicate report is far cheaper than a missing one.
    expect(hasReported(null)).toBe(false);
    expect(hasReported(undefined)).toBe(false);
  });

  it('treats a throwing storage as not-yet-reported', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    };
    expect(hasReported(storage)).toBe(false);
  });

  it('never throws when storage rejects writes', () => {
    const storage = {
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
    };
    expect(() => markReported(storage)).not.toThrow();
  });

  it('does nothing when there is no storage at all', () => {
    expect(() => markReported(null)).not.toThrow();
  });
});
