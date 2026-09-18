import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_HEADERS,
  INGEST_PATH_PREFIX,
  isIngestPath,
  posthogUpstreams,
  stripCredentialHeaders,
} from './posthog-proxy';

describe('posthogUpstreams', () => {
  it('pairs a US cloud host with its sibling assets host', () => {
    expect(posthogUpstreams('https://us.i.posthog.com')).toEqual({
      apiHost: 'https://us.i.posthog.com',
      assetHost: 'https://us-assets.i.posthog.com',
    });
  });

  it('pairs an EU cloud host with its sibling assets host', () => {
    expect(posthogUpstreams('https://eu.i.posthog.com')).toEqual({
      apiHost: 'https://eu.i.posthog.com',
      assetHost: 'https://eu-assets.i.posthog.com',
    });
  });

  it('serves both upstreams from the same host for a self-hosted instance', () => {
    expect(posthogUpstreams('https://posthog.internal.example.com')).toEqual({
      apiHost: 'https://posthog.internal.example.com',
      assetHost: 'https://posthog.internal.example.com',
    });
  });

  it('strips a trailing slash so the rewrite cannot produce a double slash', () => {
    expect(posthogUpstreams('https://us.i.posthog.com/')).toEqual({
      apiHost: 'https://us.i.posthog.com',
      assetHost: 'https://us-assets.i.posthog.com',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(posthogUpstreams('  https://eu.i.posthog.com  ')?.apiHost).toBe(
      'https://eu.i.posthog.com',
    );
  });

  it('returns null for the .env.example placeholder', () => {
    expect(posthogUpstreams('posthog_host')).toBeNull();
  });

  it('returns null when unset or blank', () => {
    expect(posthogUpstreams(undefined)).toBeNull();
    expect(posthogUpstreams('')).toBeNull();
    expect(posthogUpstreams('   ')).toBeNull();
  });

  it('returns null for a host that is nothing but slashes', () => {
    expect(posthogUpstreams('///')).toBeNull();
  });

  it('does not treat a lookalike host as a cloud region', () => {
    // `i.posthog.com.evil.test` must not be rewritten to an `-assets` sibling.
    expect(posthogUpstreams('https://us.i.posthog.com.evil.test')?.assetHost).toBe(
      'https://us.i.posthog.com.evil.test',
    );
  });
});

describe('isIngestPath', () => {
  it('matches the prefix itself and any subpath', () => {
    expect(isIngestPath(INGEST_PATH_PREFIX)).toBe(true);
    expect(isIngestPath('/ingest/e/')).toBe(true);
    expect(isIngestPath('/ingest/static/recorder.js')).toBe(true);
    expect(isIngestPath('/ingest/flags/')).toBe(true);
  });

  it('does not match a path that merely shares the prefix', () => {
    expect(isIngestPath('/ingestion')).toBe(false);
    expect(isIngestPath('/api/ingest')).toBe(false);
  });

  it('does not match unrelated paths', () => {
    expect(isIngestPath('/w/acme/pipeline')).toBe(false);
  });
});

describe('stripCredentialHeaders', () => {
  it('removes every credential header', () => {
    const headers = new Headers({
      cookie: 'authjs.session-token=secret',
      authorization: 'Bearer token',
      'x-api-secret': 'admin-secret',
    });

    stripCredentialHeaders(headers);

    for (const header of CREDENTIAL_HEADERS) {
      expect(headers.get(header)).toBeNull();
    }
  });

  it('leaves headers PostHog actually needs alone', () => {
    const headers = new Headers({
      cookie: 'authjs.session-token=secret',
      'content-type': 'text/plain',
      'user-agent': 'Mozilla/5.0',
    });

    stripCredentialHeaders(headers);

    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.get('user-agent')).toBe('Mozilla/5.0');
  });

  it('is a no-op when no credential headers are present', () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    expect(() => stripCredentialHeaders(headers)).not.toThrow();
    expect(headers.get('content-type')).toBe('text/plain');
  });
});
