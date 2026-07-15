import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureFlagRepository } from './featureFlagRepository';

// Chainable db mock. `findByWorkspace` awaits `.orderBy()`; `getOverrideMap`
// awaits `.where()`; `upsert` awaits `.onConflictDoUpdate()`.
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.leftJoin.mockReturnThis();
  mockDb.where.mockReturnThis();
  mockDb.insert.mockReturnThis();
  mockDb.values.mockReturnThis();
}

describe('FeatureFlagRepository.findByWorkspace', () => {
  let repo: FeatureFlagRepository;

  beforeEach(() => {
    resetDb();
    repo = new FeatureFlagRepository(mockDb as never);
  });

  it('builds an override map and takes the latest row for audit meta', async () => {
    mockDb.orderBy.mockResolvedValueOnce([
      {
        featureKey: 'PIPELINE_ENABLED',
        enabled: false,
        updatedAt: '2026-07-14T10:00:00.000Z',
        updatedById: 'u1',
        updatedByName: 'Jane',
        updatedByEmail: 'jane@x.com',
      },
      {
        featureKey: 'CRM_ENABLED',
        enabled: true,
        updatedAt: '2026-07-13T10:00:00.000Z',
        updatedById: 'u2',
        updatedByName: 'Bob',
        updatedByEmail: 'bob@x.com',
      },
    ]);

    const result = await repo.findByWorkspace('ws-1');

    expect(result.overrides).toEqual({ PIPELINE_ENABLED: false, CRM_ENABLED: true });
    expect(result.updatedAt).toBe('2026-07-14T10:00:00.000Z');
    expect(result.updatedBy).toEqual({ id: 'u1', name: 'Jane', email: 'jane@x.com' });
  });

  it('returns empty overrides and null meta when the workspace has no rows', async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);
    const result = await repo.findByWorkspace('ws-1');
    expect(result).toEqual({ overrides: {}, updatedAt: null, updatedBy: null });
  });

  it('reports null updatedBy when the latest row has no user', async () => {
    mockDb.orderBy.mockResolvedValueOnce([
      {
        featureKey: 'PIPELINE_ENABLED',
        enabled: true,
        updatedAt: '2026-07-14T10:00:00.000Z',
        updatedById: null,
        updatedByName: null,
        updatedByEmail: null,
      },
    ]);
    const result = await repo.findByWorkspace('ws-1');
    expect(result.updatedBy).toBeNull();
  });
});

describe('FeatureFlagRepository.getOverrideMap', () => {
  let repo: FeatureFlagRepository;

  beforeEach(() => {
    resetDb();
    repo = new FeatureFlagRepository(mockDb as never);
  });

  it('returns a plain feature key → enabled map', async () => {
    mockDb.where.mockResolvedValueOnce([
      { featureKey: 'PIPELINE_ENABLED', enabled: false },
      { featureKey: 'CRM_ENABLED', enabled: true },
    ]);
    await expect(repo.getOverrideMap('ws-1')).resolves.toEqual({
      PIPELINE_ENABLED: false,
      CRM_ENABLED: true,
    });
  });
});

describe('FeatureFlagRepository.upsert', () => {
  let repo: FeatureFlagRepository;

  beforeEach(() => {
    resetDb();
    repo = new FeatureFlagRepository(mockDb as never);
  });

  it('inserts the row with the toggle values', async () => {
    mockDb.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    await repo.upsert('ws-1', 'PIPELINE_ENABLED', false, 'u1');

    expect(mockDb.values).toHaveBeenCalledWith({
      workspace_id: 'ws-1',
      feature_key: 'PIPELINE_ENABLED',
      enabled: false,
      updated_by: 'u1',
    });
    expect(mockDb.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });
});
