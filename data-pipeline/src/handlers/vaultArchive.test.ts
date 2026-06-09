import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  monthWindow,
  dayWindow,
  inferCustodianFromEntry,
  runVaultArchive,
  parseFloor,
  parseFloorDay,
  previousMonth,
  previousDay,
  monthsBetween,
  daysBetween,
  ymdLessThanOrEqual,
} from './vaultArchive';

// --- mocks: must be hoisted because they're referenced inside vi.mock() ---
const mocks = vi.hoisted(() => ({
  loadVaultCredentials: vi.fn(() => ({
    client_email: 'svc@proj.iam.gserviceaccount.com',
    private_key: '-----PEM-----',
    project_id: 'proj',
  })),
  getVaultAccessToken: vi.fn().mockResolvedValue('token-xyz'),
  createVaultMatter: vi.fn().mockResolvedValue('matter-1'),
  createVaultExport: vi.fn().mockResolvedValue('export-1'),
  pollVaultExport: vi.fn(),
  downloadExportFile: vi.fn(),
  closeVaultMatter: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue('uploaded'),
  insertSpy: vi.fn().mockResolvedValue({ id: 'mb-1' }),
}));

vi.mock('@/lib/services/googleVaultService', () => ({
  loadVaultCredentials: mocks.loadVaultCredentials,
  getVaultAccessToken: mocks.getVaultAccessToken,
  createVaultMatter: mocks.createVaultMatter,
  createVaultExport: mocks.createVaultExport,
  pollVaultExport: mocks.pollVaultExport,
  downloadExportFile: mocks.downloadExportFile,
  closeVaultMatter: mocks.closeVaultMatter,
  VAULT_CUSTODIAN_EMAILS: [
    'hendric.g@starcapital.co.id',
    'dessi.sari@aldiracita.com',
  ],
}));

vi.mock('@/lib/s3', () => ({
  uploadFile: mocks.uploadFile,
  S3_MBOX_BUCKET: 'mbox-archive',
}));

vi.mock('@/lib/repositories', () => ({}));

vi.mock('../repositories', () => ({
  MboxFileRepository: class {
    insert = mocks.insertSpy;
  },
}));

