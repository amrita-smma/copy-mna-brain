import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutinesRepository } from '@/lib/repositories';
import {
  MARKET_SCANNING_ROUTINE_ID,
  MarketScanningRoutineService,
} from './marketScanningRoutineService';

function makeRepoStub() {
  return {
    findById: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: MARKET_SCANNING_ROUTINE_ID }),
    update: vi.fn().mockResolvedValue({ id: MARKET_SCANNING_ROUTINE_ID }),
  };
}

describe('MarketScanningRoutineService.sync', () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: MarketScanningRoutineService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new MarketScanningRoutineService(repo as unknown as RoutinesRepository);
  });

  it('creates the singleton system routine when none exists', async () => {
    repo.findById.mockResolvedValueOnce(null);

    await service.sync('weekly');

    expect(repo.findById).toHaveBeenCalledWith(MARKET_SCANNING_ROUTINE_ID);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MARKET_SCANNING_ROUTINE_ID,
        is_system: true,
        created_by: null,
        agent_name: 'analysis',
        schedule_kind: 'weekly',
      }),
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('updates the existing routine instead of creating a duplicate', async () => {
    repo.findById.mockResolvedValueOnce({ id: MARKET_SCANNING_ROUTINE_ID });

    await service.sync('daily');

    expect(repo.update).toHaveBeenCalledWith(
      MARKET_SCANNING_ROUTINE_ID,
      expect.objectContaining({
        schedule_kind: 'daily',
        cron_expression: '0 0 * * *',
      }),
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('maps a monthly cadence onto a monthly schedule on day 1', async () => {
    repo.findById.mockResolvedValueOnce(null);

    await service.sync('monthly');

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule_kind: 'monthly',
        cron_expression: '0 0 1 * *',
        schedule_spec: expect.objectContaining({ day: 1 }),
      }),
    );
  });

  it('maps a weekly cadence onto Monday 12am WIB', async () => {
    repo.findById.mockResolvedValueOnce(null);

    await service.sync('weekly');

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cron_expression: '0 0 * * 1',
        timezone: 'Asia/Jakarta',
      }),
    );
  });

  it('falls back to weekly for an unknown or empty cadence', async () => {
    repo.findById.mockResolvedValueOnce(null);

    await service.sync(undefined);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ schedule_kind: 'weekly', cron_expression: '0 0 * * 1' }),
    );
  });
});
