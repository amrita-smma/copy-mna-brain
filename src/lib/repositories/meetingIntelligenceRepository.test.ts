import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingIntelligenceRepository } from './meetingIntelligenceRepository';

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

describe('MeetingIntelligenceRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: MeetingIntelligenceRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new MeetingIntelligenceRepository(db as never);
  });

  describe('MeetingIntelligenceRepository.findClientId', () => {
    it('returns the stored client id, or null when none is registered', async () => {
      db.limit.mockResolvedValueOnce([{ client_id: 'c1' }]).mockResolvedValueOnce([]);
      expect(await repo.findClientId('https://mi.test', 'https://app.test/cb')).toBe('c1');
      expect(await repo.findClientId('https://mi.test', 'https://app.test/cb')).toBeNull();
    });
  });

  describe('MeetingIntelligenceRepository.saveClientId', () => {
    it('upserts on (server, redirect uri)', async () => {
      await repo.saveClientId('https://mi.test', 'https://app.test/cb', 'c2');
      expect(db.values).toHaveBeenCalledWith({
        server_url: 'https://mi.test',
        redirect_uri: 'https://app.test/cb',
        client_id: 'c2',
      });
      expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: { client_id: 'c2' } }),
      );
    });
  });

  describe('MeetingIntelligenceRepository.findConnection', () => {
    it('returns null when the user has no connection', async () => {
      db.limit.mockResolvedValueOnce([]);
      expect(await repo.findConnection('u1')).toBeNull();
    });
  });

  describe('MeetingIntelligenceRepository.upsertConnection', () => {
    it('stores the encrypted tokens for the user and clears any refresh lease', async () => {
      const row = { id: 'x', user_id: 'u1' };
      db.returning.mockResolvedValueOnce([row]);

      const result = await repo.upsertConnection({
        userId: 'u1',
        serverUrl: 'https://mi.test',
        clientId: 'c1',
        accessTokenEnc: 'enc-a',
        refreshTokenEnc: 'enc-r',
        accessTokenExpiresAt: '2026-10-28T01:00:00.000Z',
        scope: 'mcp:read',
        externalName: 'Nico',
        externalEmail: 'nico@test',
      });

      expect(result).toBe(row);
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'u1',
          access_token_enc: 'enc-a',
          refresh_token_enc: 'enc-r',
          refresh_lease_until: null,
        }),
      );
      expect(db.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe('MeetingIntelligenceRepository.claimRefreshLease', () => {
    it('returns the row when the conditional update claims it', async () => {
      db.returning.mockResolvedValueOnce([{ user_id: 'u1' }]);
      expect(await repo.claimRefreshLease('u1', 30)).toEqual({ user_id: 'u1' });
      expect(db.update).toHaveBeenCalled();
    });

    it('returns null when another request holds the lease', async () => {
      db.returning.mockResolvedValueOnce([]);
      expect(await repo.claimRefreshLease('u1', 30)).toBeNull();
    });
  });

  describe('MeetingIntelligenceRepository.saveRefreshedTokens', () => {
    it('writes the rotated pair and releases the lease', async () => {
      db.where.mockResolvedValueOnce(undefined);
      await repo.saveRefreshedTokens('u1', {
        accessTokenEnc: 'a2',
        refreshTokenEnc: 'r2',
        accessTokenExpiresAt: '2026-10-28T02:00:00.000Z',
        scope: null,
      });
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ access_token_enc: 'a2', refresh_token_enc: 'r2', refresh_lease_until: null }),
      );
    });
  });

  describe('MeetingIntelligenceRepository.deleteConnection', () => {
    it("deletes the user's connection", async () => {
      db.where.mockResolvedValueOnce(undefined);
      await repo.deleteConnection('u1');
      expect(db.delete).toHaveBeenCalled();
    });
  });
});
