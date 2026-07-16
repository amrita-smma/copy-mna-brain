import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findByNameFuzzy, createDb } = vi.hoisted(() => ({
  findByNameFuzzy: vi.fn(),
  createDb: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb, withBackgroundDb: vi.fn(async (cb) => cb(createDb())) }));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return {
    ...actual,
    CompanyRepository: MockCompanyRepository,
  };
});

import {
  proposeBulkPromoteCompanies,
  BULK_PROMOTE_APPROVAL_MARKER,
} from './propose_bulk_promote_companies';

function extractPayload(result: string) {
  const match = result.match(
    new RegExp(`<!--\\s*${BULK_PROMOTE_APPROVAL_MARKER}:(.*?)-->`, 's'),
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1].trim());
}

describe('proposeBulkPromoteCompanies', () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    createDb.mockReset().mockReturnValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('emits a marker with resolved candidates, target_stage, tags and signals', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c-nova',
        target: 'NovaSpec Materials',
        pipeline_stage: 'L0',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c-atlas',
        target: 'Atlas Coatings KK',
        pipeline_stage: 'L0',
        status: 'active',
      });

    const result = (await proposeBulkPromoteCompanies.invoke({
      title: 'Promote 2 candidates from L0 → L1?',
      description: 'Standard weekly promotion review.',
      target_stage: 'L1',
      candidates: [
        {
          company_name: 'NovaSpec',
          tags: ['Passes L1'],
          reason: 'Clean ownership and recent CFO refresh.',
          signals: [
            { label: 'Revenue', value: '$112M', status: 'pass' },
            { label: 'EBITDA', value: '$28M (25%)', status: 'pass' },
          ],
          meta: 'L0 since Feb 12 · Sponsor: Sarah Chen',
        },
        {
          company_name: 'Atlas Coatings',
          tags: ['Passes L1', 'Strategic fit'],
          reason: 'Highest-margin name in cohort.',
        },
      ],
    })) as string;

    expect(result).toContain('Bulk promote proposal');
    const payload = extractPayload(result);
    expect(payload.target_stage).toBe('L1');
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates[0]).toMatchObject({
      id: 'c-nova',
      name: 'NovaSpec Materials',
      current_stage: 'L0',
      tags: ['Passes L1'],
    });
    expect(payload.candidates[0].signals).toEqual([
      { label: 'Revenue', value: '$112M', status: 'pass' },
      { label: 'EBITDA', value: '$28M (25%)', status: 'pass' },
    ]);
    expect(payload.candidates[1].tags).toEqual(['Passes L1', 'Strategic fit']);
    expect(payload.candidates[1].signals).toBeUndefined();
    expect(payload.approval_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('skips already-dropped and already-at-target-stage companies and notes them', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c1',
        target: 'Eligible Co',
        pipeline_stage: 'L0',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c2',
        target: 'Already L1 Co',
        pipeline_stage: 'L1',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c3',
        target: 'Dropped Co',
        pipeline_stage: 'L0',
        status: 'dropped',
      });

    const result = (await proposeBulkPromoteCompanies.invoke({
      title: 'Promote to L1',
      description: 'd',
      target_stage: 'L1',
      candidates: [
        { company_name: 'Eligible', reason: 'r' },
        { company_name: 'Already L1', reason: 'r' },
        { company_name: 'Dropped', reason: 'r' },
      ],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.candidates.map((c: { id: string }) => c.id)).toEqual(['c1']);
    expect(result).toContain('Skipped (already at L1): Already L1 Co');
    expect(result).toContain('Skipped (already dropped): Dropped Co');
  });

  it('refuses (no marker) when zero candidates resolve', async () => {
    findByNameFuzzy.mockResolvedValue(null);

    const result = (await proposeBulkPromoteCompanies.invoke({
      title: 't',
      description: 'd',
      target_stage: 'L1',
      candidates: [
        { company_name: 'GhostOne', reason: 'r' },
        { company_name: 'GhostTwo', reason: 'r' },
      ],
    })) as string;

    expect(result).toContain('no eligible candidates resolved');
    expect(result).toContain('Unmatched in pipeline: GhostOne, GhostTwo');
    expect(result).not.toContain(BULK_PROMOTE_APPROVAL_MARKER);
  });

  it('drops blank tags and signals defensively', async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: 'c1',
      target: 'Acme',
      pipeline_stage: 'L0',
      status: 'active',
    });

    const result = (await proposeBulkPromoteCompanies.invoke({
      title: 't',
      description: 'd',
      target_stage: 'L1',
      candidates: [
        {
          company_name: 'Acme',
          tags: ['  ', 'Passes L1', ''],
          reason: 'r',
          signals: [
            { label: '  ', value: 'x' },
            { label: 'Revenue', value: '$100M' },
          ],
        },
      ],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.candidates[0].tags).toEqual(['Passes L1']);
    expect(payload.candidates[0].signals).toEqual([
      { label: 'Revenue', value: '$100M' },
    ]);
  });
});
