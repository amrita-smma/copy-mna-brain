import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { sendMock, ctorConfigs, presignMock } = vi.hoisted(() => ({
  sendMock: vi.fn().mockResolvedValue({}),
  ctorConfigs: [] as unknown[],
  presignMock: vi.fn().mockResolvedValue('https://signed.example/url'),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(public input: unknown) {}
  }
  return {
    S3Client: class {
      send = sendMock;
      constructor(config: unknown) {
        ctorConfigs.push(config);
      }
    },
    PutObjectCommand: Command,
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
    CopyObjectCommand: Command,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: presignMock }));

import { buildContentDisposition, getSignedUrl, getUploadSignedUrl, uploadFile } from './s3';

const ENV_KEYS = [
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_S3_BUCKET',
  'AWS_S3_ENDPOINT',
  'AWS_S3_PUBLIC_ENDPOINT',
  'AWS_S3_FORCE_PATH_STYLE',
] as const;

/** Snapshot + restore so this file's env manipulation can't leak to other test files. */
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  sendMock.mockClear();
  presignMock.mockClear();
  ctorConfigs.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('buildContentDisposition', () => {
  it('emits both ASCII fallback and RFC 5987 form for plain ASCII names', () => {
    const header = buildContentDisposition('report.pdf');
    expect(header).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('replaces non-ASCII chars in the ASCII fallback while preserving them in filename*', () => {
    const header = buildContentDisposition('文件.pdf');
    expect(header).toBe(
      `attachment; filename="__.pdf"; filename*=UTF-8''%E6%96%87%E4%BB%B6.pdf`,
    );
  });

  it('handles Korean filenames', () => {
    const header = buildContentDisposition('파일.pdf');
    expect(header).toBe(
      `attachment; filename="__.pdf"; filename*=UTF-8''%ED%8C%8C%EC%9D%BC.pdf`,
    );
  });

  it('preserves ASCII chars when mixed with non-ASCII', () => {
    const header = buildContentDisposition('quarterly_报告_q1.pdf');
    expect(header).toBe(
      `attachment; filename="quarterly____q1.pdf"; filename*=UTF-8''quarterly_%E6%8A%A5%E5%91%8A_q1.pdf`,
    );
  });

  it('escapes double quotes and backslashes in the ASCII fallback', () => {
    const header = buildContentDisposition('weird"name\\.pdf');
    expect(header).toBe(
      `attachment; filename="weird_name_.pdf"; filename*=UTF-8''weird%22name%5C.pdf`,
    );
  });

  it('encodes spaces in the RFC 5987 form', () => {
    const header = buildContentDisposition('my report.pdf');
    expect(header).toBe(
      `attachment; filename="my report.pdf"; filename*=UTF-8''my%20report.pdf`,
    );
  });
});

describe('uploadFile (env read timing)', () => {
  it('picks up AWS_S3_ENDPOINT/credentials/bucket set after this module was imported', async () => {
    // Simulates scripts/seed.ts, where dotenv's config() runs after s3.ts was
    // already evaluated: env captured at import time would silently point the
    // client at real AWS instead of the local S3 server.
    Object.assign(process.env, {
      AWS_ACCESS_KEY_ID: 'minioadmin',
      AWS_SECRET_ACCESS_KEY: 'minioadmin',
      AWS_S3_ENDPOINT: 'http://localhost:9000',
      AWS_S3_BUCKET: 'custom-bucket',
      AWS_S3_FORCE_PATH_STYLE: 'true',
    });

    await uploadFile(Buffer.from('hello'), 'some/key.txt', 'text/plain');

    expect(ctorConfigs).toEqual([
      expect.objectContaining({
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
        credentials: expect.objectContaining({ accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }),
      }),
    ]);
    // With no bucket argument, the bucket comes from AWS_S3_BUCKET.
    const [[command]] = sendMock.mock.calls as [[{ input: { Bucket: string } }]];
    expect(command.input.Bucket).toBe('custom-bucket');
  });

  it('throws when an endpoint is configured without explicit credentials', async () => {
    process.env.AWS_S3_ENDPOINT = 'http://localhost:9000';

    await expect(uploadFile(Buffer.from('hello'), 'some/key.txt', 'text/plain')).rejects.toThrow(
      'AWS credentials not configured',
    );
  });
});

describe('presigned URL client', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      AWS_ACCESS_KEY_ID: 'minioadmin',
      AWS_SECRET_ACCESS_KEY: 'minioadmin',
      AWS_S3_ENDPOINT: 'http://s3:9000',
      AWS_S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    });
  });

  it('signs upload URLs without a flexible checksum so a real body does not fail an empty-body CRC', async () => {
    await getUploadSignedUrl('some/key.pdf', 'application/pdf');

    expect(ctorConfigs).toEqual([
      expect.objectContaining({ endpoint: 'http://localhost:9000', requestChecksumCalculation: 'WHEN_REQUIRED' }),
    ]);
  });

  it('signs download URLs with the same presigner settings', async () => {
    await getSignedUrl('some/key.pdf');

    expect(ctorConfigs).toEqual([
      expect.objectContaining({ endpoint: 'http://localhost:9000', requestChecksumCalculation: 'WHEN_REQUIRED' }),
    ]);
  });

  it('leaves checksum defaults alone on the server-side client', async () => {
    await uploadFile(Buffer.from('hello'), 'some/key.txt', 'text/plain');

    expect(ctorConfigs).toHaveLength(1);
    expect(ctorConfigs[0]).not.toHaveProperty('requestChecksumCalculation');
    expect(ctorConfigs[0]).toEqual(expect.objectContaining({ endpoint: 'http://s3:9000' }));
  });
});
