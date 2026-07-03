import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DashboardActivityService, isPreL0EntryMove } from './dashboardActivityService';
import type { DashboardActivityRepository } from '@/lib/repositories/dashboardActivityRepository';

/**
 * Class-based mock of the repository: each feed source is a `vi.fn()` so tests
 * can stub return rows and assert the cap (limit) the service passes.
 */
class MockRepo {
  getNewL0Companies = vi.fn();
  getPipelineMoves = vi.fn();
  getDroppedDeals = vi.fn();
  getNotesUpdated = vi.fn();
  getDiscoveredCompanies = vi.fn();
  getAiSourcedCompanies = vi.fn();
  getSlidesGenerated = vi.fn();
  getWorkforceJobs = vi.fn();
  getNewContacts = vi.fn();
}

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-06-18T00:00:00.000Z');

// Minimal row fixtures shaped like each repository source.
function newDealRow(id: string, eventAt: string) {
  return {
    id,
    target: `Target ${id}`,
    project_name: null,
    source: 'inbound',
    segment: 'Tech',
    geography: 'US',
    remarks: null,
    thesis_content: null,
    revenue_usd_mn: null,
    ebitda_usd_mn: null,
    ev_usd_mn: null,
    financial_year: null,
    event_at: eventAt,
    reason: 'created' as const,
  };
}

function moveRow(id: string, createdAt: string) {
  return {
    id,
    company_id: `co-${id}`,
    action: 'PROMOTED_FROM_L1_TO_L2',
    created_at: createdAt,
    target: `Move ${id}`,
    project_name: null,
    segment: null,
    geography: null,
    source: null,
    remarks: null,
    thesis_content: null,
    revenue_usd_mn: null,
    ebitda_usd_mn: null,
    ev_usd_mn: null,
    financial_year: null,
  };
}

function droppedRow(id: string, droppedAt: string) {
  return {
    id,
    target: `Dropped ${id}`,
    project_name: null,
    pipeline_stage: 'L2',
    dropped_at: droppedAt,
    dropped_reason: null,
    segment: null,
    geography: null,
    source: null,
    thesis_content: null,
    revenue_usd_mn: null,
    ebitda_usd_mn: null,
    ev_usd_mn: null,
    financial_year: null,
  };
}

function noteRow(id: string, createdAt: string) {
  return {
    id,
    company_id: `co-${id}`,
    content: 'note',
    stage: 'L1',
    created_at: createdAt,
    target: `Note ${id}`,
    project_name: null,
    segment: null,
    geography: null,
    source: null,
    remarks: null,
    thesis_content: null,
    revenue_usd_mn: null,
    ebitda_usd_mn: null,
    ev_usd_mn: null,
    financial_year: null,
  };
}

function discoveredRow(id: string, eventAt: string) {
  return {
    id,
    target: `Discovered ${id}`,
    project_name: null,
    source: null,
    segment: null,
    geography: null,
    remarks: null,
    thesis_content: null,
    revenue_usd_mn: null,
    ebitda_usd_mn: null,
    ev_usd_mn: null,
    financial_year: null,
    event_at: eventAt,
  };
}

describe('isPreL0EntryMove', () => {
  it('is true for a move into L0 from a pre-L0 stage', () => {
    expect(isPreL0EntryMove('PROMOTED_FROM_unreviewed_TO_L0')).toBe(true);
    expect(isPreL0EntryMove('PROMOTED_FROM_market_screening_TO_L0')).toBe(true);
    expect(isPreL0EntryMove('PROMOTED_FROM_discovered_TO_L0')).toBe(true);
  });

  it('is true for a from-less promotion to L0', () => {
    expect(isPreL0EntryMove('PROMOTED_TO_L0')).toBe(true);
  });

  it('is false for moves between L-stages, including demotions back to L0', () => {
    expect(isPreL0EntryMove('PROMOTED_FROM_L0_TO_L1')).toBe(false);
    expect(isPreL0EntryMove('PROMOTED_FROM_L1_TO_L2')).toBe(false);
    expect(isPreL0EntryMove('PROMOTED_FROM_L1_TO_L0')).toBe(false);
  });

  it('is false for unparseable or null actions', () => {
    expect(isPreL0EntryMove(null)).toBe(false);
    expect(isPreL0EntryMove('DROPPED')).toBe(false);
  });
});

describe('DashboardActivityService.getActivity', () => {
  let repo: MockRepo;
  let service: DashboardActivityService;

  beforeEach(() => {
    repo = new MockRepo();
    for (const fn of Object.values(repo)) fn.mockResolvedValue([]);
    service = new DashboardActivityService(
      repo as unknown as DashboardActivityRepository,
    );
  });

  it('excludes pre-L0 → L0 entries from pipelineMoves (covered by New Deals)', async () => {
    repo.getPipelineMoves.mockResolvedValue([
      { ...moveRow('a', '2026-06-12T00:00:00.000Z'), action: 'PROMOTED_FROM_unreviewed_TO_L0' },
      { ...moveRow('b', '2026-06-11T00:00:00.000Z'), action: 'PROMOTED_TO_L0' },
      { ...moveRow('c', '2026-06-10T00:00:00.000Z'), action: 'PROMOTED_FROM_L1_TO_L2' },
    ]);

    const activity = await service.getActivity(FROM, TO);

    expect(activity.pipelineMoves.map((m) => m.id)).toEqual(['c']);
  });
});

