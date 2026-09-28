import { describe, it, expect } from 'vitest';
import { BANGUN_SEED } from './seed';

const layer = (id: string) => BANGUN_SEED.metricLayers.find((l) => l.id === id)?.metrics ?? [];

describe('BANGUN_SEED', () => {
  it('seeds the PRD cohort, the inherited benchmark components and the eight-metric peer and phasing layers', () => {
    expect(BANGUN_SEED.cohort.members).toEqual(['PANI', 'BSDE', 'CTRA', 'SMRA', 'PWON', 'ASRI', 'LPKR']);
    expect(BANGUN_SEED.inheritedComponents.map((c) => c.id)).toEqual([
      'commercials-matrix',
      'capex-stack',
      'bom-basket',
      'rates-ladder',
    ]);
    expect(layer('peer')).toHaveLength(8);
    expect(layer('phasing')).toHaveLength(8);
  });

  it('declares the modelled-phase and phasing-granularity guardrails', () => {
    expect(BANGUN_SEED.dataLimits.map((l) => l.id)).toEqual(
      expect.arrayContaining(['modelled-phase-label', 'phasing-granularity']),
    );
  });
});
