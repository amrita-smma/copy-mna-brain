import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserConsentRepository } from './userConsentRepository';

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.where.mockReturnThis();
  mockDb.insert.mockReturnThis();
  mockDb.values.mockReturnThis();
  mockDb.onConflictDoUpdate.mockReturnThis();
}

const ROW = {
  id: 'c1',
  user_id: 'u1',
  policy_version: 'v1',
  consented_at: '2026-08-27T10:00:00.000Z',
  created_at: '2026-08-27T10:00:00.000Z',
};

describe('UserConsentRepository.findByUserId', () => {
  let repo: UserConsentRepository;

  beforeEach(() => {
    resetDb();
    repo = new UserConsentRepository(mockDb as never);
  });

  it('returns the consent row for the user', async () => {
    mockDb.limit.mockResolvedValueOnce([ROW]);
    await expect(repo.findByUserId('u1')).resolves.toEqual(ROW);
  });

  it('returns null when the user has not consented', async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(repo.findByUserId('u2')).resolves.toBeNull();
  });
});

describe('UserConsentRepository.upsertConsent', () => {
  let repo: UserConsentRepository;

  beforeEach(() => {
    resetDb();
    repo = new UserConsentRepository(mockDb as never);
  });

  it('inserts with the given policy version and returns the row', async () => {
    mockDb.returning.mockResolvedValueOnce([ROW]);

    const result = await repo.upsertConsent('u1', 'v1');

    expect(mockDb.values).toHaveBeenCalledWith({ user_id: 'u1', policy_version: 'v1' });
    expect(result).toEqual(ROW);
  });

  it('re-consenting to a later policy version updates the existing row on conflict', async () => {
    const updatedRow = { ...ROW, policy_version: 'v2' };
    mockDb.returning.mockResolvedValueOnce([updatedRow]);

    const result = await repo.upsertConsent('u1', 'v2');

    const arg = mockDb.onConflictDoUpdate.mock.calls[0][0];
    expect(arg.set).toHaveProperty('policy_version', 'v2');
    expect(arg.set).toHaveProperty('consented_at');
    expect(result).toEqual(updatedRow);
  });
});
