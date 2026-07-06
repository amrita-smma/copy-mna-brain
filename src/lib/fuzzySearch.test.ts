import { describe, it, expect } from 'vitest';
import { bestFuzzyMatch, type CompanyCandidate } from './fuzzySearch';

const candidates: CompanyCandidate[] = [
  { id: 'c1', target: 'Acme Corp', project_name: null },
  { id: 'c2', target: 'Globex Industries', project_name: 'Project Phoenix' },
  { id: 'c3', target: null, project_name: 'Project Tulia' },
];

describe('bestFuzzyMatch', () => {
  it('returns an exact case-insensitive match with similarity 1', () => {
    const match = bestFuzzyMatch('acme corp', candidates);
    expect(match).toEqual({ id: 'c1', name: 'Acme Corp', type: 'company', similarity: 1 });
  });

  it('matches a single-character typo within the default threshold', () => {
    // "Acme Crop" vs "Acme Corp": distance 2 over length 9 = 0.22 <= 0.3.
    const match = bestFuzzyMatch('Acme Crop', candidates);
    expect(match?.id).toBe('c1');
    expect(match!.similarity).toBeGreaterThan(0.7);
  });

  it('matches against project_name as well as target', () => {
    const match = bestFuzzyMatch('Project Tulai', candidates);
    expect(match?.id).toBe('c3');
    expect(match?.name).toBe('Project Tulia');
  });

  it('returns null when the closest candidate exceeds the threshold', () => {
    expect(bestFuzzyMatch('Totally Different Name', candidates)).toBeNull();
  });

  it('returns null for an empty search string', () => {
    expect(bestFuzzyMatch('   ', candidates)).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(bestFuzzyMatch('Acme Corp', [])).toBeNull();
  });

  it('honours a stricter threshold', () => {
    // "Acme Crop" clears the default 0.3 but not a strict 0.1.
    expect(bestFuzzyMatch('Acme Crop', candidates, 0.1)).toBeNull();
  });

  it('picks the closest of several candidates', () => {
    const many: CompanyCandidate[] = [
      { id: 'a', target: 'Globex Industries', project_name: null },
      { id: 'b', target: 'Globex Industial', project_name: null },
    ];
    const match = bestFuzzyMatch('Globex Industrial', many);
    expect(match?.id).toBe('b');
  });
});