describe('DashboardActivityService.getFeed', () => {
  let repo: MockRepo;
  let service: DashboardActivityService;

  beforeEach(() => {
    repo = new MockRepo();
    repo.getNewL0Companies.mockReset();
    repo.getPipelineMoves.mockReset();
    repo.getDroppedDeals.mockReset();
    repo.getNotesUpdated.mockReset();
    repo.getDiscoveredCompanies.mockReset();
    // Default every feed source to empty so each test only stubs what it asserts
    // on; the merged stream is built from whichever sources return rows.
    repo.getNewL0Companies.mockResolvedValue([]);
    repo.getPipelineMoves.mockResolvedValue([]);
    repo.getDroppedDeals.mockResolvedValue([]);
    repo.getNotesUpdated.mockResolvedValue([]);
    repo.getDiscoveredCompanies.mockResolvedValue([]);
    service = new DashboardActivityService(
      repo as unknown as DashboardActivityRepository,
    );
  });

  it('merges all sources newest-first and slices the requested window', async () => {
    repo.getNewL0Companies.mockResolvedValue([newDealRow('a', '2026-06-10T00:00:00.000Z')]);
    repo.getPipelineMoves.mockResolvedValue([moveRow('b', '2026-06-12T00:00:00.000Z')]);
    repo.getDroppedDeals.mockResolvedValue([droppedRow('c', '2026-06-08T00:00:00.000Z')]);
    repo.getNotesUpdated.mockResolvedValue([noteRow('d', '2026-06-14T00:00:00.000Z')]);

    const { events, hasMore } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 10,
    });

    expect(events.map((e) => e.type)).toEqual([
      'note_updated', // 06-14
      'stage_move', //   06-12
      'new_deal', //     06-10
      'dropped', //      06-08
    ]);
    expect(hasMore).toBe(false);
  });

  it('passes offset + limit + 1 as the per-source cap', async () => {
    repo.getNewL0Companies.mockResolvedValue([]);
    repo.getPipelineMoves.mockResolvedValue([]);
    repo.getDroppedDeals.mockResolvedValue([]);
    repo.getNotesUpdated.mockResolvedValue([]);

    await service.getFeed({ from: FROM, to: TO, offset: 30, limit: 15 });

    // cap = 30 + 15 + 1
    expect(repo.getNewL0Companies).toHaveBeenCalledWith(FROM, TO, 46);
    expect(repo.getPipelineMoves).toHaveBeenCalledWith(FROM, TO, 46);
    expect(repo.getDroppedDeals).toHaveBeenCalledWith(FROM, TO, 46);
    expect(repo.getNotesUpdated).toHaveBeenCalledWith(FROM, TO, 46);
    expect(repo.getDiscoveredCompanies).toHaveBeenCalledWith(FROM, TO, 46);
  });

  it('reports hasMore when more rows exist than the page window', async () => {
    // 3 events available, page size 2 → hasMore true, returns first 2.
    repo.getNewL0Companies.mockResolvedValue([
      newDealRow('a', '2026-06-10T00:00:00.000Z'),
      newDealRow('b', '2026-06-09T00:00:00.000Z'),
      newDealRow('c', '2026-06-08T00:00:00.000Z'),
    ]);
    repo.getPipelineMoves.mockResolvedValue([]);
    repo.getDroppedDeals.mockResolvedValue([]);
    repo.getNotesUpdated.mockResolvedValue([]);

    const { events, hasMore } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 2,
    });

    expect(events).toHaveLength(2);
    expect(events[0].company_id).toBe('a');
    expect(events[1].company_id).toBe('b');
    expect(hasMore).toBe(true);
  });

  it('returns the next window for a non-zero offset', async () => {
    repo.getNewL0Companies.mockResolvedValue([
      newDealRow('a', '2026-06-10T00:00:00.000Z'),
      newDealRow('b', '2026-06-09T00:00:00.000Z'),
      newDealRow('c', '2026-06-08T00:00:00.000Z'),
    ]);
    repo.getPipelineMoves.mockResolvedValue([]);
    repo.getDroppedDeals.mockResolvedValue([]);
    repo.getNotesUpdated.mockResolvedValue([]);

    const { events, hasMore } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 2,
      limit: 2,
    });

    expect(events).toHaveLength(1);
    expect(events[0].company_id).toBe('c');
    expect(hasMore).toBe(false);
  });

  it('only queries the matching source when a single filter is set', async () => {
    repo.getPipelineMoves.mockResolvedValue([moveRow('b', '2026-06-12T00:00:00.000Z')]);

    const { events } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 10,
      filter: 'stage_move',
    });

    expect(repo.getPipelineMoves).toHaveBeenCalledTimes(1);
    expect(repo.getNewL0Companies).not.toHaveBeenCalled();
    expect(repo.getDroppedDeals).not.toHaveBeenCalled();
    expect(repo.getNotesUpdated).not.toHaveBeenCalled();
    expect(repo.getDiscoveredCompanies).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stage_move');
    expect(events[0].from_stage).toBe('L1');
    expect(events[0].to_stage).toBe('L2');
  });

  it('emits ai_discovered events and only queries that source when filtered', async () => {
    repo.getDiscoveredCompanies.mockResolvedValue([
      discoveredRow('x', '2026-06-15T00:00:00.000Z'),
    ]);

    const { events } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 10,
      filter: 'ai_discovered',
    });

    expect(repo.getDiscoveredCompanies).toHaveBeenCalledTimes(1);
    expect(repo.getNewL0Companies).not.toHaveBeenCalled();
    expect(repo.getPipelineMoves).not.toHaveBeenCalled();
    expect(repo.getDroppedDeals).not.toHaveBeenCalled();
    expect(repo.getNotesUpdated).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ai_discovered');
    expect(events[0].company_id).toBe('x');
    expect(events[0].company_name).toBe('Discovered x');
  });

  it('surfaces the dropped stage and reason on dropped events', async () => {
    repo.getNewL0Companies.mockResolvedValue([]);
    repo.getPipelineMoves.mockResolvedValue([]);
    repo.getDroppedDeals.mockResolvedValue([
      {
        ...droppedRow('c', '2026-06-08T00:00:00.000Z'),
        pipeline_stage: 'L3',
        dropped_reason: 'Valuation too high',
      },
    ]);
    repo.getNotesUpdated.mockResolvedValue([]);

    const { events } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 10,
      filter: 'dropped',
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('dropped');
    expect(events[0].dropped_stage).toBe('L3');
    expect(events[0].dropped_reason).toBe('Valuation too high');
  });

  it('skips pre-L0 → L0 moves (already emitted as new_deal events)', async () => {
    repo.getPipelineMoves.mockResolvedValue([
      { ...moveRow('a', '2026-06-12T00:00:00.000Z'), action: 'PROMOTED_FROM_unreviewed_TO_L0' },
      { ...moveRow('b', '2026-06-11T00:00:00.000Z'), action: 'PROMOTED_TO_L0' },
      { ...moveRow('c', '2026-06-10T00:00:00.000Z'), action: 'PROMOTED_FROM_L0_TO_L1' },
    ]);

    const { events } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 10,
      filter: 'stage_move',
    });

    expect(events).toHaveLength(1);
    expect(events[0].company_id).toBe('co-c');
  });

  it('drops events with a null timestamp', async () => {
    repo.getNewL0Companies.mockResolvedValue([]);
    repo.getPipelineMoves.mockResolvedValue([
      { ...moveRow('b', '2026-06-12T00:00:00.000Z'), created_at: null },
    ]);
    repo.getDroppedDeals.mockResolvedValue([]);
    repo.getNotesUpdated.mockResolvedValue([]);

    const { events, hasMore } = await service.getFeed({
      from: FROM,
      to: TO,
      offset: 0,
      limit: 10,
    });

    expect(events).toHaveLength(0);
    expect(hasMore).toBe(false);
  });
});

