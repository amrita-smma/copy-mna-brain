import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlInvestmentTypeService } from './flInvestmentTypeService';
import { EntityNotFoundError, InvalidMasterDataError } from './flErrors';

const mocks = vi.hoisted(() => ({
  findByWorkspaceId: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  assetUpdate: vi.fn(),
}));

const typeRepo = {
  findByWorkspaceId: mocks.findByWorkspaceId,
  findById: mocks.findById,
  create: mocks.create,
  update: mocks.update,
  delete: mocks.delete,
};
const assetRepo = { update: mocks.assetUpdate };
const tx = { tx: true };
const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };

const type = (id: string, name: string, sort_order: number) => ({
  id,
  workspace_id: 'ws-1',
  name,
  sort_order,
});

describe('FlInvestmentTypeService', () => {
  let service: FlInvestmentTypeService;

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    service = new FlInvestmentTypeService(db as never, typeRepo as never, assetRepo as never);
  });

  describe('FlInvestmentTypeService.list', () => {
    it('returns the repository list for the workspace', async () => {
      mocks.findByWorkspaceId.mockResolvedValue([type('t1', 'Others', 0)]);
      await expect(service.list('ws-1')).resolves.toEqual([type('t1', 'Others', 0)]);
      expect(mocks.findByWorkspaceId).toHaveBeenCalledWith('ws-1', undefined);
    });
  });

  describe('FlInvestmentTypeService.create', () => {
    it('trims the name and appends after the highest sort order', async () => {
      mocks.findByWorkspaceId.mockResolvedValue([type('t1', 'Venture Capital', 0), type('t2', 'Others', 4)]);
      mocks.create.mockImplementation(async (data) => ({ id: 'new', ...data }));

      const created = await service.create('ws-1', '  Infrastructure ');

      expect(mocks.create).toHaveBeenCalledWith(
        { workspace_id: 'ws-1', name: 'Infrastructure', sort_order: 5 },
        tx,
      );
      expect(created.name).toBe('Infrastructure');
    });

    it('rejects a blank name without touching the DB', async () => {
      await expect(service.create('ws-1', '   ')).rejects.toBeInstanceOf(InvalidMasterDataError);
      expect(mocks.findByWorkspaceId).not.toHaveBeenCalled();
    });

    it('rejects a case-insensitive duplicate', async () => {
      mocks.findByWorkspaceId.mockResolvedValue([type('t1', 'Private Equity', 0)]);
      await expect(service.create('ws-1', 'private equity')).rejects.toBeInstanceOf(InvalidMasterDataError);
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('FlInvestmentTypeService.rename', () => {
    it('renames a type, allowing its own name in another case', async () => {
      mocks.findByWorkspaceId.mockResolvedValue([type('t1', 'Others', 0)]);
      mocks.update.mockResolvedValue(type('t1', 'OTHERS', 0));

      await service.rename('ws-1', 't1', 'OTHERS');
      expect(mocks.update).toHaveBeenCalledWith('ws-1', 't1', { name: 'OTHERS' }, tx);
    });

    it('rejects a name used by another type', async () => {
      mocks.findByWorkspaceId.mockResolvedValue([type('t1', 'Others', 0), type('t2', 'Unrealized', 1)]);
      await expect(service.rename('ws-1', 't1', 'unrealized')).rejects.toBeInstanceOf(InvalidMasterDataError);
    });

    it('throws EntityNotFoundError for an unknown id', async () => {
      mocks.findByWorkspaceId.mockResolvedValue([]);
      await expect(service.rename('ws-1', 'nope', 'X')).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  });

  describe('FlInvestmentTypeService.delete', () => {
    it('deletes an existing type', async () => {
      mocks.findById.mockResolvedValue(type('t1', 'Others', 0));
      await service.delete('ws-1', 't1');
      expect(mocks.delete).toHaveBeenCalledWith('ws-1', 't1', tx);
    });

    it('throws EntityNotFoundError when the type is missing', async () => {
      mocks.findById.mockResolvedValue(undefined);
      await expect(service.delete('ws-1', 't1')).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(mocks.delete).not.toHaveBeenCalled();
    });
  });

  describe('FlInvestmentTypeService.assignAsset', () => {
    it('assigns an asset to an existing type', async () => {
      mocks.findById.mockResolvedValue(type('t1', 'Others', 0));
      mocks.assetUpdate.mockResolvedValue({ id: 'a1', investment_type_id: 't1' });

      await service.assignAsset('ws-1', 'a1', 't1');
      expect(mocks.assetUpdate).toHaveBeenCalledWith('ws-1', 'a1', { investment_type_id: 't1' }, tx);
    });

    it('unassigns with null without looking up a type', async () => {
      mocks.assetUpdate.mockResolvedValue({ id: 'a1', investment_type_id: null });
      await service.assignAsset('ws-1', 'a1', null);
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.assetUpdate).toHaveBeenCalledWith('ws-1', 'a1', { investment_type_id: null }, tx);
    });

    it('refuses a type from outside the workspace', async () => {
      mocks.findById.mockResolvedValue(undefined);
      await expect(service.assignAsset('ws-1', 'a1', 'other-ws-type')).rejects.toBeInstanceOf(EntityNotFoundError);
      expect(mocks.assetUpdate).not.toHaveBeenCalled();
    });

    it('throws EntityNotFoundError when the asset is missing', async () => {
      mocks.assetUpdate.mockResolvedValue(undefined);
      await expect(service.assignAsset('ws-1', 'missing', null)).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  });
});
