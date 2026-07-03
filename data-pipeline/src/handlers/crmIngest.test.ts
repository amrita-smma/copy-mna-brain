import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runCrmIngest } from './crmIngest';

const mocks = vi.hoisted(() => ({
  // RawEmailEnrichmentRepository
  listReadyForIngest: vi.fn(),
  findByRawEmailIds: vi.fn(),
  // DomainClassificationRepository
  findManyByDomains: vi.fn(),
  // TopicRepository
  topicsUpsertBatch: vi.fn(),
  // EmployerRepository
  employersUpsertBatch: vi.fn(),
  // EmployerOverrideRepository
  overrideListAll: vi.fn(),
  // EmployerDomainRepository
  employerDomainLoadMap: vi.fn(),
  employerDomainPersistMany: vi.fn(),
  usersFindByEmails: vi.fn(),
  employerTeamAddMany: vi.fn(),
  // CorrespondentRepository
  correspondentsUpsertBatch: vi.fn(),
  // EmailRepository
  insertBatchIgnoringDupes: vi.fn(),
  insertParticipantsBatch: vi.fn(),
  insertTopicsBatch: vi.fn(),
  // MartRepository
  martRefreshAll: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  TopicRepository: class {
    upsertBatch = mocks.topicsUpsertBatch;
  },
  EmployerRepository: class {
    upsertBatch = mocks.employersUpsertBatch;
  },
  EmployerOverrideRepository: class {
    listAll = mocks.overrideListAll;
  },
  EmployerDomainRepository: class {
    loadMap = mocks.employerDomainLoadMap;
    persistMany = mocks.employerDomainPersistMany;
  },
  UserRepository: class {
    findByEmails = mocks.usersFindByEmails;
  },
  EmployerTeamRepository: class {
    addMany = mocks.employerTeamAddMany;
  },
  CorrespondentRepository: class {
    upsertBatch = mocks.correspondentsUpsertBatch;
  },
  EmailRepository: class {
    insertBatchIgnoringDupes = mocks.insertBatchIgnoringDupes;
    insertParticipantsBatch = mocks.insertParticipantsBatch;
    insertTopicsBatch = mocks.insertTopicsBatch;
  },
  CompanyRepository: class {
    findAllIdAndTarget = vi.fn().mockResolvedValue([]);
    findByNameFuzzy = vi.fn().mockResolvedValue(null);
  },
  EmployerRelatedCompanyRepository: class {
    upsertAuto = vi.fn().mockResolvedValue('rc-1');
    insertEvidence = vi.fn().mockResolvedValue(undefined);
    refreshAggregates = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../helpers/matchRelatedCompany', () => ({
  loadCompanyIndex: vi.fn().mockResolvedValue([]),
  matchRelatedCompany: vi.fn().mockResolvedValue(null),
  normalizeCompanyName: (s: string) => s.toLowerCase().trim(),
}));

vi.mock('../repositories', () => ({
  DomainClassificationRepository: class {
    findManyByDomains = mocks.findManyByDomains;
  },
  RawEmailEnrichmentRepository: class {
    listReadyForIngest = mocks.listReadyForIngest;
    findByRawEmailIds = mocks.findByRawEmailIds;
  },
  MartRepository: class {
    refreshAll = mocks.martRefreshAll;
  },
}));

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    message_id: 'msg-1@x',
    from_address: 'alice@goldman.com',
    from_display_name: 'Alice',
    to_addresses: ['hendric.g@starcapital.co.id'],
    cc_addresses: [],
    subject: 'hi',
    body_text: 'body',
    sent_at: '2026-04-01T00:00:00Z',
    custodian_email: 'hendric.g@starcapital.co.id',
    llm_status: 'enriched',
    ingest_status: 'pending',
    ...overrides,
  };
}

function makeDb() {
  // The transaction tx must support the same query methods that the repos
  // call. We pass mock repos directly and only need a stub for the raw
  // SQL execute + the final update.
  const tx: Record<string, unknown> = {
    execute: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(tx);
    }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    // Used by the excluded-rows terminal-status update and the
    // missingMessageIds fallback lookup (both run outside the tx).
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
}

