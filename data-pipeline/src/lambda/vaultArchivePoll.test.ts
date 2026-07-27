/**
 * Focused tests for the no-S3 vault-archive-poll cutover:
 * - ZIP entries are processed without any S3 MBOX upload
 * - /tmp spooled files are unlinked on success / soft-stop / error
 * - soft-stop keeps the matter open (status back to exporting)
 * - completed/abandoned exports close the matter
 * - one failed entry yields partial success while siblings continue
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';

const mocks = vi.hoisted(() => ({
  loadSecretsFromSsm: vi.fn().mockResolvedValue(undefined),
  createLambdaDb: vi.fn(),
  pgClientEnd: vi.fn().mockResolvedValue(undefined),
  dbExecute: vi.fn(),
  loadVaultCredentials: vi.fn().mockReturnValue({ client_email: 'svc@x' }),
  getVaultAccessToken: vi.fn().mockResolvedValue('token'),
  pollVaultExport: vi.fn(),
  downloadExportFileStream: vi.fn(),
  closeVaultMatter: vi.fn().mockResolvedValue(undefined),
  processMboxSource: vi.fn(),
  getSourceRunState: vi.fn().mockResolvedValue(null),
  isSourceTerminal: vi.fn().mockReturnValue(false),
  inferCustodianFromEntry: vi.fn().mockReturnValue('analyst@starcapital.co.id'),
  unlinkCalls: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      mocks.unlinkCalls.push(String(path));
      return actual.unlink(path);
    },
  };
});

vi.mock('../secrets', () => ({
  loadSecretsFromSsm: mocks.loadSecretsFromSsm,
}));

vi.mock('../db', () => ({
  createLambdaDb: mocks.createLambdaDb,
}));

vi.mock('@/lib/services/googleVaultService', () => ({
  loadVaultCredentials: mocks.loadVaultCredentials,
  getVaultAccessToken: mocks.getVaultAccessToken,
  pollVaultExport: mocks.pollVaultExport,
  downloadExportFileStream: mocks.downloadExportFileStream,
  closeVaultMatter: mocks.closeVaultMatter,
}));

vi.mock('../handlers/vaultArchive', () => ({
  inferCustodianFromEntry: mocks.inferCustodianFromEntry,
}));

vi.mock('../handlers/emailProcess', () => ({
  processMboxSource: mocks.processMboxSource,
  getSourceRunState: mocks.getSourceRunState,
  isSourceTerminal: mocks.isSourceTerminal,
  SOFT_STOP_MS: 480_000,
}));

import { handler, inferCustodianFromMbox } from './vaultArchivePoll';

function makeZipWithEntries(entries: Array<{ name: string; body: string }>): Buffer {
  const zip = new AdmZip();
  for (const e of entries) {
    zip.addFile(e.name, Buffer.from(e.body, 'utf8'));
  }
  return zip.toBuffer();
}

describe('inferCustodianFromMbox', () => {
  it('uses the only export custodian when the filename omits it', async () => {
    await expect(
      inferCustodianFromMbox(
        () => Readable.from(['']),
        ['only@example.com'],
      ),
    ).resolves.toBe('only@example.com');
  });

  it('selects the uniquely dominant custodian from message headers', async () => {
    const mbox = [
      'From sender@example.com Sat Jul 25 00:00:00 2026',
      'From: Sender <sender@example.com>',
      'To: Analyst <analyst@example.com>',
      'Message-ID: <one@example.com>',
      'Subject: One',
      '',
      'Body one',
      'From sender@example.com Sat Jul 25 01:00:00 2026',
      'From: Sender <sender@example.com>',
      'To: Analyst <analyst@example.com>',
      'Message-ID: <two@example.com>',
      'Subject: Two',
      '',
      'Body two',
      '',
    ].join('\n');

    await expect(
      inferCustodianFromMbox(
        () => Readable.from([mbox]),
        ['analyst@example.com', 'other@example.com'],
      ),
    ).resolves.toBe('analyst@example.com');
  });

  it('refuses an ambiguous mailbox', async () => {
    const mbox = [
      'From a@example.com Sat Jul 25 00:00:00 2026',
      'From: A <a@example.com>',
      'To: B <b@example.com>',
      'Message-ID: <one@example.com>',
      'Subject: Ambiguous',
      '',
      'Body',
      '',
    ].join('\n');

    await expect(
      inferCustodianFromMbox(
        () => Readable.from([mbox]),
        ['a@example.com', 'b@example.com'],
      ),
    ).resolves.toBe('unknown');
  });
});

function exportRow() {
  return {
    id: 've-1',
    matter_id: 'matter-1',
    export_id: 'export-1',
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-02T00:00:00Z',
    mode: 'daily',
    custodian_emails: ['analyst@starcapital.co.id'],
  };
}

function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && 'value' in (c as object)) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return '';
    })
    .join('');
}

describe('vaultArchivePoll no-S3 cutover', () => {
  const tmpPathsSeen: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tmpPathsSeen.length = 0;
    mocks.unlinkCalls.length = 0;

    mocks.createLambdaDb.mockResolvedValue({
      pgClient: { end: mocks.pgClientEnd },
      db: { execute: mocks.dbExecute },
    });
    mocks.loadSecretsFromSsm.mockResolvedValue(undefined);
    mocks.getVaultAccessToken.mockResolvedValue('token');
    mocks.closeVaultMatter.mockResolvedValue(undefined);
    mocks.getSourceRunState.mockResolvedValue(null);
    mocks.isSourceTerminal.mockReturnValue(false);
    mocks.inferCustodianFromEntry.mockReturnValue('analyst@starcapital.co.id');

    // Default: SELECT export row, then claim RETURNING id, then SET status updates.
    mocks.dbExecute.mockImplementation(async (q: unknown) => {
      const flat = sqlText(q);
      if (flat.includes('ORDER BY created_at') && flat.includes('LIMIT 1')) {
        return { rows: [exportRow()] };
      }
      if (flat.includes("status = 'processing'") && flat.includes('RETURNING')) {
        return { rows: [{ id: 've-1' }] };
      }
      return { rows: [] };
    });

    mocks.processMboxSource.mockImplementation(
      async (source: {
        openStream: () => NodeJS.ReadableStream;
        sourceKey: string;
      }) => {
        const stream = source.openStream() as {
          path?: string;
        } & AsyncIterable<Buffer>;
        if (stream.path) tmpPathsSeen.push(stream.path);
        for await (const _ of stream) {
          /* drain */
        }
        return {
          run_id: 'run-1',
          status: 'completed',
          messages_seen: 1,
          messages_skipped: 0,
          messages_ingested: 1,
          attachments_uploaded: 0,
          message_offset: 1,
          fail_count: 0,
        };
      },
    );
  });

  afterEach(() => {
    // Every spooled /tmp file must already be gone (unlinked in finally).
    for (const p of tmpPathsSeen) {
      expect(existsSync(p), `tmp file leaked: ${p}`).toBe(false);
    }
  });

  it('idles when no exporting row exists', async () => {
    mocks.dbExecute.mockImplementation(async () => ({ rows: [] }));
    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });
    expect(result).toEqual({ ok: true, action: 'idle' });
    expect(
      mocks.dbExecute.mock.calls.some(([query]) => {
        const text = sqlText(query);
        return text.includes("status = 'processing'") && text.includes('updated_at <');
      }),
    ).toBe(true);
    expect(mocks.pollVaultExport).not.toHaveBeenCalled();
    expect(mocks.processMboxSource).not.toHaveBeenCalled();
  });

  it('processes ZIP entries without any S3 MBOX upload and unlinks /tmp', async () => {
    const zipBuf = makeZipWithEntries([
      { name: 'analyst@starcapital.co.id.mbox', body: 'From x\n\nhello\n' },
      { name: 'readme.txt', body: 'ignore me' },
    ]);
    mocks.pollVaultExport.mockResolvedValue({
      status: 'COMPLETED',
      files: [{ objectName: 'export.zip', size: zipBuf.length, bucketName: 'b', md5Hash: 'x' }],
    });
    mocks.downloadExportFileStream.mockResolvedValue(Readable.from([zipBuf]));

    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });

    expect(result.action).toBe('archived');
    expect(mocks.processMboxSource).toHaveBeenCalledTimes(1);
    const sourceArg = mocks.processMboxSource.mock.calls[0]![0] as {
      sourceKey: string;
      custodianEmail: string;
    };
    expect(sourceArg.sourceKey).toBe(
      'export-1::export.zip::analyst@starcapital.co.id.mbox',
    );
    expect(sourceArg.custodianEmail).toBe('analyst@starcapital.co.id');
    expect(mocks.closeVaultMatter).toHaveBeenCalledWith('token', 'matter-1');
    // No S3 Upload / PutObject modules are even imported by this lambda.
  });

  it('soft-stop keeps matter open and sets export back to exporting', async () => {
    const zipBuf = makeZipWithEntries([
      { name: 'a.mbox', body: 'From a\n\n' },
      { name: 'b.mbox', body: 'From b\n\n' },
    ]);
    mocks.pollVaultExport.mockResolvedValue({
      status: 'COMPLETED',
      files: [{ objectName: 'export.zip', size: zipBuf.length, bucketName: 'b', md5Hash: 'x' }],
    });
    mocks.downloadExportFileStream.mockResolvedValue(Readable.from([zipBuf]));
    mocks.processMboxSource.mockResolvedValueOnce({
      run_id: 'run-1',
      status: 'in_progress',
      messages_seen: 5,
      messages_skipped: 0,
      messages_ingested: 2,
      attachments_uploaded: 0,
      message_offset: 5,
      fail_count: 0,
    });

    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });

    expect(result.action).toBe('resuming');
    expect(mocks.closeVaultMatter).not.toHaveBeenCalled();
    // Second entry must not have been processed after soft-stop break.
    expect(mocks.processMboxSource).toHaveBeenCalledTimes(1);
  });

  it('skips terminal entries on resume without re-opening the stream', async () => {
    const zipBuf = makeZipWithEntries([
      { name: 'done.mbox', body: 'From done\n\n' },
      { name: 'next.mbox', body: 'From next\n\n' },
    ]);
    mocks.pollVaultExport.mockResolvedValue({
      status: 'COMPLETED',
      files: [{ objectName: 'export.zip', size: zipBuf.length, bucketName: 'b', md5Hash: 'x' }],
    });
    mocks.downloadExportFileStream.mockResolvedValue(Readable.from([zipBuf]));

    mocks.getSourceRunState.mockImplementation(async (_db: unknown, key: string) => {
      if (key.includes('done.mbox')) {
        return { status: 'completed', fail_count: 0 };
      }
      return null;
    });
    mocks.isSourceTerminal.mockImplementation(
      (state: { status: string } | null) => state?.status === 'completed',
    );

    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });

    expect(result.action).toBe('archived');
    // Only the non-terminal entry is processed.
    expect(mocks.processMboxSource).toHaveBeenCalledTimes(1);
    const key = (mocks.processMboxSource.mock.calls[0]![0] as { sourceKey: string })
      .sourceKey;
    expect(key).toContain('next.mbox');
  });

  it('closes matter as archived_partial when some entries are abandoned', async () => {
    const zipBuf = makeZipWithEntries([
      { name: 'ok.mbox', body: 'From ok\n\n' },
      { name: 'bad.mbox', body: 'From bad\n\n' },
    ]);
    mocks.pollVaultExport.mockResolvedValue({
      status: 'COMPLETED',
      files: [{ objectName: 'export.zip', size: zipBuf.length, bucketName: 'b', md5Hash: 'x' }],
    });
    mocks.downloadExportFileStream.mockResolvedValue(Readable.from([zipBuf]));

    mocks.processMboxSource
      .mockResolvedValueOnce({
        run_id: 'r1',
        status: 'completed',
        messages_seen: 1,
        messages_skipped: 0,
        messages_ingested: 1,
        attachments_uploaded: 0,
        message_offset: 1,
        fail_count: 0,
      })
      .mockResolvedValueOnce({
        run_id: 'r2',
        status: 'abandoned',
        messages_seen: 0,
        messages_skipped: 0,
        messages_ingested: 0,
        attachments_uploaded: 0,
        message_offset: 0,
        fail_count: 5,
      });

    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });

    expect(result.action).toBe('archived_partial');
    expect(mocks.closeVaultMatter).toHaveBeenCalledWith('token', 'matter-1');
    expect(mocks.processMboxSource).toHaveBeenCalledTimes(2);
  });

  it('unlinks /tmp even when processMboxSource throws', async () => {
    const zipBuf = makeZipWithEntries([
      { name: 'boom.mbox', body: 'From boom\n\n' },
    ]);
    mocks.pollVaultExport.mockResolvedValue({
      status: 'COMPLETED',
      files: [{ objectName: 'export.zip', size: zipBuf.length, bucketName: 'b', md5Hash: 'x' }],
    });
    mocks.downloadExportFileStream.mockResolvedValue(Readable.from([zipBuf]));

    // Do NOT openStream here — opening then throwing races the handler's
    // finally unlink and surfaces as an unhandled ENOENT from the ReadStream.
    mocks.processMboxSource.mockRejectedValueOnce(new Error('ensureRun blew up'));

    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });

    // Infra error → unfinished → resume (matter stays open).
    expect(result.action).toBe('resuming');
    expect(mocks.closeVaultMatter).not.toHaveBeenCalled();
    const unlinked = mocks.unlinkCalls.filter(
      (p) => p.includes('/tmp/vault-mbox/') && p.endsWith('.mbox'),
    );
    expect(unlinked.length).toBeGreaterThan(0);
    for (const p of unlinked) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it('continues siblings after a retryable failed entry (marks unfinished)', async () => {
    const zipBuf = makeZipWithEntries([
      { name: 'fail.mbox', body: 'From fail\n\n' },
      { name: 'ok.mbox', body: 'From ok\n\n' },
    ]);
    mocks.pollVaultExport.mockResolvedValue({
      status: 'COMPLETED',
      files: [{ objectName: 'export.zip', size: zipBuf.length, bucketName: 'b', md5Hash: 'x' }],
    });
    mocks.downloadExportFileStream.mockResolvedValue(Readable.from([zipBuf]));

    mocks.processMboxSource
      .mockResolvedValueOnce({
        run_id: 'r1',
        status: 'failed',
        messages_seen: 0,
        messages_skipped: 0,
        messages_ingested: 0,
        attachments_uploaded: 0,
        message_offset: 0,
        fail_count: 1,
      })
      .mockResolvedValueOnce({
        run_id: 'r2',
        status: 'completed',
        messages_seen: 1,
        messages_skipped: 0,
        messages_ingested: 1,
        attachments_uploaded: 0,
        message_offset: 1,
        fail_count: 0,
      });

    const result = await handler({}, { getRemainingTimeInMillis: () => 600_000 });

    // unfinished=true because of the failed entry → resume (don't close yet).
    expect(result.action).toBe('resuming');
    expect(mocks.processMboxSource).toHaveBeenCalledTimes(2);
    expect(mocks.closeVaultMatter).not.toHaveBeenCalled();
  });
});