describe('DashboardActivityService.getCompanyTimeline', () => {
  let repo: MockRepo;
  let service: DashboardActivityService;

  beforeEach(() => {
    repo = new MockRepo();
    repo.getNewL0Companies.mockResolvedValue([]);
    repo.getPipelineMoves.mockResolvedValue([]);
    repo.getDroppedDeals.mockResolvedValue([]);
    repo.getNotesUpdated.mockResolvedValue([]);
    repo.getDiscoveredCompanies.mockResolvedValue([]);
    service = new DashboardActivityService(
      repo as unknown as DashboardActivityRepository,
    );
  });

  it('scopes every feed source to the company with no limit', async () => {
    await service.getCompanyTimeline('co-1');

    // (from, to, limit=undefined, companyId) — the whole-history range is
    // supplied by the service; the important part is the company scope and the
    // absence of a cap so the full timeline comes back.
    for (const fn of [
      repo.getNewL0Companies,
      repo.getPipelineMoves,
      repo.getDroppedDeals,
      repo.getNotesUpdated,
      repo.getDiscoveredCompanies,
    ]) {
      expect(fn).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        undefined,
        'co-1',
      );
    }
  });

  it('merges the company sources newest-first', async () => {
    repo.getNewL0Companies.mockResolvedValue([newDealRow('co-1', '2026-01-01T00:00:00.000Z')]);
    repo.getPipelineMoves.mockResolvedValue([moveRow('co-1', '2026-03-01T00:00:00.000Z')]);
    repo.getNotesUpdated.mockResolvedValue([noteRow('co-1', '2026-02-01T00:00:00.000Z')]);

    const events = await service.getCompanyTimeline('co-1');

    expect(events.map((e) => e.type)).toEqual([
      'stage_move', //   03-01
      'note_updated', // 02-01
      'new_deal', //     01-01
    ]);
  });

  it('returns [] when the company has no activity', async () => {
    const events = await service.getCompanyTimeline('co-empty');
    expect(events).toEqual([]);
  });
});
