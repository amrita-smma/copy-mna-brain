import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MboxFileRepository } from './mboxFileRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

describe('MboxFileRepository.insert', () => {
  it('returns the inserted row', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'mb1', s3_key: 'foo' }]);
    const repo = new MboxFileRepository(db as never);
    const row = await repo.insert({
      source: 'vault',
      s3_bucket: 'mbox-archive',
      s3_key: 'foo',
      size_bytes: 100,
      custodian_email: 'a@b.com',
      window_start: '2026-03-01T00:00:00Z',
      window_end: '2026-04-01T00:00:00Z',
      mode: 'monthly',
      job_id: 'job1',
    });
    expect(row).toMatchObject({ id: 'mb1' });
    expect(db.values).toHaveBeenCalled();
  });
});

describe('MboxFileRepository.insertIgnore', () => {
  it('returns the inserted row when s3_key is new', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'mb1', s3_key: 'foo' }]);
    const repo = new MboxFileRepository(db as never);
    const row = await repo.insertIgnore({
      source: 'vault',
      s3_bucket: 'mbox-archive',
      s3_key: 'foo',
      size_bytes: 100,
      custodian_email: 'a@b.com',
      window_start: '2026-03-01T00:00:00Z',
      window_end: '2026-04-01T00:00:00Z',
      mode: 'monthly',
      job_id: 'job1',
    });
    expect(row).toMatchObject({ id: 'mb1' });
    expect(db.onConflictDoNothing).toHaveBeenCalled();
  });

  it('returns null when s3_key already exists', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([]);
    const repo = new MboxFileRepository(db as never);
    const row = await repo.insertIgnore({
      source: 'vault',
      s3_bucket: 'mbox-archive',
      s3_key: 'foo',
      size_bytes: 100,
      custodian_email: 'a@b.com',
      window_start: '2026-03-01T00:00:00Z',
      window_end: '2026-04-01T00:00:00Z',
      mode: 'monthly',
      job_id: 'job1',
    });
    expect(row).toBeNull();
  });
});

describe('MboxFileRepository.findById', () => {
  it('returns the row when found', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([{ id: 'mb1' }]);
    const repo = new MboxFileRepository(db as never);
    expect(await repo.findById('mb1')).toMatchObject({ id: 'mb1' });
  });

  it('returns null when not found', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([]);
    const repo = new MboxFileRepository(db as never);
    expect(await repo.findById('missing')).toBeNull();
  });
});

describe('MboxFileRepository.findByJobId', () => {
  it('returns all files for the job ordered by created_at', async () => {
    const db = makeDb();
    const rows = [{ id: 'mb1' }, { id: 'mb2' }];
    db.orderBy.mockResolvedValueOnce(rows);
    const repo = new MboxFileRepository(db as never);
    expect(await repo.findByJobId('job1')).toEqual(rows);
    expect(db.where).toHaveBeenCalled();
  });
});

describe('MboxFileRepository.listPending', () => {
  it('returns pending rows capped by limit', async () => {
    const db = makeDb();
    const rows = [{ id: 'mb1', parse_status: 'pending' }];
    db.limit.mockResolvedValueOnce(rows);
    const repo = new MboxFileRepository(db as never);
    expect(await repo.listPending(10)).toEqual(rows);
  });

  it('includes failed rows when includeFailed=true', async () => {
    const db = makeDb();
    const rows = [
      { id: 'mb1', parse_status: 'pending' },
      { id: 'mb2', parse_status: 'failed' },
    ];
    db.limit.mockResolvedValueOnce(rows);
    const repo = new MboxFileRepository(db as never);
    expect(await repo.listPending(10, true)).toEqual(rows);
    expect(db.where).toHaveBeenCalled();
  });
});

describe('MboxFileRepository.findByWindow', () => {
  it('filters by source and window range', async () => {
    const db = makeDb();
    db.orderBy.mockResolvedValueOnce([]);
    const repo = new MboxFileRepository(db as never);
    const out = await repo.findByWindow(
      'vault',
      '2026-03-01T00:00:00Z',
      '2026-04-01T00:00:00Z',
    );
    expect(out).toEqual([]);
    expect(db.where).toHaveBeenCalled();
  });
});

describe('MboxFileRepository.markParsing', () => {
  it('returns the updated row when the conditional UPDATE matched', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'mb1', parse_status: 'parsing' }]);
    const repo = new MboxFileRepository(db as never);
    const out = await repo.markParsing('mb1');
    expect(out).toMatchObject({ id: 'mb1', parse_status: 'parsing' });
  });

  it("returns null when no row matched (already claimed or not pending)", async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([]);
    const repo = new MboxFileRepository(db as never);
    expect(await repo.markParsing('mb-missing')).toBeNull();
  });

  it('claims a failed row when allowStatuses includes failed', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'mb1', parse_status: 'parsing' }]);
    const repo = new MboxFileRepository(db as never);
    const out = await repo.markParsing('mb1', ['pending', 'failed']);
    expect(out).toMatchObject({ id: 'mb1', parse_status: 'parsing' });
  });
});

describe('MboxFileRepository.markParsed', () => {
  it('returns the updated row with parsed_at and count', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([
      { id: 'mb1', parse_status: 'parsed', raw_email_count: 42 },
    ]);
    const repo = new MboxFileRepository(db as never);
    const out = await repo.markParsed('mb1', 42);
    expect(out).toMatchObject({ parse_status: 'parsed', raw_email_count: 42 });
  });

  it('throws when the row does not exist', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([]);
    const repo = new MboxFileRepository(db as never);
    await expect(repo.markParsed('mb-missing', 0)).rejects.toThrow(/not found/);
  });
});

describe('MboxFileRepository.markFailed', () => {
  it('stores the error message on the row', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([
      { id: 'mb1', parse_status: 'failed', parse_error: 'boom' },
    ]);
    const repo = new MboxFileRepository(db as never);
    const out = await repo.markFailed('mb1', 'boom');
    expect(out).toMatchObject({ parse_status: 'failed', parse_error: 'boom' });
  });
});
