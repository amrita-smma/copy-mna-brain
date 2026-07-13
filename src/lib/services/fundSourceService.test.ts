import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundSourceService, FundSourceNotFoundError } from './fundSourceService';
import type { FundSourceRepository } from '@/lib/repositories';

describe('FundSourceService', () => {
  let repo: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let service: FundSourceService;

  beforeEach(() => {
    repo = { findAll: vi.fn(), findById: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    service = new FundSourceService(repo as unknown as FundSourceRepository);
  });

  it('listFundSources delegates to repo.findAll', async () => {
    repo.findAll.mockResolvedValueOnce([{ id: 's1' }]);
    expect(await service.listFundSources()).toEqual([{ id: 's1' }]);
  });

  it('createFundSource delegates to repo.insert', async () => {
    repo.insert.mockResolvedValueOnce({ id: 's1', name: 'Source' });
    expect(await service.createFundSource({ name: 'Source' } as never)).toEqual({
      id: 's1',
      name: 'Source',
    });
  });

  it('updateFundSource throws FundSourceNotFoundError when missing', async () => {
    repo.update.mockResolvedValueOnce(undefined);
    await expect(service.updateFundSource('missing', { name: 'x' })).rejects.toBeInstanceOf(
      FundSourceNotFoundError,
    );
  });

  it('deleteFundSource throws and does not delete when the source does not exist', async () => {
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteFundSource('missing')).rejects.toBeInstanceOf(
      FundSourceNotFoundError,
    );
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deleteFundSource deletes once it is confirmed to exist', async () => {
    repo.findById.mockResolvedValueOnce({ id: 's1' });
    await service.deleteFundSource('s1');
    expect(repo.delete).toHaveBeenCalledWith('s1');
  });
});
