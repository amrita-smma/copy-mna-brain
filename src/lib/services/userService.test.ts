import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRepository } from '@/lib/repositories';
import { UserService } from './userService';

function makeUserRepoStub(): UserRepository {
  return {
    findAll: vi.fn(),
    findAllInWorkspace: vi.fn(),
    findByEmail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as UserRepository;
}

describe('UserService', () => {
  let userRepo: UserRepository;
  let service: UserService;

  beforeEach(() => {
    userRepo = makeUserRepoStub();
    service = new UserService(userRepo, 'ws-1');
  });

  describe('list', () => {
    it("returns the current workspace's members", async () => {
      const users = [
        { id: '1', name: 'Alice', email: 'a@x.com', role: 'admin' },
        { id: '2', name: 'Bob', email: 'b@x.com', role: 'user' },
      ];
      vi.mocked(userRepo.findAllInWorkspace).mockResolvedValue(users as never);

      const result = await service.list();

      expect(result).toEqual(users);
      expect(userRepo.findAllInWorkspace).toHaveBeenCalledWith('ws-1');
      expect(userRepo.findAllInWorkspace).toHaveBeenCalledTimes(1);
    });

    it('never falls back to the unscoped findAll', async () => {
      vi.mocked(userRepo.findAllInWorkspace).mockResolvedValue([] as never);

      await service.list();

      expect(userRepo.findAll).not.toHaveBeenCalled();
    });
  });

  describe('listAll', () => {
    it('returns the global directory for the superadmin admin portal', async () => {
      const users = [{ id: '1', name: 'Alice', email: 'a@x.com', role: 'admin' }];
      vi.mocked(userRepo.findAll).mockResolvedValue(users as never);

      const result = await service.listAll();

      expect(result).toEqual(users);
      expect(userRepo.findAll).toHaveBeenCalledTimes(1);
      expect(userRepo.findAllInWorkspace).not.toHaveBeenCalled();
    });
  });
});
