import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EmployerRelatedCompanyRepository } from './employerRelatedCompanyRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('EmployerRelatedCompanyRepository.listForEmployer', () => {
  it('returns [] without hitting the evidence table when no aggregate rows exist', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([]); // first select (aggregates) returns []
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const out = await repo.listForEmployer('emp-1', 'w1');
    expect(out).toEqual([]);
    // should not call select again for evidence since there are no rows
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('joins evidence rows onto each aggregate', async () => {
    const db = makeDb();
    db.where
      .mockResolvedValueOnce([{ id: 'rc-1', employer_id: 'emp-1', dismissed_at: null }])
      .mockResolvedValueOnce([
        { id: 'ev-1', related_company_id: 'rc-1', matched_text: 'We represent X' },
      ]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const out = await repo.listForEmployer('emp-1', 'w1');
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toHaveLength(1);
    expect(out[0].evidence[0].matched_text).toBe('We represent X');
  });

  it('keeps auto links visible without any email-sync gate, so un-syncing the last mailbox does not hide detected matches', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([]); // aggregates query result
    const repo = new EmployerRelatedCompanyRepository(db as never);
    await repo.listForEmployer('emp-1', 'w1');

    const whereArg = db.where.mock.calls[0]?.[0];
    const { sql: text } = new PgDialect().sqlToQuery(whereArg);
    expect(text).not.toContain("!= 'auto'");
    expect(text).not.toContain('user_workspaces');
    expect(text).not.toContain('is_email_synced');
  });

  it('excludes related companies that are not in the system (company_id IS NULL)', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    await repo.listForEmployer('emp-1', 'w1');

    const whereArg = db.where.mock.calls[0]?.[0];
    const { sql: text } = new PgDialect().sqlToQuery(whereArg);
    expect(text).toContain('company_id');
    expect(text.toLowerCase()).toContain('is not null');
  });
});

describe('EmployerRelatedCompanyRepository.upsertAuto', () => {
  it('returns the id on fresh insert', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'rc-1' }]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const id = await repo.upsertAuto({
      employer_id: 'emp-1',
      workspace_id: 'w1',
      company_id: null,
      company_name: 'TechSlurry',
      normalized_company_name: 'techslurry',
      source: 'auto',
      reason: 'explicit_pitch',
      reason_summary: 'Banker explicitly represents this company',
    });
    expect(id).toBe('rc-1');
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });

  it('returns the id when the row already existed (conflict → DO UPDATE returns same id)', async () => {
    const db = makeDb();
    // DO UPDATE always returns a row (unlike DO NOTHING which returns nothing on conflict)
    db.returning.mockResolvedValueOnce([{ id: 'rc-existing' }]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const id = await repo.upsertAuto({
      employer_id: 'emp-1',
      workspace_id: 'w1',
      company_id: 'co-1',
      company_name: 'TechSlurry',
      normalized_company_name: 'techslurry',
      source: 'auto',
      reason: 'explicit_pitch',
      reason_summary: null,
    });
    expect(id).toBe('rc-existing');
    // No second SELECT needed — DO UPDATE always returns the row
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('EmployerRelatedCompanyRepository.insertEvidence', () => {
  it('inserts with ON CONFLICT DO NOTHING (safe to re-run)', async () => {
    const db = makeDb();
    db.onConflictDoNothing.mockResolvedValueOnce([]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    await repo.insertEvidence({
      related_company_id: 'rc-1',
      email_id: 'em-1',
      reason: 'explicit_pitch',
      reason_summary: 'Banker represents this company',
      keywords: ['sell-side'],
      confidence: 'high',
    });
    expect(db.onConflictDoNothing).toHaveBeenCalled();
  });
});

describe('EmployerRelatedCompanyRepository.dismiss', () => {
  it('sets dismissed_at on the row', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    await repo.dismiss('rc-1');
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ dismissed_at: expect.any(String) }),
    );
  });
});

describe('EmployerRelatedCompanyRepository.createManual', () => {
  it('inserts a source=manual row with sentinel reason/confidence and returns it', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'rc-manual', source: 'manual' }]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const row = await repo.createManual({
      employer_id: 'emp-1',
      workspace_id: 'w1',
      company_id: 'co-1',
      company_name: 'TechSlurry',
      normalized_company_name: 'techslurry',
    });
    expect(row.id).toBe('rc-manual');
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual',
        reason: 'manual',
        confidence: 'high',
        company_id: 'co-1',
      }),
    );
    // manual insert must NOT swallow conflicts — it returns the row directly
    expect(db.onConflictDoNothing).not.toHaveBeenCalled();
  });
});

describe('EmployerRelatedCompanyRepository.deleteManual', () => {
  it('hard-deletes guarded to the employer and source=manual', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce(undefined);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    await repo.deleteManual('emp-1', 'rc-manual', 'w1');
    expect(db.delete).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled(); // hard delete, not a soft dismiss
  });
});

describe('EmployerRelatedCompanyRepository.dismissAuto', () => {
  it('soft-dismisses (sets dismissed_at) instead of deleting, so the ingest cannot resurrect it', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce(undefined);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    await repo.dismissAuto('emp-1', 'rc-auto', 'w1');
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith({ dismissed_at: expect.any(String) });
    expect(db.delete).not.toHaveBeenCalled();
  });
});

describe('EmployerRelatedCompanyRepository.rankByRelatedCompanyCount', () => {
  it('maps the ranked rows, coercing the aggregate counts to numbers', async () => {
    const db = makeDb();
    db.orderBy.mockResolvedValueOnce([
      {
        employerId: 'e1',
        employerName: 'Golden Sacks',
        relatedCompanyCount: '12',
        matchedCompanyCount: '7',
        lastSeenAt: '2026-06-01T00:00:00.000Z',
      },
      {
        employerId: 'e2',
        employerName: 'JP Organ',
        relatedCompanyCount: 3,
        matchedCompanyCount: 1,
        lastSeenAt: null,
      },
    ]);
    const repo = new EmployerRelatedCompanyRepository(db as never);

    const out = await repo.rankByRelatedCompanyCount('w1');

    expect(db.innerJoin).toHaveBeenCalledTimes(1);
    expect(db.groupBy).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      {
        employerId: 'e1',
        employerName: 'Golden Sacks',
        relatedCompanyCount: 12,
        matchedCompanyCount: 7,
        lastSeenAt: '2026-06-01T00:00:00.000Z',
      },
      {
        employerId: 'e2',
        employerName: 'JP Organ',
        relatedCompanyCount: 3,
        matchedCompanyCount: 1,
        lastSeenAt: null,
      },
    ]);
  });

  it('excludes dismissed rows and counts auto rows regardless of workspace sync state', async () => {
    const db = makeDb();
    db.orderBy.mockResolvedValueOnce([]);
    const repo = new EmployerRelatedCompanyRepository(db as never);

    await repo.rankByRelatedCompanyCount('w1');

    const whereArg = db.where.mock.calls[0]?.[0];
    const { sql: text } = new PgDialect().sqlToQuery(whereArg);
    expect(text).toContain('dismissed_at');
    expect(text).not.toContain("!= 'auto'");
    expect(text).not.toContain('is_email_synced');
    // Only companies in the system are counted.
    expect(text).toContain('company_id');
    expect(text.toLowerCase()).toContain('is not null');
  });
});

describe('EmployerRelatedCompanyRepository.findByCompanyId', () => {
  it('queries non-dismissed rows for the employer + company', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ id: 'rc-1', company_id: 'co-1' }]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const out = await repo.findByCompanyId('emp-1', 'co-1', 'w1');
    expect(out).toHaveLength(1);
  });
});
