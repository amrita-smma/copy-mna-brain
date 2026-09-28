import { describe, it, expect } from 'vitest';
import { DIKTI_SEED } from './seed';

describe('DIKTI_SEED', () => {
  it("seeds the seven signal sources and the PRD's eleven metrics (not trimmed to the story's nine)", () => {
    expect(DIKTI_SEED.sources).toHaveLength(7);
    expect(DIKTI_SEED.metricLayers.flatMap((l) => l.metrics)).toHaveLength(11);
  });

  it('declares the PDDikti-401, notarial-extract and observed-vs-inferred guardrails', () => {
    expect(DIKTI_SEED.dataLimits.map((l) => l.id)).toEqual(
      expect.arrayContaining(['pddikti-api', 'ahu-yayasan-coverage', 'observed-vs-inferred']),
    );
  });

  it('limits observed signals to the four US-04 types', () => {
    expect(DIKTI_SEED.observedSignalTypes).toEqual([
      'a ministerial decree',
      'a PDDikti badan penyelenggara field change',
      'a statutory newspaper announcement',
      'an AHU filing',
    ]);
  });
});
