import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEAL_ORIGINATOR_INDUSTRIES, DEAL_TOPICS, runAttachmentGate } from './attachmentGate';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  promoteToFetch: vi.fn(),
  markDropped: vi.fn(),
}));

vi.mock('../repositories', () => ({
  EmailAttachmentRepository: class {
    promoteToFetch = mocks.promoteToFetch;
    markDropped = mocks.markDropped;
  },
}));

// Build a chainable Drizzle-style query mock that resolves to `rows`.
function makeDb(rows: unknown[]) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

function makeJob() {
  return { id: 'job-1' } as never;
}

function makeRow(overrides: Partial<{
  attachment_id: string;
  from_address: string | null;
  llm_status: string;
  topics: string[] | null;
  related_companies: unknown;
  industry: string | null;
}> = {}) {
  return {
    attachment_id: 'att-1',
    from_address: 'sender@example.com',
    llm_status: 'enriched',
    topics: null,
    related_companies: null,
    industry: null,
    ...overrides,
  };
}

describe('runAttachmentGate', () => {
  beforeEach(() => {
    mocks.promoteToFetch.mockReset();
    mocks.markDropped.mockReset();
    mocks.promoteToFetch.mockResolvedValue(undefined);
    mocks.markDropped.mockResolvedValue(undefined);
  });

  it('promotes via gate A (deal company with high confidence)', async () => {
    const db = makeDb([makeRow({
      related_companies: [{ company: 'Acme', confidence: 'high' }],
      llm_status: 'enriched',
    })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.promoted).toBe(1);
    expect(result.dropped).toBe(0);
    expect(mocks.promoteToFetch).toHaveBeenCalledWith(['att-1'], 'deal_company');
  });

  it('promotes via gate B (deal-originator domain industry)', async () => {
    const db = makeDb([makeRow({
      industry: 'Private Equity',
      llm_status: 'enriched',
    })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.promoted).toBe(1);
    expect(mocks.promoteToFetch).toHaveBeenCalledWith(['att-1'], 'domain_industry');
  });

  it('promotes via gate C (deal-signal topic)', async () => {
    const db = makeDb([makeRow({
      topics: ['intro', 'nda'],
      llm_status: 'enriched',
    })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.promoted).toBe(1);
    expect(mocks.promoteToFetch).toHaveBeenCalledWith(['att-1'], 'deal_topic');
  });

  it('drops when terminally enriched and no gate fires', async () => {
    const db = makeDb([makeRow({ llm_status: 'enriched' })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.dropped).toBe(1);
    expect(result.promoted).toBe(0);
    expect(mocks.markDropped).toHaveBeenCalledWith(['att-1']);
  });

  it('drops when not_needed and no gate fires', async () => {
    const db = makeDb([makeRow({ llm_status: 'not_needed' })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.dropped).toBe(1);
    expect(mocks.markDropped).toHaveBeenCalledWith(['att-1']);
  });

  it('defers when email not yet terminally enriched', async () => {
    const db = makeDb([makeRow({ llm_status: 'pending' })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.deferred).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.promoted).toBe(0);
    expect(mocks.promoteToFetch).not.toHaveBeenCalled();
    expect(mocks.markDropped).not.toHaveBeenCalled();
  });

  it('returns zero counts with no rows', async () => {
    const db = makeDb([]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result).toEqual({ evaluated: 0, promoted: 0, dropped: 0, deferred: 0 });
  });

  it('gate A takes priority over B and C', async () => {
    const db = makeDb([makeRow({
      related_companies: [{ company: 'Fund', confidence: 'high' }],
      industry: 'Private Equity',
      topics: ['nda'],
      llm_status: 'enriched',
    })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.promoted).toBe(1);
    expect(mocks.promoteToFetch).toHaveBeenCalledWith(['att-1'], 'deal_company');
  });

  it('ignores low-confidence related_companies', async () => {
    const db = makeDb([makeRow({
      related_companies: [{ company: 'Unknown', confidence: 'low' }],
      llm_status: 'enriched',
    })]);
    const result = await runAttachmentGate({}, { db: db as never, job: makeJob() });
    expect(result.dropped).toBe(1);
    expect(mocks.promoteToFetch).not.toHaveBeenCalled();
  });
});

describe('DEAL_ORIGINATOR_INDUSTRIES', () => {
  it('includes Investment Banking, Private Equity, Asset Management, Legal Services', () => {
    expect(DEAL_ORIGINATOR_INDUSTRIES.has('Investment Banking')).toBe(true);
    expect(DEAL_ORIGINATOR_INDUSTRIES.has('Private Equity')).toBe(true);
    expect(DEAL_ORIGINATOR_INDUSTRIES.has('Asset Management')).toBe(true);
    expect(DEAL_ORIGINATOR_INDUSTRIES.has('Legal Services')).toBe(true);
  });
  it('excludes Management Consulting', () => {
    expect(DEAL_ORIGINATOR_INDUSTRIES.has('Management Consulting')).toBe(false);
  });
});

describe('DEAL_TOPICS', () => {
  it('includes expected deal-signal topics', () => {
    for (const t of ['nda', 'term-sheet', 'due-diligence', 'valuation', 'mou', 'loi', 'ipo']) {
      expect(DEAL_TOPICS.has(t)).toBe(true);
    }
  });
  it('excludes intro', () => {
    expect(DEAL_TOPICS.has('intro')).toBe(false);
  });
});
