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
  proposeBulkDropCompanies,
  BULK_DROP_APPROVAL_MARKER,
} from './propose_bulk_drop_companies';

function extractPayload(result: string) {
  const match = result.match(
    new RegExp(`<!--\\s*${BULK_DROP_APPROVAL_MARKER}:(.*?)-->`, 's'),
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1].trim());
}

describe('proposeBulkDropCompanies', () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    createDb.mockReset().mockReturnValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders an approval marker with resolved candidates', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c-helix',
        target: 'HelixChem Industries',
        pipeline_stage: 'L0',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c-beta',
        target: 'Beta Polymers SDN',
        pipeline_stage: 'L0',
        status: 'active',
      });

    const result = (await proposeBulkDropCompanies.invoke({
      title: 'Drop 2 stale L0 candidates?',
      description: 'Standard Q2 cleanup.',
      candidates: [
        {
          company_name: 'HelixChem',
          tag: 'Fails L0',
          reason: 'FY2024 EBITDA negative — fails threshold #2.',
          meta: 'L0 since Feb 12 · Sponsor: Sarah Chen',
        },
        {
          company_name: 'Beta Polymers',
          tag: 'Stale · 7mo',
          reason: 'No banker contact since Oct; sector multiples down 22%.',
        },
      ],
    })) as string;

    expect(result).toContain('Bulk drop proposal');
    const payload = extractPayload(result);
    expect(payload).toMatchObject({
      title: 'Drop 2 stale L0 candidates?',
      description: 'Standard Q2 cleanup.',
    });
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates[0]).toMatchObject({
      id: 'c-helix',
      name: 'HelixChem Industries',
      current_stage: 'L0',
      tag: 'Fails L0',
    });
    expect(payload.candidates[1].meta).toBeUndefined();
    expect(payload.approval_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('silently drops already-dropped companies and notes them in the output', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c-active',
        target: 'NovaSpec Materials',
        pipeline_stage: 'L0',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c-gone',
        target: 'Already Gone Co',
        pipeline_stage: 'L0',
        status: 'dropped',
      });

    const result = (await proposeBulkDropCompanies.invoke({
      title: 'Drop',
      description: 'd',
      candidates: [
        { company_name: 'NovaSpec', reason: 'r1' },
        { company_name: 'Already Gone', reason: 'r2' },
      ],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.candidates.map((c: { id: string }) => c.id)).toEqual(['c-active']);
    expect(result).toContain('Skipped (already dropped): Already Gone Co');
  });

  it('refuses (no marker) when no candidates resolve', async () => {
    findByNameFuzzy.mockResolvedValue(null);

    const result = (await proposeBulkDropCompanies.invoke({
      title: 'Drop',
      description: 'd',
      candidates: [
        { company_name: 'GhostCo', reason: 'r' },
        { company_name: 'AnotherGhost', reason: 'r' },
      ],
    })) as string;

    expect(result).toContain('no live candidates resolved');
    expect(result).toContain('Unmatched in pipeline: GhostCo, AnotherGhost');
    expect(result).not.toContain(BULK_DROP_APPROVAL_MARKER);
  });

  it('refuses when every candidate is already dropped', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c1',
        target: 'Dropped One',
        pipeline_stage: 'L0',
        status: 'dropped',
      })
      .mockResolvedValueOnce({
        id: 'c2',
        target: 'Dropped Two',
        pipeline_stage: 'L1',
        status: 'dropped',
      });

    const result = (await proposeBulkDropCompanies.invoke({
      title: 'Drop',
      description: 'd',
      candidates: [
        { company_name: 'Dropped One', reason: 'r' },
        { company_name: 'Dropped Two', reason: 'r' },
      ],
    })) as string;

    expect(result).toContain('Already dropped: Dropped One, Dropped Two');
    expect(result).not.toContain(BULK_DROP_APPROVAL_MARKER);
  });

  it('trims whitespace and omits optional tag/meta when blank', async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: 'c1',
      target: 'Acme',
      pipeline_stage: 'L0',
      status: 'active',
    });

    const result = (await proposeBulkDropCompanies.invoke({
      title: '  Trim me  ',
      description: '  desc  ',
      candidates: [
        { company_name: 'Acme', tag: '   ', reason: '  rsn  ', meta: '   ' },
      ],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.title).toBe('Trim me');
    expect(payload.description).toBe('desc');
    expect(payload.candidates[0]).toMatchObject({ id: 'c1', reason: 'rsn' });
    expect(payload.candidates[0].tag).toBeUndefined();
    expect(payload.candidates[0].meta).toBeUndefined();
  });
});