describe('monthWindow', () => {
  it('returns [first-of-month, first-of-next-month) in UTC', () => {
    const { start, end } = monthWindow(2026, 3);
    expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('handles December → next year January', () => {
    const { start, end } = monthWindow(2025, 12);
    expect(start.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('dayWindow', () => {
  it('returns [day 00:00, next-day 00:00) in UTC', () => {
    const { start, end } = dayWindow(2026, 3, 15);
    expect(start.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('rolls over month end', () => {
    const { start, end } = dayWindow(2026, 1, 31);
    expect(start.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('rolls over year end (Dec 31 → Jan 1)', () => {
    const { end } = dayWindow(2025, 12, 31);
    expect(end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('parseFloorDay', () => {
  it('parses YYYY-MM-DD', () => {
    expect(parseFloorDay('2026-01-01')).toEqual({ year: 2026, month: 1, day: 1 });
    expect(parseFloorDay('2026-1-5')).toEqual({ year: 2026, month: 1, day: 5 });
  });

  it('throws on a malformed floor string', () => {
    expect(() => parseFloorDay('2026-01')).toThrow();
    expect(() => parseFloorDay('2026/01/01')).toThrow();
  });

  it('throws on an impossible calendar date', () => {
    expect(() => parseFloorDay('2026-02-30')).toThrow();
    expect(() => parseFloorDay('2026-13-01')).toThrow();
  });
});

describe('previousDay', () => {
  it('decrements within a month', () => {
    expect(previousDay({ year: 2026, month: 3, day: 15 })).toEqual({ year: 2026, month: 3, day: 14 });
  });

  it('wraps to the previous month', () => {
    expect(previousDay({ year: 2026, month: 3, day: 1 })).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it('wraps across the year boundary', () => {
    expect(previousDay({ year: 2026, month: 1, day: 1 })).toEqual({ year: 2025, month: 12, day: 31 });
  });
});

describe('ymdLessThanOrEqual', () => {
  it('orders by year, then month, then day', () => {
    expect(ymdLessThanOrEqual({ year: 2026, month: 1, day: 5 }, { year: 2026, month: 1, day: 5 })).toBe(true);
    expect(ymdLessThanOrEqual({ year: 2026, month: 1, day: 5 }, { year: 2026, month: 1, day: 4 })).toBe(false);
    expect(ymdLessThanOrEqual({ year: 2025, month: 12, day: 31 }, { year: 2026, month: 1, day: 1 })).toBe(true);
  });
});

describe('daysBetween', () => {
  it('returns empty when floor is strictly after ceiling', () => {
    expect(daysBetween({ year: 2026, month: 3, day: 5 }, { year: 2026, month: 3, day: 4 })).toEqual([]);
  });

  it('returns a single day when floor === ceiling', () => {
    expect(daysBetween({ year: 2026, month: 3, day: 3 }, { year: 2026, month: 3, day: 3 })).toEqual([
      { year: 2026, month: 3, day: 3 },
    ]);
  });

  it('walks oldest-to-newest across a month boundary', () => {
    expect(daysBetween({ year: 2026, month: 2, day: 27 }, { year: 2026, month: 3, day: 2 })).toEqual([
      { year: 2026, month: 2, day: 27 },
      { year: 2026, month: 2, day: 28 },
      { year: 2026, month: 3, day: 1 },
      { year: 2026, month: 3, day: 2 },
    ]);
  });
});

describe('inferCustodianFromEntry', () => {
  it('matches a custodian email substring in the entry name', () => {
    expect(
      inferCustodianFromEntry('export/hendric.g@starcapital.co.id-001.mbox', [
        'hendric.g@starcapital.co.id',
        'other@x.com',
      ]),
    ).toBe('hendric.g@starcapital.co.id');
  });

  it('is case-insensitive', () => {
    expect(
      inferCustodianFromEntry('HENDRIC.G@STARCAPITAL.CO.ID-001.mbox', [
        'hendric.g@starcapital.co.id',
      ]),
    ).toBe('hendric.g@starcapital.co.id');
  });

  it("returns 'unknown' when no custodian matches", () => {
    expect(
      inferCustodianFromEntry('weird-name.mbox', ['a@b.com']),
    ).toBe('unknown');
  });

  it('picks the longest custodian when one email is a substring of another', () => {
    // Iteration must be longest-first so a shorter address can't shadow a
    // longer one that's also present in the entry name.
    expect(
      inferCustodianFromEntry('hendric.g@starcapital.co.id-001.mbox', [
        'g@starcapital.co.id',
        'hendric.g@starcapital.co.id',
      ]),
    ).toBe('hendric.g@starcapital.co.id');
  });
});

describe('previousMonth', () => {
  it('decrements the month within the same year', () => {
    expect(previousMonth({ year: 2026, month: 11 })).toEqual({ year: 2026, month: 10 });
  });

  it('wraps January back to December of the previous year', () => {
    expect(previousMonth({ year: 2026, month: 1 })).toEqual({ year: 2025, month: 12 });
  });
});

describe('monthsBetween', () => {
  it('returns empty when floor is strictly after ceiling', () => {
    expect(
      monthsBetween({ year: 2026, month: 5 }, { year: 2026, month: 4 }),
    ).toEqual([]);
  });

  it('returns a single month when floor === ceiling', () => {
    expect(
      monthsBetween({ year: 2026, month: 3 }, { year: 2026, month: 3 }),
    ).toEqual([{ year: 2026, month: 3 }]);
  });

  it('walks oldest-to-newest across year boundaries', () => {
    expect(
      monthsBetween({ year: 2025, month: 11 }, { year: 2026, month: 2 }),
    ).toEqual([
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });
});

describe('parseFloor', () => {
  it('parses YYYY-MM', () => {
    expect(parseFloor('2026-01')).toEqual({ year: 2026, month: 1 });
    expect(parseFloor('2026-12')).toEqual({ year: 2026, month: 12 });
  });

  it('accepts single-digit month', () => {
    expect(parseFloor('2026-3')).toEqual({ year: 2026, month: 3 });
  });

  it('throws on a malformed floor string', () => {
    expect(() => parseFloor('2026/01')).toThrow();
    expect(() => parseFloor('nope')).toThrow();
  });

  it('throws when month is out of 1-12', () => {
    expect(() => parseFloor('2026-13')).toThrow();
    expect(() => parseFloor('2026-0')).toThrow();
  });
});

describe('runVaultArchive', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockReset' in m) {
        // Reset call history but preserve default implementations below.
        (m as ReturnType<typeof vi.fn>).mockClear();
      }
    });
    mocks.loadVaultCredentials.mockReturnValue({
      client_email: 'svc@proj.iam.gserviceaccount.com',
      private_key: '-----PEM-----',
      project_id: 'proj',
    });
    mocks.getVaultAccessToken.mockResolvedValue('token-xyz');
    mocks.createVaultMatter.mockResolvedValue('matter-1');
    mocks.createVaultExport.mockResolvedValue('export-1');
    mocks.closeVaultMatter.mockResolvedValue(undefined);
    mocks.insertSpy.mockResolvedValue({ id: 'mb-1' });
  });

  afterEach(() => vi.clearAllMocks());

  it("rejects mode 'live' until PR #2", async () => {
    await expect(
      runVaultArchive(
        { year: 2026, month: 5, mode: 'live' },
        { db: {} as never, job: { id: 'job-1' } as never },
      ),
    ).rejects.toThrow(/not implemented/);
  });

  it('throws and closes the matter when Vault reports FAILED', async () => {
    mocks.pollVaultExport.mockResolvedValueOnce({
      id: 'export-1',
      status: 'FAILED',
      files: [],
    });
    await expect(
      runVaultArchive(
        { year: 2026, month: 3, mode: 'monthly' },
        { db: {} as never, job: { id: 'job-1' } as never },
      ),
    ).rejects.toThrow(/failed/i);
    expect(mocks.closeVaultMatter).toHaveBeenCalled();
  });

  it('uploads gzipped MBOX entries and inserts mbox_files rows', async () => {
    mocks.pollVaultExport.mockResolvedValue({
      id: 'export-1',
      status: 'COMPLETED',
      files: [{ bucketName: 'gcs-bkt', objectName: 'out.zip', size: '123' }],
    });

    // Build a tiny zip containing one .mbox entry
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    const mboxBody = Buffer.from(
      'From hendric.g@starcapital.co.id Fri Jan  2 00:00:00 2026\n' +
        'From: a@b.com\nTo: hendric.g@starcapital.co.id\n\nhello\n',
      'utf-8',
    );
    zip.addFile('hendric.g@starcapital.co.id-001.mbox', mboxBody);
    mocks.downloadExportFile.mockResolvedValueOnce(zip.toBuffer());

    const result = await runVaultArchive(
      { year: 2026, month: 3, mode: 'monthly' },
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    const [, key, contentType, bucket, contentEncoding] =
      mocks.uploadFile.mock.calls[0];
    expect(bucket).toBe('mbox-archive');
    expect(contentType).toBe('application/x-mbox');
    expect(contentEncoding).toBe('gzip');
    expect(key).toBe(
      'vault/2026/03/monthly/hendric.g@starcapital.co.id/export-1__hendric.g@starcapital.co.id-001.mbox.gz',
    );

    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    const inserted = mocks.insertSpy.mock.calls[0][0];
    expect(inserted).toMatchObject({
      source: 'vault',
      s3_bucket: 'mbox-archive',
      mode: 'monthly',
      job_id: 'job-1',
      custodian_email: 'hendric.g@starcapital.co.id',
      parse_status: 'pending',
      vault_matter_id: 'matter-1',
      vault_export_id: 'export-1',
    });
    expect(inserted.uncompressed_size_bytes).toBe(mboxBody.length);
    expect(inserted.size_bytes).toBeGreaterThan(0);

    expect(result.files_uploaded).toBe(1);
    expect(result.bytes_uncompressed).toBe(mboxBody.length);
    expect(result.window_start).toBe('2026-03-01T00:00:00.000Z');
    expect(result.window_end).toBe('2026-04-01T00:00:00.000Z');
  });

  it("requires a 'day' when mode is 'daily'", async () => {
    await expect(
      runVaultArchive(
        { year: 2026, month: 3, mode: 'daily' },
        { db: {} as never, job: { id: 'job-1' } as never },
      ),
    ).rejects.toThrow(/requires an integer 'day'/);
  });

  it('daily mode writes a single-day window, day-scoped S3 key, and mode=daily', async () => {
    mocks.pollVaultExport.mockResolvedValue({
      id: 'export-1',
      status: 'COMPLETED',
      files: [{ bucketName: 'gcs-bkt', objectName: 'out.zip', size: '123' }],
    });

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    const mboxBody = Buffer.from(
      'From hendric.g@starcapital.co.id Fri Mar 15 00:00:00 2026\n' +
        'From: a@b.com\nTo: hendric.g@starcapital.co.id\n\nhello\n',
      'utf-8',
    );
    zip.addFile('hendric.g@starcapital.co.id-001.mbox', mboxBody);
    mocks.downloadExportFile.mockResolvedValueOnce(zip.toBuffer());

    const result = await runVaultArchive(
      { year: 2026, month: 3, day: 15, mode: 'daily' },
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    const [, key] = mocks.uploadFile.mock.calls[0];
    expect(key).toBe(
      'vault/2026/03/15/daily/hendric.g@starcapital.co.id/export-1__hendric.g@starcapital.co.id-001.mbox.gz',
    );

    const inserted = mocks.insertSpy.mock.calls[0][0];
    expect(inserted).toMatchObject({ mode: 'daily', custodian_email: 'hendric.g@starcapital.co.id' });
    expect(inserted.window_start).toBe('2026-03-15T00:00:00.000Z');
    expect(inserted.window_end).toBe('2026-03-16T00:00:00.000Z');

    expect(result.window_start).toBe('2026-03-15T00:00:00.000Z');
    expect(result.window_end).toBe('2026-03-16T00:00:00.000Z');
  });

  it('skips non-zip files in the Vault export', async () => {
    mocks.pollVaultExport.mockResolvedValue({
      id: 'export-1',
      status: 'COMPLETED',
      files: [
        { bucketName: 'gcs-bkt', objectName: 'manifest.json', size: '10' },
      ],
    });

    const result = await runVaultArchive(
      { year: 2026, month: 3, mode: 'monthly' },
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(mocks.downloadExportFile).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(result.files_uploaded).toBe(0);
  });
});
