import { describe, it, expect } from 'vitest';
import { filterInsightTemplates, sortTemplatesByRecency } from './insightSlashCommand';
import type { InsightTemplateSummary } from '@/lib/api/insightTemplates';

function makeTemplate(id: string, name: string): InsightTemplateSummary {
  return {
    id,
    workspace_id: 'ws-1',
    name,
    description: null,
    icon: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  };
}

const TEMPLATES: InsightTemplateSummary[] = [
  makeTemplate('t1', 'Quarterly Portfolio Review'),
  makeTemplate('t2', 'Market Entry Analysis'),
  makeTemplate('t3', 'Competitive Landscape Snapshot'),
  makeTemplate('t4', 'Deal Pipeline Summary'),
];

describe('filterInsightTemplates', () => {
  it.each(['', '   '])('returns the full list on an empty or whitespace query (%j)', (query) => {
    expect(filterInsightTemplates(TEMPLATES, query)).toEqual(TEMPLATES);
  });

  it('matches a case-insensitive substring of the name', () => {
    expect(filterInsightTemplates(TEMPLATES, 'QUAR')).toEqual([TEMPLATES[0]]);
  });

  it('matches a substring anywhere in the name, not just the prefix', () => {
    expect(filterInsightTemplates(TEMPLATES, 'pipeline')).toEqual([TEMPLATES[3]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterInsightTemplates(TEMPLATES, 'zzz')).toEqual([]);
  });
});

describe('sortTemplatesByRecency', () => {
  it.each([
    ['lastUsedId is null', null],
    ['the id is already first', 't1'],
    ['the id is not present (e.g. a deleted template)', 'does-not-exist'],
  ])('is a no-op when %s', (_, id) => {
    expect(sortTemplatesByRecency(TEMPLATES, id)).toEqual(TEMPLATES);
  });

  it('moves the matching id to the front, keeping the rest in order', () => {
    expect(sortTemplatesByRecency(TEMPLATES, 't3').map((t) => t.id)).toEqual(['t3', 't1', 't2', 't4']);
  });
});
