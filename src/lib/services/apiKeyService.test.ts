import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApiKeyService,
  InvalidApiKeyError,
  InsufficientScopeError,
  ApiKeyNotFoundError,
  CHAT_WRITE_SCOPE,
} from './apiKeyService';
import type { ApiKeyRepository } from '@/lib/repositories';

describe('ApiKeyService', () => {
  let repo: {
    create: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    findActiveByPrefix: ReturnType<typeof vi.fn>;
    touchLastUsed: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  let service: ApiKeyService;

  beforeEach(() => {
    repo = {
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      getById: vi.fn(),
      findActiveByPrefix: vi.fn(),
      touchLastUsed: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn(),
    };
    service = new ApiKeyService(repo as unknown as ApiKeyRepository);
  });

  describe('issue', () => {
    it('mints an mna_-prefixed token and persists only the hash + prefix', async () => {
      repo.create.mockImplementation(async (row) => ({
        id: 'k1',
        last_used_at: null,
        revoked_at: null,
        created_at: '2026-06-06T00:00:00Z',
        ...row,
      }));

      const { token, key } = await service.issue({ name: 'partner' });

      expect(token).toMatch(/^mna_[0-9a-f]{48}$/);
      expect(key.id).toBe('k1');
      expect(key.name).toBe('partner');
      expect(key.scopes).toEqual([CHAT_WRITE_SCOPE]);
      // The view never carries the secret material.
      expect(key).not.toHaveProperty('key_hash');

      const stored = repo.create.mock.calls[0][0];
      expect(stored.name).toBe('partner');
      expect(stored.scopes).toEqual([CHAT_WRITE_SCOPE]);
      // Lookup prefix matches the secret portion, and the raw token is not stored.
      expect(token.startsWith(`mna_${stored.key_prefix}`)).toBe(true);
      expect(stored.key_hash).toMatch(/^scrypt\$/);
      expect(stored.key_hash).not.toContain(token);
    });

    it('honours custom scopes', async () => {
      repo.create.mockImplementation(async (row) => ({
        id: 'k1',
        last_used_at: null,
        revoked_at: null,
        created_at: '2026-06-06T00:00:00Z',
        ...row,
      }));

      const { key } = await service.issue({ name: 'ro', scopes: ['chat:read'] });

      expect(key.scopes).toEqual(['chat:read']);
    });
  });

  describe('list / get / update', () => {
    const row = {
      id: 'k1',
      name: 'partner',
      scopes: [CHAT_WRITE_SCOPE],
      key_prefix: 'abcd1234',
      key_hash: 'scrypt$x$y',
      last_used_at: null,
      revoked_at: null,
      created_at: '2026-06-06T00:00:00Z',
    };

    it('list returns views without the hash', async () => {
      repo.list.mockResolvedValueOnce([row]);

      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('key_hash');
      expect(result[0]).toMatchObject({ id: 'k1', key_prefix: 'abcd1234' });
    });

    it('get returns the view when found', async () => {
      repo.getById.mockResolvedValueOnce(row);
      const result = await service.get('k1');
      expect(result.id).toBe('k1');
      expect(result).not.toHaveProperty('key_hash');
    });

    it('get throws ApiKeyNotFoundError when missing', async () => {
      repo.getById.mockResolvedValueOnce(null);
      await expect(service.get('missing')).rejects.toBeInstanceOf(ApiKeyNotFoundError);
    });

    it('update passes through only provided fields and returns a view', async () => {
      repo.update.mockResolvedValueOnce({ ...row, name: 'renamed' });

      const result = await service.update('k1', { name: 'renamed' });

      expect(repo.update).toHaveBeenCalledWith('k1', { name: 'renamed' });
      expect(result.name).toBe('renamed');
    });

    it('update throws ApiKeyNotFoundError when missing', async () => {
      repo.update.mockResolvedValueOnce(null);
      await expect(service.update('missing', { name: 'x' })).rejects.toBeInstanceOf(
        ApiKeyNotFoundError,
      );
    });
  });

  describe('verify', () => {
    it('returns the principal for a valid token and refreshes last_used_at', async () => {
      repo.create.mockImplementation(async (row) => ({ id: 'k1', ...row }));
      const { token } = await service.issue({ name: 'partner' });
      const stored = repo.create.mock.calls[0][0];
      repo.findActiveByPrefix.mockResolvedValueOnce([{ id: 'k1', name: 'partner', scopes: [CHAT_WRITE_SCOPE], ...stored }]);

      const principal = await service.verify(token, CHAT_WRITE_SCOPE);

      expect(principal).toEqual({ id: 'k1', name: 'partner', scopes: [CHAT_WRITE_SCOPE] });
      expect(repo.findActiveByPrefix).toHaveBeenCalledWith(stored.key_prefix);
      expect(repo.touchLastUsed).toHaveBeenCalledWith('k1');
    });

    it('throws InvalidApiKeyError when the token lacks the mna_ prefix', async () => {
      await expect(service.verify('Bearer nope')).rejects.toBeInstanceOf(InvalidApiKeyError);
      expect(repo.findActiveByPrefix).not.toHaveBeenCalled();
    });

    it('throws InvalidApiKeyError when no active key matches the hash', async () => {
      repo.findActiveByPrefix.mockResolvedValueOnce([
        { id: 'k1', name: 'x', scopes: [], key_hash: 'scrypt$dead$beef' },
      ]);

      await expect(service.verify('mna_' + 'a'.repeat(48))).rejects.toBeInstanceOf(
        InvalidApiKeyError,
      );
    });

    it('throws InsufficientScopeError when the required scope is absent', async () => {
      repo.create.mockImplementation(async (row) => ({ id: 'k1', ...row }));
      const { token } = await service.issue({ name: 'ro', scopes: ['chat:read'] });
      const stored = repo.create.mock.calls[0][0];
      repo.findActiveByPrefix.mockResolvedValueOnce([{ id: 'k1', name: 'ro', scopes: ['chat:read'], ...stored }]);

      await expect(service.verify(token, CHAT_WRITE_SCOPE)).rejects.toBeInstanceOf(
        InsufficientScopeError,
      );
    });
  });

  it('revoke delegates to the repository and returns the updated view', async () => {
    repo.revoke.mockResolvedValueOnce({
      id: 'k1',
      name: 'partner',
      scopes: [CHAT_WRITE_SCOPE],
      key_prefix: 'abcd1234',
      key_hash: 'scrypt$x$y',
      last_used_at: null,
      revoked_at: '2026-06-06T00:00:00Z',
      created_at: '2026-06-06T00:00:00Z',
    });

    const result = await service.revoke('k1');

    expect(repo.revoke).toHaveBeenCalledWith('k1');
    expect(result.revoked_at).toBe('2026-06-06T00:00:00Z');
    expect(result).not.toHaveProperty('key_hash');
  });

  it('revoke throws ApiKeyNotFoundError when missing', async () => {
    repo.revoke.mockResolvedValueOnce(null);
    await expect(service.revoke('missing')).rejects.toBeInstanceOf(ApiKeyNotFoundError);
  });
});
