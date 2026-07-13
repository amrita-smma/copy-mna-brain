import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HoldingEntityService, HoldingEntityNotFoundError } from './holdingEntityService';
import type { HoldingEntityRepository } from '@/lib/repositories';

describe('HoldingEntityService', () => {
  let repo: {
    findAll: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let service: HoldingEntityService;

  beforeEach(() => {
    repo = { findAll: vi.fn(), findById: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    service = new HoldingEntityService(repo as unknown as HoldingEntityRepository);
  });

  it('listHoldingEntities delegates to repo.findAll', async () => {
    repo.findAll.mockResolvedValueOnce([{ id: 'i1' }]);
    expect(await service.listHoldingEntities()).toEqual([{ id: 'i1' }]);
  });

  it('createHoldingEntity delegates to repo.insert', async () => {
    repo.insert.mockResolvedValueOnce({ id: 'i1', name: 'Entity' });
    expect(await service.createHoldingEntity({ name: 'Entity' } as never)).toEqual({
      id: 'i1',
      name: 'Entity',
    });
  });

  it('updateHoldingEntity throws HoldingEntityNotFoundError when missing', async () => {
    repo.update.mockResolvedValueOnce(undefined);
    await expect(service.updateHoldingEntity('missing', { name: 'x' })).rejects.toBeInstanceOf(
      HoldingEntityNotFoundError,
    );
  });

  it('updateHoldingEntity returns the updated row on success', async () => {
    repo.update.mockResolvedValueOnce({ id: 'i1', name: 'Renamed' });
    expect(await service.updateHoldingEntity('i1', { name: 'Renamed' })).toEqual({
      id: 'i1',
      name: 'Renamed',
    });
  });

  it('deleteHoldingEntity throws and does not delete when the holdingEntity does not exist', async () => {
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteHoldingEntity('missing')).rejects.toBeInstanceOf(HoldingEntityNotFoundError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deleteHoldingEntity deletes once it is confirmed to exist', async () => {
    repo.findById.mockResolvedValueOnce({ id: 'i1' });
    await service.deleteHoldingEntity('i1');
    expect(repo.delete).toHaveBeenCalledWith('i1');
  });
});
