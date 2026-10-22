/**
 * The app's Redis: live, expiring state and pub/sub fan-out for the Copilot
 * bots (which bot is thinking, Stop signals, "a reply landed" pushes to the
 * browsers' SSE streams). Nothing durable lives here — bots, history,
 * checkpoints and routines are in Postgres, and so is the turn lock.
 *
 * Required infrastructure: provisioned by `terraform/redis` (a TLS-only
 * redis:7 on EC2). `REDIS_URL` is `rediss://default:<password>@<host>:6379`
 * and `REDIS_CA_PEM` is the private CA the server certificate chains to;
 * locally `pnpm docker:run-redis` and `REDIS_URL=redis://localhost:6379`.
 *
 * Two kinds of connection:
 *   - `getRedis()`: one command client per process, cached on `globalThis`
 *     like the pg pool in `./db`, lazily connected.
 *   - `createRedisSubscriber()`: a fresh connection for SUBSCRIBE, which
 *     takes the connection over; the caller owns it and must `quit()`.
 */
import Redis, { type RedisOptions } from 'ioredis';

export class RedisNotConfiguredError extends Error {
  constructor() {
    super(
      'REDIS_URL is not set. The app needs Redis for the bots’ live state (see terraform/redis; ' +
        'locally: pnpm docker:run-redis and REDIS_URL=redis://localhost:6379).',
    );
    this.name = 'RedisNotConfiguredError';
  }
}

const globalForRedis = globalThis as unknown as { __mnaRedis?: Redis };

/** Whether `REDIS_URL` is set; the one place that decides. */
export function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

const PEM_HEADER = '-----BEGIN CERTIFICATE-----';

/**
 * `REDIS_CA_PEM` as the env may carry it. A multiline PEM pasted into a
 * hosting dashboard does not always arrive intact (Vercel previews lost the
 * newlines), so three shapes are accepted and all yield the PEM text:
 *   - the PEM itself;
 *   - the PEM with its newlines escaped as the two characters `\n`;
 *   - the PEM base64-encoded as one line (`base64 -w0 ca.pem`; the Terraform
 *     output `redis_ca_pem_base64`), which survives any dashboard.
 * Returns undefined when unset or blank. Exported for its tests.
 */
export function readCaPem(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.includes(PEM_HEADER)) return value.replace(/\\n/g, '\n');
  const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
  if (decoded.includes(PEM_HEADER)) return decoded;
  // Neither shape: hand it over as given, so the TLS error names the real
  // problem instead of this silently dropping the pin.
  return value;
}

/**
 * Connection options from the env. Pulled out so a test can assert them
 * without opening a socket.
 */
export function redisOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): { url: string; options: RedisOptions } {
  const url = env.REDIS_URL;
  if (!url) throw new RedisNotConfiguredError();
  const ca = readCaPem(env.REDIS_CA_PEM);
  const options: RedisOptions = {
    lazyConnect: true,
    // A command that cannot reach Redis fails fast: live state is best-effort
    // and a turn must never hang on it.
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    enableOfflineQueue: true,
  };
  if (url.startsWith('rediss://')) {
    // `tls` must be set for ioredis to negotiate TLS; the CA is pinned when
    // given (the EC2 box presents a certificate from our own CA).
    options.tls = ca ? { ca } : {};
  }
  return { url, options };
}

/** The process-wide command client. Throws `RedisNotConfiguredError` without `REDIS_URL`. */
export function getRedis(): Redis {
  if (globalForRedis.__mnaRedis) return globalForRedis.__mnaRedis;
  const { url, options } = redisOptionsFromEnv();
  const client = new Redis(url, options);
  client.on('error', (err: Error) => {
    console.error('[redis] client error:', err.message);
  });
  globalForRedis.__mnaRedis = client;
  return client;
}

/** A dedicated connection for SUBSCRIBE. The caller must `quit()` it. */
export function createRedisSubscriber(): Redis {
  const { url, options } = redisOptionsFromEnv();
  const client = new Redis(url, options);
  client.on('error', (err: Error) => {
    console.error('[redis] subscriber error:', err.message);
  });
  return client;
}
