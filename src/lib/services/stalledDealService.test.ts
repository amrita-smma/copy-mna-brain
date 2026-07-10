import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CompanyLogRepository,
  CompanyRepository,
} from '@/lib/repositories';
import {
  StalledDealService,
  parseStageDestination,
  buildStageTimeline,
  computeStageEnteredAt,
  daysBetween,
} from './stalledDealService';

const findForAgentStats = vi.fn();
const findByCompanyIds = vi.fn();

function makeService(): StalledDealService {
  const companyRepo = { findForAgentStats } as unknown as CompanyRepository;
  const companyLogRepo = { findByCompanyIds } as unknown as CompanyLogRepository;
  return new StalledDealService(companyRepo, companyLogRepo);
}

beforeEach(() => {
  findForAgentStats.mockReset();
  findByCompanyIds.mockReset();
});

describe('parseStageDestination', () => {
  it('parses a from/to promotion', () => {
    expect(parseStageDestination('PROMOTED_FROM_L1_TO_L2')).toEqual({
      from: 'L1',
      to: 'L2',
    });
  });

  it('parses a from-less promotion', () => {
    expect(parseStageDestination('PROMOTED_TO_L1')).toEqual({
      from: null,
      to: 'L1',
    });
  });

  it('parses restore and resurface actions', () => {
    expect(parseStageDestination('RESTORED_TO_L3').to).toBe('L3');
    expect(parseStageDestination('RESURFACED_TO_L2').to).toBe('L2');
  });

  it('keeps an underscore-containing origin stage intact', () => {
    expect(parseStageDestination('PROMOTED_FROM_market_screening_TO_L0')).toEqual(
      { from: 'market_screening', to: 'L0' },
    );
  });

  it('returns nulls for drops, creation markers, and unknowns', () => {
    expect(parseStageDestination('DROPPED_FROM_L2')).toEqual({
      from: null,
      to: null,
    });
    expect(parseStageDestination('created_from_file:abc')).toEqual({
      from: null,
      to: null,
    });
    expect(parseStageDestination(null)).toEqual({ from: null, to: null });
  });
});

describe('buildStageTimeline', () => {
  it('keeps only stage-move logs with a timestamp, oldest first', () => {
    const timeline = buildStageTimeline([
      { action: 'created_from_file:x', created_at: '2026-01-01' },
      { action: 'PROMOTED_TO_L0', created_at: '2026-01-02' },
      { action: 'SLIDE_GENERATED', created_at: '2026-01-03' },
      { action: 'PROMOTED_FROM_L0_TO_L1', created_at: '2026-01-05' },
      { action: 'PROMOTED_TO_L2', created_at: null },
    ]);

    expect(timeline).toEqual([
      { stage: 'L0', fromStage: null, enteredAt: '2026-01-02', action: 'PROMOTED_TO_L0' },
      { stage: 'L1', fromStage: 'L0', enteredAt: '2026-01-05', action: 'PROMOTED_FROM_L0_TO_L1' },
    ]);
  });
});

describe('computeStageEnteredAt', () => {
  const logs = [
    { action: 'PROMOTED_TO_L0', created_at: '2026-01-02' },
    { action: 'PROMOTED_FROM_L0_TO_L1', created_at: '2026-01-05' },
    { action: 'PROMOTED_FROM_L1_TO_L2', created_at: '2026-01-10' },
  ];

  it('returns the latest log that moved the deal into its current stage', () => {
    expect(computeStageEnteredAt(logs, 'L2', '2026-01-01')).toEqual({
      enteredAt: '2026-01-10',
      basis: 'log',
    });
  });

  it('picks the most recent entry when a stage was entered more than once', () => {
    const revisited = [
      { action: 'PROMOTED_TO_L1', created_at: '2026-01-02' },
      { action: 'RESTORED_TO_L1', created_at: '2026-03-01' },
    ];
    expect(computeStageEnteredAt(revisited, 'L1', '2026-01-01')).toEqual({
      enteredAt: '2026-03-01',
      basis: 'log',
    });
  });

  it('falls back to created_at when no log matches the current stage', () => {
    expect(computeStageEnteredAt(logs, 'L4', '2026-01-01')).toEqual({
      enteredAt: '2026-01-01',
      basis: 'created_at',
    });
  });
});

