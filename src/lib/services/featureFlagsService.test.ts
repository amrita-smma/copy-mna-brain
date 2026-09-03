import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FeatureFlagRepository } from '@/lib/repositories/featureFlagRepository';
import { FeatureFlagsService, UnknownFeatureError } from './featureFlagsService';

const WS = 'ws-123';

function makeRepo() {
  return {
    findByWorkspace: vi.fn(),
    getOverrideMap: vi.fn(),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
}

function emptyOverrides() {
  return { overrides: {}, updatedAt: null, updatedBy: null };
}

describe('FeatureFlagsService', () => {
  let repo: ReturnType<typeof makeRepo>;
  let service: FeatureFlagsService;

  beforeEach(() => {
    // Pin env defaults so effective states are deterministic. COMPANY_GRAPH
    // has catalog default false; PIPELINE has catalog default true.
    process.env.COMPANY_GRAPH_ENABLED = 'true';
    delete process.env.PIPELINE_ENABLED;
    repo = makeRepo();
    service = new FeatureFlagsService(repo as unknown as FeatureFlagRepository);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.COMPANY_GRAPH_ENABLED;
  });

  describe('listFeatures', () => {
    it('reads overrides for the given workspace', async () => {
      repo.findByWorkspace.mockResolvedValue(emptyOverrides());
      await service.listFeatures(WS);
      expect(repo.findByWorkspace).toHaveBeenCalledWith(WS);
    });

    it('uses env/catalog defaults when no override row exists', async () => {
      repo.findByWorkspace.mockResolvedValue(emptyOverrides());
      const { features, meta } = await service.listFeatures(WS);

      // env override → true
      expect(features.find((f) => f.key === 'COMPANY_GRAPH_ENABLED')).toMatchObject({
        enabled: true,
        isOverridden: false,
      });
      // nav feature, catalog default true, no env var set
      expect(features.find((f) => f.key === 'PIPELINE_ENABLED')).toMatchObject({
        enabled: true,
        isOverridden: false,
      });
      // opt-in feature, catalog default false, no env var set
      expect(features.find((f) => f.key === 'CHAT_CACHE_ENABLED')).toMatchObject({
        enabled: false,
        isOverridden: false,
      });
      expect(meta).toEqual({ updatedAt: null, updatedBy: null });
    });

    it('applies stored overrides over defaults and marks them overridden', async () => {
      repo.findByWorkspace.mockResolvedValue({
        overrides: { PIPELINE_ENABLED: false, CHAT_CACHE_ENABLED: true },
        updatedAt: '2026-07-14T00:00:00.000Z',
        updatedBy: { id: 'u1', name: 'Admin', email: 'a@x.com' },
      });
      const { features, meta } = await service.listFeatures(WS);

      expect(features.find((f) => f.key === 'PIPELINE_ENABLED')).toMatchObject({
        enabled: false,
        isOverridden: true,
      });
      expect(features.find((f) => f.key === 'CHAT_CACHE_ENABLED')).toMatchObject({
        enabled: true,
        isOverridden: true,
      });
      expect(meta.updatedBy).toEqual({ id: 'u1', name: 'Admin', email: 'a@x.com' });
    });

    it('returns one entry per catalog feature', async () => {
      repo.findByWorkspace.mockResolvedValue(emptyOverrides());
      const { features } = await service.listFeatures(WS);
      expect(features).toHaveLength(15);
    });

    it('marks sidebar sections as navItem and non-navbar features as not', async () => {
      repo.findByWorkspace.mockResolvedValue(emptyOverrides());
      const { features } = await service.listFeatures(WS);
      expect(features.find((f) => f.key === 'PIPELINE_ENABLED')?.navItem).toBe(true);
      expect(features.find((f) => f.key === 'CHAT_CACHE_ENABLED')?.navItem).toBe(false);
    });

    it('tags each feature with its settings-tab category (funds vs general)', async () => {
      repo.findByWorkspace.mockResolvedValue(emptyOverrides());
      const { features } = await service.listFeatures(WS);
      // Source of Funds is a Funds-tab setting, on by default.
      expect(features.find((f) => f.key === 'SOURCE_OF_FUNDS_ENABLED')).toMatchObject({
        category: 'funds',
        enabled: true,
      });
      // Everything else falls under the general (Features) tab.
      expect(features.find((f) => f.key === 'PIPELINE_ENABLED')?.category).toBe('general');
    });
  });

  describe('setFeature', () => {
    it('upserts the toggle for the workspace and returns the refreshed list', async () => {
      repo.findByWorkspace.mockResolvedValue(emptyOverrides());

      await service.setFeature(WS, 'PIPELINE_ENABLED', false, 'user-1');

      expect(repo.upsert).toHaveBeenCalledWith(WS, 'PIPELINE_ENABLED', false, 'user-1');
      expect(repo.findByWorkspace).toHaveBeenCalledWith(WS);
    });

    it('rejects an unknown feature key without writing', async () => {
      await expect(
        service.setFeature(WS, 'NOT_A_FEATURE', true, 'user-1'),
      ).rejects.toBeInstanceOf(UnknownFeatureError);
      expect(repo.upsert).not.toHaveBeenCalled();
    });
  });
});