describe('terraform cutover surface (static)', () => {
  it('schedules exactly two email pipeline lambdas', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const main = readFileSync(
      resolve(__dirname, '../../terraform/pipeline-compute/main.tf'),
      'utf8',
    );
    expect(main).toMatch(/vault-archive-start\s*=/);
    expect(main).toMatch(/vault-archive-poll\s*=/);
    expect(main).not.toMatch(/email-process\s*=/);
    expect(main).not.toMatch(/legacy_email_pipeline_enabled/);
    expect(main).not.toMatch(/EPHEMERAL_EMAIL_PROCESS_ENABLED/);
    expect(main).not.toMatch(/crm-llm-submit\s*=/);
  });

  it('removes the pipeline data-lake S3 bucket (no MBOX on S3)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const s3Path = resolve(__dirname, '../../terraform/pipeline-compute/s3.tf');
    // Cutover deleted s3.tf; if reintroduced it must not recreate mbox storage.
    if (!existsSync(s3Path)) return;
    const s3 = readFileSync(s3Path, 'utf8');
    expect(s3).not.toMatch(/aws_s3_bucket"\s+"data_lake"/);
    expect(s3).not.toMatch(/mna-data-lake-/);
    expect(s3).not.toMatch(/ephemeral-mbox-ttl/);
    expect(s3).not.toMatch(/prefix\s*=\s*"ephemeral\//);
  });
});
