import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFundVehiclesEnabled, resolveTargetKind } from './fundVehicles';

const { getOverrideMap } = vi.hoisted(() => ({ getOverrideMap: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: () => ({}) }));
vi.mock('@/lib/repositories/featureFlagRepository', () => ({
  FeatureFlagRepository: class { getOverrideMap = getOverrideMap; },
}));

describe('fund vehicle persistence policy', () => {
  beforeEach(() => {
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('FUND_VEHICLE_VIEW_ENABLED', 'true');
    getOverrideMap.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses the explicit workspace override even when the default is enabled', async () => {
    getOverrideMap.mockImplementation(async (workspaceId: string) => ({ FUND_VEHICLE_VIEW_ENABLED: workspaceId !== 'disabled-workspace' }));
    expect(await resolveFundVehiclesEnabled('disabled-workspace')).toBe(false);
    expect(await resolveFundVehiclesEnabled('enabled-workspace')).toBe(true);
  });

  it('fails closed when overrides cannot be loaded', async () => {
    getOverrideMap.mockRejectedValue(new Error('Override store unavailable'));
    await expect(resolveFundVehiclesEnabled('workspace')).rejects.toThrow('Override store unavailable');
  });

  it('keeps managed targets exempt while routing external targets to assets', () => {
    expect(resolveTargetKind('fund_of_funds', false)).toBe('asset');
    expect(resolveTargetKind('fund_of_funds', true)).toBe('fund');
    expect(resolveTargetKind('fund_of_funds', false, true)).toBe('fund');
    expect(resolveTargetKind('direct_investment', true, true)).toBe('asset');
  });
});
