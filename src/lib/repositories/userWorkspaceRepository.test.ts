import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserWorkspaceRepository } from './userWorkspaceRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
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

/**
 * Column names referenced by a Drizzle `where(...)` expression. Lets these
 * chain-mock tests assert on the PREDICATE (e.g. that soft-deleted workspaces
 * are filtered out) rather than only on how many times `where` was called.
 */
function columnNamesInSql(node: unknown, acc: string[] = []): string[] {
  const chunks = (node as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return acc;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
      columnNamesInSql(chunk, acc);
    } else if (typeof (chunk as { name?: unknown }).name === 'string') {
      acc.push((chunk as { name: string }).name);
    }
  }
  return acc;
}

describe('UserWorkspaceRepository', () => {
  let mockDb: MockDb;
  let repo: UserWorkspaceRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
    };
    repo = new UserWorkspaceRepository(mockDb as never);
  });

  it('findByUserId returns every membership row for the user', async () => {
    const rows = [{ id: 'uw1', user_id: 'u1', workspace_id: 'w1', role_id: 'r1' }];
    mockDb.where.mockResolvedValueOnce(rows);

    const result = await repo.findByUserId('u1');

    expect(result).toEqual(rows);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('findByWorkspaceId returns every membership row for the workspace', async () => {
    const rows = [{ id: 'uw1', user_id: 'u1', workspace_id: 'w1', role_id: 'r1' }];
    mockDb.where.mockResolvedValueOnce(rows);

    const result = await repo.findByWorkspaceId('w1');

    expect(result).toEqual(rows);
  });

  it('insert returns the inserted row', async () => {
    const row = { id: 'uw1', user_id: 'u1', workspace_id: 'w1', role_id: 'r1' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.insert({ user_id: 'u1', workspace_id: 'w1', role_id: 'r1' } as never);

    expect(result).toEqual(row);
    expect(mockDb.values).toHaveBeenCalledWith({ user_id: 'u1', workspace_id: 'w1', role_id: 'r1' });
  });

  it('findWorkspaceIdsBySyncedEmail returns every workspace watching that email, oldest first', async () => {
    mockDb.orderBy.mockResolvedValueOnce([{ workspace_id: 'w1' }, { workspace_id: 'w2' }]);

    const result = await repo.findWorkspaceIdsBySyncedEmail('custodian@example.com');

    expect(result).toEqual(['w1', 'w2']);
    // users, workspaces, and user_consents — a synced-but-unconsented user
    // must be excluded, so the consent table is joined too.
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(3);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    // An archived workspace must stop pulling its custodian mailbox.
    expect(columnNamesInSql(mockDb.where.mock.calls[0][0])).toContain('deleted_at');
  });

  it('findWorkspaceIdsBySyncedEmail returns an empty array when no membership is synced for that email', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    const result = await repo.findWorkspaceIdsBySyncedEmail('unknown@example.com');

    expect(result).toEqual([]);
  });

  it('findMembershipsForUser returns joined workspace + role details, oldest workspace first', async () => {
    const rows = [
      { workspaceId: 'w1', workspaceName: 'MnA', workspaceSlug: 'mna', roleId: 'r1', roleName: 'editor', isEmailSynced: false },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findMembershipsForUser('u1');

    expect(result).toEqual(rows);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('findMembershipsForUser excludes memberships of a soft-deleted workspace', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    await repo.findMembershipsForUser('u1');

    // The `workspaces.deleted_at IS NULL` half of the predicate — this single
    // query backs the picker, the switcher and the JWT's workspaces claim.
    expect(columnNamesInSql(mockDb.where.mock.calls[0][0])).toContain('deleted_at');
  });

  it('findOne returns the membership row when it exists', async () => {
    const row = { id: 'uw1', user_id: 'u1', workspace_id: 'w1', role_id: 'r1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.findOne('u1', 'w1');

    expect(result).toEqual(row);
  });

  it('findOne returns undefined when no membership exists', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.findOne('u1', 'w-nonmember');

    expect(result).toBeUndefined();
  });

  it('hasAnySyncEnabled returns true when at least one membership has sync enabled', async () => {
    mockDb.limit.mockResolvedValueOnce([{ workspace_id: 'w1' }]);

    const result = await repo.hasAnySyncEnabled('u1');

    expect(result).toBe(true);
  });

  it('hasAnySyncEnabled returns false when no membership has sync enabled', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.hasAnySyncEnabled('u1');

    expect(result).toBe(false);
  });

  it('updateRole sets the new role_id and returns the updated row', async () => {
    const row = { id: 'uw1', user_id: 'u1', workspace_id: 'w1', role_id: 'r2' };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.updateRole('u1', 'w1', 'r2');

    expect(result).toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith({ role_id: 'r2' });
  });

  it('delete removes the membership row for the given user/workspace pair', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.delete('u1', 'w1');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('findMembersForWorkspace returns joined user + role details, ordered by name', async () => {
    const rows = [
      {
        userId: 'u1',
        userName: 'Alice',
        userEmail: 'alice@x',
        roleId: 'r1',
        roleName: 'editor',
        isEmailSynced: false,
        consentedAt: '2026-08-27T10:00:00.000Z',
        meetingIntelligenceConnectionId: 'mi1',
        gmailConnectionId: null,
      },
      {
        userId: 'u2',
        userName: 'Bob',
        userEmail: 'bob@x',
        roleId: 'r1',
        roleName: 'editor',
        isEmailSynced: true,
        consentedAt: null,
        meetingIntelligenceConnectionId: null,
        gmailConnectionId: 'g1',
      },
    ];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await repo.findMembersForWorkspace('w1');

    // `consentedAt` is collapsed into `hasConsented`, not exposed raw — a
    // member who hasn't accepted the consent screen still appears (via the
    // left join) but with `hasConsented: false`. Connection ids are collapsed
    // into `connectedApps` the same way.
    expect(result).toEqual([
      {
        userId: 'u1', userName: 'Alice', userEmail: 'alice@x', roleId: 'r1', roleName: 'editor', isEmailSynced: false, hasConsented: true,
        connectedApps: { meetingIntelligence: true, gmail: false },
      },
      {
        userId: 'u2', userName: 'Bob', userEmail: 'bob@x', roleId: 'r1', roleName: 'editor', isEmailSynced: true, hasConsented: false,
        connectedApps: { meetingIntelligence: false, gmail: true },
      },
    ]);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
    // user_consents, meeting_intelligence_connections, gmail_connections.
    expect(mockDb.leftJoin).toHaveBeenCalledTimes(3);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });

  it('updateEmailSync sets is_email_synced and returns the updated row', async () => {
    const row = { id: 'uw1', user_id: 'u1', workspace_id: 'w1', role_id: 'r1', is_email_synced: true };
    mockDb.returning.mockResolvedValueOnce([row]);

    const result = await repo.updateEmailSync('u1', 'w1', true);

    expect(result).toEqual(row);
    expect(mockDb.set).toHaveBeenCalledWith({ is_email_synced: true });
  });

  it('findSyncedCustodianEmails returns distinct emails flagged as synced', async () => {
    mockDb.where.mockResolvedValueOnce([
      { email: 'alice@x.com' },
      { email: 'bob@x.com' },
      { email: 'alice@x.com' },
    ]);

    const result = await repo.findSyncedCustodianEmails();

    expect(result).toEqual(['alice@x.com', 'bob@x.com']);
    // users, workspaces and user_consents — an is_email_synced user with no
    // recorded consent must never be returned as an eligible custodian
    // mailbox, and neither must one whose workspace has been archived.
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(3);
    expect(columnNamesInSql(mockDb.where.mock.calls[0][0])).toContain('deleted_at');
  });

  it('findSyncedCustodianEmails returns [] when nobody is synced', async () => {
    mockDb.where.mockResolvedValueOnce([]);

    const result = await repo.findSyncedCustodianEmails();

    expect(result).toEqual([]);
  });

  it('countSyncedCustodians counts distinct synced emails within one workspace', async () => {
    mockDb.where.mockResolvedValueOnce([{ email: 'alice@x.com' }, { email: 'bob@x.com' }]);

    const result = await repo.countSyncedCustodians('w1');

    expect(result).toBe(2);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
  });
});