describe('daysBetween', () => {
  it('floors the whole-day gap', () => {
    expect(daysBetween('2026-01-01T00:00:00Z', new Date('2026-01-16T12:00:00Z'))).toBe(15);
  });

  it('clamps negatives and nulls to 0', () => {
    expect(daysBetween('2026-02-01', new Date('2026-01-01'))).toBe(0);
    expect(daysBetween(null, new Date('2026-01-01'))).toBe(0);
  });
});

describe('StalledDealService.getStalledDeals', () => {
  it('scopes to active L0–L5 deals when no stage is given', async () => {
    findForAgentStats.mockResolvedValue([]);
    const service = makeService();

    await service.getStalledDeals();

    expect(findForAgentStats).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        stageIn: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
      }),
    );
    // No companies → never queries logs.
    expect(findByCompanyIds).not.toHaveBeenCalled();
  });

  it('passes an explicit stage through and omits stageIn', async () => {
    findForAgentStats.mockResolvedValue([]);
    const service = makeService();

    await service.getStalledDeals({ stage: 'L2' });

    expect(findForAgentStats).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L2', stageIn: undefined }),
    );
  });

  it('flags deals at/over the threshold, sorts by days-in-stage desc, and counts stalled', async () => {
    findForAgentStats.mockResolvedValue([
      { id: 'c1', target: 'Acme', project_name: 'Alpha', segment: 'Tech', geography: 'USA', pipeline_stage: 'L2', status: 'active', created_at: '2026-01-01' },
      { id: 'c2', target: 'Beta', project_name: null, segment: null, geography: null, pipeline_stage: 'L1', status: 'active', created_at: '2026-06-25' },
    ]);
    findByCompanyIds.mockResolvedValue([
      { company_id: 'c1', action: 'PROMOTED_FROM_L1_TO_L2', created_at: '2026-06-01' },
      { company_id: 'c2', action: 'PROMOTED_TO_L1', created_at: '2026-06-25' },
    ]);
    const service = makeService();

    const report = await service.getStalledDeals({
      asOf: new Date('2026-07-01T00:00:00Z'),
      thresholdDays: 14,
    });

    expect(report.totalActive).toBe(2);
    expect(report.stalledCount).toBe(1);
    expect(report.thresholdDays).toBe(14);
    // c1 (30 days) stalled and sorted first; c2 (6 days) not stalled.
    expect(report.deals.map((d) => d.companyId)).toEqual(['c1', 'c2']);
    expect(report.deals[0]).toMatchObject({
      companyId: 'c1',
      daysInStage: 30,
      isStalled: true,
      enteredStageAt: '2026-06-01',
      enteredStageBasis: 'log',
    });
    expect(report.deals[1]).toMatchObject({
      companyId: 'c2',
      daysInStage: 6,
      isStalled: false,
    });
  });

  it('falls back to created_at for a deal with no matching stage log', async () => {
    findForAgentStats.mockResolvedValue([
      { id: 'c3', target: 'Gamma', project_name: null, segment: null, geography: null, pipeline_stage: 'L0', status: 'active', created_at: '2026-01-01' },
    ]);
    findByCompanyIds.mockResolvedValue([]);
    const service = makeService();

    const report = await service.getStalledDeals({
      asOf: new Date('2026-02-01T00:00:00Z'),
      thresholdDays: 14,
    });

    expect(report.deals[0]).toMatchObject({
      enteredStageBasis: 'created_at',
      isStalled: true,
      timeline: [],
    });
  });
});
