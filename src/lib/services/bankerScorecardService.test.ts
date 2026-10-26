import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BankerScorecardService,
  buildStageRanker,
  furthestStage,
  stagesInLogs,
} from './bankerScorecardService';

const mocks = vi.hoisted(() => ({
  listForContacts: vi.fn(),
  findByCompanyIds: vi.fn(),
  listStages: vi.fn(),
}));

class MockDealContactRepo {
  listForContacts = mocks.listForContacts;
}

class MockCompanyLogRepo {
  findByCompanyIds = mocks.findByCompanyIds;
}

class MockStageRepo {
  list = mocks.listStages;
}

function makeService() {
  return new BankerScorecardService(
    new MockDealContactRepo() as never,
    new MockCompanyLogRepo() as never,
    new MockStageRepo() as never,
    'w1',
  );
}

const stage = (key: string, position: number, deleted = false) => ({
  workspace_id: 'w1',
  key,
  code: key.startsWith('stg-') ? 'X' : key,
  name: key === 'L1' ? 'Screening' : '',
  description: '',
  position,
  deleted_at: deleted ? '2026-09-01T00:00:00Z' : null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

// L0 · L1 · a deleted stage between L1 and L2 · L2 · L3.
const STAGES = [stage('L0', 0), stage('L1', 1), stage('stg-old', 2, true), stage('L2', 3), stage('L3', 4)];

const link = (
  correspondentId: string,
  companyId: string,
  role: 'source' | 'involved',
  pipelineStage: string,
  extra: { status?: 'active' | 'dismissed'; companyStatus?: 'active' | 'dropped' } = {},
) => ({
  correspondentId,
  companyId,
  role,
  pipelineStage,
  status: extra.status ?? 'active',
  companyStatus: extra.companyStatus ?? 'active',
});

const log = (company_id: string, action: string) => ({
  company_id,
  action,
  created_at: '2026-10-01T00:00:00Z',
});

describe('stagesInLogs', () => {
  it('reads both ends of a stage move and the stage a drop left from', () => {
    expect(
      stagesInLogs([
        'PROMOTED_FROM_L0_TO_L1',
        'PROMOTED_FROM_L2_TO_L1',
        'RESTORED_TO_L3',
        'DROPPED_FROM_L1',
        'auto_created_from_file:abc',
        null,
      ]),
    ).toEqual(['L0', 'L1', 'L2', 'L1', 'L3', 'L1']);
  });
});

describe('buildStageRanker', () => {
  it('ranks pre-pipeline buckets below L0 and stages by position', () => {
    const ranker = buildStageRanker(STAGES as never);
    const order = ['discovered', 'market_screening', 'unreviewed', 'L0', 'L1', 'stg-old', 'L2', 'L3'];
    const ranks = order.map((k) => ranker.rankOf(k) as number);
    expect(ranks.every((r) => typeof r === 'number')).toBe(true);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(ranker.rankOf('unknown')).toBeNull();
  });

  it('counts a deleted stage after L0 as past screening, and L0 / pre-pipeline as not', () => {
    const ranker = buildStageRanker(STAGES as never);
    expect(ranker.isPastFirstStage('stg-old')).toBe(true);
    expect(ranker.isPastFirstStage('L1')).toBe(true);
    expect(ranker.isPastFirstStage('L0')).toBe(false);
    expect(ranker.isPastFirstStage('unreviewed')).toBe(false);
    expect(ranker.isPastFirstStage('unknown')).toBe(false);
  });

  it('falls back to the six original stages when the workspace has no stage rows', () => {
    const ranker = buildStageRanker([]);
    expect(ranker.rankOf('L5')).toBeGreaterThan(ranker.rankOf('L0') as number);
    expect(ranker.isPastFirstStage('L1')).toBe(true);
    expect(ranker.rankOf('unreviewed')).toBeLessThan(ranker.rankOf('L0') as number);
  });
});

describe('furthestStage', () => {
  const ranker = buildStageRanker(STAGES as never);

  it('takes the highest stage across the current stage and the logs', () => {
    expect(furthestStage('L1', ['PROMOTED_FROM_L0_TO_L1', 'PROMOTED_FROM_L1_TO_L2', 'PROMOTED_FROM_L2_TO_L1'], ranker)).toBe('L2');
  });

  it('keeps the current stage when the logs show nothing further', () => {
    expect(furthestStage('L3', ['PROMOTED_FROM_L0_TO_L1'], ranker)).toBe('L3');
  });

  it('ranks pre-pipeline below L0', () => {
    expect(furthestStage('unreviewed', [], ranker)).toBe('unreviewed');
    expect(furthestStage('L0', ['PROMOTED_FROM_unreviewed_TO_L0'], ranker)).toBe('L0');
  });

  it('ignores stage keys it cannot place, falling back to the current stage', () => {
    expect(furthestStage('mystery', ['PROMOTED_TO_other'], ranker)).toBe('mystery');
    expect(furthestStage('mystery', ['PROMOTED_TO_L1'], ranker)).toBe('L1');
  });
});

describe('BankerScorecardService.getScorecards', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.listForContacts.mockResolvedValue([]);
    mocks.findByCompanyIds.mockResolvedValue([]);
    mocks.listStages.mockResolvedValue(STAGES);
  });

  it('returns an empty map without hitting the DB when the id list is empty', async () => {
    await expect(makeService().getScorecards([])).resolves.toEqual(new Map());
    expect(mocks.listForContacts).not.toHaveBeenCalled();
  });

  it('gives a contact with no links an empty scorecard with conversion null, never 0', async () => {
    const cards = await makeService().getScorecards(['c1']);
    expect(cards.get('c1')).toEqual({
      correspondentId: 'c1',
      dealsBrought: 0,
      dealsInvolved: 0,
      reachedL1: 0,
      conversion: null,
      stageBreakdown: [],
      involvedStageBreakdown: [],
      hasDealLinks: false,
    });
    // No linked deals: no log read.
    expect(mocks.findByCompanyIds).not.toHaveBeenCalled();
  });

  it('counts a deal from its furthest logged stage, and a deal dropped after L1 as reached', async () => {
    mocks.listForContacts.mockResolvedValue([
      // Demoted back to L0 after reaching L1.
      link('c1', 'co-demoted', 'source', 'L0'),
      // Reached L1, then dropped there.
      link('c1', 'co-dropped', 'source', 'L1', { companyStatus: 'dropped' }),
      // Never left L0.
      link('c1', 'co-l0', 'source', 'L0'),
      // Still pending confirmation.
      link('c1', 'co-pending', 'source', 'unreviewed'),
    ]);
    mocks.findByCompanyIds.mockResolvedValue([
      log('co-demoted', 'PROMOTED_FROM_L0_TO_L1'),
      log('co-demoted', 'PROMOTED_FROM_L1_TO_L0'),
      log('co-dropped', 'PROMOTED_FROM_L0_TO_L1'),
      log('co-dropped', 'DROPPED_FROM_L1'),
    ]);

    const card = (await makeService().getScorecards(['c1'])).get('c1')!;

    expect(card.dealsBrought).toBe(4);
    expect(card.reachedL1).toBe(2);
    expect(card.conversion).toBe(0.5);
    expect(card.stageBreakdown).toEqual([
      // currentCount is where each live deal sits now: the demoted one is back at L0.
      { stageKey: 'unreviewed', label: 'Pending Confirmation', count: 1, currentCount: 1 },
      { stageKey: 'L0', label: 'L0', count: 1, currentCount: 2 },
      { stageKey: 'L1', label: 'L1 · Screening', count: 2, currentCount: 0 },
      { stageKey: 'L2', label: 'L2', count: 0, currentCount: 0 },
      { stageKey: 'L3', label: 'L3', count: 0, currentCount: 0 },
    ]);
  });

  it('zero-fills every live stage, in position order, so the funnel never skips one', async () => {
    mocks.listForContacts.mockResolvedValue([link('c1', 'co1', 'source', 'L2')]);

    const card = (await makeService().getScorecards(['c1'])).get('c1')!;

    // The deleted stage between L1 and L2 is not filled in.
    expect(card.stageBreakdown.map((b) => [b.stageKey, b.count])).toEqual([
      ['L0', 0],
      ['L1', 0],
      ['L2', 1],
      ['L3', 0],
    ]);
  });

  it('zero-fills the six built-in stages when the workspace has no stage rows', async () => {
    mocks.listStages.mockResolvedValue([]);
    mocks.listForContacts.mockResolvedValue([link('c1', 'co1', 'source', 'L1')]);

    const card = (await makeService().getScorecards(['c1'])).get('c1')!;

    expect(card.stageBreakdown.map((b) => b.stageKey)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
    expect(card.stageBreakdown.find((b) => b.stageKey === 'L1')?.count).toBe(1);
  });

  it('ranks a deal on a deleted stage by its position', async () => {
    mocks.listForContacts.mockResolvedValue([link('c1', 'co1', 'source', 'stg-old', { companyStatus: 'dropped' })]);
    mocks.findByCompanyIds.mockResolvedValue([log('co1', 'PROMOTED_FROM_L1_TO_stg-old')]);

    const card = (await makeService().getScorecards(['c1'])).get('c1')!;

    expect(card.reachedL1).toBe(1);
    expect(card.stageBreakdown.filter((b) => b.count > 0)).toEqual([
      // Dropped, so it sits nowhere now.
      { stageKey: 'stg-old', label: 'X', count: 1, currentCount: 0 },
    ]);
    expect(card.stageBreakdown.map((b) => b.stageKey)).toEqual(['L0', 'L1', 'stg-old', 'L2', 'L3']);
  });

  it('credits two bankers on the same deal each by their own role', async () => {
    mocks.listForContacts.mockResolvedValue([
      link('c1', 'co1', 'source', 'L2'),
      link('c2', 'co1', 'involved', 'L2'),
    ]);

    const cards = await makeService().getScorecards(['c1', 'c2']);

    expect(cards.get('c1')).toMatchObject({ dealsBrought: 1, dealsInvolved: 0, reachedL1: 1, conversion: 1, hasDealLinks: true });
    expect(cards.get('c2')).toMatchObject({
      dealsBrought: 0,
      dealsInvolved: 1,
      reachedL1: 0,
      conversion: null,
      stageBreakdown: [],
      hasDealLinks: true,
    });
    expect(cards.get('c1')?.involvedStageBreakdown).toEqual([]);
    expect(cards.get('c2')?.involvedStageBreakdown.filter((b) => b.count > 0)).toEqual([
      { stageKey: 'L2', label: 'L2', count: 1, currentCount: 1 },
    ]);
    // Logs once per linked company, whichever role linked it.
    expect(mocks.findByCompanyIds).toHaveBeenCalledTimes(1);
    expect(mocks.findByCompanyIds).toHaveBeenCalledWith(['co1']);
  });

  it('builds the involved breakdown by furthest stage, apart from the brought one', async () => {
    mocks.listForContacts.mockResolvedValue([
      link('c1', 'co-brought', 'source', 'unreviewed'),
      // Reached L2, then dropped there.
      link('c1', 'co-dropped', 'involved', 'L2', { companyStatus: 'dropped' }),
      link('c1', 'co-l1', 'involved', 'L1'),
      link('c1', 'co-pending', 'involved', 'unreviewed'),
    ]);
    mocks.findByCompanyIds.mockResolvedValue([
      log('co-dropped', 'PROMOTED_FROM_L1_TO_L2'),
      log('co-dropped', 'DROPPED_FROM_L2'),
    ]);

    const card = (await makeService().getScorecards(['c1'])).get('c1')!;

    expect(mocks.findByCompanyIds).toHaveBeenCalledWith(['co-brought', 'co-dropped', 'co-l1', 'co-pending']);
    expect(card.involvedStageBreakdown).toEqual([
      { stageKey: 'unreviewed', label: 'Pending Confirmation', count: 1, currentCount: 1 },
      { stageKey: 'L0', label: 'L0', count: 0, currentCount: 0 },
      { stageKey: 'L1', label: 'L1 · Screening', count: 1, currentCount: 1 },
      // Dropped, so it sits nowhere now.
      { stageKey: 'L2', label: 'L2', count: 1, currentCount: 0 },
      { stageKey: 'L3', label: 'L3', count: 0, currentCount: 0 },
    ]);
    // The brought side only sees the one deal brought.
    expect(card.stageBreakdown.filter((b) => b.count > 0)).toEqual([
      { stageKey: 'unreviewed', label: 'Pending Confirmation', count: 1, currentCount: 1 },
    ]);
  });

  it('never counts involved deals toward reached L1 or conversion', async () => {
    mocks.listForContacts.mockResolvedValue([
      link('c1', 'co-brought', 'source', 'L0'),
      link('c1', 'co-involved', 'involved', 'L3'),
    ]);

    const card = (await makeService().getScorecards(['c1'])).get('c1')!;

    expect(card).toMatchObject({ dealsBrought: 1, dealsInvolved: 1, reachedL1: 0, conversion: 0 });
  });

  it('ignores dismissed links', async () => {
    mocks.listForContacts.mockResolvedValue([link('c1', 'co1', 'source', 'L2', { status: 'dismissed' })]);
    const card = (await makeService().getScorecards(['c1'])).get('c1')!;
    expect(card).toMatchObject({ dealsBrought: 0, conversion: null, hasDealLinks: false });
  });

  it('issues the same fixed set of reads for 1 or 50 contacts', async () => {
    const run = async (n: number) => {
      for (const m of Object.values(mocks)) m.mockClear();
      const ids = Array.from({ length: n }, (_, i) => `c${i}`);
      mocks.listForContacts.mockResolvedValue(ids.map((id, i) => link(id, `co${i}`, 'source', 'L1')));
      const cards = await makeService().getScorecards(ids);
      expect(cards.size).toBe(n);
      return [
        mocks.listForContacts.mock.calls.length,
        mocks.findByCompanyIds.mock.calls.length,
        mocks.listStages.mock.calls.length,
      ];
    };
    expect(await run(1)).toEqual([1, 1, 1]);
    expect(await run(50)).toEqual([1, 1, 1]);
  });

  it('reads the links of the deduped contacts once, all time by default', async () => {
    mocks.listForContacts.mockResolvedValue([link('c1', 'co1', 'source', 'L1')]);

    const cards = await makeService().getScorecards(['c1', 'c1']);

    expect(mocks.listForContacts).toHaveBeenCalledExactlyOnceWith('w1', ['c1'], {});
    expect(cards.get('c1')?.dealsBrought).toBe(1);
  });

  it('passes since through to the link read', async () => {
    await makeService().getScorecards(['c1'], { since: '2026-01-01T00:00:00.000Z' });
    expect(mocks.listForContacts).toHaveBeenCalledWith('w1', ['c1'], {
      since: '2026-01-01T00:00:00.000Z',
    });
  });
});
