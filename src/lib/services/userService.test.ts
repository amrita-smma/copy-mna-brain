import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRepository } from '@/lib/repositories';
import type { AuthService } from './authService';
import {
  CannotDeactivateSelfError,
  CannotDeleteSelfError,
  DeleteConfirmationMismatchError,
  UserHasRetainedHistoryError,
  UserNotDeactivatedError,
  UserNotFoundError,
  UserService,
} from './userService';

function makeUserRepoStub(): UserRepository {
  return {
    findAll: vi.fn(),
    findAllInWorkspace: vi.fn(),
    findAllIncludingDeactivated: vi.fn(),
    findByEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deactivate: vi.fn(),
    reactivate: vi.fn(),
    hasDeleteBlockingHistory: vi.fn(),
    hardDeleteDeactivated: vi.fn(),
  } as unknown as UserRepository;
}

function makeAuthServiceStub(): AuthService {
  return {
    forgetPassword: vi.fn(),
  } as unknown as AuthService;
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    name: 'Alice',
    email: 'alice@x.com',
    role: null,
    is_superadmin: false,
    deactivated_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    password: 'hash',
    ...overrides,
  };
}

function adminShape(user: ReturnType<typeof makeUser>) {
  const { id, name, email, role, is_superadmin, deactivated_at, created_at } = user;
  return { id, name, email, role, is_superadmin, deactivated_at, created_at };
}

