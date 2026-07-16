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
  // UserWorkspaceRepository
  findWorkspaceIdsBySyncedEmail: vi.fn().mockResolvedValue([]),
  companyRepoWorkspaceIds: [] as string[],
  // WorkspaceCorrespondentRepository
  addMemberships: vi.fn().mockResolvedValue(undefined),
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
    constructor(_db: unknown, workspaceId: string) {
      mocks.companyRepoWorkspaceIds.push(workspaceId);
    }
    findAllIdAndTarget = vi.fn().mockResolvedValue([]);
    findByNameFuzzy = vi.fn().mockResolvedValue(null);
  },
  EmployerRelatedCompanyRepository: class {
    upsertAuto = vi.fn().mockResolvedValue('rc-1');
    insertEvidence = vi.fn().mockResolvedValue(undefined);
    refreshAggregates = vi.fn().mockResolvedValue(undefined);
  },
  UserWorkspaceRepository: class {
    findWorkspaceIdsBySyncedEmail = mocks.findWorkspaceIdsBySyncedEmail;
  },
  WorkspaceCorrespondentRepository: class {
    addMemberships = mocks.addMemberships;
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
    execute: vi.fn().mockResolvedValue({ rows: [] }),
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
    // Exposed so tests can control the in-transaction backfill lookup (the
    // [5/7] missingMessageIdsForParticipants query) before invoking
    // runCrmIngest — not part of the real DbClient shape.
    _tx: tx,
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
    mocks.findWorkspaceIdsBySyncedEmail.mockResolvedValue([]);
    mocks.companyRepoWorkspaceIds.length = 0;
  });

  afterEach(() => vi.clearAllMocks());

  it('returns immediately when no targets, but still refreshes marts', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([]);
    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );
    expect(result.rows_ingested).toBe(0);
    expect(mocks.employersUpsertBatch).not.toHaveBeenCalled();
    expect(mocks.martRefreshAll).toHaveBeenCalledTimes(1);
    expect(result.marts_refreshed).toEqual(['mart_crm', 'mart_mom', 'mart_topics']);
  });

  it('excludes rows whose sender domain is in _excluded, but still refreshes marts', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({ id: 'r1', from_address: 'spam@fireflies.ai' }),
    ]);
    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );
    expect(result.rows_excluded).toBe(1);
    expect(result.rows_ingested).toBe(0);
    expect(mocks.martRefreshAll).toHaveBeenCalledTimes(1);
    expect(result.marts_refreshed).toEqual(['mart_crm', 'mart_mom', 'mart_topics']);
  });

  it('does not create an employer or correspondent for a domain marked internal', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        from_address: 'alice@goldman.com',
        to_addresses: ['hendric.g@starcapital.co.id'],
      }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c1', email: 'alice@goldman.com' },
    ]);

    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    // Only the external domain is resolved into an employer — the internal
    // domain (starcapital.co.id) never gets its own employer card.
    expect(mocks.employersUpsertBatch).toHaveBeenCalledWith([
      {
        name: 'Goldman Sachs',
        normalized_name: 'goldman-sachs',
        industry: 'Investment Banking',
        status: 'inbound',
        curation_status: 'published',
      },
    ]);
    // The internal recipient never becomes a correspondent (no employer to
    // attach it to).
    expect(mocks.correspondentsUpsertBatch).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        expect.objectContaining({ email: 'hendric.g@starcapital.co.id' }),
      ]),
    );
    // No employer_domains mapping is persisted for the internal domain either.
    expect(mocks.employerDomainPersistMany).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        expect.objectContaining({ domain: 'starcapital.co.id' }),
      ]),
    );
    expect(result.employers_upserted).toBe(1);
  });

  it('does not create an employer for a hardcoded internal domain even with no employer_overrides row at all', async () => {
    mocks.overrideListAll.mockResolvedValueOnce([
      { domain: 'goldman.com', employer_name: 'Goldman Sachs', industry: 'Investment Banking', internal: false, excluded: false },
    ]);
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        from_address: 'alice@goldman.com',
        to_addresses: ['bob@smma.id'],
      }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c1', email: 'alice@goldman.com' },
    ]);

    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.employersUpsertBatch).toHaveBeenCalledWith([
      {
        name: 'Goldman Sachs',
        normalized_name: 'goldman-sachs',
        industry: 'Investment Banking',
        status: 'inbound',
        curation_status: 'published',
      },
    ]);
    expect(mocks.correspondentsUpsertBatch).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        expect.objectContaining({ email: 'bob@smma.id' }),
      ]),
    );
    expect(result.employers_upserted).toBe(1);
  });

  it('creates an employer for a domain marked internal only in employer_overrides — that column is no longer read', async () => {
    // INTERNAL_MAIL_DOMAINS (crmDomainClassify.ts) is the sole source of truth
    // for "internal" now; employer_overrides.internal is dead data until the
    // column itself is dropped in a follow-up migration.
    mocks.overrideListAll.mockResolvedValueOnce([
      { domain: 'newsub.co.id', employer_name: null, industry: null, internal: true, excluded: false },
    ]);
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({ from_address: 'alice@newsub.co.id', to_addresses: [] }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-newsub', normalized_name: 'newsub' },
    ]);

    const result = await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.employersUpsertBatch).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Newsub', normalized_name: 'newsub' }),
    ]);
    expect(result.employers_upserted).toBe(1);
  });

  it('drops a stale persisted employer_domains mapping once a domain is marked internal', async () => {
    // Simulates a domain that was resolved to a real employer in a prior run,
    // before it was added to INTERNAL_MAIL_DOMAINS — the resolve-once cache
    // must not keep re-adopting that stale mapping.
    mocks.employerDomainLoadMap.mockResolvedValueOnce(
      new Map([['starcapital.co.id', 'emp-star-old']]),
    );
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        from_address: 'hendric.g@starcapital.co.id',
        to_addresses: ['alice@goldman.com'],
      }),
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c1', email: 'alice@goldman.com' },
    ]);
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([
      { id: 'e1', message_id: 'msg-1@x' },
    ]);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    const inserted = mocks.insertBatchIgnoringDupes.mock.calls[0][0];
    expect(inserted[0]).toMatchObject({ employer_id: null, direction: 'outbound' });
    expect(mocks.correspondentsUpsertBatch).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        expect.objectContaining({ email: 'hendric.g@starcapital.co.id' }),
      ]),
    );
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

  it('matches related companies against the custodian\'s synced workspace, not the platform default', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({ id: 'r1', message_id: 'msg-1@x', custodian_email: 'custodianA@sqe.co.id' }),
      makeRow({ id: 'r2', message_id: 'msg-2@x', custodian_email: 'custodianB@sqe.co.id' }),
    ]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      {
        raw_email_id: 'r1',
        topics: ['nda'],
        people: [],
        candidates: [],
        related_companies: [
          {
            company_name: 'Acme Co',
            matched_text: 'Acme',
            reason: 'company_mention',
            reason_summary: 'mentioned',
            keywords: [],
            confidence: 'medium',
          },
        ],
      },
      {
        raw_email_id: 'r2',
        topics: ['nda'],
        people: [],
        candidates: [],
        related_companies: [
          {
            company_name: 'Beta Co',
            matched_text: 'Beta',
            reason: 'company_mention',
            reason_summary: 'mentioned',
            keywords: [],
            confidence: 'medium',
          },
        ],
      },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([]);
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([
      { id: 'e1', message_id: 'msg-1@x' },
      { id: 'e2', message_id: 'msg-2@x' },
    ]);
    // Two custodians, each synced to a different workspace.
    mocks.findWorkspaceIdsBySyncedEmail.mockImplementation(async (email: string) => {
      if (email === 'custodianA@sqe.co.id') return ['ws-A'];
      if (email === 'custodianB@sqe.co.id') return ['ws-B'];
      return [];
    });

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    // One CompanyRepository for the default workspace (loaded up front) plus
    // one each for ws-A and ws-B — not one shared instance for every row.
    expect(mocks.companyRepoWorkspaceIds).toContain('ws-A');
    expect(mocks.companyRepoWorkspaceIds).toContain('ws-B');
    expect(new Set(mocks.companyRepoWorkspaceIds).size).toBe(
      mocks.companyRepoWorkspaceIds.length,
    );
    expect(mocks.findWorkspaceIdsBySyncedEmail).toHaveBeenCalledWith('custodianA@sqe.co.id');
    expect(mocks.findWorkspaceIdsBySyncedEmail).toHaveBeenCalledWith('custodianB@sqe.co.id');
  });

  it('attaches correspondent workspace membership per-email, not per-batch (no cross-contamination)', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        message_id: 'msg-1@x',
        from_address: 'alice@goldman.com',
        to_addresses: [],
        custodian_email: 'custodianA@sqe.co.id',
      }),
      makeRow({
        id: 'r2',
        message_id: 'msg-2@x',
        from_address: 'bob@morgan.com',
        to_addresses: [],
        custodian_email: 'custodianB@sqe.co.id',
      }),
    ]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      { raw_email_id: 'r1', topics: [], people: [], candidates: [] },
      { raw_email_id: 'r2', topics: [], people: [], candidates: [] },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c-alice', email: 'alice@goldman.com' },
      { id: 'c-bob', email: 'bob@morgan.com' },
    ]);
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([
      { id: 'e1', message_id: 'msg-1@x' },
      { id: 'e2', message_id: 'msg-2@x' },
    ]);
    mocks.insertParticipantsBatch.mockResolvedValueOnce([]);
    // Two custodians in the same ingest batch, each synced to a different
    // workspace — this is the scenario that would silently defeat isolation
    // if membership were attached after the whole batch upsert instead of
    // per source email.
    mocks.findWorkspaceIdsBySyncedEmail.mockImplementation(async (email: string) => {
      if (email === 'custodianA@sqe.co.id') return ['ws-A'];
      if (email === 'custodianB@sqe.co.id') return ['ws-B'];
      return [];
    });

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(mocks.addMemberships).toHaveBeenCalledWith([
      { workspaceId: 'ws-A', correspondentId: 'c-alice', source: 'ingest' },
      { workspaceId: 'ws-B', correspondentId: 'c-bob', source: 'ingest' },
    ]);
  });

  it('grants membership for a message_id already ingested in a prior run when a new custodian now sees it', async () => {
    // msg-1@x was already ingested in a previous run (e.g. by a different
    // custodian) — insertBatchIgnoringDupes skips it as an existing row, so
    // it's absent from insertedEmails. This run's custodian receives the same
    // message and must still get workspace_correspondents membership.
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({
        id: 'r1',
        message_id: 'msg-1@x',
        from_address: 'alice@goldman.com',
        to_addresses: [],
        custodian_email: 'custodianC@sqe.co.id',
      }),
    ]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      { raw_email_id: 'r1', topics: [], people: [], candidates: [] },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([
      { id: 'c-alice', email: 'alice@goldman.com' },
    ]);
    // Nothing new inserted — msg-1@x already exists from a prior run.
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([]);
    mocks.insertParticipantsBatch.mockResolvedValueOnce([]);
    mocks.findWorkspaceIdsBySyncedEmail.mockImplementation(async (email: string) => {
      if (email === 'custodianC@sqe.co.id') return ['ws-C'];
      return [];
    });

    const db = makeDb();
    // The [5/7] backfill query resolves msg-1@x to its already-existing email id.
    (db._tx.where as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'e-existing', message_id: 'msg-1@x' },
    ]);

    await runCrmIngest({}, { db: db as never, job: { id: 'j1' } as never });

    expect(mocks.addMemberships).toHaveBeenCalledWith([
      { workspaceId: 'ws-C', correspondentId: 'c-alice', source: 'ingest' },
    ]);
  });

  it('falls back to the default workspace when a custodian has no synced workspace', async () => {
    mocks.listReadyForIngest.mockResolvedValueOnce([
      makeRow({ id: 'r1', message_id: 'msg-1@x', custodian_email: 'unsynced@sqe.co.id' }),
    ]);
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      {
        raw_email_id: 'r1',
        topics: ['nda'],
        people: [],
        candidates: [],
        related_companies: [
          {
            company_name: 'Acme Co',
            matched_text: 'Acme',
            reason: 'company_mention',
            reason_summary: 'mentioned',
            keywords: [],
            confidence: 'medium',
          },
        ],
      },
    ]);
    mocks.employersUpsertBatch.mockResolvedValueOnce([
      { id: 'emp-goldman', normalized_name: 'goldman-sachs' },
    ]);
    mocks.correspondentsUpsertBatch.mockResolvedValueOnce([]);
    mocks.insertBatchIgnoringDupes.mockResolvedValueOnce([
      { id: 'e1', message_id: 'msg-1@x' },
    ]);
    mocks.findWorkspaceIdsBySyncedEmail.mockResolvedValue([]);

    await runCrmIngest(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    // Only the default workspace's CompanyRepository was ever constructed —
    // no extra one for the unsynced custodian.
    expect(new Set(mocks.companyRepoWorkspaceIds).size).toBe(1);
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
