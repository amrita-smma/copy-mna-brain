import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmployerRelatedCompanyRepository } from './employerRelatedCompanyRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
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
    const out = await repo.listForEmployer('emp-1');
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
    const out = await repo.listForEmployer('emp-1');
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toHaveLength(1);
    expect(out[0].evidence[0].matched_text).toBe('We represent X');
  });
});

describe('EmployerRelatedCompanyRepository.upsertAuto', () => {
  it('returns the id on fresh insert', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([{ id: 'rc-1' }]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const id = await repo.upsertAuto({
      employer_id: 'emp-1',
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
      raw_email_id: 'raw-1',
      matched_text: 'We represent TechSlurry',
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
    await repo.deleteManual('emp-1', 'rc-manual');
    expect(db.delete).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled(); // hard delete, not a soft dismiss
  });
});

describe('EmployerRelatedCompanyRepository.findByCompanyId', () => {
  it('queries non-dismissed rows for the employer + company', async () => {
    const db = makeDb();
    db.where.mockResolvedValueOnce([{ id: 'rc-1', company_id: 'co-1' }]);
    const repo = new EmployerRelatedCompanyRepository(db as never);
    const out = await repo.findByCompanyId('emp-1', 'co-1');
    expect(out).toHaveLength(1);
  });
});
