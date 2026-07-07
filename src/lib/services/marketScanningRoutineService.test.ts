import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutinesRepository } from '@/lib/repositories';
import { MarketScanningRoutineService } from './marketScanningRoutineService';

const ROUTINE_TITLE = 'Market Scanning';
const EXISTING_ID = 'routine-in-this-workspace';

function makeRepoStub() {
  return {
    findSystemRoutineByTitle: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: EXISTING_ID }),
    update: vi.fn().mockResolvedValue({ id: EXISTING_ID }),
  };
}

describe('MarketScanningRoutineService.sync', () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: MarketScanningRoutineService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new MarketScanningRoutineService(repo as unknown as RoutinesRepository);
  });

  it('creates the routine for this workspace when none exists yet', async () => {
    repo.findSystemRoutineByTitle.mockResolvedValueOnce(null);

    await service.sync('weekly');

    expect(repo.findSystemRoutineByTitle).toHaveBeenCalledWith(ROUTINE_TITLE);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: ROUTINE_TITLE,
        is_system: true,
        created_by: null,
        agent_name: 'analysis',
        schedule_kind: 'weekly',
      }),
    );
    // No fixed id in the payload — a second workspace must get its own row,
    // not collide on a shared primary key.
    expect(repo.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ id: expect.anything() }),
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('updates this workspace\'s existing routine instead of creating a duplicate', async () => {
    repo.findSystemRoutineByTitle.mockResolvedValueOnce({ id: EXISTING_ID });

    await service.sync('daily');

    expect(repo.update).toHaveBeenCalledWith(
      EXISTING_ID,
      expect.objectContaining({
        schedule_kind: 'daily',
        cron_expression: '0 0 * * *',
      }),
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('maps a monthly cadence onto a monthly schedule on day 1', async () => {
    repo.findSystemRoutineByTitle.mockResolvedValueOnce(null);

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
    repo.findSystemRoutineByTitle.mockResolvedValueOnce(null);

    await service.sync('weekly');

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cron_expression: '0 0 * * 1',
        timezone: 'Asia/Jakarta',
      }),
    );
  });

  it('falls back to weekly for an unknown or empty cadence', async () => {
    repo.findSystemRoutineByTitle.mockResolvedValueOnce(null);

    await service.sync(undefined);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ schedule_kind: 'weekly', cron_expression: '0 0 * * 1' }),
    );
  });
});
