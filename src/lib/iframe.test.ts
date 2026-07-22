import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAllowedAncestorOrigins,
  isAllowedAncestor,
  isEmbedded,
  isLauncherMessage,
  postToLauncher,
} from './iframe';

const DEFAULTS = [
  'https://brain.starcapital.co.id',
  'https://brain-stg.starcapital.co.id',
  'http://localhost:3000',
];

describe('getAllowedAncestorOrigins', () => {
  const original = process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS;
  afterEach(() => {
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS = original;
  });

  it('returns the launcher defaults when the env var is unset', () => {
    delete process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS;
    expect(getAllowedAncestorOrigins()).toEqual(DEFAULTS);
  });

  it('parses a whitespace-separated list and strips trailing slashes', () => {
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS =
      'https://a.example.com/  https://b.example.com';
    expect(getAllowedAncestorOrigins()).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('parses a comma-separated list and de-dupes while preserving order', () => {
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS =
      'https://a.example.com, https://a.example.com, https://c.example.com';
    expect(getAllowedAncestorOrigins()).toEqual([
      'https://a.example.com',
      'https://c.example.com',
    ]);
  });
});

describe('isAllowedAncestor', () => {
  const original = process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS;
  afterEach(() => {
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS = original;
  });

  it('allows an allowlisted origin and rejects anything else', () => {
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS = 'https://brain.starcapital.co.id';
    expect(isAllowedAncestor('https://brain.starcapital.co.id')).toBe(true);
    expect(isAllowedAncestor('https://evil.example.com')).toBe(false);
    // Exact-origin match — a sub-path or trailing slash must not slip through.
    expect(isAllowedAncestor('https://brain.starcapital.co.id/')).toBe(false);
  });
});

describe('isEmbedded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when there is no window (server)', () => {
    expect(isEmbedded()).toBe(false);
  });

  it('is false when window.self === window.top (top-level)', () => {
    const w = {} as Window & typeof globalThis;
    (w as { self: unknown }).self = w;
    (w as { top: unknown }).top = w;
    vi.stubGlobal('window', w);
    expect(isEmbedded()).toBe(false);
  });

  it('is true when window.self !== window.top (framed)', () => {
    const top = {};
    const w = { self: {}, top } as unknown as Window;
    vi.stubGlobal('window', w);
    expect(isEmbedded()).toBe(true);
  });

  it('is true when accessing window.top throws (cross-origin parent)', () => {
    const w = { self: {} } as Record<string, unknown>;
    Object.defineProperty(w, 'top', {
      get() {
        throw new Error('cross-origin');
      },
    });
    vi.stubGlobal('window', w);
    expect(isEmbedded()).toBe(true);
  });
});

describe('postToLauncher', () => {
  const original = process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS;
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS = original;
  });

  it('is a no-op when not embedded', () => {
    const postMessage = vi.fn();
    const w = {} as Record<string, unknown>;
    w.self = w;
    w.top = w;
    w.parent = { postMessage };
    vi.stubGlobal('window', w);

    postToLauncher({ type: 'ready' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts once per allowlisted origin with an explicit targetOrigin (never "*")', () => {
    process.env.NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS =
      'https://brain.starcapital.co.id https://brain-stg.starcapital.co.id';
    const postMessage = vi.fn();
    const parent = { postMessage };
    const w = { self: {}, top: {}, parent } as Record<string, unknown>;
    vi.stubGlobal('window', w);

    postToLauncher({ type: 'auth-expired' });

    expect(postMessage).toHaveBeenCalledTimes(2);
    const targetOrigins = postMessage.mock.calls.map((c) => c[1]);
    expect(targetOrigins).toEqual([
      'https://brain.starcapital.co.id',
      'https://brain-stg.starcapital.co.id',
    ]);
    expect(targetOrigins).not.toContain('*');
    // Payload is tagged with the neutral portal source the launcher expects.
    expect(postMessage.mock.calls[0][0]).toEqual({
      source: 'brain-portal',
      type: 'auth-expired',
    });
  });
});

describe('isLauncherMessage', () => {
  it('accepts a well-formed launcher message', () => {
    expect(isLauncherMessage({ source: 'brain-portal', type: 'logout' })).toBe(true);
  });

  it('rejects the wrong source, missing type, and non-objects', () => {
    expect(isLauncherMessage({ source: 'mna-brain', type: 'ready' })).toBe(false);
    expect(isLauncherMessage({ source: 'brain-portal' })).toBe(false);
    expect(isLauncherMessage(null)).toBe(false);
    expect(isLauncherMessage('logout')).toBe(false);
  });
});