describe('UserService', () => {
  let userRepo: UserRepository;
  let authService: AuthService;
  let service: UserService;

  beforeEach(() => {
    userRepo = makeUserRepoStub();
    authService = makeAuthServiceStub();
    service = new UserService(userRepo, 'ws-1', authService);
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

  describe('listAllForAdmin', () => {
    it('returns every user, deactivated ones included', async () => {
      const users = [makeUser(), makeUser({ id: 'u2', deactivated_at: '2026-02-01T00:00:00.000Z' })];
      vi.mocked(userRepo.findAllIncludingDeactivated).mockResolvedValue(users as never);

      const result = await service.listAllForAdmin();

      expect(result).toEqual(users);
      expect(userRepo.findAllIncludingDeactivated).toHaveBeenCalledTimes(1);
    });
  });

  describe('deactivateUser', () => {
    it('throws CannotDeactivateSelfError when the actor targets themselves', async () => {
      await expect(service.deactivateUser('u1', 'u1')).rejects.toBeInstanceOf(
        CannotDeactivateSelfError,
      );
      expect(userRepo.findById).not.toHaveBeenCalled();
    });

    it('throws UserNotFoundError for an unknown id', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);
      await expect(service.deactivateUser('admin', 'nope')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });

    it('is idempotent — an already-deactivated user is returned unchanged', async () => {
      const deactivated = makeUser({ deactivated_at: '2026-02-01T00:00:00.000Z' });
      vi.mocked(userRepo.findById).mockResolvedValue(deactivated as never);

      const result = await service.deactivateUser('admin', 'u1');

      expect(result).toEqual(adminShape(deactivated));
      expect(result).not.toHaveProperty('password');
      expect(userRepo.deactivate).not.toHaveBeenCalled();
    });

    it('deactivates an active user', async () => {
      const active = makeUser();
      const deactivated = { ...active, deactivated_at: '2026-02-01T00:00:00.000Z' };
      vi.mocked(userRepo.findById).mockResolvedValue(active as never);
      vi.mocked(userRepo.deactivate).mockResolvedValue(deactivated as never);

      const result = await service.deactivateUser('admin', 'u1');

      expect(userRepo.deactivate).toHaveBeenCalledWith('u1');
      expect(result).toEqual(adminShape(deactivated));
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('reactivateUser', () => {
    it('throws UserNotFoundError for an unknown id', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);
      await expect(service.reactivateUser('nope')).rejects.toBeInstanceOf(UserNotFoundError);
    });

    it('is a no-op for a user that is not deactivated', async () => {
      const active = makeUser();
      vi.mocked(userRepo.findById).mockResolvedValue(active as never);

      const result = await service.reactivateUser('u1');

      expect(result).toEqual(adminShape(active));
      expect(result).not.toHaveProperty('password');
      expect(userRepo.reactivate).not.toHaveBeenCalled();
    });

    it('reactivates a deactivated user', async () => {
      const deactivated = makeUser({ deactivated_at: '2026-02-01T00:00:00.000Z' });
      const reactivated = { ...deactivated, deactivated_at: null };
      vi.mocked(userRepo.findById).mockResolvedValue(deactivated as never);
      vi.mocked(userRepo.reactivate).mockResolvedValue(reactivated as never);

      const result = await service.reactivateUser('u1');

      expect(userRepo.reactivate).toHaveBeenCalledWith('u1');
      expect(result).toEqual(adminShape(reactivated));
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('hardDeleteUser', () => {
    const deactivated = () => makeUser({ deactivated_at: '2026-02-01T00:00:00.000Z' });

    it('throws CannotDeleteSelfError when the actor targets themselves', async () => {
      await expect(service.hardDeleteUser('u1', 'u1', 'Alice')).rejects.toBeInstanceOf(
        CannotDeleteSelfError,
      );
      expect(userRepo.findById).not.toHaveBeenCalled();
    });

    it('throws UserNotFoundError for an unknown id', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);
      await expect(service.hardDeleteUser('admin', 'nope', 'Alice')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });

    it('refuses to delete a user who is still active', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser() as never);
      await expect(service.hardDeleteUser('admin', 'u1', 'Alice')).rejects.toBeInstanceOf(
        UserNotDeactivatedError,
      );
      expect(userRepo.hardDeleteDeactivated).not.toHaveBeenCalled();
    });

    it.each(['alice', 'Alice ', 'Alic', ''])(
      'refuses when the typed name %j is not an exact match',
      async (typed) => {
        vi.mocked(userRepo.findById).mockResolvedValue(deactivated() as never);
        await expect(service.hardDeleteUser('admin', 'u1', typed)).rejects.toBeInstanceOf(
          DeleteConfirmationMismatchError,
        );
        expect(userRepo.hardDeleteDeactivated).not.toHaveBeenCalled();
      },
    );

    it('refuses when the user has vote or routine history', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(deactivated() as never);
      vi.mocked(userRepo.hasDeleteBlockingHistory).mockResolvedValue(true);
      await expect(service.hardDeleteUser('admin', 'u1', 'Alice')).rejects.toBeInstanceOf(
        UserHasRetainedHistoryError,
      );
      expect(userRepo.hardDeleteDeactivated).not.toHaveBeenCalled();
    });

    it('maps a foreign-key violation during the delete to UserHasRetainedHistoryError', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(deactivated() as never);
      vi.mocked(userRepo.hasDeleteBlockingHistory).mockResolvedValue(false);
      vi.mocked(userRepo.hardDeleteDeactivated).mockRejectedValue(
        Object.assign(new Error('fk'), { code: '23503' }),
      );
      await expect(service.hardDeleteUser('admin', 'u1', 'Alice')).rejects.toBeInstanceOf(
        UserHasRetainedHistoryError,
      );
    });

    it('rethrows any other delete error unchanged', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(deactivated() as never);
      vi.mocked(userRepo.hasDeleteBlockingHistory).mockResolvedValue(false);
      const boom = new Error('boom');
      vi.mocked(userRepo.hardDeleteDeactivated).mockRejectedValue(boom);
      await expect(service.hardDeleteUser('admin', 'u1', 'Alice')).rejects.toBe(boom);
    });

    it('throws UserNotFoundError when a concurrent delete already removed the user', async () => {
      vi.mocked(userRepo.findById)
        .mockResolvedValueOnce(deactivated() as never)
        .mockResolvedValueOnce(null);
      vi.mocked(userRepo.hasDeleteBlockingHistory).mockResolvedValue(false);
      vi.mocked(userRepo.hardDeleteDeactivated).mockResolvedValue(undefined);
      await expect(service.hardDeleteUser('admin', 'u1', 'Alice')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });

    it('throws UserNotDeactivatedError when the user was reactivated before the delete ran', async () => {
      vi.mocked(userRepo.findById)
        .mockResolvedValueOnce(deactivated() as never)
        .mockResolvedValueOnce(makeUser() as never);
      vi.mocked(userRepo.hasDeleteBlockingHistory).mockResolvedValue(false);
      vi.mocked(userRepo.hardDeleteDeactivated).mockResolvedValue(undefined);
      await expect(service.hardDeleteUser('admin', 'u1', 'Alice')).rejects.toBeInstanceOf(
        UserNotDeactivatedError,
      );
    });

    it('deletes a deactivated user whose name was typed exactly', async () => {
      const user = deactivated();
      vi.mocked(userRepo.findById).mockResolvedValue(user as never);
      vi.mocked(userRepo.hasDeleteBlockingHistory).mockResolvedValue(false);
      vi.mocked(userRepo.hardDeleteDeactivated).mockResolvedValue(user as never);

      const result = await service.hardDeleteUser('admin', 'u1', 'Alice');

      expect(userRepo.hardDeleteDeactivated).toHaveBeenCalledWith('u1');
      expect(result).toEqual(adminShape(user));
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('updateProfile', () => {
    it('throws UserNotFoundError for an unknown id', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);
      await expect(service.updateProfile('nope', { name: 'X' })).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });

    it('throws when the name is blank', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser() as never);
      await expect(service.updateProfile('u1', { name: '   ' })).rejects.toThrow(
        'Name is required',
      );
    });

    it('throws when the email is blank', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser() as never);
      await expect(service.updateProfile('u1', { email: '   ' })).rejects.toThrow(
        'Email is required',
      );
    });

    it('throws when the new email already belongs to a different user', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser() as never);
      vi.mocked(userRepo.findByEmail).mockResolvedValue(makeUser({ id: 'other' }) as never);
      await expect(
        service.updateProfile('u1', { email: 'taken@x.com' }),
      ).rejects.toThrow('Email already registered');
    });

    it('allows keeping the same email (no uniqueness check against self)', async () => {
      const existing = makeUser({ email: 'alice@x.com' });
      vi.mocked(userRepo.findById).mockResolvedValue(existing as never);
      vi.mocked(userRepo.update).mockResolvedValue(existing as never);

      await service.updateProfile('u1', { email: 'Alice@X.com' });

      expect(userRepo.findByEmail).not.toHaveBeenCalled();
      expect(userRepo.update).toHaveBeenCalledWith('u1', { email: 'alice@x.com' });
    });

    it('updates name and email together, normalizing the email', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser() as never);
      vi.mocked(userRepo.findByEmail).mockResolvedValue(null);
      const updated = makeUser({ name: 'Alicia', email: 'new@x.com' });
      vi.mocked(userRepo.update).mockResolvedValue(updated as never);

      const result = await service.updateProfile('u1', {
        name: '  Alicia  ',
        email: '  New@X.com  ',
      });

      expect(userRepo.update).toHaveBeenCalledWith('u1', { name: 'Alicia', email: 'new@x.com' });
      expect(result).toEqual(adminShape(updated));
      expect(result).not.toHaveProperty('password');
    });

    it('returns the existing row unchanged when no fields are given', async () => {
      const existing = makeUser();
      vi.mocked(userRepo.findById).mockResolvedValue(existing as never);

      const result = await service.updateProfile('u1', {});

      expect(result).toEqual(adminShape(existing));
      expect(result).not.toHaveProperty('password');
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('sendResetLink', () => {
    it('throws UserNotFoundError for an unknown id', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(null);
      await expect(service.sendResetLink('nope', 'https://x.com')).rejects.toBeInstanceOf(
        UserNotFoundError,
      );
    });

    it('throws when the user has no email on file', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser({ email: null }) as never);
      await expect(service.sendResetLink('u1', 'https://x.com')).rejects.toThrow(
        'This user has no email on file',
      );
    });

    it('delegates to AuthService.forgetPassword with the user\'s email', async () => {
      vi.mocked(userRepo.findById).mockResolvedValue(makeUser({ email: 'alice@x.com' }) as never);

      await service.sendResetLink('u1', 'https://app.example.com');

      expect(authService.forgetPassword).toHaveBeenCalledWith('alice@x.com', 'https://app.example.com');
    });
  });
});
