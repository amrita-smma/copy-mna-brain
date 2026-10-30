import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailRepository } from './gmailRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
}

describe('GmailRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: GmailRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new GmailRepository(db as never);
  });

  describe('GmailRepository.findConnection', () => {
    it("returns the member's row, or null when they have not connected", async () => {
      db.limit.mockResolvedValueOnce([{ user_id: 'u1' }]).mockResolvedValueOnce([]);
      expect(await repo.findConnection('u1')).toEqual({ user_id: 'u1' });
      expect(await repo.findConnection('u2')).toBeNull();
    });
  });

  describe('GmailRepository.upsertConnection', () => {
    it('inserts one row per user and replaces it on a reconnect', async () => {
      db.returning.mockResolvedValue([{ id: 'c1', user_id: 'u1' }]);

      const row = await repo.upsertConnection({
        userId: 'u1',
        accessTokenEnc: 'a',
        refreshTokenEnc: 'r',
        accessTokenExpiresAt: '2026-10-29T01:00:00Z',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        googleEmail: 'me@gmail.com',
      });

      expect(row).toEqual({ id: 'c1', user_id: 'u1' });
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'u1', access_token_enc: 'a', refresh_token_enc: 'r', google_email: 'me@gmail.com' }),
      );
      const conflict = db.onConflictDoUpdate.mock.calls[0]![0];
      expect(conflict.set).toEqual(
        expect.objectContaining({ access_token_enc: 'a', refresh_token_enc: 'r', google_email: 'me@gmail.com' }),
      );
      expect(conflict.set).toHaveProperty('connected_at');
    });
  });

  describe('GmailRepository.saveRefreshedTokens', () => {
    it('keeps the stored refresh token when Google did not rotate it', async () => {
      await repo.saveRefreshedTokens('u1', { accessTokenEnc: 'a2', accessTokenExpiresAt: '2026-10-29T02:00:00Z' });
      const set = db.set.mock.calls[0]![0];
      expect(set.access_token_enc).toBe('a2');
      expect(set).not.toHaveProperty('refresh_token_enc');
    });

    it('stores a rotated refresh token', async () => {
      await repo.saveRefreshedTokens('u1', {
        accessTokenEnc: 'a2',
        refreshTokenEnc: 'r2',
        accessTokenExpiresAt: '2026-10-29T02:00:00Z',
      });
      expect(db.set.mock.calls[0]![0].refresh_token_enc).toBe('r2');
    });
  });

  describe('GmailRepository.deleteConnection', () => {
    it("deletes only the given member's row", async () => {
      await repo.deleteConnection('u1');
      expect(db.delete).toHaveBeenCalledTimes(1);
      expect(db.where).toHaveBeenCalledTimes(1);
    });
  });
});
