import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvestmentThesisRepository } from './investmentThesisRepository';

// Chainable db mock. `findAll` awaits `.orderBy()`; `deleteById` awaits `.where()`.
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
  delete: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.where.mockReturnThis();
  mockDb.delete.mockReturnThis();
  mockDb.update.mockReturnThis();
  mockDb.set.mockReturnThis();
}

describe('InvestmentThesisRepository.findAll', () => {
  let repo: InvestmentThesisRepository;

  beforeEach(() => {
    resetDb();
    repo = new InvestmentThesisRepository(mockDb as never);
  });

  it('returns all theses ordered by the query', async () => {
    const rows = [{ id: 't1' }, { id: 't2' }];
    mockDb.orderBy.mockResolvedValueOnce(rows);

    await expect(repo.findAll()).resolves.toBe(rows);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
  });
});

describe('InvestmentThesisRepository.deleteById', () => {
  let repo: InvestmentThesisRepository;

  beforeEach(() => {
    resetDb();
    repo = new InvestmentThesisRepository(mockDb as never);
  });

  it('deletes the row matching the id', async () => {
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.deleteById('t1');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });
});

describe('InvestmentThesisRepository.setActive', () => {
  let repo: InvestmentThesisRepository;

  beforeEach(() => {
    resetDb();
    repo = new InvestmentThesisRepository(mockDb as never);
  });

  it('deactivates all theses then activates the given ids', async () => {
    await repo.setActive(['t1', 't2']);

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(mockDb.set).toHaveBeenNthCalledWith(1, { is_active: false });
    expect(mockDb.set).toHaveBeenNthCalledWith(2, { is_active: true });
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('only deactivates when the active set is empty', async () => {
    await repo.setActive([]);

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({ is_active: false });
    expect(mockDb.where).not.toHaveBeenCalled();
  });
});

describe('InvestmentThesisRepository.updateMany', () => {
  let repo: InvestmentThesisRepository;

  beforeEach(() => {
    resetDb();
    repo = new InvestmentThesisRepository(mockDb as never);
  });

  it('applies updates to the given ids', async () => {
    await repo.updateMany(['t1', 't2'], { scan_frequency: 'monthly' });

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledWith({ scan_frequency: 'monthly' });
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for an empty id list', async () => {
    await repo.updateMany([], { scan_frequency: 'monthly' });

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
