import { describe, it, expect } from 'vitest';
import { RedisNotConfiguredError, readCaPem, redisConfigured, redisOptionsFromEnv } from './redis';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBabc\nDEF\n-----END CERTIFICATE-----';

describe('readCaPem', () => {
  it('accepts the PEM itself, trimmed', () => {
    expect(readCaPem(`\n${PEM}\n`)).toBe(PEM);
  });

  it('accepts a PEM whose newlines arrived as literal backslash-n', () => {
    expect(readCaPem(PEM.replace(/\n/g, '\\n'))).toBe(PEM);
  });

  it('accepts the PEM base64-encoded on one line, as a dashboard keeps it intact', () => {
    expect(readCaPem(Buffer.from(`${PEM}\n`).toString('base64'))).toBe(PEM);
  });

  it('returns nothing for an unset or blank value, and passes anything else through untouched', () => {
    expect(readCaPem(undefined)).toBeUndefined();
    expect(readCaPem('  ')).toBeUndefined();
    expect(readCaPem('not a certificate')).toBe('not a certificate');
  });
});

describe('redisOptionsFromEnv', () => {
  it('throws a clear error when REDIS_URL is unset', () => {
    expect(() => redisOptionsFromEnv({})).toThrow(RedisNotConfiguredError);
    expect(() => redisOptionsFromEnv({})).toThrow(/REDIS_URL is not set/);
  });

  it('negotiates TLS for rediss:// and pins the CA when one is given', () => {
    const { url, options } = redisOptionsFromEnv({
      REDIS_URL: 'rediss://default:pw@203.0.113.7:6379',
      REDIS_CA_PEM: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n',
    });

    expect(url).toBe('rediss://default:pw@203.0.113.7:6379');
    expect(options.tls).toEqual({ ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' });
    // Live state is best-effort: a command fails fast rather than hanging a turn.
    expect(options.maxRetriesPerRequest).toBe(2);
    expect(options.lazyConnect).toBe(true);
  });

  it('pins a base64-encoded CA the same as the PEM', () => {
    const { options } = redisOptionsFromEnv({
      REDIS_URL: 'rediss://default:pw@203.0.113.7:6379',
      REDIS_CA_PEM: Buffer.from(PEM).toString('base64'),
    });
    expect(options.tls).toEqual({ ca: PEM });
  });

  it('uses TLS without a pinned CA when only rediss:// is set, and none for redis://', () => {
    expect(redisOptionsFromEnv({ REDIS_URL: 'rediss://h:6379' }).options.tls).toEqual({});
    expect(redisOptionsFromEnv({ REDIS_URL: 'redis://localhost:6379' }).options.tls).toBeUndefined();
  });
});

describe('redisConfigured', () => {
  it('reflects REDIS_URL', () => {
    const before = process.env.REDIS_URL;
    try {
      delete process.env.REDIS_URL;
      expect(redisConfigured()).toBe(false);
      process.env.REDIS_URL = 'redis://localhost:6379';
      expect(redisConfigured()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = before;
    }
  });
});
