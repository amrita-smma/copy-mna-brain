import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CompanyVoteRepository } from './companyVoteRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CompanyVoteRepository', () => {
  let db: MockDb;
  let repo: CompanyVoteRepository;

  beforeEach(() => {
    db = makeMockDb();
    repo = new CompanyVoteRepository(db as never, 'ws-1');
  });

  it('findSessionById returns the row when one matches', async () => {
    const row = { id: 'vs-1', company_id: 'c-1', workspace_id: 'ws-1' };
    db.limit.mockResolvedValueOnce([row]);

    await expect(repo.findSessionById('vs-1')).resolves.toEqual(row);
  });

  it('findSessionById returns null when nothing matches', async () => {
    db.limit.mockResolvedValueOnce([]);

    await expect(repo.findSessionById('missing')).resolves.toBeNull();
  });

  it('findActiveSessionByCompanyId returns null when no round is open', async () => {
    db.limit.mockResolvedValueOnce([]);

    await expect(repo.findActiveSessionByCompanyId('c-1')).resolves.toBeNull();
  });

  it('findLatestSessionByCompanyId orders newest-first and takes one row', async () => {
    const row = { id: 'vs-9', company_id: 'c-1' };
    db.limit.mockResolvedValueOnce([row]);

    await expect(repo.findLatestSessionByCompanyId('c-1')).resolves.toEqual(row);
    expect(db.orderBy).toHaveBeenCalledTimes(1);
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it('listSessionsByCompanyId returns every round newest-first', async () => {
    const rows = [{ id: 'vs-2' }, { id: 'vs-1' }];
    db.orderBy.mockResolvedValueOnce(rows);

    await expect(repo.listSessionsByCompanyId('c-1')).resolves.toEqual(rows);
  });

  it('listCompletedSessionsByCompanyIds returns [] without hitting the DB when the id list is empty', async () => {
    await expect(repo.listCompletedSessionsByCompanyIds([])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('listCompletedSessionsByCompanyIds scopes to completed rounds in this workspace', async () => {
    const rows = [{ id: 'vs-2', company_id: 'c-1', status: 'completed' }];
    db.orderBy.mockResolvedValueOnce(rows);

    await expect(
      repo.listCompletedSessionsByCompanyIds(['c-1', 'c-2']),
    ).resolves.toEqual(rows);
    const { params } = new PgDialect().sqlToQuery(db.where.mock.calls[0][0] as SQL);
    expect(params).toEqual(
      expect.arrayContaining(['c-1', 'c-2', 'ws-1', 'completed']),
    );
    expect(params).not.toContain('active');
    expect(params).not.toContain('cancelled');
  });

  it('listCompletedSessionsByCompanyIds orders by company then newest conclusion first, nulls last', async () => {
    db.orderBy.mockResolvedValueOnce([]);

    await repo.listCompletedSessionsByCompanyIds(['c-1']);
    const rendered = (db.orderBy.mock.calls[0] as SQL[])
      .map((arg) => new PgDialect().sqlToQuery(arg).sql)
      .join(', ');
    expect(rendered).toContain('"company_id" asc');
    // NULLS LAST: a completed row missing its conclusion stamp must not
    // shadow a newer, properly concluded round (Postgres sorts NULL first
    // under plain DESC).
    expect(rendered).toContain('"concluded_at" desc nulls last');
    expect(rendered).toContain('"created_at" desc');
  });

  it('findDueSessions returns open sessions past their deadline', async () => {
    const rows = [{ id: 'vs-1', deadline_at: '2026-01-01T00:00:00Z' }];
    db.orderBy.mockResolvedValueOnce(rows);

    await expect(repo.findDueSessions('2026-02-01T00:00:00Z')).resolves.toEqual(rows);
  });

  it('createSession stamps the workspace id itself rather than trusting the caller', async () => {
    const row = { id: 'vs-1', company_id: 'c-1' };
    db.returning.mockResolvedValueOnce([row]);

    const created = await repo.createSession({
      company_id: 'c-1',
      initiated_by: 'u-1',
      deadline_at: '2026-09-04T00:00:00Z',
    } as never);

    expect(created).toEqual(row);
    expect(db.values).toHaveBeenCalledWith({
      company_id: 'c-1',
      initiated_by: 'u-1',
      deadline_at: '2026-09-04T00:00:00Z',
      workspace_id: 'ws-1',
    });
  });

  it('deleteSession scopes the delete to this workspace', async () => {
    await repo.deleteSession('vs-1');

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it('updateSession refreshes updated_at alongside the caller updates', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'vs-1', status: 'cancelled' }]);

    await repo.updateSession('vs-1', { status: 'cancelled' });

    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', updated_at: expect.anything() }),
    );
  });

  it('updateSession returns null when no row matched the workspace', async () => {
    db.returning.mockResolvedValueOnce([]);

    await expect(repo.updateSession('vs-1', { status: 'completed' })).resolves.toBeNull();
  });

  it('updateSession compare-and-swaps on the expected status when asked', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'vs-1', status: 'completed' }]);

    await repo.updateSession('vs-1', { status: 'completed' }, { expectedStatus: 'active' });

    // id + workspace + status all land in the single where()
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it('updateSession returns null when the compare-and-swap loses', async () => {
    db.returning.mockResolvedValueOnce([]);

    await expect(
      repo.updateSession('vs-1', { status: 'completed' }, { expectedStatus: 'active' }),
    ).resolves.toBeNull();
  });

  it('insertBallots writes every row in one statement', async () => {
    const rows = [
      { vote_session_id: 'vs-1', voter_id: 'u-1' },
      { vote_session_id: 'vs-1', voter_id: 'u-2' },
    ];

    await repo.insertBallots(rows as never);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledWith(rows);
  });

  it('insertBallots returns [] without hitting the DB when there are no rows', async () => {
    await repo.insertBallots([]);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('listBallotsBySessionIds returns [] without hitting the DB for an empty id list', async () => {
    await expect(repo.listBallotsBySessionIds([])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('listBallotsBySessionIds groups by session id first so callers can group in one pass', async () => {
    const rows = [{ id: 'b-1' }, { id: 'b-2' }];
    db.orderBy.mockResolvedValueOnce(rows);

    await expect(repo.listBallotsBySessionIds(['vs-1', 'vs-2'])).resolves.toEqual(rows);
    expect(db.orderBy).toHaveBeenCalledTimes(1);
  });

  it('listBallotsBySessionId delegates to the batched variant', async () => {
    const rows = [{ id: 'b-1' }];
    db.orderBy.mockResolvedValueOnce(rows);

    await expect(repo.listBallotsBySessionId('vs-1')).resolves.toEqual(rows);
  });

  it('findBallot returns null when the voter has no ballot in the session', async () => {
    db.limit.mockResolvedValueOnce([]);

    await expect(repo.findBallot('vs-1', 'u-9')).resolves.toBeNull();
  });

  it('updateBallot refreshes updated_at and returns the row', async () => {
    const row = { id: 'b-1', status: 'submitted' };
    db.returning.mockResolvedValueOnce([row]);

    await expect(repo.updateBallot('b-1', { status: 'submitted' })).resolves.toEqual(row);
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'submitted', updated_at: expect.anything() }),
    );
  });

  it('updateBallot compare-and-swaps on draft so a submitted ballot cannot be overwritten', async () => {
    db.returning.mockResolvedValueOnce([]);

    await expect(
      repo.updateBallot('b-1', { choice: 'no' }, { expectedStatus: 'draft' }),
    ).resolves.toBeNull();
  });

  it('updateBallotsBySessionId flips every ballot in one set-based statement', async () => {
    const rows = [{ id: 'b-1' }, { id: 'b-2' }];
    db.returning.mockResolvedValueOnce(rows);

    await expect(
      repo.updateBallotsBySessionId('vs-1', { status: 'draft', submitted_at: null }),
    ).resolves.toEqual(rows);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('updateBallotsBySessionId narrows to one prior status when asked', async () => {
    db.returning.mockResolvedValueOnce([]);

    await repo.updateBallotsBySessionId(
      'vs-1',
      { status: 'submitted' },
      { onlyStatus: 'draft' },
    );

    // session id + workspace guard + status filter all land in a single where()
    expect(db.where).toHaveBeenCalledTimes(2); // the workspace subquery adds one
  });

  it('updateBallotsBySessionId can target only ballots with no choice yet', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'b-1' }]);

    await expect(
      repo.updateBallotsBySessionId(
        'vs-1',
        { status: 'submitted', choice: 'inconclusive' },
        { onlyStatus: 'draft', choiceIsNull: true },
      ),
    ).resolves.toEqual([{ id: 'b-1' }]);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('updateBallotsBySessionId can target only ballots that already have a choice', async () => {
    db.returning.mockResolvedValueOnce([{ id: 'b-2' }]);

    await expect(
      repo.updateBallotsBySessionId(
        'vs-1',
        { status: 'submitted' },
        { onlyStatus: 'draft', choiceIsNull: false },
      ),
    ).resolves.toEqual([{ id: 'b-2' }]);
  });

  it('findCompanyNames returns null for a company outside the workspace', async () => {
    db.limit.mockResolvedValueOnce([]);

    await expect(repo.findCompanyNames('c-9')).resolves.toBeNull();
  });

  it('findCompanyNames returns just the naming columns', async () => {
    const row = { id: 'c-1', target: 'Acme', project_name: 'Project Highway' };
    db.limit.mockResolvedValueOnce([row]);

    await expect(repo.findCompanyNames('c-1')).resolves.toEqual(row);
  });
});

describe('CompanyVoteRepository.listOpenBallotsByVoter', () => {
  function makeJoinDb(rows: unknown[]) {
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    const db = { select: vi.fn().mockReturnValue(chain) };
    return { db, chain };
  }

  it('scopes to draft ballots on active sessions in this workspace', async () => {
    const { db, chain } = makeJoinDb([]);
    const repo = new CompanyVoteRepository(db as never, 'ws-1');

    await repo.listOpenBallotsByVoter('user-1');

    const { params } = new PgDialect().sqlToQuery(chain.where.mock.calls[0][0] as SQL);
    expect(params).toEqual(
      expect.arrayContaining(['user-1', 'draft', 'active', 'ws-1']),
    );
  });

  it('joins the company in so the caller never looks one up per ballot', async () => {
    const rows = [
      {
        ballot_id: 'b-1',
        session_id: 'vs-1',
        company_id: 'c-1',
        company_target: 'Acme',
        company_project_name: 'Project Highway',
        deadline_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { db, chain } = makeJoinDb(rows);
    const repo = new CompanyVoteRepository(db as never, 'ws-1');

    await expect(repo.listOpenBallotsByVoter('user-1')).resolves.toEqual(rows);
    expect(chain.innerJoin).toHaveBeenCalledTimes(2);
  });

  it('orders by the soonest deadline and bounds the result', async () => {
    const { db, chain } = makeJoinDb([]);
    const repo = new CompanyVoteRepository(db as never, 'ws-1');

    await repo.listOpenBallotsByVoter('user-1');
    const { sql: orderText } = new PgDialect().sqlToQuery(
      chain.orderBy.mock.calls[0][0] as SQL,
    );
    expect(orderText).toContain('"deadline_at" asc');
    expect(chain.limit).toHaveBeenCalledWith(10);

    await repo.listOpenBallotsByVoter('user-1', 4);
    expect(chain.limit).toHaveBeenLastCalledWith(4);
  });
});
