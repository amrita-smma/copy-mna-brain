import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRepository } from '@/lib/repositories';
import { UserService } from './userService';

function makeUserRepoStub(): UserRepository {
  return {
    findAll: vi.fn(),
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
    service = new UserService(userRepo);
  });

  describe('list', () => {
    it('returns all users from the user repository', async () => {
      const users = [
        { id: '1', name: 'Alice', email: 'a@x.com', role: 'admin' },
        { id: '2', name: 'Bob', email: 'b@x.com', role: 'user' },
      ];
      vi.mocked(userRepo.findAll).mockResolvedValue(users as never);

      const result = await service.list();

      expect(result).toEqual(users);
      expect(userRepo.findAll).toHaveBeenCalledTimes(1);
    });
  });
});
