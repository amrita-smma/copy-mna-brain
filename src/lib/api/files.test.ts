import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiRequest: apiRequestMock,
}));

import { searchFiles } from './files';

describe('searchFiles', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it('requests page 1 with the given search term and lite=true', async () => {
    apiRequestMock.mockResolvedValueOnce([]);

    await searchFiles({ search: 'acme' });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/smart-files?pageSize=20&page=1&lite=true&search=acme',
    );
  });

  it('omits the search param entirely when not given (browse mode)', async () => {
    apiRequestMock.mockResolvedValueOnce([]);

    await searchFiles({});

    expect(apiRequestMock).toHaveBeenCalledWith('/api/smart-files?pageSize=20&page=1&lite=true');
  });

  it('includes sortField/sortDirection when given', async () => {
    apiRequestMock.mockResolvedValueOnce([]);

    await searchFiles({ sortField: 'created_at', sortDirection: 'desc' });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/smart-files?pageSize=20&page=1&lite=true&sortField=created_at&sortDirection=desc',
    );
  });

  it('respects a custom limit', async () => {
    apiRequestMock.mockResolvedValueOnce([]);

    await searchFiles({ search: 'acme', limit: 5 });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/smart-files?pageSize=5&page=1&lite=true&search=acme',
    );
  });

  it('converts an offset into the corresponding page number', async () => {
    apiRequestMock.mockResolvedValueOnce([]);

    await searchFiles({ search: 'acme', limit: 20, offset: 40 });

    expect(apiRequestMock).toHaveBeenCalledWith(
      '/api/smart-files?pageSize=20&page=3&lite=true&search=acme',
    );
  });

  it('returns whatever apiRequest resolves with', async () => {
    const rows = [{ id: '1', file_name: 'a.pdf', file_link: 'k1' }];
    apiRequestMock.mockResolvedValueOnce(rows);

    const result = await searchFiles({ search: 'a' });

    expect(result).toBe(rows);
  });
});
