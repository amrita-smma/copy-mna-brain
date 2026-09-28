import { describe, it, expect } from 'vitest';
import { MINERBA_SEED } from './seed';

const layer = (id: string) => MINERBA_SEED.metricLayers.find((l) => l.id === id)?.metrics ?? [];

describe('MINERBA_SEED', () => {
  it('seeds the eight-name IDX cohort and the ten-metric economics layer from PRD §4.1', () => {
    expect(MINERBA_SEED.cohort.members).toEqual(['ADRO', 'ITMG', 'PTBA', 'INCO', 'MDKA', 'ANTM', 'BUMI', 'HRUM']);
    expect(layer('economics')).toHaveLength(10);
  });

  it('flags exactly the login-only / robots-blocked portals as restricted', () => {
    const restricted = MINERBA_SEED.sources.filter((s) => s.limitId === 'restricted-portals');
    expect(restricted.map((s) => s.name)).toEqual(['MODI', 'MOMS', 'e-RKAB']);
  });

  it('declares separate limits for RKAB quota, IUP-to-beneficial-owner and unlisted deal prices (MB-542)', () => {
    expect(MINERBA_SEED.dataLimits.map((l) => l.id)).toEqual(
      expect.arrayContaining(['rkab-quota', 'iup-beneficial-owner', 'unlisted-deal-price', 'restricted-portals']),
    );
  });

  it('has unique limit ids and only links sources to declared limits', () => {
    const ids = MINERBA_SEED.dataLimits.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of MINERBA_SEED.sources) if (s.limitId) expect(ids).toContain(s.limitId);
  });
});
