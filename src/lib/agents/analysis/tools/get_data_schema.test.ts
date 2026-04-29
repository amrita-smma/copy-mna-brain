import { afterEach, describe, expect, it, vi } from 'vitest';

const countAllMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: function CompanyRepository() {
    return { countAll: countAllMock };
  },
}));

import { getDataSchema } from './get_data_schema';

afterEach(() => vi.clearAllMocks());

describe('getDataSchema', () => {
  it('returns the schema sections and the row count from the repo', async () => {
    countAllMock.mockResolvedValue(42);

    const result = (await getDataSchema.invoke({})) as string;

    expect(result).toContain('## Companies Data Schema');
    expect(result).toContain('**Total Rows:** 42');
    expect(result).toContain('company_financials');
    expect(result).toContain('company_fx_adjustments');
  });

  it('still produces the schema if the row count lookup throws', async () => {
    countAllMock.mockRejectedValue(new Error('db down'));

    const result = (await getDataSchema.invoke({})) as string;

    expect(result).toContain('**Total Rows:** 0');
    expect(result).toContain('## Companies Data Schema');
  });
});
