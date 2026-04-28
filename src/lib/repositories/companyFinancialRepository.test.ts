import { describe, expect, it, vi } from 'vitest';
import { CompanyFinancialRepository } from './companyFinancialRepository';

function makeDb(deleteMock = vi.fn()) {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  deleteMock.mockReturnValue({ where: whereMock });
  return { db: { delete: deleteMock } as any, whereMock, deleteMock };
}

describe('CompanyFinancialRepository.deleteByCompanyAndYears', () => {
  it('makes no DB call when years array is empty', async () => {
    const { db, deleteMock } = makeDb();
    const repo = new CompanyFinancialRepository(db);

    await repo.deleteByCompanyAndYears('company-1', []);

    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('calls db.delete with the correct table and where clause for non-empty years', async () => {
    const { db, deleteMock, whereMock } = makeDb();
    const repo = new CompanyFinancialRepository(db);

    await repo.deleteByCompanyAndYears('company-1', [2021, 2022]);

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
