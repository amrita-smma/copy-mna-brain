import { describe, it, expect, vi } from 'vitest';
import { RawEmailEnrichmentRepository } from './rawEmailEnrichmentRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

describe('RawEmailEnrichmentRepository.upsertExtract', () => {
  it('returns the upserted row', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([
      { id: 'e1', raw_email_id: 'r1', needs_llm: true },
    ]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    const out = await repo.upsertExtract('r1', {
      candidates: [],
      domain_tag: null,
      needs_llm: true,
      body_snippet: 'hello',
    });
    expect(out).toMatchObject({ id: 'e1', raw_email_id: 'r1' });
    expect(db.onConflictDoUpdate).toHaveBeenCalled();
  });
});

describe('RawEmailEnrichmentRepository.findByRawEmailId', () => {
  it('returns null when missing', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    expect(await repo.findByRawEmailId('r1')).toBeNull();
  });

  it('returns the row when present', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([{ id: 'e1' }]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    expect(await repo.findByRawEmailId('r1')).toMatchObject({ id: 'e1' });
  });
});

describe('RawEmailEnrichmentRepository.findByRawEmailIds', () => {
  it('returns [] for empty input without hitting the DB', async () => {
    const db = makeDb();
    const repo = new RawEmailEnrichmentRepository(db as never);
    expect(await repo.findByRawEmailIds([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('RawEmailEnrichmentRepository.setLlmResult', () => {
  it('writes topics + people + model + batch id', async () => {
    const db = makeDb();
    const topicObj = { name: 'nda', is_deal_related: true };
    db.returning.mockResolvedValueOnce([
      { id: 'e1', raw_email_id: 'r1', topics: [topicObj], people: [] },
    ]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    const out = await repo.setLlmResult('r1', {
      topics: [topicObj],
      people: [],
      llm_model: 'claude-haiku-4-5',
      llm_batch_id: 'b1',
    });
    expect(out).toMatchObject({ topics: [topicObj] });
  });

  it('throws when the row does not exist', async () => {
    const db = makeDb();
    db.returning.mockResolvedValueOnce([]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    await expect(
      repo.setLlmResult('missing', {
        topics: [],
        people: [],
        llm_model: 'x',
        llm_batch_id: null,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('persists related_companies when provided', async () => {
    const db = makeDb();
    const relatedCompanies = [
      { company_name: 'TechSlurry', matched_text: 'We represent TechSlurry', reason: 'explicit_pitch', reason_summary: 'Banker represents this company', keywords: ['sell-side'], confidence: 'high' },
    ];
    db.returning.mockResolvedValueOnce([
      { id: 'e1', raw_email_id: 'r1', related_companies: relatedCompanies },
    ]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    const out = await repo.setLlmResult('r1', {
      topics: [],
      people: [],
      related_companies: relatedCompanies,
      llm_model: 'claude-haiku-4-5',
      llm_batch_id: null,
    });
    const setCall = db.set.mock.calls[0][0];
    expect(setCall).toHaveProperty('related_companies');
    expect(out).toMatchObject({ related_companies: relatedCompanies });
  });
});

describe('RawEmailEnrichmentRepository.listReadyForIngest', () => {
  it('queries and returns rows', async () => {
    const db = makeDb();
    db.limit.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    const repo = new RawEmailEnrichmentRepository(db as never);
    expect(await repo.listReadyForIngest(100)).toHaveLength(2);
  });
});