describe('runCrmIngest', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockClear' in m) (m as ReturnType<typeof vi.fn>).mockClear();
    });
    // Defaults — domain config now comes from employer_overrides (DB), not a file.
    mocks.overrideListAll.mockResolvedValue([
      { domain: 'fireflies.ai', employer_name: null, industry: null, internal: false, excluded: true },
      { domain: 'starcapital.co.id', employer_name: 'STAR Capital', industry: 'Private Equity', internal: true, excluded: false },
      { domain: 'goldman.com', employer_name: 'Goldman Sachs', industry: 'Investment Banking', internal: false, excluded: false },
    ]);
    mocks.employerDomainLoadMap.mockResolvedValue(new Map());
    mocks.employerDomainPersistMany.mockResolvedValue([]);
    mocks.usersFindByEmails.mockResolvedValue([]);
    mocks.employerTeamAddMany.mockResolvedValue(0);
    mocks.findManyByDomains.mockResolvedValue([]);
    mocks.findByRawEmailIds.mockResolvedValue([]);
    mocks.topicsUpsertBatch.mockResolvedValue([]);
    mocks.employersUpsertBatch.mockResolvedValue([]);
    mocks.correspondentsUpsertBatch.mockResolvedValue([]);
    mocks.insertBatchIgnoringDupes.mockResolvedValue([]);
    mocks.insertParticipantsBatch.mockResolvedValue([]);
    mocks.insertTopicsBatch.mockResolvedValue([]);
    mocks.martRefreshAll.mockResolvedValue(['mart_crm', 'mart_mom', 'mart_topics']);
  });

  afterEach(() => vi.clearAllMocks());

  it('returns immediately when no targets', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([]);
    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );
    expect(result.rows_ingested).toBe(0);
    expect(mocks.employersUpsertBatch).not.toHaveBeenCalled();
  });

  it('excludes rows whose sender domain is in _excluded', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({ id: 'r1', from_address: 'spam@fireflies.ai' }),
    ]);
    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );
    expect(result.rows_excluded).toBe(1);
    expect(result.rows_ingested).toBe(0);
  });

  it('runs the full transaction for a single eligible row', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      {
        raw_email_id: 'r1',
        topics: ['nda'],
        people: [],
        candidates: [],
      },
    ]);
    mocks.topicsUpsertBatch.mockResolvedValueOnce([
      { id: 't1', slug: 'nda', name: 'nda' },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
      { id: 'emp-star', normalized_name: 'star-capital' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c1', email: 'alice@goldman.com' },
    ]);
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([
      { id: 'e1', message_id: 'msg-1@x' },
    ]);
    mocks.insertParticipantsBatch.mockResolvedValueOnce([{ id: 'p1' }]);
    mocks.insertTopicsBatch.mockResolvedValueOnce([{ id: 'et1' }]);

    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(result.topics_upserted).toBe(1);
    expect(result.employers_upserted).toBe(2);
    expect(result.correspondents_upserted).toBe(1);
    expect(result.emails_inserted).toBe(1);
    expect(result.participants_inserted).toBe(1);
    expect(result.email_topics_inserted).toBe(1);
    expect(result.team_members_inserted).toBe(0);
    expect(result.rows_ingested).toBe(1);
    // Marts are refreshed after the ingest tx commits.
    expect(result.marts_refreshed).toEqual(['mart_crm', 'mart_mom', 'mart_topics']);
  });

  it('assigns receiver and custodian users to every external employer on the email', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        to_addresses: [
          'hendric.g@starcapital.co.id',
          'jien.lit@starcapital.co.id',
        ],
        cc_addresses: ['advisor@goldman.com'],
      }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
      { id: 'emp-star', normalized_name: 'star-capital' },
    ]);
    mocks.usersFindByEmails.mockResolvedValueOnce([
      { id: 'u-hendric', email: 'HENDRIC.G@starcapital.co.id' },
      { id: 'u-jien', email: 'jien.lit@starcapital.co.id' },
    ]);
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([
      { id: 'e1', message_id: 'msg-1@x' },
    ]);
    mocks.employerTeamAddMany.mockResolvedValueOnce(2);

    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.employerTeamAddMany).toHaveBeenCalledWith([
      { employer_id: 'emp-goldman', user_id: 'u-hendric' },
      { employer_id: 'emp-goldman', user_id: 'u-jien' },
    ]);
    expect(mocks.insertParticipantsBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          address: 'hendric.g@starcapital.co.id',
          user_id: 'u-hendric',
        }),
        expect.objectContaining({
          address: 'jien.lit@starcapital.co.id',
          user_id: 'u-jien',
        }),
      ]),
    );
    expect(result.team_members_inserted).toBe(2);
  });

  it('uses the custodian to assign outbound email coverage', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        from_address: 'hendric.g@starcapital.co.id',
        to_addresses: ['alice@goldman.com'],
      }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
      { id: 'emp-star', normalized_name: 'star-capital' },
    ]);
    mocks.usersFindByEmails.mockResolvedValueOnce([
      { id: 'u-hendric', email: 'hendric.g@starcapital.co.id' },
    ]);
    mocks.employerTeamAddMany.mockResolvedValueOnce(1);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.employerTeamAddMany).toHaveBeenCalledWith([
      { employer_id: 'emp-goldman', user_id: 'u-hendric' },
    ]);
  });

  it('passes the LLM deal classification through to topicsUpsertBatch (new object format)', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      {
        raw_email_id: 'r1',
        topics: [
          { name: 'acquisition', is_deal_related: true },
          { name: 'semiconductors', is_deal_related: false },
        ],
        people: [],
        candidates: [],
      },
    ]);
    mocks.topicsUpsertBatch.mockResolvedValueOnce([
      { id: 't1', slug: 'acquisition', name: 'acquisition' },
      { id: 't2', slug: 'semiconductors', name: 'semiconductors' },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([]);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.topicsUpsertBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        { slug: 'acquisition', is_deal_related: true },
        { slug: 'semiconductors', is_deal_related: false },
      ]),
    );
  });

  it('treats legacy string topics as non-deal (backward compat)', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      { raw_email_id: 'r1', topics: ['nda'], people: [], candidates: [] },
    ]);
    mocks.topicsUpsertBatch.mockResolvedValueOnce([
      { id: 't1', slug: 'nda', name: 'nda' },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([]);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.topicsUpsertBatch).toHaveBeenCalledWith([
      { slug: 'nda', is_deal_related: false },
    ]);
  });

  it('threads the raw in_reply_to onto the inserted email', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({ id: 'r1', in_reply_to: 'parent-msg@x' }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
      { id: 'emp-star', normalized_name: 'star-capital' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c1', email: 'alice@goldman.com' },
    ]);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    const inserted = mocks.insertBatchIgnoringDupes.mock.calls[0][0];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      message_id: 'msg-1@x',
      direction: 'inbound',
      in_reply_to: 'parent-msg@x',
    });
  });

  it('inserts a null in_reply_to when the raw email has none', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([makeRow({ id: 'r1' })]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
      { id: 'emp-star', normalized_name: 'star-capital' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c1', email: 'alice@goldman.com' },
    ]);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    const inserted = mocks.insertBatchIgnoringDupes.mock.calls[0][0];
    expect(inserted[0].in_reply_to).toBeNull();
  });
});
