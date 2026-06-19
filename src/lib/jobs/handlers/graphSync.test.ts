import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAll: vi.fn(),
  syncFromDatabase: vi.fn(),
  createNeo4jDriver: vi.fn(() => ({})),
}));

vi.mock('@/lib/neo4j', () => ({ createNeo4jDriver: mocks.createNeo4jDriver }));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {
    findAll = mocks.findAll;
  },
}));

vi.mock('@/lib/repositories/companyRelationRepository', () => ({
  CompanyRelationRepository: class {},
}));

vi.mock('@/lib/services/companyGraphService', () => ({
  CompanyGraphService: class {
    syncFromDatabase = mocks.syncFromDatabase;
  },
}));

import { runGraphSync } from './graphSync';

afterEach(() => vi.clearAllMocks());

describe('runGraphSync', () => {
  it('feeds every Postgres company into the reconciliation and returns its result', async () => {
    const companies = [{ id: 'c1' }, { id: 'c2' }];
    mocks.findAll.mockResolvedValue(companies);
    mocks.syncFromDatabase.mockResolvedValue({ upserted: 2, deleted: 1 });

    const result = await runGraphSync({ db: {} as never });

    expect(mocks.findAll).toHaveBeenCalledTimes(1);
    expect(mocks.syncFromDatabase).toHaveBeenCalledWith(companies);
    expect(result).toEqual({ upserted: 2, deleted: 1 });
  });
});
